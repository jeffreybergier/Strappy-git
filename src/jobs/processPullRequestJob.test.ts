import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "./scheduler.js";
import { defaultStepKinds } from "./stepKinds.js";
import { processPullRequestJob } from "./processPullRequestJob.js";
import { openDatabase } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";

const trigger = {
  repo: "owner/repo",
  prNumber: 12,
  prAuthor: "jeffreybergier",
  prBranch: "feature/retry",
  baseBranch: "release/1.2",
  jobUuid: "uuid-1",
};

test("processPullRequestJob runs end-to-end through stub kinds (no creds, no mutations)", async () => {
  const job = processPullRequestJob();
  const run = await runJob(job, trigger, { registry: defaultStepKinds() });
  assert.equal(run.status, "succeeded");
  assert.equal(run.stepRuns.length, job.steps.length);
  assert.ok(run.stepRuns.every((s) => s.status === "succeeded"));
});

test("processPullRequestJob persists to SQLite and records its run", async () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = processPullRequestJob();
  store.saveJob(job);
  assert.deepEqual(store.getJob("process-pull-request"), job);
  const run = await runJob(job, trigger, {
    registry: defaultStepKinds(),
    store,
    newRunId: () => "run-pr",
  });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(store.listRuns().find((r) => r.id === "run-pr"), run);
});

test("processPullRequestJob addresses its failure handler by prNumber", () => {
  const handler = processPullRequestJob().failureHandler;
  const byKey = Object.fromEntries(handler.inputs.map((io) => [io.key, io]));
  assert.equal(byKey["prNumber"]?.source, "trigger");
  assert.equal(byKey["prNumber"]?.type, "number");
  assert.equal(byKey["issueNumber"], undefined);
});

test("processPullRequestJob marks the review comment as failure-feeding", () => {
  const job = processPullRequestJob();
  const review = job.steps.find((s) => s.id === "review");
  assert.equal(review?.outputs.find((io) => io.key === "reviewComment")?.feedsFailure, true);
});
