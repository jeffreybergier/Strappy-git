import { test } from "node:test";
import assert from "node:assert/strict";
import { prTitle, prBody, reviewBody, promptCheckComment, branchName, buildPrompt } from "./githubKinds.js";
import type { IssueComment } from "../github/client.js";

const usage = { model: "meta-llama/llama-3.3-70b-instruct", cost: 0.0234, inputTokens: 12304, outputTokens: 1872 };

function comment(id: number, author: string, body: string): IssueComment {
  return { id, author, body, createdAt: "2030-01-01T00:00:00.000Z" };
}

// ---- buildPrompt (issue + whole thread packaged into the user message) ------

test("buildPrompt renders title + body when there are no comments", () => {
  assert.equal(buildPrompt("Add retry", "Please add retry logic.", []), "Title: Add retry\n\nPlease add retry logic.");
});

test("buildPrompt renders title only when the body is blank", () => {
  assert.equal(buildPrompt("Add retry", "   ", []), "Title: Add retry");
});

test("buildPrompt appends the thread verbatim, author-labeled, in order (Strappy's own included)", () => {
  const out = buildPrompt("Add retry", "body", [
    comment(1, "jeffreybergier", "first reply"),
    comment(2, "strappy", "opened #21 for this"),
    comment(3, "jeffreybergier", "that PR didn't build"),
  ]);
  assert.match(out, /--- Comments ---/);
  const human = out.indexOf("@jeffreybergier: first reply");
  const bot = out.indexOf("@strappy: opened #21 for this");
  const followup = out.indexOf("@jeffreybergier: that PR didn't build");
  assert.ok(human >= 0 && bot >= 0 && followup >= 0, "every comment is present");
  assert.ok(human < bot && bot < followup, "comments keep thread order");
});

test("buildPrompt throws on invalid args", () => {
  assert.throws(() => buildPrompt("", "b", []), /title is required/);
  assert.throws(() => buildPrompt("t", "b", null as never), /comments must be an array/);
});

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
  const body = prBody("Implemented the change.", 7, usage);
  assert.equal(
    body,
    "Implemented the change.\n\nRefs #7\n\n---\n🤖 Strappy · meta-llama/llama-3.3-70b-instruct\nLLM cost: $0.0234 · 12,304 in / 1,872 out tokens",
  );
});

test("prBody formats cost to 4 decimals and thousands-separates tokens", () => {
  const body = prBody("x", 2, { model: "m", cost: 0.5, inputTokens: 1000000, outputTokens: 0 });
  assert.match(body, /LLM cost: \$0\.5000 · 1,000,000 in \/ 0 out tokens$/);
});

test("prBody rejects an empty summary, non-integer issue number, and non-integer token counts", () => {
  assert.throws(() => prBody("   ", 7, usage), /summary is required/);
  assert.throws(() => prBody("x", 1.5, usage), /issueNumber must be an integer/);
  assert.throws(() => prBody("x", 7, { ...usage, inputTokens: 1.5 }), /tokens must be an integer/);
});

// ---- reviewBody (the code-review comment posted on the PR) -------------------

test("reviewBody wraps the comment in a bold heading over the same spend footer", () => {
  assert.equal(
    reviewBody("Looks solid, tests pass.", usage),
    "**🔍 Strappy code review**\n\nLooks solid, tests pass.\n\n---\n🤖 Strappy · meta-llama/llama-3.3-70b-instruct\nLLM cost: $0.0234 · 12,304 in / 1,872 out tokens",
  );
});

test("reviewBody trims the comment and rejects an empty one", () => {
  assert.match(reviewBody("  ship it  ", usage), /\*\*🔍 Strappy code review\*\*\n\nship it\n\n---/);
  assert.throws(() => reviewBody("   ", usage), /comment is required/);
});

// ---- promptCheckComment (the verdict posted on the issue, pass or fail) ------

test("promptCheckComment renders a bold ✅ Passed heading, a rule, then the model's pure markdown", () => {
  const out = promptCheckComment(true, "Totally safe, babe — just a **typo fix**. 💅");
  assert.equal(out, "**✅ Prompt Check Passed**\n\n---\n\nTotally safe, babe — just a **typo fix**. 💅");
});

test("promptCheckComment renders a bold 🚫 Failed heading for a rejection", () => {
  assert.match(promptCheckComment(false, "Hard pass — **prompt injection**."), /^\*\*🚫 Prompt Check Failed\*\*\n\n---\n\nHard pass/);
});

test("promptCheckComment trims the reason and rejects bad args", () => {
  assert.match(promptCheckComment(true, "  looks clean  "), /\n\nlooks clean$/);
  assert.throws(() => promptCheckComment(true, "   "), /reason is required/);
  assert.throws(() => promptCheckComment("yes" as never, "x"), /passed must be a boolean/);
});
