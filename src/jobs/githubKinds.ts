import path from "node:path";
import { StepKindRegistry } from "./stepKinds.js";
import type { StepContext, StepValues } from "./stepKinds.js";
import { llmStepKind, llmDerivableKeys } from "./llmKind.js";
import { securityStepKind } from "./securityKind.js";
import type { GitHubClient, IssueComment } from "../github/client.js";
import * as git from "../github/git.js";

export interface GitHubKindDeps {
  client: GitHubClient;
  token: string;
  tempDir: string;
  committer: { name: string; email: string };
  // Model id for the code-review step (config.openRouter.reviewModel). Kept on
  // deps so the kind stays a pure function of its inputs — no global lookup.
  reviewModel: string;
}

// Live registry for processIssueJob: the same kind keys defaultStepKinds() stubs,
// but each backed by a real git/GitHub/LLM action. Inputs are read off ctx
// (threaded by the scheduler); outputs feed the next step.
// The per-run workspace: <tempDir>/jobs/<jobUuid>. The clone lands under here and
// the whole dir is removed on teardown, so one run can never touch another's
// files. Single source of the path so clone and cleanup can't drift.
export function jobWorkspace(tempDir: string, jobUuid: string): string {
  if (typeof tempDir !== "string" || tempDir === "") throw new Error("[githubKinds.jobWorkspace] tempDir is required");
  if (typeof jobUuid !== "string" || jobUuid === "") throw new Error("[githubKinds.jobWorkspace] jobUuid is required");
  return path.join(tempDir, "jobs", jobUuid);
}

// Scheduler teardown hook: remove the run's clone workspace, keyed off the
// ambient jobUuid trigger constant. Fires on success and failure.
export function githubCleanup(deps: GitHubKindDeps): (trigger: StepValues) => Promise<void> {
  validateDeps(deps);
  return (trigger) => git.removeDir(jobWorkspace(deps.tempDir, str(trigger, "jobUuid")));
}

export function githubStepKinds(deps: GitHubKindDeps): StepKindRegistry {
  validateDeps(deps);
  return new StepKindRegistry()
    .register("github.fetchIssue", (ctx) => fetchIssue(deps, ctx))
    .register("github.fetchPullRequest", (ctx) => fetchPullRequest(deps, ctx))
    .register("security.scan", securityStepKind())
    .register("github.commentSecurity", (ctx) => commentSecurity(deps, ctx))
    .register("git.cloneRepo", (ctx) => cloneRepo(deps, ctx))
    .register("git.createBranch", (ctx) => createBranch(ctx))
    .register("git.checkoutBranch", (ctx) => checkoutPullRequestBranch(deps, ctx))
    .register("llm", llmStepKind(), { derivableKeys: llmDerivableKeys() })
    .register("llm.review", llmStepKind(undefined, deps.reviewModel), { derivableKeys: llmDerivableKeys() })
    .register("git.commitPush", (ctx) => commitPush(deps, ctx))
    .register("github.openPullRequest", (ctx) => openPullRequest(deps, ctx))
    .register("github.commentPr", (ctx) => commentPullRequest(deps, ctx))
    .register("github.commentUpdate", (ctx) => commentUpdate(deps, ctx))
    .register("github.closeIssue", (ctx) => closeIssue(deps, ctx));
}

async function fetchIssue(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const repo = str(ctx.inputs, "repo");
  const issueNumber = num(ctx.inputs, "issueNumber");
  const issue = await deps.client.getIssue(repo, issueNumber);
  const comments = await deps.client.listComments(repo, issueNumber);
  return { userPrompt: buildPrompt(issue.title, issue.body, comments) };
}

// Renders the issue and its whole comment thread into the user message the
// implement step prompts with: title + body, then every comment verbatim, each
// labeled with its author (a re-run reply lands here so the model sees the full
// conversation, including its own prior PR/error comments — that history is the
// point of a reply-triggered re-run).
export function buildPrompt(title: string, body: string, comments: IssueComment[]): string {
  if (typeof title !== "string" || title.trim() === "") throw new Error("[githubKinds.buildPrompt] title is required");
  if (!Array.isArray(comments)) throw new Error("[githubKinds.buildPrompt] comments must be an array");
  const trimmed = body.trim();
  const head = trimmed === "" ? `Title: ${title}` : `Title: ${title}\n\n${trimmed}`;
  if (comments.length === 0) return head;
  const thread = comments.map((c) => `@${c.author}: ${c.body.trim()}`).join("\n\n");
  return `${head}\n\n--- Comments ---\n\n${thread}`;
}

// GitHub models a PR as an issue, so the issue read APIs fetch the PR's title,
// description, and comment thread; buildPrompt renders them the same way it
// renders an issue, into the review step's user message.
async function fetchPullRequest(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const repo = str(ctx.inputs, "repo");
  const prNumber = num(ctx.inputs, "prNumber");
  const pr = await deps.client.getIssue(repo, prNumber);
  const comments = await deps.client.listComments(repo, prNumber);
  return { userPrompt: buildPrompt(pr.title, pr.body, comments) };
}

