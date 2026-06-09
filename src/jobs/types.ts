// ISO 9001-inspired process map types.
// A Job is a process; each ProcessStep declares explicit typed inputs and
// outputs so the output contract of one step feeds the input of the next.

import type { IoSource, IoType } from "./io.js";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

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
  trigger: string;
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
