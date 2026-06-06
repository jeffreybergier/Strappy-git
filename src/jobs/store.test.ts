import { test } from "node:test";
import assert from "node:assert/strict";
import { JobStore } from "./store.js";

test("seeded store exposes jobs", () => {
  const store = JobStore.seeded();
  assert.ok(store.listJobs().length >= 1);
});

test("getJob returns the job when present", () => {
  const store = JobStore.seeded();
  const job = store.getJob("triage-issue");
  assert.equal(job?.id, "triage-issue");
});

test("getJob returns null when absent", () => {
  const store = JobStore.seeded();
  assert.equal(store.getJob("does-not-exist"), null);
});

test("constructor rejects non-array jobs", () => {
  assert.throws(() => new JobStore(undefined as never, []), /jobs must be an array/);
});

test("every process step declares typed inputs and outputs", () => {
  const store = JobStore.seeded();
  for (const job of store.listJobs()) {
    for (const step of job.steps) {
      assert.ok(step.inputs.length >= 0 && Array.isArray(step.inputs));
      assert.ok(Array.isArray(step.outputs));
    }
  }
});
