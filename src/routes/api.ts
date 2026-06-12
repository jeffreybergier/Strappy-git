import { Router } from "express";
import { createLogger } from "../logger.js";
import type { JobReadStore, TriggerAdmin } from "../jobs/store.js";
import type { GitHubClient } from "../github/client.js";
import type { JobRun } from "../jobs/types.js";
import type { RunEventStream } from "./runEvents.js";

const log = createLogger("Api");

// What the retry endpoint needs beyond the read store: the ledger admin surface
// to release a claim, and (optionally) a GitHub client to reopen a closed issue.
export interface RetryDeps {
  admin: TriggerAdmin;
  client?: GitHubClient;
}

export interface RetryResult {
  status: number;
  body: Record<string, unknown>;
}

// Releases a failed/interrupted run's trigger claim so the poller re-fires it on
// the next tick. For an issue-subject job the issue is also reopened (a failed
// one-shot run closed it as not planned, and only open issues are polled);
// reopening is best-effort — the claim is already released either way.
export async function retryRun(store: JobReadStore, deps: RetryDeps, runId: unknown): Promise<RetryResult> {
  if (!store) throw new Error("[Api.retryRun] store is required");
  if (!deps || !deps.admin) throw new Error("[Api.retryRun] deps.admin is required");
  if (typeof runId !== "string" || runId.trim() === "") {
    return { status: 400, body: { error: "query parameter id is required" } };
  }
  const run = store.listRuns().find((r) => r.id === runId);
  if (run === undefined) return { status: 404, body: { error: `run "${runId}" not found` } };
  if (run.status !== "failed" && run.status !== "interrupted") {
    return { status: 409, body: { error: `only a failed or interrupted run can be retried (run is ${run.status})` } };
  }
  const trigger = deps.admin.runTrigger(run.id);
  if (trigger === null) {
    return { status: 409, body: { error: "run holds no trigger claim (not poller-started, or superseded by a newer run)" } };
  }
  deps.admin.releaseTrigger(trigger.repo, trigger.issueNumber);
  const reopened = await maybeReopen(store, deps, run, trigger.repo, trigger.issueNumber);
  log.info("retryRun", `released ${trigger.repo}#${trigger.issueNumber} for ${run.id} (reopened: ${reopened})`);
  return {
    status: 200,
    body: {
      retried: run.id,
      repo: trigger.repo,
      number: trigger.issueNumber,
      reopened,
      note: "trigger released; the poller re-runs it on the next tick",
    },
  };
}

// Only an issue-subject job needs (or should get) a reopen: a PR-subject run's
// thread is the PR itself, which the failure path never closes.
async function maybeReopen(store: JobReadStore, deps: RetryDeps, run: JobRun, repo: string, issueNumber: number): Promise<boolean> {
  if (deps.client === undefined) return false;
  if (store.getJob(run.jobId)?.trigger.subject !== "issue") return false;
  try {
    await deps.client.reopenIssue(repo, issueNumber);
    return true;
  } catch (error) {
    log.error("retryRun", `could not reopen ${repo}#${issueNumber}`, error);
    return false;
  }
}

// retry is wired only when a TriggerAdmin-capable store backs the server (the
// SQLite store); without it the endpoint reports itself unavailable.
export function apiRouter(store: JobReadStore, retry?: RetryDeps, events?: RunEventStream): Router {
  if (!store) throw new Error("[apiRouter] store is required");
  const router = Router();
  router.get("/jobs", (_req, res) => {
    res.json(store.listJobs());
  });
  if (events !== undefined) {
    router.get("/runs/events", (req, res) => events.subscribe(req, res));
  }
  router.get("/runs", (_req, res) => {
    res.json(store.listRuns());
  });
  router.get("/jobs/:id", (req, res) => {
    const job = store.getJob(req.params.id);
    if (job === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(job);
  });
  // POST with the run id as a query parameter: run ids contain "/" and "#"
  // (owner/name#42/process-issue/abc), which a path parameter cannot carry.
  router.post("/runs/retry", (req, res) => {
    if (retry === undefined) {
      res.status(503).json({ error: "retry unavailable: server is not backed by a trigger ledger" });
      return;
    }
    retryRun(store, retry, req.query.id)
      .then((result) => res.status(result.status).json(result.body))
      .catch((error: unknown) => {
        log.error("retry", "failed", error);
        res.status(500).json({ error: "retry failed; see server log" });
      });
  });
  return router;
}
