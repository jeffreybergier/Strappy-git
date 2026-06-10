import { Octokit } from "@octokit/rest";
import { createLogger } from "../logger.js";

const log = createLogger("GitHub");

export interface IssueRef {
  repo: string;
  number: number;
  author: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface OpenPrInput {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

// One open pull request. `headRef` is the head branch name and `headRepo` the
// full name of the repo that branch lives in ("" when the head repo was
// deleted) — together they let the poller reject fork PRs before any work runs.
export interface PullRequestRef {
  repo: string;
  number: number;
  author: string;
  title: string;
  body: string;
  headRef: string;
  headRepo: string;
  createdAt: string;
}

// One issue comment. `id` is GitHub's monotonically-increasing comment id, used
// as the poller's re-trigger watermark; `author` gates whether it can trigger.
export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

// GitHub's two close reasons: "completed" (the default when omitted) for a
// resolved issue, "not_planned" for one given up on — the failure path uses it.
export type CloseReason = "completed" | "not_planned";

export interface GitHubClient {
  listAccessibleRepos(): Promise<string[]>;
  listOpenIssues(repo: string): Promise<IssueRef[]>;
  listOpenPullRequests(repo: string): Promise<PullRequestRef[]>;
  getIssue(repo: string, issueNumber: number): Promise<IssueRef>;
  listComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
  getDefaultBranch(repo: string): Promise<string>;
  listBranchRules(repo: string, branch: string): Promise<string[]>;
  openPullRequest(input: OpenPrInput): Promise<{ number: number; url: string }>;
  commentOnIssue(repo: string, issueNumber: number, body: string): Promise<number>;
  closeIssue(repo: string, issueNumber: number, reason?: CloseReason): Promise<void>;
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  const owner = match?.[1];
  const name = match?.[2];
  if (owner === undefined || name === undefined) {
    throw new Error(`[GitHub.parseRepo] repo must be "owner/name", got "${repo}"`);
  }
  return { owner, name };
}

export function createGitHubClient(token: string): GitHubClient {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("[GitHub.createGitHubClient] token is required");
  }
  const octokit = new Octokit({ auth: token });
  return {
    listAccessibleRepos: () => listAccessibleRepos(octokit),
    listOpenIssues: (repo) => listOpenIssues(octokit, repo),
    listOpenPullRequests: (repo) => listOpenPullRequests(octokit, repo),
    getIssue: (repo, n) => getIssue(octokit, repo, n),
    listComments: (repo, n) => listComments(octokit, repo, n),
    getDefaultBranch: (repo) => getDefaultBranch(octokit, repo),
    listBranchRules: (repo, branch) => listBranchRules(octokit, repo, branch),
    openPullRequest: (input) => openPullRequest(octokit, input),
    commentOnIssue: (repo, n, body) => commentOnIssue(octokit, repo, n, body),
    closeIssue: (repo, n, reason) => closeIssue(octokit, repo, n, reason),
  };
}

// The repos this token can act on: only those it can push to, since Strappy's
// job is to branch + open a PR. Paginates over all affiliations.
async function listAccessibleRepos(octokit: Octokit): Promise<string[]> {
  try {
    const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      per_page: 100,
      affiliation: "owner,collaborator,organization_member",
      sort: "pushed",
    });
    return repos.filter((r) => r.permissions?.push === true).map((r) => r.full_name);
  } catch (error) {
    log.error("listAccessibleRepos", "failed to list accessible repos", error);
    throw error;
  }
}

// listForRepo returns PRs too (GitHub models PRs as issues); pull_request is
// only present on PRs, so we drop them.
async function listOpenIssues(octokit: Octokit, repo: string): Promise<IssueRef[]> {
  const { owner, name } = parseRepo(repo);
  try {
    const res = await octokit.issues.listForRepo({
      owner, repo: name, state: "open", sort: "created", direction: "desc", per_page: 50,
    });
    return res.data.filter((i) => i.pull_request === undefined).map((i) => toIssueRef(repo, i));
  } catch (error) {
    log.error("listOpenIssues", `failed for ${repo}`, error);
    throw error;
  }
}

function toIssueRef(repo: string, i: { number: number; user: { login: string } | null; title: string; body?: string | null; created_at: string }): IssueRef {
  const author = i.user?.login;
  if (author === undefined) throw new Error(`[GitHub.toIssueRef] issue #${i.number} has no author`);
  return { repo, number: i.number, author, title: i.title, body: i.body ?? "", createdAt: i.created_at };
}

