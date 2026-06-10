import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeActivation,
  describeCondition,
  describeFailurePolicy,
  manualTrigger,
  parseTriggerSpec,
  serializeTriggerSpec,
  validateTriggerPartition,
  validateTriggerSpec,
  validateWatchedTrigger,
} from "./trigger.js";
import { issueTrigger } from "./processIssueJob.js";
import { pullRequestTrigger } from "./processPullRequestJob.js";
import { pullRequestReplyTrigger } from "./processPullRequestCommentJob.js";
import type { TriggerSpec } from "./types.js";

// ---- the real specs (the production contracts) -------------------------------

test("the issue trigger is one-shot: creation by a whitelisted author, closes on failure", () => {
  const spec = issueTrigger();
  assert.equal(spec.id, "github.issue.opened");
  assert.equal(spec.subject, "issue");
  assert.equal(spec.activation, "creation");
  assert.equal(spec.onFailure, "close-not-planned");
  assert.deepEqual(spec.conditions.map((c) => c.kind).sort(), ["author-whitelisted", "once-per-trigger"]);
});

test("the PR review trigger gates the PR author, same-repo head, and excludes strappy/ branches", () => {
  const spec = pullRequestTrigger();
  assert.equal(spec.subject, "pull_request");
  assert.equal(spec.activation, "creation");
  assert.equal(spec.onFailure, "comment-and-retry");
  assert.ok(spec.conditions.some((c) => c.kind === "author-whitelisted" && c.of === "item"));
  assert.ok(spec.conditions.some((c) => c.kind === "head-branch-in-same-repo"));
  assert.ok(spec.conditions.some((c) => c.kind === "head-branch-not-prefixed" && c.prefix === "strappy/"));
});

test("the PR reply trigger gates the COMMENT author and has no branch-prefix exclusion", () => {
  const spec = pullRequestReplyTrigger();
  assert.equal(spec.subject, "pull_request");
  assert.equal(spec.activation, "comment");
  assert.ok(spec.conditions.some((c) => c.kind === "author-whitelisted" && c.of === "comment"));
  assert.ok(!spec.conditions.some((c) => c.kind === "head-branch-not-prefixed"));
});

test("the two PR triggers partition the shared ledger row (creation vs comment)", () => {
  assert.doesNotThrow(() => validateTriggerPartition([issueTrigger(), pullRequestTrigger(), pullRequestReplyTrigger()]));
});

// ---- shape validation ---------------------------------------------------------

test("validateTriggerSpec accepts every real spec and the manual one", () => {
  for (const spec of [issueTrigger(), pullRequestTrigger(), pullRequestReplyTrigger(), manualTrigger()]) {
    assert.doesNotThrow(() => validateTriggerSpec(spec));
  }
});

test("validateTriggerSpec rejects structural drift", () => {
  assert.throws(() => validateTriggerSpec(null), /spec must be an object/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), id: " " }), /id must be a non-empty string/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), subject: "branch" }), /invalid subject/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), activation: "always" }), /invalid activation/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), onFailure: "explode" }), /invalid onFailure/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), conditions: [{ kind: "vibes" }] }), /invalid condition kind/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), conditions: [{ kind: "author-whitelisted", of: "repo" }] }), /needs of/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), conditions: [{ kind: "head-branch-not-prefixed", prefix: "" }] }), /non-empty prefix/);
  assert.throws(() => validateTriggerSpec({ ...manualTrigger(), inputs: [{ key: "x" }] }), /needs a description/);
});

// ---- policy validation (what a WATCHED job must declare) ----------------------

function spec(overrides: Partial<TriggerSpec>): TriggerSpec {
  return { ...issueTrigger(), ...overrides };
}

test("validateWatchedTrigger demands the ledger condition", () => {
  assert.throws(
    () => validateWatchedTrigger(spec({ conditions: [{ kind: "author-whitelisted", of: "item" }] })),
    /once-per-trigger/,
  );
});

