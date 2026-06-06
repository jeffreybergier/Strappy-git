import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrompt } from "./prompts.js";

test("loadPrompt reads a step prompt from prompts/<name>.md", () => {
  const text = loadPrompt("triage-issue");
  assert.match(text, /triage/i);
  assert.equal(text, text.trim());
});

test("loadPrompt throws a clear error for a missing prompt file", () => {
  assert.throws(() => loadPrompt("no-such-prompt-xyz"), /cannot read prompt file/);
});

test("loadPrompt rejects a non-string or empty name", () => {
  assert.throws(() => loadPrompt(""), /name must be a non-empty string/);
  assert.throws(() => loadPrompt(123 as never), /name must be a non-empty string/);
});