// Open PRs only; the same-repo (non-fork) policy is applied by the caller
// (poller.isReviewablePullRequest), so this stays a faithful API read.
async function listOpenPullRequests(octokit: Octokit, repo: string): Promise<PullRequestRef[]> {
  const { owner, name } = parseRepo(repo);
  try {
    const res = await octokit.pulls.list({
      owner, repo: name, state: "open", sort: "created", direction: "desc", per_page: 50,
    });
    return res.data.map((pr) => toPullRequestRef(repo, pr));
  } catch (error) {
    log.error("listOpenPullRequests", `failed for ${repo}`, error);
    throw error;
  }
}

function toPullRequestRef(
  repo: string,
  pr: { number: number; user: { login: string } | null; title: string; body?: string | null; created_at: string; head: { ref: string; repo: { full_name: string } | null } },
): PullRequestRef {
  const author = pr.user?.login;
  if (author === undefined) throw new Error(`[GitHub.toPullRequestRef] PR #${pr.number} has no author`);
  return {
    repo, number: pr.number, author, title: pr.title, body: pr.body ?? "",
    headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? "", createdAt: pr.created_at,
  };
}

async function getIssue(octokit: Octokit, repo: string, issueNumber: number): Promise<IssueRef> {
  const { owner, name } = parseRepo(repo);
  try {
    const res = await octokit.issues.get({ owner, repo: name, issue_number: issueNumber });
    return toIssueRef(repo, res.data);
  } catch (error) {
    log.error("getIssue", `failed for ${repo}#${issueNumber}`, error);
    throw error;
  }
}

// The full comment thread, oldest first (GitHub's default order), paginated so a
// long thread is complete. A comment with no author is dropped — it can neither
// trigger nor be attributed in the packaged prompt.
async function listComments(octokit: Octokit, repo: string, issueNumber: number): Promise<IssueComment[]> {
  const { owner, name } = parseRepo(repo);
  try {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner, repo: name, issue_number: issueNumber, per_page: 100,
    });
    return comments.filter((c) => c.user !== null && c.user !== undefined).map((c) => toComment(c));
  } catch (error) {
    log.error("listComments", `failed for ${repo}#${issueNumber}`, error);
    throw error;
  }
}

function toComment(c: { id: number; user: { login: string } | null; body?: string | null; created_at: string }): IssueComment {
  const author = c.user?.login;
  if (author === undefined) throw new Error(`[GitHub.toComment] comment ${c.id} has no author`);
  return { id: c.id, author, body: c.body ?? "", createdAt: c.created_at };
}

async function getDefaultBranch(octokit: Octokit, repo: string): Promise<string> {
  const { owner, name } = parseRepo(repo);
  try {
    const res = await octokit.repos.get({ owner, repo: name });
    return res.data.default_branch;
  } catch (error) {
    log.error("getDefaultBranch", `failed for ${repo}`, error);
    throw error;
  }
}

// The active ruleset rule types in effect on a branch (e.g. "pull_request"),
// merged across all Active rulesets that target it. Readable with plain read
// access — unlike classic branch protection, which needs repo admin. No
// logging here: the check is advisory, so the poller owns reporting (a 403 is
// routine for a private repo on a free plan and must not dump an error).
async function listBranchRules(octokit: Octokit, repo: string, branch: string): Promise<string[]> {
  const { owner, name } = parseRepo(repo);
  const res = await octokit.repos.getBranchRules({ owner, repo: name, branch, per_page: 100 });
  return res.data.map((r) => r.type);
}

async function openPullRequest(octokit: Octokit, input: OpenPrInput): Promise<{ number: number; url: string }> {
  const { owner, name } = parseRepo(input.repo);
  try {
    const res = await octokit.pulls.create({
      owner, repo: name, head: input.head, base: input.base, title: input.title, body: input.body,
    });
    return { number: res.data.number, url: res.data.html_url };
  } catch (error) {
    log.error("openPullRequest", `failed for ${input.repo}`, error);
    throw error;
  }
}

async function commentOnIssue(octokit: Octokit, repo: string, issueNumber: number, body: string): Promise<number> {
  const { owner, name } = parseRepo(repo);
  try {
    const res = await octokit.issues.createComment({ owner, repo: name, issue_number: issueNumber, body });
    return res.data.id;
  } catch (error) {
    log.error("commentOnIssue", `failed for ${repo}#${issueNumber}`, error);
    throw error;
  }
}

async function closeIssue(octokit: Octokit, repo: string, issueNumber: number, reason?: CloseReason): Promise<void> {
  const { owner, name } = parseRepo(repo);
  try {
    await octokit.issues.update({
      owner, repo: name, issue_number: issueNumber, state: "closed",
      ...(reason !== undefined && { state_reason: reason }),
    });
  } catch (error) {
    log.error("closeIssue", `failed for ${repo}#${issueNumber}`, error);
    throw error;
  }
}
