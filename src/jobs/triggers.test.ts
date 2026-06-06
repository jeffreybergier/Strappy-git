import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerInputs } from "./triggers.js";

test("triggerInputs returns the declared contract for a known trigger", () => {
  const inputs = triggerInputs("github.issue.opened");
  assert.deepEqual(inputs.map((io) => io.key), ["repo", "issueNumber", "issueAuthor", "jobUuid"]);
  assert.ok(inputs.every((io) => io.source === "trigger"));
});

test("triggerInputs returns [] for an unregistered trigger", () => {
  assert.deepEqual(triggerInputs("manual"), []);
});

test("triggerInputs throws on a non-string trigger", () => {
  assert.throws(() => triggerInputs(123 as never), /trigger must be a string/);
});
