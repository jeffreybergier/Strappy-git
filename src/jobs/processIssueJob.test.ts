import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "./scheduler.js";
import { defaultStepKinds } from "./stepKinds.js";
import { processIssueJob } from "./processIssueJob.js";
import { openDatabase } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";

const trigger = { repo: "owner/repo", issueNumber: 7, issueAuthor: "jeffreybergier", jobUuid: "uuid-1" };

test("processIssueJob runs end-to-end through stub kinds (no creds, no mutations)", async () => {
  const job = processIssueJob();
  const run = await runJob(job, trigger, { registry: defaultStepKinds() });
  assert.equal(run.status, "succeeded");
  assert.equal(run.stepRuns.length, job.steps.length);
  assert.ok(run.stepRuns.every((s) => s.status === "succeeded"));
});

test("processIssueJob persists to SQLite and records its run", async () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = processIssueJob();
  store.saveJob(job);
  assert.deepEqual(store.getJob("process-issue"), job);
  const run = await runJob(job, trigger, {
    registry: defaultStepKinds(),
    store,
    newRunId: () => "run-pi",
  });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(store.listRuns().find((r) => r.id === "run-pi"), run);
});
