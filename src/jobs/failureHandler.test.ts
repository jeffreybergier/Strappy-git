import { test } from "node:test";
import assert from "node:assert/strict";
import { failureHandler } from "./failureHandler.js";

test("failureHandler declares the contract the issue comment is built from", () => {
  const handler = failureHandler();
  assert.equal(handler.id, "post-failure-comment");
  const byKey = Object.fromEntries(handler.inputs.map((io) => [io.key, io]));
  // The run-level failure facts the comment surfaces.
  for (const key of ["failedStep", "errorNote", "runId", "attemptedSummary"]) {
    assert.equal(byKey[key]?.source, "failure", `${key} should be a "failure" input`);
  }
  // The trigger constants needed to address the comment.
  assert.equal(byKey["repo"]?.source, "trigger");
  assert.equal(byKey["issueNumber"]?.source, "trigger");
  assert.equal(byKey["issueNumber"]?.type, "number");
});

test("failureHandler inputs only ever source 'trigger' or 'failure' (the terminal node has no step producer)", () => {
  for (const io of failureHandler().inputs) {
    assert.ok(io.source === "trigger" || io.source === "failure", `unexpected source ${io.source} on ${io.key}`);
  }
});

test("failureHandler addresses the comment by the given number key (the PR job passes prNumber)", () => {
  const byKey = Object.fromEntries(failureHandler("prNumber").inputs.map((io) => [io.key, io]));
  assert.equal(byKey["prNumber"]?.source, "trigger");
  assert.equal(byKey["prNumber"]?.type, "number");
  assert.equal(byKey["issueNumber"], undefined);
});

test("failureHandler throws on a blank number key", () => {
  assert.throws(() => failureHandler(""), /numberKey must be a non-empty string/);
});

test("failureHandler returns a fresh object each call (no shared mutable state)", () => {
  assert.notEqual(failureHandler(), failureHandler());
  assert.deepEqual(failureHandler(), failureHandler());
});
