import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOutputs, relayedOnFailure } from "./ioGroups.js";
import type { IoSource } from "../jobs/io.js";
import type { ProcessStep, StepIO } from "../jobs/types.js";

function io(key: string, source: IoSource, feedsFailure?: boolean): StepIO {
  return { key, type: "string", source, description: "", ...(feedsFailure && { feedsFailure: true }) };
}

function step(id: string, outputs: StepIO[]): ProcessStep {
  return { id, kind: "llm", name: id, description: "", inputs: [], outputs };
}

test("groupOutputs buckets produced, passthrough and receipt outputs in order", () => {
  const groups = groupOutputs([io("a", "step"), io("c", "receipt"), io("b", "pass"), io("d", "derived")]);
  assert.deepEqual(groups.map((g) => g.label), ["New", "Passthrough", "Receipt"]);
  assert.deepEqual(groups[0]?.items.map((i) => i.key), ["a", "d"]); // step + derived = New
});

test("groupOutputs drops empty categories", () => {
  const groups = groupOutputs([io("a", "step")]);
  assert.deepEqual(groups.map((g) => g.label), ["New"]);
});

test("a feedsFailure output goes to 'Relayed on failure', not its source bucket (no duplication)", () => {
  const groups = groupOutputs([io("summary", "step", true), io("plain", "step")]);
  const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.items.map((i) => i.key)]));
  assert.deepEqual(byLabel["New"], ["plain"]);
  assert.deepEqual(byLabel["Relayed on failure"], ["summary"]);
  assert.equal(groups.find((g) => g.label === "Relayed on failure")?.key, "relayed"); // stable css key
});

test("groupOutputs validates its argument", () => {
  assert.throws(() => groupOutputs(null as never), /outputs must be an array/);
});

test("relayedOnFailure exposes only EARLIER steps' marked keys (a step's own output is excluded)", () => {
  const steps = [
    step("a", [io("x", "step")]),
    step("b", [io("summary", "step", true)]), // producer
    step("c", [io("y", "step")]),
  ];
  // a fails: nothing; b (producer) fails: nothing yet; c fails: b's summary is recorded
  assert.deepEqual(relayedOnFailure(steps), [[], [], ["summary"]]);
});

test("relayedOnFailure dedupes a key marked on both a producer and a carried passthrough", () => {
  const steps = [
    step("a", [io("s", "step", true)]),
    step("b", [io("s", "pass", true)]),
    step("c", [io("z", "step")]),
  ];
  assert.deepEqual(relayedOnFailure(steps), [[], ["s"], ["s"]]);
});

test("relayedOnFailure validates its argument", () => {
  assert.throws(() => relayedOnFailure(null as never), /steps must be an array/);
});
