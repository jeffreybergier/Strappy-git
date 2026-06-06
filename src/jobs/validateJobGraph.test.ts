import { test } from "node:test";
import assert from "node:assert/strict";
import { unconsumedOutputs, validateJobGraph } from "./validateJobGraph.js";
import { processIssueJob, issueTriggerInputs } from "./processIssueJob.js";
import type { IoSource, IoType } from "./io.js";
import type { Job, ProcessStep, StepIO } from "./types.js";

function io(key: string, type: IoType, source: IoSource): StepIO {
  return { key, type, source, description: "" };
}

function step(id: string, inputs: StepIO[], outputs: StepIO[], systemPrompt?: string): ProcessStep {
  return { id, kind: "k", name: id, description: "", ...(systemPrompt !== undefined && { systemPrompt }), inputs, outputs };
}

function job(steps: ProcessStep[]): Job {
  return { id: "j", name: "j", description: "", trigger: "t", steps };
}

test("the real processIssueJob graph validates against its trigger contract", () => {
  // processIssueJob() self-validates, so simply constructing it exercises this.
  assert.doesNotThrow(() => validateJobGraph(processIssueJob(), issueTriggerInputs()));
});

test("the immediately preceding step's output satisfies a step input", () => {
  const graph = job([step("a", [], [io("token", "string", "step")]), step("b", [io("token", "string", "step")], [])]);
  assert.doesNotThrow(() => validateJobGraph(graph, []));
});

test("a step input with no producer is rejected", () => {
  const graph = job([step("a", [io("missing", "string", "step")], [])]);
  assert.throws(() => validateJobGraph(graph, []), /input "missing" has no producer/);
});

test("a trigger input is satisfied by the ambient trigger contract at any step", () => {
  const graph = job([step("a", [], []), step("b", [io("repo", "string", "trigger")], [])]);
  assert.doesNotThrow(() => validateJobGraph(graph, [io("repo", "string", "trigger")]));
});

test("a trigger input with no matching trigger constant is rejected", () => {
  const graph = job([step("a", [io("nope", "string", "trigger")], [])]);
  assert.throws(() => validateJobGraph(graph, [io("repo", "string", "trigger")]), /input "nope" has no producer/);
});

test("a type that drifts between producer and consumer is rejected", () => {
  const graph = job([step("a", [], [io("n", "string", "step")]), step("b", [io("n", "number", "step")], [])]);
  assert.throws(() => validateJobGraph(graph, []), /type "number" != producer type "string"/);
});

test("a non-adjacent value is NOT visible unless passed through (strict adjacency)", () => {
  const graph = job([
    step("a", [], [io("token", "string", "step")]),
    step("b", [], []), // does not carry token forward
    step("c", [io("token", "string", "step")], []),
  ]);
  assert.throws(() => validateJobGraph(graph, []), /step "c" input "token" has no producer/);
});

test("a passthrough carries a value across an intervening step", () => {
  const graph = job([
    step("a", [], [io("token", "string", "step")]),
    step("b", [io("token", "string", "pass")], [io("token", "string", "pass")]),
    step("c", [io("token", "string", "step")], []),
  ]);
  assert.doesNotThrow(() => validateJobGraph(graph, []));
});

test("a pass output without a matching pass input is rejected", () => {
  const graph = job([step("a", [], [io("token", "string", "step")]), step("b", [], [io("token", "string", "pass")])]);
  assert.throws(() => validateJobGraph(graph, []), /pass output "token" needs a matching pass input/);
});

test("an output declared with a non-step\/derived\/pass\/receipt source is rejected", () => {
  const graph = job([step("a", [], [io("token", "string", "trigger")])]);
  assert.throws(() => validateJobGraph(graph, []), /output "token" must have source "step", "derived", "pass", or "receipt"/);
});

test("a derived output is produced by the step and satisfies a later step's input", () => {
  const graph = job([
    step("a", [], [io("cost", "number", "derived")]),
    step("b", [io("cost", "number", "step")], []),
  ]);
  assert.doesNotThrow(() => validateJobGraph(graph, []));
});

test("a receipt output is an intentional terminal: it validates and is never flagged", () => {
  const graph = job([step("a", [], [io("closed", "boolean", "receipt")])]);
  assert.doesNotThrow(() => validateJobGraph(graph, []));
  assert.deepEqual(unconsumedOutputs(graph), []);
});

test("a receipt is kept out of the producer scope, so a later step cannot consume it", () => {
  const graph = job([
    step("a", [], [io("closed", "boolean", "receipt")]),
    step("b", [io("closed", "boolean", "step")], []),
  ]);
  assert.throws(() => validateJobGraph(graph, []), /step "b" input "closed" has no producer/);
});

test("unconsumedOutputs flags a step output the next step never reads, but not a consumed one", () => {
  const graph = job([
    step("a", [], [io("used", "string", "step"), io("dropped", "string", "step")]),
    step("b", [io("used", "string", "step")], []),
  ]);
  assert.deepEqual(unconsumedOutputs(graph), [{ stepId: "a", key: "dropped" }]);
});

test("unconsumedOutputs flags a pass value carried but never consumed downstream", () => {
  const graph = job([
    step("a", [], [io("tok", "string", "step")]),
    step("b", [io("tok", "string", "pass")], [io("tok", "string", "pass")]),
  ]);
  assert.deepEqual(unconsumedOutputs(graph), [{ stepId: "b", key: "tok" }]);
});

test("the real job surfaces only the terminal prUrl as an audit candidate", () => {
  // cost/model/tokens are now threaded into the PR footer (consumed by open-pr),
  // so the lone dangling output is the PR URL, which nothing downstream reads.
  const candidates = unconsumedOutputs(processIssueJob()).map((d) => `${d.stepId}.${d.key}`);
  assert.deepEqual(candidates, ["open-pr.prUrl"]);
});

test("a static input is sourced from the step, not a producer", () => {
  const graph = job([step("a", [io("systemPrompt", "string", "static")], [], "be terse")]);
  assert.doesNotThrow(() => validateJobGraph(graph, []));
});

test("a static input still needs the step to carry static content", () => {
  const graph = job([step("a", [io("systemPrompt", "string", "static")], [])]);
  assert.throws(() => validateJobGraph(graph, []), /static input "systemPrompt" but step carries no static content/);
});

test("validateJobGraph validates its arguments", () => {
  assert.throws(() => validateJobGraph(undefined as never, []), /job must be a valid Job/);
  assert.throws(() => validateJobGraph(job([]), undefined as never), /triggerInputs must be an array/);
});
