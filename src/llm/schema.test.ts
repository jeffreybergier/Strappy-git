import { test } from "node:test";
import assert from "node:assert/strict";
import { outputsToSchema } from "./schema.js";
import type { TObject } from "typebox";
import type { StepIO } from "../jobs/types.js";
import type { IoType } from "../jobs/io.js";

// `type` stays a string here so the fallback test can pass an out-of-vocabulary
// value; the cast mimics the one defensive path (a cast at a call site).
function io(key: string, type: string): StepIO {
  return { key, type: type as IoType, source: "step", description: `desc for ${key}` };
}

// typebox property values are the abstract TSchema; read their JSON-schema
// fields (present at runtime) through a narrow view for assertions.
function prop(schema: TObject, key: string): { type?: string; description?: string } {
  return schema.properties[key] as unknown as { type?: string; description?: string };
}

test("outputsToSchema builds a required typebox object keyed by output", () => {
  const schema = outputsToSchema([io("category", "string"), io("difficulty", "integer")]);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["category", "difficulty"]);
  assert.deepEqual(Object.keys(schema.properties), ["category", "difficulty"]);
});

test("outputsToSchema maps known StepIO types and passes descriptions through", () => {
  const schema = outputsToSchema([
    io("s", "string"),
    io("n", "number"),
    io("i", "integer"),
    io("b", "boolean"),
  ]);
  assert.equal(prop(schema, "s").type, "string");
  assert.equal(prop(schema, "n").type, "number");
  assert.equal(prop(schema, "i").type, "integer");
  assert.equal(prop(schema, "b").type, "boolean");
  assert.equal(prop(schema, "s").description, "desc for s");
});

test("outputsToSchema prefers model-facing guidance over the human description", () => {
  const withGuidance: StepIO = {
    key: "pullRequestTitle",
    type: "string",
    source: "step",
    description: "Concise PR title describing the change the model made",
    guidance: "A short imperative title. Keep under ~70 chars.",
  };
  const schema = outputsToSchema([withGuidance]);
  assert.equal(prop(schema, "pullRequestTitle").description, "A short imperative title. Keep under ~70 chars.");
});

test("outputsToSchema falls back to string for unknown types", () => {
  const schema = outputsToSchema([io("weird", "some-custom-type")]);
  assert.equal(prop(schema, "weird").type, "string");
});

test("outputsToSchema throws on an empty output set", () => {
  assert.throws(() => outputsToSchema([]), /non-empty array/);
  assert.throws(() => outputsToSchema(undefined as never), /non-empty array/);
});
