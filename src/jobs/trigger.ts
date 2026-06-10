import type {
  Activation,
  FailurePolicy,
  StepIO,
  TriggerCondition,
  TriggerSpec,
  TriggerSubject,
} from "./types.js";
import { asIoSource, asIoType } from "./io.js";

const SUBJECTS: readonly TriggerSubject[] = ["issue", "pull_request"];
const ACTIVATIONS: readonly Activation[] = ["creation", "comment", "creation-or-comment"];
const FAILURE_POLICIES: readonly FailurePolicy[] = ["close-not-planned", "comment-and-retry"];
const CONDITION_KINDS = ["author-whitelisted", "head-branch-in-same-repo", "head-branch-not-prefixed", "once-per-trigger"] as const;

// The trigger for a job the poller never fires (test fixtures, hand-run jobs).
// It has no entry criteria and seeds nothing, so it round-trips the store but
// is rejected by validateWatchedTrigger if someone tries to watch it.
export function manualTrigger(): TriggerSpec {
  return {
    id: "manual",
    subject: "issue",
    activation: "creation",
    conditions: [],
    onFailure: "comment-and-retry",
    inputs: [],
  };
}

// Shape check: throws unless the value is structurally a TriggerSpec. Used on
// every store read (parseTriggerSpec), so a hydrated job carries a verified
// contract, never a blob the dashboard has to defend against.
export function validateTriggerSpec(spec: unknown): TriggerSpec {
  if (spec === null || typeof spec !== "object") throw new Error("[Trigger.validateTriggerSpec] spec must be an object");
  const s = spec as Record<string, unknown>;
  if (typeof s["id"] !== "string" || s["id"].trim() === "") throw new Error("[Trigger.validateTriggerSpec] id must be a non-empty string");
  if (!SUBJECTS.includes(s["subject"] as TriggerSubject)) throw new Error(`[Trigger.validateTriggerSpec] invalid subject "${String(s["subject"])}"`);
  if (!ACTIVATIONS.includes(s["activation"] as Activation)) throw new Error(`[Trigger.validateTriggerSpec] invalid activation "${String(s["activation"])}"`);
  if (!FAILURE_POLICIES.includes(s["onFailure"] as FailurePolicy)) throw new Error(`[Trigger.validateTriggerSpec] invalid onFailure "${String(s["onFailure"])}"`);
  if (!Array.isArray(s["conditions"])) throw new Error("[Trigger.validateTriggerSpec] conditions must be an array");
  for (const condition of s["conditions"]) validateCondition(condition);
  if (!Array.isArray(s["inputs"])) throw new Error("[Trigger.validateTriggerSpec] inputs must be an array");
  for (const input of s["inputs"]) validateInput(input);
  return spec as TriggerSpec;
}

function validateCondition(condition: unknown): void {
  if (condition === null || typeof condition !== "object") throw new Error("[Trigger.validateTriggerSpec] each condition must be an object");
  const c = condition as Record<string, unknown>;
  const kind = c["kind"];
  if (!CONDITION_KINDS.includes(kind as (typeof CONDITION_KINDS)[number])) {
    throw new Error(`[Trigger.validateTriggerSpec] invalid condition kind "${String(kind)}"`);
  }
  if (kind === "author-whitelisted" && c["of"] !== "item" && c["of"] !== "comment") {
    throw new Error('[Trigger.validateTriggerSpec] author-whitelisted needs of: "item" | "comment"');
  }
  if (kind === "head-branch-not-prefixed" && (typeof c["prefix"] !== "string" || c["prefix"] === "")) {
    throw new Error("[Trigger.validateTriggerSpec] head-branch-not-prefixed needs a non-empty prefix");
  }
}

function validateInput(input: unknown): void {
  if (input === null || typeof input !== "object") throw new Error("[Trigger.validateTriggerSpec] each input must be an object");
  const io = input as Record<string, unknown>;
  if (typeof io["key"] !== "string" || io["key"] === "") throw new Error("[Trigger.validateTriggerSpec] input key must be a non-empty string");
  if (typeof io["description"] !== "string") throw new Error(`[Trigger.validateTriggerSpec] input "${String(io["key"])}" needs a description`);
  asIoType(String(io["type"]));
  asIoSource(String(io["source"]));
}

// Policy check for a trigger the poller actually watches: the spec must declare
// every gate the poller core enforces, so the rendered process map can never
// promise less (or more) than the runtime does. Throws on the first violation.
export function validateWatchedTrigger(spec: TriggerSpec): void {
  validateTriggerSpec(spec);
  const fail = (message: string): never => {
    throw new Error(`[Trigger.validateWatchedTrigger] "${spec.id}": ${message}`);
  };
  if (!spec.conditions.some((c) => c.kind === "once-per-trigger")) {
    fail('must declare "once-per-trigger" (the ledger claim is unconditional)');
  }
  if (firesOnCreation(spec.activation) && !hasWhitelist(spec, "item")) {
    fail('creation activation requires an "author-whitelisted" condition on the item');
  }
  if (firesOnComment(spec.activation) && !hasWhitelist(spec, "comment")) {
    fail('comment activation requires an "author-whitelisted" condition on the comment');
  }
  validateSubjectRules(spec, fail);
}

