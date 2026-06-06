import { runStructured } from "../llm/pi.js";
import type { StructuredResult } from "../llm/pi.js";
import { outputsToSchema } from "../llm/schema.js";
import type { StepContext, StepExecutor, StepValues } from "./stepKinds.js";
import type { LlmExecution, StepIO } from "./types.js";

type RunStructured = (
  prompt: string,
  systemPrompt: string | undefined,
  schema: ReturnType<typeof outputsToSchema>,
  toolName: string,
  cwd: string,
) => Promise<StructuredResult>;

// Outputs the harness fills from the recorded execution rather than asking the
// model for them: keyed by output name -> value read off the LlmExecution. `cost`
// is the spend Pi reports, which the model cannot know.
const DERIVED_OUTPUTS: Record<string, (execution: LlmExecution) => unknown> = {
  cost: (execution) => execution.usage.costTotal,
};

// LLM-backed step kind: prompts the model with the step's "userPrompt" input
// under its "systemPrompt", runs it against the checked-out repo (the
// "workingDirectory" input) with the built-in + submit tools, asks it to return
// the model-authored outputs via a generated submit tool, records the full
// execution, and emits the validated arguments plus any harness-derived outputs.
// runStructured is injected so the kind is unit-testable without a live API.
export function llmStepKind(run: RunStructured = runStructured): StepExecutor {
  if (typeof run !== "function") throw new Error("[llmStepKind] run must be a function");
  return async (ctx) => {
    const schema = outputsToSchema(modelOutputs(ctx.step.outputs));
    const { values, execution } = await run(
      readInput(ctx, "userPrompt"),
      readOptionalInput(ctx, "systemPrompt"),
      schema,
      toolName(ctx),
      readInput(ctx, "workingDirectory"),
    );
    ctx.recordExecution?.(execution);
    return { ...values, ...derivedOutputs(ctx.step.outputs, execution) } as StepValues;
  };
}

// The model fills only the outputs it authors: harness-derived outputs (filled
// from the execution) and "pass" outputs (carried through by the scheduler) are
// excluded from the submit tool's schema.
function modelOutputs(outputs: StepIO[]): StepIO[] {
  return outputs.filter((io) => io.source !== "pass" && !(io.key in DERIVED_OUTPUTS));
}

function derivedOutputs(outputs: StepIO[], execution: LlmExecution): StepValues {
  const values: StepValues = {};
  for (const io of outputs) {
    const derive = DERIVED_OUTPUTS[io.key];
    if (derive) values[io.key] = derive(execution);
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