// Also returns the branch as newBranch so the reply job's commit/push step can
// consume it; the review job declares neither, so the extra key is dropped.
async function checkoutPullRequestBranch(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const branch = str(ctx.inputs, "prBranch");
  await git.checkoutBranch(str(ctx.inputs, "workingDirectory"), branch, deps.token);
  return { checkedOut: true, newBranch: branch };
}

async function cloneRepo(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const repo = str(ctx.inputs, "repo");
  const baseDir = jobWorkspace(deps.tempDir, str(ctx.inputs, "jobUuid"));
  const workingDirectory = await git.cloneRepo({ repo, token: deps.token, baseDir });
  const baseBranch = await deps.client.getDefaultBranch(repo);
  return { workingDirectory, baseBranch };
}

async function createBranch(ctx: StepContext): Promise<StepValues> {
  const newBranch = branchName(num(ctx.inputs, "issueNumber"), str(ctx.inputs, "jobUuid"));
  await git.createBranch(str(ctx.inputs, "workingDirectory"), newBranch);
  return { newBranch };
}

// The PR branch: strappy/issue-<n>/<uuid stem>. Reuses the run id's UUID stem
// (git.uuidStem) so the branch ties back to its JobRun + clone workspace by eye,
// and stays unique across re-runs of the same issue — the issue number alone is
// not (a closed-and-reopened issue could collide).
export function branchName(issueNumber: number, jobUuid: string): string {
  if (!Number.isInteger(issueNumber)) throw new Error("[githubKinds.branchName] issueNumber must be an integer");
  return `strappy/issue-${issueNumber}/${git.uuidStem(jobUuid)}`;
}

async function commitPush(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const workingDirectory = str(ctx.inputs, "workingDirectory");
  const newBranch = str(ctx.inputs, "newBranch");
  await git.commitAll(workingDirectory, str(ctx.inputs, "commitMessage"), deps.committer);
  await git.pushBranch(workingDirectory, newBranch, deps.token);
  return { pushed: true };
}

async function openPullRequest(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const n = num(ctx.inputs, "issueNumber");
  const pr = await deps.client.openPullRequest({
    repo: str(ctx.inputs, "repo"),
    head: str(ctx.inputs, "newBranch"),
    base: str(ctx.inputs, "baseBranch"),
    title: prTitle(str(ctx.inputs, "pullRequestTitle"), n),
    body: prBody(str(ctx.inputs, "pullRequestSummary"), n, {
      model: str(ctx.inputs, "model"),
      cost: num(ctx.inputs, "cost"),
      inputTokens: num(ctx.inputs, "inputTokens"),
      outputTokens: num(ctx.inputs, "outputTokens"),
    }),
  });
  return { prNumber: pr.number, prUrl: pr.url };
}

// Pi's reported spend for the implementation step, rendered into the PR footer.
export interface PrUsage {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

// "Strappy: <model-authored title> (#n)": keeps the bot prefix and the issue
// link for traceability, but the body of the title now describes the change.
export function prTitle(modelTitle: string, issueNumber: number): string {
  if (typeof modelTitle !== "string" || modelTitle.trim() === "") throw new Error("[githubKinds.prTitle] modelTitle is required");
  if (!Number.isFinite(issueNumber)) throw new Error("[githubKinds.prTitle] issueNumber must be a number");
  return `Strappy: ${modelTitle.trim()} (#${issueNumber})`;
}

// The model's summary, an explicit issue reference for GitHub's native
// cross-linking, then a footer carrying the real LLM spend Pi reported.
export function prBody(summary: string, issueNumber: number, usage: PrUsage): string {
  if (typeof summary !== "string" || summary.trim() === "") throw new Error("[githubKinds.prBody] summary is required");
  if (!Number.isInteger(issueNumber)) throw new Error("[githubKinds.prBody] issueNumber must be an integer");
  return `${summary.trim()}\n\nRefs #${issueNumber}\n\n${usageFooter(usage)}`;
}

// The review model's comment, posted on the PR under a bold heading (our
// static-heading convention) and over the same spend footer the PR body uses —
// here it reports the REVIEW model's cost, not the implement step's.
export function reviewBody(comment: string, usage: PrUsage): string {
  if (typeof comment !== "string" || comment.trim() === "") throw new Error("[githubKinds.reviewBody] comment is required");
  return `**🔍 Strappy code review**\n\n${comment.trim()}\n\n${usageFooter(usage)}`;
}

// The implement model's own account of the update it just pushed, posted as the
// PR reply that closes the loop on a comment-triggered run; same spend footer.
export function updateBody(summary: string, usage: PrUsage): string {
  if (typeof summary !== "string" || summary.trim() === "") throw new Error("[githubKinds.updateBody] summary is required");
  return `**🔧 Strappy pushed an update**\n\n${summary.trim()}\n\n${usageFooter(usage)}`;
}

// The prompt-check verdict comment: a bold "Prompt Check Passed/Failed" heading
// (our static-heading convention — bold, not a `#` heading), a horizontal rule,
// then the guard model's own voiced reason as pure markdown (it renders — no code
// fence or blockquote around it). Shared by both outcomes: the safe path posts it
// from the comment step (passed = true); the unsafe path posts it from the poller
// (passed = false), since the security step throws to fail closed.
export function promptCheckComment(passed: boolean, reason: string): string {
  if (typeof passed !== "boolean") throw new Error("[githubKinds.promptCheckComment] passed must be a boolean");
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("[githubKinds.promptCheckComment] reason is required");
  }
  const heading = passed ? "✅ Prompt Check Passed" : "🚫 Prompt Check Failed";
  return `**${heading}**\n\n---\n\n${reason.trim()}`;
}

