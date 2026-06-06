import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "./scheduler.js";
import { StepKindRegistry, defaultStepKinds } from "./stepKinds.js";
import type { StepValues } from "./stepKinds.js";
import { openDatabase } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";
import { seedJobs } from "./seed.js";
import type { Job, LlmExecution, ProcessStep } from "./types.js";

function fakeExecution(text: string): LlmExecution {
  return {
    provider: "openrouter",
    model: "m",
    stopReason: "stop",
    text,
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, costTotal: 0 },
  };
}

function step(id: string, kind: string, inputs: string[], outputs: string[]): ProcessStep {
  return {
    id,
    kind,
    name: id,
    description: "",
    inputs: inputs.map((key) => ({ key, type: "string", description: "" })),
    outputs: outputs.map((key) => ({ key, type: "string", description: "" })),
  };
}

function job(id: string, steps: ProcessStep[]): Job {
  return { id, name: id, description: "", trigger: "manual", steps };
}

test("runJob threads one step's outputs into the next step's inputs", async () => {
  const seen: StepValues = {};
  const registry = new StepKindRegistry()
    .register("produce", () => ({ token: "abc" }))
    .register("consume", (ctx) => {
      Object.assign(seen, ctx.inputs);
      return {};
    });
  const chain = job("chain", [step("a", "produce", [], ["token"]), step("b", "consume", ["token"], [])]);
  const run = await runJob(chain, {}, { registry });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(seen, { token: "abc" });
});

test("runJob runs a seeded job with default kinds and records a succeeded run", async () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const proc = seedJobs().find((j) => j.id === "process-issue");
  assert.ok(proc);
  store.saveJob(proc);
  const run = await runJob(proc, { repo: "o/r", issueNumber: 1, jobUuid: "uuid-test" }, {
    registry: defaultStepKinds(),
    store,
    now: () => "2026-06-06T00:00:00.000Z",
    newRunId: () => "run-test",
  });
  assert.equal(run.status, "succeeded");
  assert.equal(run.stepRuns.length, proc.steps.length);
  assert.ok(run.stepRuns.every((s) => s.status === "succeeded"));
  assert.deepEqual(store.listRuns().find((r) => r.id === "run-test"), run);
});

test("an executor's recorded execution is attached to its step run and persisted", async () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const registry = new StepKindRegistry().register("ask", (ctx) => {
    ctx.recordExecution?.(fakeExecution("hi there"));
    return { answer: "hi there" };
  });
  const j = job("j", [step("ask", "ask", [], ["answer"])]);
  store.saveJob(j);
  const run = await runJob(j, {}, { registry, store, newRunId: () => "run-exec" });
  assert.deepEqual(run.stepRuns[0]?.execution, fakeExecution("hi there"));
  assert.deepEqual(store.listRuns().find((r) => r.id === "run-exec"), run);
});

test("a recorded execution is kept even when the step later fails its contract", async () => {
  const registry = new StepKindRegistry().register("ask", (ctx) => {
    ctx.recordExecution?.(fakeExecution("partial"));
    return {}; // omits the declared "answer" output -> contract failure
  });
  const run = await runJob(job("j", [step("ask", "ask", [], ["answer"])]), {}, { registry });
  assert.equal(run.stepRuns[0]?.status, "failed");
  assert.equal(run.stepRuns[0]?.execution?.text, "partial");
});

test("a thrown step fails the run and skips the remaining steps", async () => {
  const registry = new StepKindRegistry()
    .register("ok", () => ({}))
    .register("boom", () => {
      throw new Error("kaboom");
    });
  const failing = job("j", [step("s1", "ok", [], []), step("s2", "boom", [], []), step("s3", "ok", [], [])]);
  const run = await runJob(failing, {}, { registry });
  assert.equal(run.status, "failed");
  assert.deepEqual(run.stepRuns.map((s) => s.status), ["succeeded", "failed", "skipped"]);
  assert.equal(run.stepRuns[1]?.note, "kaboom");
});

test("a step missing a declared input fails with a clear note", async () => {
  const registry = new StepKindRegistry().register("ok", () => ({}));
  const run = await runJob(job("j", [step("s1", "ok", ["missing"], [])]), {}, { registry });
  assert.equal(run.status, "failed");
  assert.match(run.stepRuns[0]?.note ?? "", /missing input "missing"/);
});

test("a step that omits a declared output fails the contract", async () => {
  const registry = new StepKindRegistry().register("forgetful", () => ({}));
  const run = await runJob(job("j", [step("s1", "forgetful", [], ["promised"])]), {}, { registry });
  assert.equal(run.status, "failed");
  assert.match(run.stepRuns[0]?.note ?? "", /did not produce output "promised"/);
});

test("the registry rejects duplicate registration and unknown kinds", () => {
  const registry = new StepKindRegistry().register("x", () => ({}));
  assert.throws(() => registry.register("x", () => ({})), /already registered/);
  assert.throws(() => registry.resolve("nope"), /unknown step kind/);
});

test("runJob validates its arguments", async () => {
  await assert.rejects(runJob(undefined as never, {}, { registry: defaultStepKinds() }), /job must be a valid Job/);
  await assert.rejects(runJob(job("j", []), {}, {} as never), /registry is required/);
});
