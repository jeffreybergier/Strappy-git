import { test } from "node:test";
import assert from "node:assert/strict";
import { prTitle, prBody, branchName } from "./githubKinds.js";

const usage = { model: "meta-llama/llama-3.3-70b-instruct", cost: 0.0234, inputTokens: 12304, outputTokens: 1872 };

test("branchName builds strappy/issue-<n>/<uuid stem>", () => {
  assert.equal(branchName(8, "8e6e2f89-4dab-425b-93ca-3f49310dfe8e"), "strappy/issue-8/8e6e2f89");
});

test("branchName rejects a non-integer issue number and a blank uuid", () => {
  assert.throws(() => branchName(1.5, "8e6e2f89-4dab"), /issueNumber must be an integer/);
  assert.throws(() => branchName(8, ""), /jobUuid must be a non-empty string/);
});

test("prTitle prefixes the model title and appends the issue link", () => {
  assert.equal(prTitle("Add retry logic to the HTTP client", 2), "Strappy: Add retry logic to the HTTP client (#2)");
});

test("prTitle trims the model title", () => {
  assert.equal(prTitle("  Fix the thing  ", 7), "Strappy: Fix the thing (#7)");
});

test("prTitle rejects an empty title or a non-numeric issue number", () => {
  assert.throws(() => prTitle("", 2), /modelTitle is required/);
  assert.throws(() => prTitle("x", Number.NaN), /issueNumber must be a number/);
});

test("prBody appends a cost/model/token footer under the summary", () => {
  const body = prBody("Implemented the change.", usage);
  assert.equal(
    body,
    "Implemented the change.\n\n---\n🤖 Strappy · meta-llama/llama-3.3-70b-instruct\nLLM cost: $0.0234 · 12,304 in / 1,872 out tokens",
  );
});

test("prBody formats cost to 4 decimals and thousands-separates tokens", () => {
  const body = prBody("x", { model: "m", cost: 0.5, inputTokens: 1000000, outputTokens: 0 });
  assert.match(body, /LLM cost: \$0\.5000 · 1,000,000 in \/ 0 out tokens$/);
});

test("prBody rejects an empty summary and non-integer token counts", () => {
  assert.throws(() => prBody("   ", usage), /summary is required/);
  assert.throws(() => prBody("x", { ...usage, inputTokens: 1.5 }), /tokens must be an integer/);
});
