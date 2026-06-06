import fs from "node:fs/promises";
import path from "node:path";
import { StepKindRegistry } from "./stepKinds.js";
import type { StepContext, StepValues } from "./stepKinds.js";
import type { GitHubClient } from "../github/client.js";
import * as git from "../github/git.js";

export interface GitHubKindDeps {
  client: GitHubClient;
  token: string;
  tempDir: string;
  committer: { name: string; email: string };
}

// Live registry for processIssueJob: the same kind keys defaultStepKinds() stubs,
// but each backed by a real git/GitHub action. Inputs are read off ctx (threaded
// by the scheduler); outputs feed the next step.
export function githubStepKinds(deps: GitHubKindDeps): StepKindRegistry {
  validateDeps(deps);
  return new StepKindRegistry()
    .register("github.fetchIssue", (ctx) => fetchIssue(deps, ctx))
    .register("git.cloneRepo", (ctx) => cloneRepo(deps, ctx))
    .register("git.createBranch", (ctx) => createBranch(ctx))
    .register("agent.applyChange", (ctx) => applyChange(ctx))
    .register("git.commitPush", (ctx) => commitPush(deps, ctx))
    .register("github.openPullRequest", (ctx) => openPullRequest(deps, ctx))
    .register("github.commentIssue", (ctx) => commentIssue(deps, ctx))
    .register("github.closeIssue", (ctx) => closeIssue(deps, ctx));
}

async function fetchIssue(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const issue = await deps.client.getIssue(str(ctx.inputs, "repo"), num(ctx.inputs, "issueNumber"));
  return { issueTitle: issue.title, issueBody: issue.body };
}

async function cloneRepo(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const repo = str(ctx.inputs, "repo");
  const baseDir = path.join(deps.tempDir, "jobs", str(ctx.inputs, "jobUuid"));
  const workdir = await git.cloneRepo({ repo, token: deps.token, baseDir });
  const baseBranch = await deps.client.getDefaultBranch(repo);
  return { workdir, baseBranch };
}

async function createBranch(ctx: StepContext): Promise<StepValues> {
  const branch = `strappy/issue-${num(ctx.inputs, "issueNumber")}`;
  await git.createBranch(str(ctx.inputs, "workdir"), branch);
  return { branch };
}

// Placeholder for the future LLM step: just touches an empty file so there is a
// change to commit. Swap this executor for one that calls runPrompt() later.
async function applyChange(ctx: StepContext): Promise<StepValues> {
  const n = num(ctx.inputs, "issueNumber");
  const changedPath = path.join(str(ctx.inputs, "workdir"), `STRAPPY-ISSUE-${n}.md`);
  await fs.writeFile(changedPath, "");
  return { changedPath };
}

async function commitPush(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const workdir = str(ctx.inputs, "workdir");
  const branch = str(ctx.inputs, "branch");
  await git.commitAll(workdir, `strappy: prepare ${branch}`, deps.committer);
  await git.pushBranch(workdir, branch, deps.token);
  return { pushed: true };
}

async function openPullRequest(deps: GitHubKindDeps, ctx: StepContext): Promise<StepValues> {
  const n = num(ctx.inputs, "issueNumber");
  const pr = await deps.client.openPullRequest({
    repo: str(ctx.inputs, "repo"),
    head: str(ctx.inputs, "branch"),
    base: str(ctx.inputs, "baseBranch"),
    title: `Strappy: issue #${n}`,
    body: `Automated PR opened by Strappy for #${n}.`,
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
