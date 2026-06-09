import test from "node:test";
import assert from "node:assert/strict";
import { StepKindRegistry, stubExecutor } from "./stepKinds.js";
import { llmDerivableKeys } from "./llmKind.js";
import { validateJobRegistry } from "./validateJobRegistry.js";
import { processIssueJob } from "./processIssueJob.js";
import { failureHandler } from "./failureHandler.js";
import type { IoSource, IoType } from "./io.js";
import type { Job, ProcessStep, StepIO } from "./types.js";

function io(key: string, type: IoType, source: IoSource): StepIO {
  return { key, type, source, description: key };
}

function step(id: string, kind: string, outputs: StepIO[]): ProcessStep {
  return { id, kind, name: id, description: id, inputs: [], outputs };
}

function job(steps: ProcessStep[]): Job {
  return { id: "j", name: "j", description: "j", trigger: "t", steps, failureHandler: failureHandler() };
}

// Registry whose "llm" kind declares the real deriver set; "noop" derives nothing.
function registry(): StepKindRegistry {
  return new StepKindRegistry()
    .register("llm", stubExecutor, { derivableKeys: llmDerivableKeys() })
    .register("noop", stubExecutor);
}

test("a derived output whose key the kind can fill validates", () => {
  const j = job([step("s", "llm", [io("cost", "number", "derived")])]);
  assert.doesNotThrow(() => validateJobRegistry(j, registry()));
});

test("a derived output with no deriver in its kind is rejected (the typo case)", () => {
  const j = job([step("s", "llm", [io("costt", "number", "derived")])]);
  assert.throws(() => validateJobRegistry(j, registry()), /derived output "costt" has no deriver/);
});

test("a derived output on a kind that derives nothing is rejected", () => {
  const j = job([step("s", "noop", [io("cost", "number", "derived")])]);
  assert.throws(() => validateJobRegistry(j, registry()), /derived output "cost" has no deriver in kind "noop"/);
});

test("a non-derived output is never checked against the deriver set", () => {
  const j = job([step("s", "noop", [io("safe", "boolean", "receipt"), io("x", "string", "step")])]);
  assert.doesNotThrow(() => validateJobRegistry(j, registry()));
});

test("a step whose kind is not registered is rejected", () => {
  const j = job([step("s", "ghost", [])]);
  assert.throws(() => validateJobRegistry(j, registry()), /unregistered kind "ghost"/);
});

test("the real processIssueJob validates against a registry that declares the llm derivers", () => {
  const j = processIssueJob();
  const reg = new StepKindRegistry();
  for (const kind of new Set(j.steps.map((s) => s.kind))) {
    const caps = kind === "llm" || kind === "llm.review" ? { derivableKeys: llmDerivableKeys() } : undefined;
    reg.register(kind, stubExecutor, caps);
  }
  assert.doesNotThrow(() => validateJobRegistry(j, reg));
});

test("the real processIssueJob is rejected by a registry that omits the llm derivers", () => {
  const j = processIssueJob();
  const reg = new StepKindRegistry();
  for (const kind of new Set(j.steps.map((s) => s.kind))) reg.register(kind, stubExecutor);
  assert.throws(() => validateJobRegistry(j, reg), /has no deriver in kind "llm"/);
});

test("validateJobRegistry validates its arguments", () => {
  assert.throws(() => validateJobRegistry(null as unknown as Job, registry()), /must be a valid Job/);
  assert.throws(() => validateJobRegistry(job([]), {} as unknown as StepKindRegistry), /must be a StepKindRegistry/);
});
