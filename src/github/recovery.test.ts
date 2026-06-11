import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, seedDatabase } from "../jobs/db.js";
import { SqliteJobStore } from "../jobs/sqliteStore.js";
import { seedJobs, seedRuns } from "../jobs/seed.js";
import type { GitHubClient } from "./client.js";
import type { JobRun } from "../jobs/types.js";
import { RETRY_EPILOGUE } from "./poller.js";
import {
  INTERRUPTED_STEP_NOTE,
  ONE_SHOT_INTERRUPTED_EPILOGUE,
  interruptedComment,
  markRunInterrupted,
  reconcileInterruptedRuns,
} from "./recovery.js";

const NOW = "2026-06-11T00:00:00.000Z";

function freshStore(): SqliteJobStore {
  const db = openDatabase(":memory:");
  seedDatabase(db, seedJobs(), seedRuns());
  return new SqliteJobStore(db);
}

interface PostedComment {
  repo: string;
  issueNumber: number;
  body: string;
}

// Only commentOnIssue matters to recovery; everything else throws if reached.
function fakeClient(posted: PostedComment[], fail = false): GitHubClient {
  const reject = (): never => {
    throw new Error("unexpected GitHub call");
  };
  return {
    listAccessibleRepos: reject,
    listOpenIssues: reject,
    listOpenPullRequests: reject,
    getIssue: reject,
    listComments: reject,
    getDefaultBranch: reject,
    listBranchRules: reject,
    openPullRequest: reject,
    commentOnIssue: async (repo, issueNumber, body) => {
      if (fail) throw new Error("comment rejected");
      posted.push({ repo, issueNumber, body });
      return posted.length;
    },
    closeIssue: reject,
    reopenIssue: reject,
  };
}

function orphanRun(id: string, jobId: string, status: "queued" | "running"): JobRun {
  return {
    id,
    jobId,
    status,
    startedAt: "2026-06-10T23:00:00.000Z",
    stepRuns: [
      { stepId: "fetch-issue", status: "succeeded", startedAt: "2026-06-10T23:00:00.000Z", finishedAt: "2026-06-10T23:00:01.000Z" },
      { stepId: "implement", status: status === "running" ? "running" : "pending", startedAt: "2026-06-10T23:00:01.000Z" },
      { stepId: "open-pr", status: "pending" },
    ],
  };
}

test("reconcile marks a running run interrupted, finishes its steps, and stamps the ledger", async () => {
  const store = freshStore();
  const run = orphanRun("o/r#1/process-issue/abc", "process-issue", "running");
  store.recordRun(run);
  store.markProcessing("o/r", 1, run.id, 0);
  const interrupted = await reconcileInterruptedRuns({ store, now: () => NOW });
  assert.equal(interrupted.length, 1);
  const persisted = store.listRuns().find((r) => r.id === run.id);
  assert.equal(persisted?.status, "interrupted");
  assert.equal(persisted?.finishedAt, NOW);
  assert.equal(persisted?.stepRuns[0]?.status, "succeeded"); // finished work is untouched
  assert.equal(persisted?.stepRuns[1]?.status, "interrupted");
  assert.equal(persisted?.stepRuns[1]?.note, INTERRUPTED_STEP_NOTE);
  assert.equal(persisted?.stepRuns[2]?.status, "skipped");
  assert.equal(store.runTrigger(run.id)?.status, "interrupted");
});

test("reconcile flips a queued run too, and leaves finished runs alone", async () => {
  const store = freshStore();
  store.recordRun(orphanRun("queued-run", "process-issue", "queued"));
  store.recordRun({ ...orphanRun("done-run", "process-issue", "running"), status: "succeeded", stepRuns: [] });
  store.recordRun({ ...orphanRun("failed-run", "process-issue", "running"), status: "failed", stepRuns: [] });
  const interrupted = await reconcileInterruptedRuns({ store, now: () => NOW });
  assert.deepEqual(interrupted.map((r) => r.id), ["queued-run"]);
  assert.equal(store.listRuns().find((r) => r.id === "done-run")?.status, "succeeded");
  assert.equal(store.listRuns().find((r) => r.id === "failed-run")?.status, "failed");
});

test("reconcile posts the interruption comment on the claimed thread", async () => {
  const store = freshStore();
  const run = orphanRun("o/r#7/process-issue/xyz", "process-issue", "running");
  store.recordRun(run);
  store.markProcessing("o/r", 7, run.id, 0);
  const posted: PostedComment[] = [];
  await reconcileInterruptedRuns({ store, client: fakeClient(posted), now: () => NOW });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.repo, "o/r");
  assert.equal(posted[0]?.issueNumber, 7);
  assert.match(posted[0]?.body ?? "", /Job interrupted/);
  assert.match(posted[0]?.body ?? "", /did not finish/);
});

