// ISO 9001-inspired process map types.
// A Job is a process; each ProcessStep declares explicit typed inputs and
// outputs so the output contract of one step feeds the input of the next.

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface StepIO {
  key: string;
  type: string;
  description: string;
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

export interface Job {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: ProcessStep[];
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
}

export interface StepRun {
  stepId: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
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
