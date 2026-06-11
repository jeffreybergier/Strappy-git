import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, seedDatabase } from "../jobs/db.js";
import { SqliteJobStore } from "../jobs/sqliteStore.js";
import { seedJobs, seedRuns } from "../jobs/seed.js";
import type { GitHubClient } from "../github/client.js";
import type { JobRun, RunStatus } from "../jobs/types.js";
import { retryRun } from "./api.js";

function freshStore(): SqliteJobStore {
  const db = openDatabase(":memory:");
  seedDatabase(db, seedJobs(), seedRuns());
  return new SqliteJobStore(db);
}

function run(id: string, jobId: string, status: RunStatus): JobRun {
  return { id, jobId, status, startedAt: "2026-06-11T00:00:00.000Z", stepRuns: [] };
}

// Only reopenIssue matters to retry; everything else throws if reached.
function fakeClient(reopened: Array<{ repo: string; issueNumber: number }>, fail = false): GitHubClient {
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
    commentOnIssue: reject,
    closeIssue: reject,
    reopenIssue: async (repo, issueNumber) => {
      if (fail) throw new Error("reopen rejected");
      reopened.push({ repo, issueNumber });
    },
  };
}

test("retryRun releases the claim and reopens the issue for a failed issue run", async () => {
  const store = freshStore();
  store.recordRun(run("r1", "process-issue", "failed"));
  store.markProcessing("o/r", 5, "r1", 0);
  const reopened: Array<{ repo: string; issueNumber: number }> = [];
  const result = await retryRun(store, { admin: store, client: fakeClient(reopened) }, "r1");
  assert.equal(result.status, 200);
  assert.equal(result.body.reopened, true);
  assert.deepEqual(reopened, [{ repo: "o/r", issueNumber: 5 }]);
  assert.equal(store.isProcessed("o/r", 5), false); // claim gone -> poller re-fires
});

test("retryRun works for an interrupted run", async () => {
  const store = freshStore();
  store.recordRun(run("r2", "process-issue", "interrupted"));
  store.markProcessing("o/r", 6, "r2", 0);
  const result = await retryRun(store, { admin: store }, "r2");
  assert.equal(result.status, 200);
  assert.equal(store.isProcessed("o/r", 6), false);
});

test("retryRun does not reopen for a PR-subject job", async () => {
  const store = freshStore();
  store.recordRun(run("r3", "process-pull-request-comment", "failed"));
  store.markProcessing("o/r", 7, "r3", 9);
  const reopened: Array<{ repo: string; issueNumber: number }> = [];
  const result = await retryRun(store, { admin: store, client: fakeClient(reopened) }, "r3");
  assert.equal(result.status, 200);
  assert.equal(result.body.reopened, false);
  assert.equal(reopened.length, 0);
  assert.equal(store.isProcessed("o/r", 7), false);
});

test("retryRun without a client still releases the claim (reopened: false)", async () => {
  const store = freshStore();
  store.recordRun(run("r4", "process-issue", "failed"));
  store.markProcessing("o/r", 8, "r4", 0);
  const result = await retryRun(store, { admin: store }, "r4");
  assert.equal(result.status, 200);
  assert.equal(result.body.reopened, false);
  assert.equal(store.isProcessed("o/r", 8), false);
});

test("a reopen failure does not undo the release", async () => {
  const store = freshStore();
  store.recordRun(run("r5", "process-issue", "failed"));
  store.markProcessing("o/r", 9, "r5", 0);
  const result = await retryRun(store, { admin: store, client: fakeClient([], true) }, "r5");
  assert.equal(result.status, 200);
  assert.equal(result.body.reopened, false);
  assert.equal(store.isProcessed("o/r", 9), false);
});

test("retryRun rejects a run that is not failed or interrupted", async () => {
  const store = freshStore();
  store.recordRun(run("r6", "process-issue", "succeeded"));
  store.markProcessing("o/r", 10, "r6", 0);
  const result = await retryRun(store, { admin: store }, "r6");
  assert.equal(result.status, 409);
  assert.equal(store.isProcessed("o/r", 10), true); // claim untouched
});

test("retryRun rejects a run with no trigger claim", async () => {
  const store = freshStore();
  store.recordRun(run("r7", "process-issue", "failed"));
  const result = await retryRun(store, { admin: store }, "r7");
  assert.equal(result.status, 409);
});

test("retryRun rejects a superseded claim (a newer run owns the ledger row)", async () => {
  const store = freshStore();
  store.recordRun(run("old", "process-issue", "failed"));
  store.markProcessing("o/r", 11, "old", 0);
  store.markProcessing("o/r", 11, "new", 5); // newer run took over the row
  const result = await retryRun(store, { admin: store }, "old");
  assert.equal(result.status, 409);
  assert.equal(store.isProcessed("o/r", 11), true);
});

test("retryRun handles an unknown id and a missing id", async () => {
  const store = freshStore();
  assert.equal((await retryRun(store, { admin: store }, "nope")).status, 404);
  assert.equal((await retryRun(store, { admin: store }, undefined)).status, 400);
  assert.equal((await retryRun(store, { admin: store }, " ")).status, 400);
});
