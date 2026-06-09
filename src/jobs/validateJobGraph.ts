import { createLogger } from "../logger.js";
import type { IoType } from "./io.js";
import type { FailureHandler, Job, ProcessStep, StepIO } from "./types.js";

const log = createLogger("validateJobGraph");

// One producer-with-no-consumer finding: step output `key` that no later step reads.
export interface UnconsumedOutput {
  stepId: string;
  key: string;
}

// Static check of a Job's input/output contract, run before any step executes.
// It mirrors the scheduler's two-scope model: a step may read an ambient trigger
// constant, its own static (disk-loaded) content, or an output of the
// IMMEDIATELY preceding step. A value that must outlive the step that produced it
// is carried explicitly as a "pass" output (re-declared as a "pass" input). Each
// declared type must agree with its producer. Throws on the first violation, so a
// typo or a drifted type fails at load time, never mid-run after a clone/branch/
// LLM spend has already happened.
export function validateJobGraph(job: Job, triggerInputs: StepIO[]): void {
  validateArgs(job, triggerInputs);
  const trigger = typeMap(triggerInputs);
  let previous = new Map<string, IoType>();
  for (const step of job.steps) {
    const inputsByKey = indexInputs(step);
    for (const input of step.inputs) checkInput(step, input, trigger, previous);
    previous = checkOutputs(step, inputsByKey);
  }
  checkFailureHandler(job.failureHandler, trigger);
  warnUnconsumed(unconsumedOutputs(job));
}

// The terminal every step routes to on failure. Its inputs may only be ambient
// trigger constants (verified against the trigger contract, exactly like a step's
// "trigger" input) or run-level "failure" facts (which have no in-graph producer,
// so there is nothing to check beyond the source). Any other source would imply
// reading a step's output, but a failure can stop the run before that step ran.
function checkFailureHandler(handler: FailureHandler, trigger: Map<string, IoType>): void {
  for (const input of handler.inputs) checkHandlerInput(handler, input, trigger);
}

function checkHandlerInput(handler: FailureHandler, input: StepIO, trigger: Map<string, IoType>): void {
  if (input.source === "failure") return;
  if (input.source !== "trigger") {
    throw new Error(`[validateJobGraph] failure handler "${handler.id}" input "${input.key}" must source "trigger" or "failure"`);
  }
  const producerType = trigger.get(input.key);
  if (producerType === undefined) {
    throw new Error(`[validateJobGraph] failure handler "${handler.id}" trigger input "${input.key}" has no producer`);
  }
  if (producerType !== input.type) {
    throw new Error(`[validateJobGraph] failure handler "${handler.id}" input "${input.key}" type "${input.type}" != producer type "${producerType}"`);
  }
}

function checkInput(step: ProcessStep, input: StepIO, trigger: Map<string, IoType>, previous: Map<string, IoType>): void {
  if (input.source === "static") return checkStatic(step, input);
  const from = input.source === "trigger" ? trigger : previous;
  const producerType = from.get(input.key);
  if (producerType === undefined) {
    throw new Error(`[validateJobGraph] step "${step.id}" input "${input.key}" has no producer (source ${input.source})`);
  }
  if (producerType !== input.type) {
    throw new Error(
      `[validateJobGraph] step "${step.id}" input "${input.key}" type "${input.type}" != producer type "${producerType}"`,
    );
  }
}

function checkStatic(step: ProcessStep, input: StepIO): void {
  if (step.systemPrompt === undefined) {
    throw new Error(`[validateJobGraph] step "${step.id}" static input "${input.key}" but step carries no static content`);
  }
}

// Returns this step's outputs as the next step's only producer scope. A "pass"
// output must mirror a "pass" input of the same key and type; a "receipt" output
// is a terminal side-effect, kept OUT of the producer scope so nothing downstream
// can read it (a consumer of one fails as "no producer"); any other output must
// be freshly produced — by the executor/model ("step") or by the harness from the
// recorded execution ("derived"). Both kinds enter the producer scope.
function checkOutputs(step: ProcessStep, inputsByKey: Map<string, StepIO>): Map<string, IoType> {
  const produced = new Map<string, IoType>();
  for (const output of step.outputs) {
    if (output.source === "pass") checkPass(step, output, inputsByKey);
    else if (output.source !== "step" && output.source !== "derived" && output.source !== "receipt") {
      throw new Error(`[validateJobGraph] step "${step.id}" output "${output.key}" must have source "step", "derived", "pass", or "receipt"`);
    }
    if (output.source !== "receipt") produced.set(output.key, output.type);
  }
  return produced;
}

function checkPass(step: ProcessStep, output: StepIO, inputsByKey: Map<string, StepIO>): void {
  const input = inputsByKey.get(output.key);
  if (input === undefined || input.source !== "pass") {
    throw new Error(`[validateJobGraph] step "${step.id}" pass output "${output.key}" needs a matching pass input`);
  }
  if (input.type !== output.type) {
    throw new Error(`[validateJobGraph] step "${step.id}" pass output "${output.key}" type "${output.type}" != input type "${input.type}"`);
  }
}

// The mirror of the missing-input error: a "step"/"pass" output the next step
// never reads, and that is not declared a terminal "receipt", is dangling —
// either waste to delete, or a side-effect to mark "receipt" on purpose. The
// verifier can't choose for you (a receipt and a leak both have zero consumers),
// so it surfaces the candidates instead of rejecting them.
export function unconsumedOutputs(job: Job): UnconsumedOutput[] {
  if (!job || !Array.isArray(job.steps)) throw new Error("[validateJobGraph] job must be a valid Job");
  const dangling: UnconsumedOutput[] = [];
  job.steps.forEach((step, i) => {
    const consumed = consumerKeys(job.steps[i + 1]);
    for (const output of step.outputs) {
      if (output.source !== "receipt" && !consumed.has(output.key)) dangling.push({ stepId: step.id, key: output.key });
    }
  });
  return dangling;
}

// Keys the next step actually reads off the previous step: only "step"/"pass"
// inputs draw from that scope (trigger/static are sourced elsewhere).
function consumerKeys(next: ProcessStep | undefined): Set<string> {
  const keys = new Set<string>();
  if (next === undefined) return keys;
  for (const input of next.inputs) {
    if (input.source === "step" || input.source === "pass") keys.add(input.key);
  }
  return keys;
}

function warnUnconsumed(dangling: UnconsumedOutput[]): void {
  if (dangling.length === 0) return;
  const list = dangling.map((d) => `${d.stepId}.${d.key}`).join(", ");
  log.warn("unconsumedOutputs", `produced but never consumed (mark "receipt" or remove): ${list}`);
}

function typeMap(ios: StepIO[]): Map<string, IoType> {
  const map = new Map<string, IoType>();
  for (const io of ios) map.set(io.key, io.type);
  return map;
}

function indexInputs(step: ProcessStep): Map<string, StepIO> {
  const map = new Map<string, StepIO>();
  for (const input of step.inputs) map.set(input.key, input);
  return map;
}

function validateArgs(job: Job, triggerInputs: StepIO[]): void {
  if (!job || !Array.isArray(job.steps)) throw new Error("[validateJobGraph] job must be a valid Job");
  if (!Array.isArray(triggerInputs)) throw new Error("[validateJobGraph] triggerInputs must be an array");
  if (!job.failureHandler || !Array.isArray(job.failureHandler.inputs)) {
    throw new Error("[validateJobGraph] job.failureHandler must declare inputs");
  }
}
