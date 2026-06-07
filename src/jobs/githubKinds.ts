import path from "node:path";
import { StepKindRegistry } from "./stepKinds.js";
import type { StepContext, StepValues } from "./stepKinds.js";
import { llmStepKind } from "./llmKind.js";
import type { GitHubClient } from "../github/client.js";
import * as git from "../github/git.js";

export interface GitHubKindDeps {
  client: GitHubClient;
  token: string;
  tempDir: string;
  committer: { name: string; email: string };
}

// Live registry for processIssueJob: the same kind keys defaultStepKinds() stubs,
// but each backed by a real git/GitHub/LLM action. Inputs are read off ctx
// (threaded by the scheduler); outputs feed the next step. The PR-flow kinds
// (createBranch/commitPush/...) stay registered for the follow-up even though the
// implement-only job does not reference them yet.
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
    .register("git.cloneRepo", (ctx) => cloneRepo(deps, ctx))
    .register("git.createBranch", (ctx) => createBranch(ctx))
    .register("llm", llmStepKind())
    .register("git.commitPush", (ctx) => commitPush(deps, ctx))
    .register("github.openPullRequest", (ctx) => openPullRequest(deps, ctx))
    .register("github.commentIssue", (ctx) => commentIssue(deps, ctx))
    .register("github.closeIssue", (ctx) => closeIssue(deps, ctx));
}

async function fetchIssue(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const issue = await deps.client.getIssue(str(ctx.inputs, "repo"), num(ctx.inputs, "issueNumber"));
  return { userPrompt: buildPrompt(issue.title, issue.body) };
}

// Renders the fetched issue into the user message the implement step prompts with.
function buildPrompt(title: string, body: string): string {
  const trimmed = body.trim();
  return trimmed === "" ? `Title: ${title}` : `Title: ${title}\n\n${trimmed}`;
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
    body: prBody(str(ctx.inputs, "pullRequestSummary"), {
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

// The model's summary, then a footer carrying the real LLM spend Pi reported
// (model, cost, token split) so a reviewer sees what the run cost.
export function prBody(summary: string, usage: PrUsage): string {
  if (typeof summary !== "string" || summary.trim() === "") throw new Error("[githubKinds.prBody] summary is required");
  return `${summary.trim()}\n\n${usageFooter(usage)}`;
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

async function commentIssue(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const prNumber = num(ctx.inputs, "prNumber");
  const commentId = await deps.client.commentOnIssue(
    str(ctx.inputs, "repo"),
    num(ctx.inputs, "issueNumber"),
    `Strappy opened #${prNumber} for this issue.`,
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
}
