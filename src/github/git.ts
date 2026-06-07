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
  await runGit(["-c", header, "clone", "--depth", "1", url, dest], { secrets: [input.token, header] });
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

export async function createBranch(workdir: string, branch: string): Promise<void> {
  await runGit(["-C", workdir, "checkout", "-b", branch]);
  log.info("createBranch", `created ${branch}`);
}

export async function commitAll(workdir: string, message: string, identity: CommitIdentity): Promise<void> {
  await runGit(["-C", workdir, "add", "-A"]);
  await runGit([
    "-C", workdir,
    "-c", `user.name=${identity.name}`,
    "-c", `user.email=${identity.email}`,
    "commit", "-m", message,
  ]);
  log.info("commitAll", "committed staged changes");
}

export async function pushBranch(workdir: string, branch: string, token: string): Promise<void> {
  const header = authHeader(token);
  await runGit(["-C", workdir, "-c", header, "push", "origin", branch], { secrets: [token, header] });
  log.info("pushBranch", `pushed ${branch}`);
}
