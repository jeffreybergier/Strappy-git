import { runStructured } from "../llm/pi.js";
import type { StructuredResult } from "../llm/pi.js";
import { outputsToSchema } from "../llm/schema.js";
import type { StepContext, StepExecutor, StepValues } from "./stepKinds.js";

type RunStructured = (
  prompt: string,
  systemPrompt: string | undefined,
  schema: ReturnType<typeof outputsToSchema>,
  toolName: string,
  cwd: string,
) => Promise<StructuredResult>;

// LLM-backed step kind: prompts the model with the step's "prompt" input under
// the step's authored systemPrompt, runs it against the checked-out repo (the
// "workdir" input) with the built-in + submit tools, asks it to return the
// step's declared outputs via a generated submit tool, records the full
// execution, and emits the validated arguments as the step's outputs.
// runStructured is injected so the kind is unit-testable without a live API.
export function llmStepKind(run: RunStructured = runStructured): StepExecutor {
  if (typeof run !== "function") throw new Error("[llmStepKind] run must be a function");
  return async (ctx) => {
    const schema = outputsToSchema(ctx.step.outputs);
    const { values, execution } = await run(readPrompt(ctx), ctx.step.systemPrompt, schema, toolName(ctx), readWorkdir(ctx));
    ctx.recordExecution?.(execution);
    return values as StepValues;
  };
}

function readPrompt(ctx: StepContext): string {
  return readInput(ctx, "prompt");
}

// Fail closed: the model gets write/edit/bash, so it must run in the cloned repo
// workdir, never the server's own directory. A missing workdir is a hard error.
function readWorkdir(ctx: StepContext): string {
  return readInput(ctx, "workdir");
}

function readInput(ctx: StepContext, key: string): string {
  const v = ctx.inputs[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`[llmStepKind] step requires a non-empty string input "${key}"`);
  }
  return v;
}

// Tool names must be identifier-safe; step ids like "process-issue" carry dashes.
function toolName(ctx: StepContext): string {
  return `submit_${ctx.step.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
