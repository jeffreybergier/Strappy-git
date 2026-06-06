import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, seedDatabase } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";
import { seedJobs, seedRuns } from "./seed.js";
import type { Job, JobRun } from "./types.js";

function freshStore(): SqliteJobStore {
  const db = openDatabase(":memory:");
  seedDatabase(db, seedJobs(), seedRuns());
  return new SqliteJobStore(db);
}

test("seeded sqlite store exposes the seeded jobs", () => {
  const store = freshStore();
  assert.equal(store.listJobs().length, seedJobs().length);
});

test("getJob hydrates steps with ordered inputs and outputs", () => {
  const store = freshStore();
  const job = store.getJob("process-issue");
  assert.equal(job?.id, "process-issue");
  assert.deepEqual(job, seedJobs().find((j) => j.id === "process-issue"));
});

test("getJob returns null when absent", () => {
  const store = freshStore();
  assert.equal(store.getJob("does-not-exist"), null);
});

test("getJob throws on a non-string id", () => {
  const store = freshStore();
  assert.throws(() => store.getJob(123 as never), /id must be a string/);
});

test("seeded sqlite store starts with no runs", () => {
  assert.equal(freshStore().listRuns().length, 0);
  assert.equal(seedRuns().length, 0);
});

test("listRuns preserves step runs, statuses and optional notes", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob({ id: "j", name: "J", description: "d", trigger: "manual", steps: [] });
  const run: JobRun = {
    id: "run-note",
    jobId: "j",
    status: "failed",
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:02.000Z",
    stepRuns: [
      { stepId: "a", status: "succeeded" },
      { stepId: "b", status: "failed", note: "OpenRouter rate limit" },
      { stepId: "c", status: "skipped" },
    ],
  };
  store.recordRun(run);
  const runs = store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.stepRuns.find((s) => s.stepId === "b")?.note, "OpenRouter rate limit");
});

test("seedDatabase is idempotent (no duplicate rows on a second call)", () => {
  const db = openDatabase(":memory:");
  seedDatabase(db, seedJobs(), seedRuns());
  seedDatabase(db, seedJobs(), seedRuns());
  assert.equal(new SqliteJobStore(db).listJobs().length, seedJobs().length);
});

test("saveJob + getJob round-trips a new job with its IO contract", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job: Job = {
    id: "echo",
    name: "Echo",
    description: "Round-trip a single step.",
    trigger: "manual",
    steps: [
      {
        id: "say",
        kind: "noop",
        name: "Say",
        description: "Echo the input.",
        inputs: [{ key: "in", type: "string", description: "text in" }],
        outputs: [{ key: "out", type: "string", description: "text out" }],
      },
    ],
  };
  store.saveJob(job);
  assert.deepEqual(store.getJob("echo"), job);
});

test("recordRun + listRuns round-trips an execution", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob({ id: "j", name: "J", description: "d", trigger: "manual", steps: [] });
  const run: JobRun = {
    id: "r1",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:01.000Z",
    stepRuns: [{ stepId: "s", status: "succeeded" }],
  };
  store.recordRun(run);
  assert.deepEqual(store.listRuns(), [run]);
});

test("trigger ledger detects and records processed issues", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  assert.equal(store.isProcessed("o/r", 5), false);
  store.markProcessing("o/r", 5, "run-x");
  assert.equal(store.isProcessed("o/r", 5), true);
  assert.equal(store.isProcessed("o/r", 6), false);
  store.setStatus("o/r", 5, "done");
  assert.equal(store.isProcessed("o/r", 5), true);
});

test("constructor rejects a missing db", () => {
  assert.throws(() => new SqliteJobStore(undefined as never), /db is required/);
});
