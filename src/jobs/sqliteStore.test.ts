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
  const job = store.getJob("triage-issue");
  assert.equal(job?.id, "triage-issue");
  assert.deepEqual(job, seedJobs().find((j) => j.id === "triage-issue"));
});

test("getJob returns null when absent", () => {
  const store = freshStore();
  assert.equal(store.getJob("does-not-exist"), null);
});

test("getJob throws on a non-string id", () => {
  const store = freshStore();
  assert.throws(() => store.getJob(123 as never), /id must be a string/);
});

test("listRuns preserves step runs, statuses and optional notes", () => {
  const store = freshStore();
  const runs = store.listRuns();
  assert.equal(runs.length, seedRuns().length);
  const failed = runs.find((r) => r.id === "run-1003");
  assert.equal(failed?.stepRuns.find((s) => s.stepId === "classify")?.note, "OpenRouter rate limit");
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

test("constructor rejects a missing db", () => {
  assert.throws(() => new SqliteJobStore(undefined as never), /db is required/);
});
