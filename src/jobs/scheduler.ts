import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { StepKindRegistry } from "./stepKinds.js";
import type { StepValues } from "./stepKinds.js";
import { describeValue, matchesIoType } from "./io.js";
import type { JobWriteStore } from "./store.js";
import type { Job, JobRun, LlmExecution, ProcessStep, StepIO, StepRun } from "./types.js";

const log = createLogger("Scheduler");

export interface RunJobOptions {
  registry: StepKindRegistry;
  store?: JobWriteStore;
  now?: () => string;
  newRunId?: () => string;
}

interface Outcome {
  stepRun: StepRun;
  outputs?: StepValues;
}

// Executes a Job's steps in order under a two-scope model: every step reads
// ambient trigger constants, its own static content, or the IMMEDIATELY
// preceding step's outputs (a value that must reach a later step is carried as a
// "pass" output). Records the JobRun. A failed step fails the run and skips the
// rest (matching the seeded run shape).
export async function runJob(job: Job, triggerInputs: StepValues, options: RunJobOptions): Promise<JobRun> {
  validateArgs(job, triggerInputs, options);
  const now = options.now ?? isoNow;
  const startedAt = now();
  const trigger: StepValues = { ...triggerInputs };
  let previous: StepValues = {};
  const stepRuns: StepRun[] = [];
  let failed = false;
  for (const step of job.steps) {
    const outcome = failed ? skip(step) : await runStep(step, trigger, previous, options.registry, now);
    stepRuns.push(outcome.stepRun);
    if (outcome.stepRun.status === "failed") failed = true;
    else if (outcome.outputs) previous = outcome.outputs;
  }
  const run = buildRun(job, startedAt, now(), failed, stepRuns, options.newRunId ?? defaultRunId);
  options.store?.recordRun(run);
  log.info("runJob", `job "${job.id}" finished: ${run.status} (${run.id})`);
  return run;
}

async function runStep(step: ProcessStep, trigger: StepValues, previous: StepValues, registry: StepKindRegistry, now: () => string): Promise<Outcome> {
  const startedAt = now();
  // Captured even if the step later fails, so a model call is always recorded.
  let execution: LlmExecution | undefined;
  const recordExecution = (e: LlmExecution): void => { execution = e; };
  try {
    const inputs = resolveInputs(step, trigger, previous);
    const produced = await registry.resolve(step.kind)({ step, inputs, recordExecution });
    const outputs = buildOutputs(step, inputs, produced);
    return { stepRun: { stepId: step.id, status: "succeeded", startedAt, finishedAt: now(), ...(execution && { execution }) }, outputs };
  } catch (error) {
    log.error("runStep", `step "${step.id}" failed`, error);
    return { stepRun: { stepId: step.id, status: "failed", startedAt, finishedAt: now(), note: message(error), ...(execution && { execution }) } };
  }
}

// Resolves each declared input from its source: an ambient trigger constant, the
// step's own static content (loaded from prompts/*.md), or the previous step's
// outputs ("step"/"pass"). A missing key is a contract violation, so the step
// fails before its executor runs.
function resolveInputs(step: ProcessStep, trigger: StepValues, previous: StepValues): StepValues {
  const inputs: StepValues = {};
  for (const io of step.inputs) inputs[io.key] = resolveInput(step, io, trigger, previous);
  return inputs;
}

function resolveInput(step: ProcessStep, io: StepIO, trigger: StepValues, previous: StepValues): unknown {
  if (io.source === "static") {
    if (step.systemPrompt === undefined) throw new Error(`[Scheduler.resolveInputs] step "${step.id}" static input "${io.key}" but step carries no static content`);
    return step.systemPrompt;
  }
  const from = io.source === "trigger" ? trigger : previous;
  if (!(io.key in from)) throw new Error(`[Scheduler.resolveInputs] step "${step.id}" missing input "${io.key}"`);
  return from[io.key];
}

// Builds the step's declared output bag the next step reads from: "pass" outputs
// are copied from the matching input (carried unchanged); "step" outputs must be
// emitted by the executor. Each value must match its declared type.
function buildOutputs(step: ProcessStep, inputs: StepValues, produced: StepValues): StepValues {
  if (produced === null || typeof produced !== "object") {
    throw new Error(`[Scheduler.buildOutputs] step "${step.id}" executor must return an object`);
  }
  const outputs: StepValues = {};
  for (const io of step.outputs) outputs[io.key] = collectOutput(step, io, inputs, produced);
  return outputs;
}

function collectOutput(step: ProcessStep, io: StepIO, inputs: StepValues, produced: StepValues): unknown {
  if (io.source !== "pass" && !(io.key in produced)) {
    throw new Error(`[Scheduler.buildOutputs] step "${step.id}" did not produce output "${io.key}"`);
  }
  const value = io.source === "pass" ? inputs[io.key] : produced[io.key];
  if (!matchesIoType(value, io.type)) {
    throw new Error(`[Scheduler.buildOutputs] step "${step.id}" output "${io.key}" expected ${io.type}, got ${describeValue(value)}`);
  }
  return value;
}

function skip(step: ProcessStep): Outcome {
  return { stepRun: { stepId: step.id, status: "skipped" } };
}

function buildRun(job: Job, startedAt: string, finishedAt: string, failed: boolean, stepRuns: StepRun[], newRunId: () => string): JobRun {
  return {
    id: newRunId(),
    jobId: job.id,
    status: failed ? "failed" : "succeeded",
    startedAt,
    finishedAt,
    stepRuns,
  };
}

function validateArgs(job: Job, triggerInputs: StepValues, options: RunJobOptions): void {
  if (!job || typeof job.id !== "string" || !Array.isArray(job.steps)) {
    throw new Error("[Scheduler.runJob] job must be a valid Job");
  }
  if (triggerInputs === null || typeof triggerInputs !== "object") {
    throw new Error("[Scheduler.runJob] triggerInputs must be an object");
  }
  if (!options || !(options.registry instanceof StepKindRegistry)) {
    throw new Error("[Scheduler.runJob] options.registry is required");
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function defaultRunId(): string {
  return `run-${randomUUID()}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
