import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "./scheduler.js";
import { defaultStepKinds } from "./stepKinds.js";
import { processPullRequestCommentJob } from "./processPullRequestCommentJob.js";
import { openDatabase } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";

const trigger = {
  repo: "owner/repo",
  prNumber: 21,
  prAuthor: "coworker",
  prBranch: "strappy/issue-3/8e6e2f89",
  baseBranch: "release/1.2",
  jobUuid: "uuid-1",
};

test("processPullRequestCommentJob runs end-to-end through stub kinds (no creds, no mutations)", async () => {
  const job = processPullRequestCommentJob();
  const run = await runJob(job, trigger, { registry: defaultStepKinds() });
  assert.equal(run.status, "succeeded");
  assert.equal(run.stepRuns.length, job.steps.length);
  assert.ok(run.stepRuns.every((s) => s.status === "succeeded"));
});

test("processPullRequestCommentJob threads the PR head branch into the commit/push step", async () => {
  const run = await runJob(processPullRequestCommentJob(), trigger, { registry: defaultStepKinds() });
  const push = run.stepRuns.find((s) => s.stepId === "commit-push");
  assert.equal(push?.inputs?.["newBranch"], "<checkout-branch.newBranch>", "newBranch flows checkout -> update -> push");
});

test("processPullRequestCommentJob persists to SQLite and records its run", async () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = processPullRequestCommentJob();
  store.saveJob(job);
  assert.deepEqual(store.getJob("process-pull-request-comment"), job);
  const run = await runJob(job, trigger, {
    registry: defaultStepKinds(),
    store,
    newRunId: () => "run-pr-reply",
  });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(store.listRuns().find((r) => r.id === "run-pr-reply"), run);
});

test("processPullRequestCommentJob threads the pushed flag from commit-push into the reply step", () => {
  const job = processPullRequestCommentJob();
  const push = job.steps.find((s) => s.id === "commit-push");
  assert.equal(push?.outputs.find((io) => io.key === "pushed")?.source, "step", "pushed is consumable, not a terminal receipt");
  assert.equal(push?.outputs.find((io) => io.key === "diff")?.source, "receipt", "the diff is recorded for the dashboard, never consumed");
  const reply = job.steps.find((s) => s.id === "comment-update");
  const input = reply?.inputs.find((io) => io.key === "pushed");
  assert.equal(input?.source, "step");
  assert.equal(input?.type, "boolean");
});

test("processPullRequestCommentJob addresses its failure handler by prNumber", () => {
  const handler = processPullRequestCommentJob().failureHandler;
  const byKey = Object.fromEntries(handler.inputs.map((io) => [io.key, io]));
  assert.equal(byKey["prNumber"]?.source, "trigger");
  assert.equal(byKey["prNumber"]?.type, "number");
  assert.equal(byKey["issueNumber"], undefined);
});

test("processPullRequestCommentJob marks the update summary as failure-feeding", () => {
  const job = processPullRequestCommentJob();
  const update = job.steps.find((s) => s.id === "update-pr");
  assert.equal(update?.outputs.find((io) => io.key === "updateSummary")?.feedsFailure, true);
});

test("processPullRequestCommentJob gates at security BEFORE any repo work", () => {
  const ids = processPullRequestCommentJob().steps.map((s) => s.id);
  assert.ok(ids.indexOf("security-scan") < ids.indexOf("clone-repo"), "the scan must precede the clone");
});
