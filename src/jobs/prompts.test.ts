import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuidance, loadGuidanceKey, loadPrompt } from "./prompts.js";

test("loadPrompt reads a step prompt from prompts/<name>.md", () => {
  const text = loadPrompt("implement-issue");
  assert.match(text, /issue/i);
  assert.equal(text, text.trim());
});

test("loadPrompt reads the global personality prompt", () => {
  const text = loadPrompt("personality");
  assert.match(text, /Strappy/);
  assert.equal(text, text.trim());
});

test("loadPrompt throws a clear error for a missing prompt file", () => {
  assert.throws(() => loadPrompt("no-such-prompt-xyz"), /cannot read prompt file/);
});

test("loadPrompt rejects a non-string or empty name", () => {
  assert.throws(() => loadPrompt(""), /name must be a non-empty string/);
  assert.throws(() => loadPrompt(123 as never), /name must be a non-empty string/);
});

test("loadGuidance reads the security-check section of guidance.json", () => {
  const guidance = loadGuidance("security-check");
  for (const key of ["safe", "reason", "echoToken"]) {
    const text = guidance[key];
    assert.equal(typeof text, "string");
    assert.notEqual(text, "");
  }
  assert.match(guidance["reason"] ?? "", /starting on the implementation/);
});

test("loadGuidance reads every step's section of guidance.json", () => {
  assert.equal(typeof loadGuidance("implement-issue")["pullRequestTitle"], "string");
  assert.equal(typeof loadGuidance("update-pull-request")["updateSummary"], "string");
  assert.equal(typeof loadGuidance("code-review")["reviewComment"], "string");
});

test("loadGuidance reads the shared submit-nudge reminder with its {toolName} placeholder", () => {
  assert.match(loadGuidance("submit-nudge")["reminder"] ?? "", /\{toolName\}/);
});

test("loadGuidanceKey returns one guidance string and throws on a missing key", () => {
  assert.match(loadGuidanceKey("code-review", "reviewComment"), /code review/i);
  assert.throws(() => loadGuidanceKey("code-review", "noSuchKey"), /missing "code-review.noSuchKey"/);
  assert.throws(() => loadGuidanceKey("code-review", ""), /key must be a non-empty string/);
});

test("loadGuidance throws a clear error for a missing section", () => {
  assert.throws(() => loadGuidance("no-such-section-xyz"), /missing section "no-such-section-xyz"/);
});

test("loadGuidance rejects a non-string or empty section", () => {
  assert.throws(() => loadGuidance(""), /section must be a non-empty string/);
  assert.throws(() => loadGuidance(123 as never), /section must be a non-empty string/);
});
