import { runStructured } from "../llm/pi.js";
import type { RunStructuredOptions, StructuredResult } from "../llm/pi.js";
import { outputsToSchema } from "../llm/schema.js";
import { transcriptId } from "./stepKinds.js";
import type { StepContext, StepExecutor, StepValues } from "./stepKinds.js";
import type { LlmExecution, StepIO } from "./types.js";

type RunStructured = (
  prompt: string,
  systemPrompt: string | undefined,
  schema: ReturnType<typeof outputsToSchema>,
  toolName: string,
  cwd: string,
  runId: string | undefined,
  options?: RunStructuredOptions,
) => Promise<StructuredResult>;

// How to fill each harness-derived output from the recorded execution: keyed by
// output name -> value read off the LlmExecution. These are the provider's
// reported facts (model id, spend, token split) the model cannot know about its
// own call; a step opts in by declaring the output with source "derived".
const DERIVED_OUTPUTS: Record<string, (execution: LlmExecution) => unknown> = {
  cost: (execution) => execution.usage.costTotal,
  model: (execution) => execution.model,
  inputTokens: (execution) => execution.usage.inputTokens,
  outputTokens: (execution) => execution.usage.outputTokens,
};

// LLM-backed step kind: prompts the model with the step's "userPrompt" input
// under its "systemPrompt", runs it against the checked-out repo (the
// "workingDirectory" input) with the built-in + submit tools, asks it to return
// the model-authored outputs via a generated submit tool, records the full
// execution, and emits the validated arguments plus any harness-derived outputs.
// runStructured is injected so the kind is unit-testable without a live API.
// modelId, when given, overrides the default model for this step (the review
// step binds it to config.openRouter.reviewModel).
export function llmStepKind(run: RunStructured = runStructured, modelId?: string): StepExecutor {
  if (typeof run !== "function") throw new Error("[llmStepKind] run must be a function");
  if (modelId !== undefined && (typeof modelId !== "string" || modelId.trim() === "")) {
    throw new Error("[llmStepKind] modelId, when provided, must be a non-empty string");
  }
  return async (ctx) => {
    const schema = outputsToSchema(modelOutputs(ctx.step.outputs));
    const { values, execution } = await run(
      readInput(ctx, "userPrompt"),
      readOptionalInput(ctx, "systemPrompt"),
      schema,
      toolName(ctx),
      readInput(ctx, "workingDirectory"),
      transcriptId(ctx),
      modelId !== undefined ? { model: modelId } : undefined,
    );
    ctx.recordExecution?.(execution);
    return { ...values, ...derivedOutputs(ctx.step.outputs, execution) } as StepValues;
  };
}

// The model fills only the outputs it authors, declared with source "step".
// "derived" outputs (filled from the execution) and "pass" outputs (carried
// through by the scheduler) are excluded from the submit tool's schema.
function modelOutputs(outputs: StepIO[]): StepIO[] {
  return outputs.filter((io) => io.source === "step");
}

// Strict: a "derived" output whose key has no deriver is a contract error (the
// step asked the harness for a fact it cannot produce), surfaced at run time.
function derivedOutputs(outputs: StepIO[], execution: LlmExecution): StepValues {
  const values: StepValues = {};
  for (const io of outputs) {
    if (io.source !== "derived") continue;
    const derive = DERIVED_OUTPUTS[io.key];
    if (derive === undefined) throw new Error(`[llmStepKind] no deriver for derived output "${io.key}"`);
    values[io.key] = derive(execution);
  }
  return values;
}

// Fail closed: the model gets write/edit/bash, so a non-empty userPrompt and a
// workingDirectory (the cloned repo, never the server's own dir) are required.
function readInput(ctx: StepContext, key: string): string {
  const v = ctx.inputs[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`[llmStepKind] step requires a non-empty string input "${key}"`);
  }
  return v;
}

function readOptionalInput(ctx: StepContext, key: string): string | undefined {
  return ctx.inputs[key] === undefined ? undefined : readInput(ctx, key);
}

// Tool names must be identifier-safe; step ids like "process-issue" carry dashes.
function toolName(ctx: StepContext): string {
  return `submit_${ctx.step.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
