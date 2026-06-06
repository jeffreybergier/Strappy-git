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
  const baseDir = path.join(deps.tempDir, "jobs", str(ctx.inputs, "jobUuid"));
  const workingDirectory = await git.cloneRepo({ repo, token: deps.token, baseDir });
  const baseBranch = await deps.client.getDefaultBranch(repo);
  return { workingDirectory, baseBranch };
}

async function createBranch(ctx: StepContext): Promise<StepValues> {
  const newBranch = `strappy/issue-${num(ctx.inputs, "issueNumber")}`;
  await git.createBranch(str(ctx.inputs, "workingDirectory"), newBranch);
  return { newBranch };
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
    title: `Strappy: issue #${n}`,
    body: str(ctx.inputs, "pullRequestSummary"),
  });
  return { prNumber: pr.number, prUrl: pr.url };
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
