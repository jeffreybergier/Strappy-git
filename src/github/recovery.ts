import { createLogger } from "../logger.js";
import { attemptedSummary, failureOutputKeys, failureStateLine, RETRY_EPILOGUE } from "./poller.js";
import type { GitHubClient } from "./client.js";
import type { JobReadStore, JobWriteStore, TriggerAdmin, TriggerLedger } from "../jobs/store.js";
import type { Job, JobRun } from "../jobs/types.js";

const log = createLogger("Recovery");

// The poller claims a trigger BEFORE its run executes (at-most-once), so a
// server that dies mid-run leaves the run stuck at queued/running and its
// (repo, issue) claimed forever — silently never processed. This boot-time pass
// flips those orphans to the terminal "interrupted" status and reports the
// outcome on the thread. The ledger claim is deliberately KEPT: releasing it
// would auto-re-fire a run with unknown partial side effects. The manual retry
// endpoint (POST /api/runs/retry) is the explicit re-run path.

export const INTERRUPTED_STEP_NOTE = "interrupted: the server stopped while this step was running";

// For a one-shot issue job ("close-not-planned"): the issue stays open and
// claimed, so replies are inert — point the human at the explicit retry paths.
export const ONE_SHOT_INTERRUPTED_EPILOGUE =
  "This is an automatic report from the harness. The server was interrupted mid-run; this issue stays open, but replies here will not re-run the job. Retry the run from the Strappy dashboard, or open a new issue.";

export type RecoveryStore = JobReadStore & JobWriteStore & TriggerAdmin & Pick<TriggerLedger, "setStatus">;

export interface RecoveryDeps {
  store: RecoveryStore;
  // Without a client (no GitHub token) runs are still marked interrupted; only
  // the thread comment is skipped.
  client?: GitHubClient;
  now?: () => string;
}

// Returns the runs it interrupted (already persisted). Comment posting is
// best-effort per run — one unreachable thread never blocks the rest of boot.
export async function reconcileInterruptedRuns(deps: RecoveryDeps): Promise<JobRun[]> {
  if (!deps || !deps.store) throw new Error("[Recovery.reconcileInterruptedRuns] store is required");
  if (deps.now !== undefined && typeof deps.now !== "function") {
    throw new Error("[Recovery.reconcileInterruptedRuns] now must be a function");
  }
  const now = deps.now ?? isoNow;
  const orphans = deps.store.listRuns().filter((r) => r.status === "queued" || r.status === "running");
  if (orphans.length === 0) return [];
  log.warn("reconcile", `${orphans.length} run(s) were abandoned by a previous server process; marking interrupted`);
  for (const run of orphans) {
    markRunInterrupted(run, now());
    deps.store.recordRun(run);
    await reportInterruption(deps, run);
  }
  return orphans;
}

// Flips an abandoned run to its terminal record: the run and its mid-flight
// step become "interrupted" (the step keeps a note saying why), steps that
// never started become "skipped" — matching the shape a failed run leaves.
export function markRunInterrupted(run: JobRun, finishedAt: string): void {
  if (run === null || typeof run !== "object" || !Array.isArray(run.stepRuns)) {
    throw new Error("[Recovery.markRunInterrupted] run must be a JobRun");
  }
  if (typeof finishedAt !== "string" || finishedAt.trim() === "") {
    throw new Error("[Recovery.markRunInterrupted] finishedAt must be a non-empty string");
  }
  run.status = "interrupted";
  run.finishedAt = finishedAt;
  for (const step of run.stepRuns) {
    if (step.status === "running") {
      step.status = "interrupted";
      step.finishedAt = finishedAt;
      step.note = INTERRUPTED_STEP_NOTE;
    } else if (step.status === "pending") {
      step.status = "skipped";
    }
  }
}

// The thread comment for an interrupted run: same frame as the generic failure
// report (state line, run id, optional attributed model summary, epilogue) but
// honest about the cause — the job didn't fail, the server stopped.
export function interruptedComment(runId: string, summary: string | null, epilogue: string, stateLine: string): string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("[Recovery.interruptedComment] runId must be a non-empty string");
  }
  if (typeof epilogue !== "string" || epilogue.trim() === "") {
    throw new Error("[Recovery.interruptedComment] epilogue must be a non-empty string");
  }
  if (typeof stateLine !== "string" || stateLine.trim() === "") {
    throw new Error("[Recovery.interruptedComment] stateLine must be a non-empty string");
  }
  const lines = [
    "**⚠️ Job interrupted**",
    "",
    "---",
    "",
    `${stateLine.trim()} Run \`${runId}\` did not finish: the server stopped while it was queued or in progress.`,
  ];
  if (typeof summary === "string" && summary.trim() !== "") {
    lines.push("", "---", "", "**What the model was trying to do**", "", summary.trim());
  }
  lines.push("", epilogue.trim());
  return lines.join("\n");
}

// Stamp the ledger row and tell the thread. A run without a ledger row was not
// poller-started (seeded/manual), so there is no thread to address.
async function reportInterruption(deps: RecoveryDeps, run: JobRun): Promise<void> {
  const trigger = deps.store.runTrigger(run.id);
  if (trigger === null) {
    log.info("reconcile", `${run.id}: no ledger row (not poller-started); marked only`);
    return;
  }
  deps.store.setStatus(trigger.repo, trigger.issueNumber, run.id, "interrupted");
  if (deps.client === undefined) {
    log.warn("reconcile", `${run.id}: no GitHub client; skipping the interruption comment on ${trigger.repo}#${trigger.issueNumber}`);
    return;
  }
  const job = deps.store.getJob(run.jobId);
  const summary = job === null ? null : attemptedSummary(run, failureOutputKeys(job));
  const body = interruptedComment(run.id, summary, epilogueFor(job), failureStateLine(run));
  try {
    await deps.client.commentOnIssue(trigger.repo, trigger.issueNumber, body);
    log.info("reconcile", `${run.id}: reported interruption on ${trigger.repo}#${trigger.issueNumber}`);
  } catch (error) {
    log.error("reconcile", `${run.id}: could not comment on ${trigger.repo}#${trigger.issueNumber}`, error);
  }
}

function epilogueFor(job: Job | null): string {
  return job?.trigger.onFailure === "close-not-planned" ? ONE_SHOT_INTERRUPTED_EPILOGUE : RETRY_EPILOGUE;
}

function isoNow(): string {
  return new Date().toISOString();
}
