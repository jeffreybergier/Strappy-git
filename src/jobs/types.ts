// ISO 9001-inspired process map types.
// A Job is a process; each ProcessStep declares explicit typed inputs and
// outputs so the output contract of one step feeds the input of the next.

import type { IoSource, IoType } from "./io.js";

// "interrupted" is a terminal status stamped at boot by recovery
// (jobs/recovery.ts) onto a run the server abandoned mid-flight — it is never
// produced by a live scheduler pass.
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "interrupted";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

// What a trigger watches: the open-issue feed or the open-PR feed.
export type TriggerSubject = "issue" | "pull_request";

// What may fire the trigger for a watched item. "creation": a never-seen item,
// exactly once. "comment": a whitelisted comment newer than the ledger
// watermark (the item's own author is NOT gated). "creation-or-comment": both.
// Two triggers may share a subject only when their activations partition the
// events (validateTriggerPartition checks this).
export type Activation = "creation" | "comment" | "creation-or-comment";

// What the poller does after a failed run, beyond posting the failure report.
// "close-not-planned" is the one-shot issue policy (skipped when code was
// already pushed); "comment-and-retry" leaves the thread open so a whitelisted
// reply re-runs the job.
export type FailurePolicy = "close-not-planned" | "comment-and-retry";

// One entry criterion of a trigger, as data: the poller executes it (each kind
// maps to a gate or a feed filter) and the dashboard renders it
// (describeCondition), so the firing rules are part of the process map instead
// of being buried in poller code.
export type TriggerCondition =
  | { kind: "author-whitelisted"; of: "item" | "comment" }
  | { kind: "head-branch-in-same-repo" }
  | { kind: "head-branch-not-prefixed"; prefix: string }
  | { kind: "once-per-trigger" };

// The typed contract of a job's trigger — the process map's "step zero". Like a
// ProcessStep it declares outputs (`inputs`: the ambient constants seeded onto
// the run), and additionally the entry criteria: what feed is watched, what
// event fires it, which conditions gate it, and the failure policy. The poller
// derives its watcher from this (poller.watcherFor), so the wiring cannot
// drift from the declaration.
export interface TriggerSpec {
  id: string;
  subject: TriggerSubject;
  activation: Activation;
  conditions: TriggerCondition[];
  onFailure: FailurePolicy;
  inputs: StepIO[];
}

export interface StepIO {
  key: string;
  type: IoType;
  // Where the value is sourced from. On inputs: any IoSource. On outputs:
  // "step" (the executor/model produces it), "derived" (the harness fills it
  // from the recorded execution), "pass" (carried through unchanged), or
  // "receipt" (a terminal side-effect).
  source: IoSource;
  // Human-facing label (dashboard, docs).
  description: string;
  // Model-facing instruction for an LLM-authored ("step") output: the submit
  // tool's schema uses this verbatim (falling back to `description`), so the
  // output contract carries the prompt guidance — imperative voice, examples,
  // length/format limits — that helps the model produce a good value.
  guidance?: string;
  // Output-only marker: this produced value is also surfaced into the generic
  // failure comment if any step later fails (the poller relays it as the
  // handler's "attemptedSummary"). Orthogonal to `source` — the output keeps its
  // real source for threading; this just routes a copy to the error handler. The
  // dashboard groups marked outputs under "Error". Never set on an input.
  feedsFailure?: boolean;
}

export interface ProcessStep {
  id: string;
  // Registered step-kind key; the StepKindRegistry resolves it to an executor.
  kind: string;
  name: string;
  description: string;
  // Static instructions for an LLM-backed step (the system prompt). Authored as
  // a prompts/*.md file and loaded into the step, so the process map is
  // self-contained and a recorded run traces to the exact instructions used.
  systemPrompt?: string;
  inputs: StepIO[];
  outputs: StepIO[];
}

// The single, generic error handler every step routes to on failure: a comment
// posted back on the triggering issue. Strappy handles a step failure the SAME
// way for every step (there is no per-step failure logic), so the failure path is
// declared once per job rather than on each step. `inputs` enumerate the data the
// handler receives — the run-level failure facts (source "failure": the failed
// step id, its error note, the run id, a best-effort attempted summary) plus the
// trigger constants needed to address the comment. It is part of the persisted
// process graph so the dashboard can draw the failure edge from every step.
export interface FailureHandler {
  id: string;
  name: string;
  description: string;
  inputs: StepIO[];
}

export interface Job {
  id: string;
  name: string;
  description: string;
  trigger: TriggerSpec;
  steps: ProcessStep[];
  // The terminal every step transitions to on failure (see FailureHandler).
  failureHandler: FailureHandler;
}

// Token counts and cost for one LLM call, taken from the provider's reported
// usage so a recorded run carries its real spend.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costTotal: number;
}

// One tool the model asked to call. `arguments` is the model's already-parsed
// argument object (Pi returns it as a record, not a raw JSON string).
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// Full record of a single LLM-backed step execution: the answer plus every
// other thing the model emitted (reasoning, tool calls, usage), so a step run
// is auditable rather than just "succeeded/failed".
export interface LlmExecution {
  provider: string;
  model: string;
  stopReason: string;
  text: string;
  thinking?: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  // Repo-relative path to the rendered HTML transcript of this call
  // (e.g. data/sessions/<run>-<step>.html), recorded for traceability. Absent on
  // in-memory runs (no runId) or when transcript rendering failed.
  transcriptPath?: string;
}

// Resolved per-run IO values for one step, keyed by StepIO.key. The scheduler
// captures these from a step's resolved inputs and produced outputs so a recorded
// run carries the real values that flowed through, not just status/timing.
export type IoValues = Record<string, unknown>;

export interface StepRun {
  stepId: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
  // Present only when the step recorded resolved values: a succeeded step carries
  // both; a failed step keeps the inputs it resolved before failing. Empty bags
  // are omitted so a value-free step round-trips equal to one that never had any.
  inputs?: IoValues;
  outputs?: IoValues;
  // Present only for LLM-backed steps that recorded a model call.
  execution?: LlmExecution;
}

export interface JobRun {
  id: string;
  jobId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  stepRuns: StepRun[];
}
