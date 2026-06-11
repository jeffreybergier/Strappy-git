import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logger.js";
import { parseRepo } from "./client.js";

const log = createLogger("Git");
const exec = promisify(execFile);

export interface CloneInput {
  repo: string;
  token: string;
  baseDir: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

// Auth via a per-command header (base64 "x-access-token:<token>") so the token
// is never written into the cloned repo's .git/config, only passed to git for
// the single clone/push invocation.
function authHeader(token: string): string {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `http.extraHeader=AUTHORIZATION: basic ${basic}`;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s !== "") out = out.split(s).join("***");
  return out;
}

// Throws a redacted error so a leaked token can't reach scheduler logs or a
// persisted StepRun.note. Logs only the git subcommand, never full args.
async function runGit(args: string[], opts: { cwd?: string; secrets?: string[] } = {}): Promise<string> {
  if (!Array.isArray(args) || args.length === 0) throw new Error("[Git.runGit] args are required");
  const secrets = opts.secrets ?? [];
  try {
    const { stdout } = await exec("git", args, opts.cwd ? { cwd: opts.cwd } : {});
    return stdout.trim();
  } catch (error) {
    const sub = args.find((a) => !a.startsWith("-")) ?? "?";
    const message = redact(error instanceof Error ? error.message : String(error), secrets);
    log.error("runGit", `git ${sub} failed: ${message}`);
    throw new Error(`[Git.runGit] git ${sub} failed: ${message}`);
  }
}

export async function cloneRepo(input: CloneInput): Promise<string> {
  const { name } = parseRepo(input.repo);
  const dest = path.join(input.baseDir, name);
  await fs.mkdir(input.baseDir, { recursive: true });
  const header = authHeader(input.token);
  const url = `https://github.com/${input.repo}.git`;
  const secrets = [input.token, header];
  await runGit(["-c", header, "clone", "--depth", "1", url, dest], { secrets });
  // Init only direct submodules (non-recursive: no nested submodules) and keep
  // them shallow. The -c header reaches submodule fetches via GIT_CONFIG_PARAMETERS;
  // a submodule failure throws here, failing the job.
  await runGit(["-C", dest, "-c", header, "submodule", "update", "--init", "--depth", "1"], { secrets });
  log.info("cloneRepo", `cloned ${input.repo} -> ${dest}`);
  return dest;
}

// Best-effort recursive remove (force: a missing dir is not an error), used to
// tear down a run's clone workspace. Caller wraps it so a teardown failure never
// fails the run.
export async function removeDir(dir: string): Promise<void> {
  if (typeof dir !== "string" || dir === "") throw new Error("[Git.removeDir] dir is required");
  await fs.rm(dir, { recursive: true, force: true });
  log.info("removeDir", `removed ${dir}`);
}

// First segment of a per-run UUID ("8e6e2f89-…" -> "8e6e2f89"): the short,
// collision-proof stem shared by the run id (Poller.formatRunId) and the branch
// name (githubKinds.branchName), so a branch always carries the same handle as
// its JobRun and clone workspace.
export function uuidStem(jobUuid: string): string {
  if (typeof jobUuid !== "string" || jobUuid.trim() === "") {
    throw new Error("[Git.uuidStem] jobUuid must be a non-empty string");
  }
  return jobUuid.split("-")[0] ?? jobUuid;
}

// The clone is shallow AND single-branch (--depth 1 implies --single-branch), so
// a PR's base and head branches may not be in the clone. Fetch the real PR base
// into origin/<base>, point origin/HEAD at it, then fetch and check out the head.
// The review/update diff stays stable as origin/HEAD..HEAD even for PRs whose
// base is not the repo default branch.
export async function checkoutBranch(workdir: string, branch: string, baseBranch: string, token: string): Promise<void> {
  if (typeof branch !== "string" || branch.trim() === "") throw new Error("[Git.checkoutBranch] branch is required");
  if (typeof baseBranch !== "string" || baseBranch.trim() === "") throw new Error("[Git.checkoutBranch] baseBranch is required");
  const header = authHeader(token);
  await runGit([
    "-C", workdir, "-c", header, "fetch", "--depth", "1", "origin",
    `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ], { secrets: [token, header] });
  await runGit(["-C", workdir, "remote", "set-head", "origin", baseBranch]);
  await runGit(["-C", workdir, "-c", header, "fetch", "--depth", "1", "origin", branch], { secrets: [token, header] });
  await runGit(["-C", workdir, "checkout", "-b", branch, "FETCH_HEAD"]);
  log.info("checkoutBranch", `checked out ${branch} against ${baseBranch}`);
}

export async function createBranch(workdir: string, branch: string): Promise<void> {
  await runGit(["-C", workdir, "checkout", "-b", branch]);
  log.info("createBranch", `created ${branch}`);
}

// True when the working tree differs from HEAD (staged, unstaged, or untracked).
// The commit/push step keys off this: a clean tree after the update model ran
// means it decided no changes were needed, which is a sanctioned outcome.
export async function hasChanges(workdir: string): Promise<boolean> {
  if (typeof workdir !== "string" || workdir === "") throw new Error("[Git.hasChanges] workdir is required");
  const status = await runGit(["-C", workdir, "status", "--porcelain"]);
  return status !== "";
}

// Capped so one lockfile churn can't bloat the persisted StepRun row or the
// dashboard's /api/runs payload.
const MAX_DIFF_CHARS = 200_000;

function capDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated (${diff.length} chars)`;
}

// Returns the staged diff, captured between add and commit — the only point
// where untracked files are visible to `git diff`. Recorded on the run as the
// commit/push step's "diff" receipt.
export async function commitAll(workdir: string, message: string, identity: CommitIdentity): Promise<string> {
  await runGit(["-C", workdir, "add", "-A"]);
  const diff = await runGit(["-C", workdir, "diff", "--cached"]);
  await runGit([
    "-C", workdir,
    "-c", `user.name=${identity.name}`,
    "-c", `user.email=${identity.email}`,
    "commit", "-m", message,
  ]);
  log.info("commitAll", "committed staged changes");
  return capDiff(diff);
}

export async function pushBranch(workdir: string, branch: string, token: string): Promise<void> {
  const header = authHeader(token);
  await runGit(["-C", workdir, "-c", header, "push", "origin", branch], { secrets: [token, header] });
  log.info("pushBranch", `pushed ${branch}`);
}