function usageFooter(usage: PrUsage): string {
  const tokens = `${tokenCount(usage.inputTokens)} in / ${tokenCount(usage.outputTokens)} out tokens`;
  return `---\n🤖 Strappy · ${usage.model}\nLLM cost: ${money(usage.cost)} · ${tokens}`;
}

function money(cost: number): string {
  if (!Number.isFinite(cost)) throw new Error("[githubKinds.money] cost must be a number");
  return `$${cost.toFixed(4)}`;
}

function tokenCount(tokens: number): string {
  if (!Number.isInteger(tokens)) throw new Error("[githubKinds.tokenCount] tokens must be an integer");
  return tokens.toLocaleString("en-US");
}

// Posts the review model's comment on the PR. GitHub models a PR as an issue, so
// commentOnIssue(repo, prNumber, …) adds a normal PR conversation comment.
async function commentPullRequest(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const commentId = await deps.client.commentOnIssue(
    str(ctx.inputs, "repo"),
    num(ctx.inputs, "prNumber"),
    reviewBody(str(ctx.inputs, "reviewComment"), {
      model: str(ctx.inputs, "model"),
      cost: num(ctx.inputs, "cost"),
      inputTokens: num(ctx.inputs, "inputTokens"),
      outputTokens: num(ctx.inputs, "outputTokens"),
    }),
  );
  return { commentId };
}

// Posts the "Prompt Check Passed" verdict on the issue or PR once it clears.
// Only reached on the safe path — an unsafe verdict throws in the security step,
// and the poller posts the matching "Prompt Check Failed" comment instead.
async function commentSecurity(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const commentId = await deps.client.commentOnIssue(
    str(ctx.inputs, "repo"),
    targetNumber(ctx.inputs),
    promptCheckComment(true, str(ctx.inputs, "securityReason")),
  );
  return { commentId };
}

// The comment target: the issue job seeds issueNumber, the PR jobs seed prNumber
// (a PR is an issue to the comment API, so both post the same way).
function targetNumber(inputs: StepValues): number {
  return num(inputs, inputs["prNumber"] !== undefined ? "prNumber" : "issueNumber");
}

// Posts the pushed-update summary as a PR reply (commentOnIssue serves PRs too).
async function commentUpdate(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const commentId = await deps.client.commentOnIssue(
    str(ctx.inputs, "repo"),
    num(ctx.inputs, "prNumber"),
    updateBody(str(ctx.inputs, "updateSummary"), {
      model: str(ctx.inputs, "model"),
      cost: num(ctx.inputs, "cost"),
      inputTokens: num(ctx.inputs, "inputTokens"),
      outputTokens: num(ctx.inputs, "outputTokens"),
    }),
  );
  return { commentId };
}

async function closeIssue(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  await deps.client.closeIssue(str(ctx.inputs, "repo"), num(ctx.inputs, "issueNumber"));
  return { closed: true };
}

function str(inputs: StepValues, key: string): string {
  const v = inputs[key];
  if (typeof v !== "string" || v === "") throw new Error(`[githubKinds] expected non-empty string input "${key}"`);
  return v;
}

function num(inputs: StepValues, key: string): number {
  const v = inputs[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`[githubKinds] expected number input "${key}"`);
  return v;
}

function validateDeps(deps: GitHubKindDeps): void {
  if (!deps || !deps.client) throw new Error("[githubKinds] client is required");
  if (typeof deps.token !== "string" || deps.token === "") throw new Error("[githubKinds] token is required");
  if (typeof deps.tempDir !== "string" || deps.tempDir === "") throw new Error("[githubKinds] tempDir is required");
  if (!deps.committer) throw new Error("[githubKinds] committer is required");
  if (typeof deps.reviewModel !== "string" || deps.reviewModel === "") throw new Error("[githubKinds] reviewModel is required");
}