test("validateWatchedTrigger demands a whitelist condition matching the activation", () => {
  assert.throws(
    () => validateWatchedTrigger(spec({ conditions: [{ kind: "once-per-trigger" }] })),
    /creation activation requires/,
  );
  assert.throws(
    () => validateWatchedTrigger(spec({ activation: "comment", conditions: [{ kind: "once-per-trigger" }] })),
    /comment activation requires/,
  );
  assert.throws(
    () => validateWatchedTrigger(spec({
      activation: "creation-or-comment",
      conditions: [{ kind: "once-per-trigger" }, { kind: "author-whitelisted", of: "item" }],
    })),
    /comment activation requires/,
  );
});

test("validateWatchedTrigger rejects branch conditions on an issue trigger", () => {
  assert.throws(
    () => validateWatchedTrigger(spec({
      conditions: [{ kind: "once-per-trigger" }, { kind: "author-whitelisted", of: "item" }, { kind: "head-branch-in-same-repo" }],
    })),
    /branch conditions only apply to pull_request/,
  );
});

test("validateWatchedTrigger demands the same-repo trust boundary on a PR trigger", () => {
  assert.throws(
    () => validateWatchedTrigger(spec({
      subject: "pull_request",
      onFailure: "comment-and-retry",
      conditions: [{ kind: "once-per-trigger" }, { kind: "author-whitelisted", of: "item" }],
    })),
    /head-branch-in-same-repo/,
  );
});

test("validateWatchedTrigger forbids close-not-planned on a PR trigger (it would close the PR)", () => {
  assert.throws(
    () => validateWatchedTrigger({ ...pullRequestTrigger(), onFailure: "close-not-planned" }),
    /only issue triggers may close/,
  );
});

test("validateWatchedTrigger rejects the manual trigger (a watched job must declare its gates)", () => {
  assert.throws(() => validateWatchedTrigger(manualTrigger()), /once-per-trigger/);
});

// ---- partition validation ------------------------------------------------------

test("validateTriggerPartition rejects two triggers on one subject with overlapping activations", () => {
  assert.throws(() => validateTriggerPartition([issueTrigger(), issueTrigger()]), /overlapping activations/);
  assert.throws(
    () => validateTriggerPartition([pullRequestTrigger(), spec({ ...pullRequestReplyTrigger(), activation: "creation-or-comment" })]),
    /overlapping activations/,
  );
  assert.throws(() => validateTriggerPartition(null as never), /specs must be an array/);
});

// ---- descriptions (what the dashboard renders) ---------------------------------

test("describeActivation reads naturally per subject and activation", () => {
  assert.equal(describeActivation(issueTrigger()), "Fires once when an issue is created");
  assert.equal(describeActivation(pullRequestTrigger()), "Fires once when a pull request is created");
  assert.equal(describeActivation(pullRequestReplyTrigger()), "Fires on each new whitelisted comment on an open pull request");
});

test("describeCondition voices each condition kind", () => {
  assert.match(describeCondition({ kind: "author-whitelisted", of: "item" }), /author is on the user whitelist/);
  assert.match(describeCondition({ kind: "author-whitelisted", of: "comment" }), /comment author .* not gated/);
  assert.match(describeCondition({ kind: "head-branch-in-same-repo" }), /never a fork/);
  assert.match(describeCondition({ kind: "head-branch-not-prefixed", prefix: "strappy/" }), /not a strappy\/… branch/);
  assert.match(describeCondition({ kind: "once-per-trigger" }), /exactly once/);
});

test("describeFailurePolicy voices both policies", () => {
  assert.match(describeFailurePolicy(issueTrigger()), /close as not planned/);
  assert.match(describeFailurePolicy(pullRequestTrigger()), /whitelisted reply re-runs/);
});

// ---- persistence round-trip -----------------------------------------------------

test("serialize/parse round-trips every spec exactly", () => {
  for (const original of [issueTrigger(), pullRequestTrigger(), pullRequestReplyTrigger(), manualTrigger()]) {
    assert.deepEqual(parseTriggerSpec(serializeTriggerSpec(original)), original);
  }
});

test("parseTriggerSpec rejects junk strictly", () => {
  assert.throws(() => parseTriggerSpec(""), /non-empty string/);
  assert.throws(() => parseTriggerSpec("not json"), /not valid JSON/);
  assert.throws(() => parseTriggerSpec('"manual"'), /spec must be an object/); // a pre-spec legacy value
  assert.throws(() => parseTriggerSpec('{"id":"x"}'), /invalid subject/);
});