function validateSubjectRules(spec: TriggerSpec, fail: (message: string) => never): void {
  const branchConditions = spec.conditions.filter((c) => c.kind === "head-branch-in-same-repo" || c.kind === "head-branch-not-prefixed");
  if (spec.subject === "issue" && branchConditions.length > 0) {
    fail("branch conditions only apply to pull_request triggers");
  }
  if (spec.subject === "pull_request" && !spec.conditions.some((c) => c.kind === "head-branch-in-same-repo")) {
    fail('pull_request triggers must declare "head-branch-in-same-repo" (the trust boundary)');
  }
  if (spec.subject === "pull_request" && spec.onFailure === "close-not-planned") {
    fail('"close-not-planned" would close the pull request; only issue triggers may close');
  }
}

function firesOnCreation(activation: Activation): boolean {
  return activation === "creation" || activation === "creation-or-comment";
}

function firesOnComment(activation: Activation): boolean {
  return activation === "comment" || activation === "creation-or-comment";
}

function hasWhitelist(spec: TriggerSpec, of: "item" | "comment"): boolean {
  return spec.conditions.some((c) => c.kind === "author-whitelisted" && c.of === of);
}

// Two triggers on the same subject share one ledger row per item, which only
// works when their activations partition the events (creation claims an item
// once, comments advance the watermark). This turns that invariant — previously
// a comment in the poller — into a checked property of the registry.
export function validateTriggerPartition(specs: TriggerSpec[]): void {
  if (!Array.isArray(specs)) throw new Error("[Trigger.validateTriggerPartition] specs must be an array");
  for (const [i, a] of specs.entries()) {
    for (const b of specs.slice(i + 1)) checkPair(a, b);
  }
}

function checkPair(a: TriggerSpec, b: TriggerSpec): void {
  if (a.subject !== b.subject) return;
  const overlap = a.activation === b.activation || a.activation === "creation-or-comment" || b.activation === "creation-or-comment";
  if (overlap) {
    throw new Error(
      `[Trigger.validateTriggerPartition] "${a.id}" and "${b.id}" both watch ${a.subject}s with overlapping activations (${a.activation} / ${b.activation})`,
    );
  }
}

// ---- human-facing descriptions (dashboard) -----------------------------------

const SUBJECT_NOUNS: Record<TriggerSubject, string> = { issue: "issue", pull_request: "pull request" };
const SUBJECT_WITH_ARTICLE: Record<TriggerSubject, string> = { issue: "an issue", pull_request: "a pull request" };

export function describeActivation(spec: TriggerSpec): string {
  validateTriggerSpec(spec);
  if (spec.activation === "creation") return `Fires once when ${SUBJECT_WITH_ARTICLE[spec.subject]} is created`;
  if (spec.activation === "comment") return `Fires on each new whitelisted comment on an open ${SUBJECT_NOUNS[spec.subject]}`;
  return `Fires when ${SUBJECT_WITH_ARTICLE[spec.subject]} is created or commented on`;
}

export function describeCondition(condition: TriggerCondition): string {
  validateCondition(condition);
  if (condition.kind === "author-whitelisted") {
    return condition.of === "item"
      ? "the author is on the user whitelist"
      : "the comment author is on the user whitelist (the item's own author is not gated)";
  }
  if (condition.kind === "head-branch-in-same-repo") return "the head branch lives in this repo (never a fork)";
  if (condition.kind === "head-branch-not-prefixed") return `the head branch is not a ${condition.prefix}… branch`;
  return "each trigger event fires exactly once (SQLite ledger claim)";
}

export function describeFailurePolicy(spec: TriggerSpec): string {
  validateTriggerSpec(spec);
  if (spec.onFailure === "close-not-planned") {
    return "on failure: post the report and close as not planned (left open if code was already pushed)";
  }
  return "on failure: post the report; a whitelisted reply re-runs the job";
}

// ---- persistence (the jobs.trigger column) -----------------------------------

export function serializeTriggerSpec(spec: TriggerSpec): string {
  return JSON.stringify(validateTriggerSpec(spec));
}

export function parseTriggerSpec(raw: string): TriggerSpec {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("[Trigger.parseTriggerSpec] raw must be a non-empty string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`[Trigger.parseTriggerSpec] not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateTriggerSpec(parsed);
}