test("a one-shot issue job gets the dashboard-retry epilogue; a PR job gets the reply-retry one", async () => {
  const store = freshStore();
  const issueRun = orphanRun("issue-run", "process-issue", "running");
  const prRun = orphanRun("pr-run", "process-pull-request-comment", "running");
  store.recordRun(issueRun);
  store.recordRun(prRun);
  store.markProcessing("o/r", 1, issueRun.id, 0);
  store.markProcessing("o/r", 2, prRun.id, 5);
  const posted: PostedComment[] = [];
  await reconcileInterruptedRuns({ store, client: fakeClient(posted), now: () => NOW });
  const issueBody = posted.find((p) => p.issueNumber === 1)?.body ?? "";
  const prBody = posted.find((p) => p.issueNumber === 2)?.body ?? "";
  assert.ok(issueBody.includes(ONE_SHOT_INTERRUPTED_EPILOGUE));
  assert.ok(prBody.includes(RETRY_EPILOGUE));
});

test("a run without a ledger row is marked but produces no comment", async () => {
  const store = freshStore();
  store.recordRun(orphanRun("manual-run", "process-issue", "running"));
  const posted: PostedComment[] = [];
  await reconcileInterruptedRuns({ store, client: fakeClient(posted), now: () => NOW });
  assert.equal(posted.length, 0);
  assert.equal(store.listRuns().find((r) => r.id === "manual-run")?.status, "interrupted");
});

test("without a client the run and ledger are still stamped", async () => {
  const store = freshStore();
  const run = orphanRun("no-client", "process-issue", "running");
  store.recordRun(run);
  store.markProcessing("o/r", 3, run.id, 0);
  await reconcileInterruptedRuns({ store, now: () => NOW });
  assert.equal(store.listRuns().find((r) => r.id === run.id)?.status, "interrupted");
  assert.equal(store.runTrigger(run.id)?.status, "interrupted");
});

test("a comment failure never blocks reconciliation", async () => {
  const store = freshStore();
  const run = orphanRun("flaky", "process-issue", "running");
  store.recordRun(run);
  store.markProcessing("o/r", 4, run.id, 0);
  await reconcileInterruptedRuns({ store, client: fakeClient([], true), now: () => NOW });
  assert.equal(store.listRuns().find((r) => r.id === run.id)?.status, "interrupted");
});

test("reconcile with nothing to do returns an empty list", async () => {
  assert.deepEqual(await reconcileInterruptedRuns({ store: freshStore() }), []);
});

test("a pushed-code receipt surfaces in the comment's state line", async () => {
  const store = freshStore();
  const run: JobRun = {
    id: "pushed-run",
    jobId: "process-issue",
    status: "running",
    startedAt: "2026-06-10T23:00:00.000Z",
    stepRuns: [
      { stepId: "commit-push", status: "succeeded", outputs: { pushed: true, newBranch: "strappy/issue-9" } },
      { stepId: "open-pr", status: "running", startedAt: "2026-06-10T23:01:00.000Z" },
    ],
  };
  store.recordRun(run);
  store.markProcessing("o/r", 9, run.id, 0);
  const posted: PostedComment[] = [];
  await reconcileInterruptedRuns({ store, client: fakeClient(posted), now: () => NOW });
  assert.match(posted[0]?.body ?? "", /Code was pushed to branch `strappy\/issue-9`/);
});

test("markRunInterrupted validates its arguments", () => {
  assert.throws(() => markRunInterrupted(null as never, NOW), /run must be a JobRun/);
  assert.throws(() => markRunInterrupted(orphanRun("x", "j", "running"), " "), /finishedAt/);
});

test("interruptedComment includes the model's summary only when one exists", () => {
  const withSummary = interruptedComment("run-1", "I was adding a flag.", RETRY_EPILOGUE, "No code was pushed.");
  assert.match(withSummary, /What the model was trying to do/);
  assert.match(withSummary, /I was adding a flag\./);
  const without = interruptedComment("run-1", null, RETRY_EPILOGUE, "No code was pushed.");
  assert.doesNotMatch(without, /What the model was trying to do/);
});

test("interruptedComment validates its arguments", () => {
  assert.throws(() => interruptedComment("", null, RETRY_EPILOGUE, "No code was pushed."), /runId/);
  assert.throws(() => interruptedComment("r", null, " ", "No code was pushed."), /epilogue/);
  assert.throws(() => interruptedComment("r", null, RETRY_EPILOGUE, " "), /stateLine/);
});
