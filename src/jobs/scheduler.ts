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
  // Optional teardown run after the steps (success OR failure), e.g. removing the
  // run's clone workspace. Receives the ambient trigger constants; best-effort.
  cleanup?: (triggerInputs: StepValues) => Promise<void> | void;
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
  const trigger: StepValues = { ...triggerInputs };
  const run = startRun(job, (options.newRunId ?? defaultRunId)(), now());
  options.store?.recordRun(run); // persist up front so the dashboard shows the job while it runs
  let previous: StepValues = {};
  let failed = false;
  try {
    for (const [i, step] of job.steps.entries()) {
      if (failed) {
        run.stepRuns[i] = skip(step).stepRun;
        options.store?.recordRun(run);
        continue;
      }
      const startedAt = now();
      run.stepRuns[i] = { stepId: step.id, status: "running", startedAt };
      options.store?.recordRun(run); // mark the step in progress so the dashboard shows it running
      const outcome = await runStep(step, trigger, previous, options.registry, now, run.id, startedAt);
      run.stepRuns[i] = outcome.stepRun;
      if (outcome.stepRun.status === "failed") failed = true;
      else if (outcome.outputs) previous = outcome.outputs;
      options.store?.recordRun(run); // re-persist after the step finishes
    }
  } finally {
    await runCleanup(options.cleanup, trigger);
  }
  finishRun(run, failed, now());
  options.store?.recordRun(run);
  log.info("runJob", `job "${job.id}" finished: ${run.status} (${run.id})`);
  return run;
}

async function runStep(step: ProcessStep, trigger: StepValues, previous: StepValues, registry: StepKindRegistry, now: () => string, runId: string, startedAt: string): Promise<Outcome> {
  // Captured even if the step later fails, so a model call is always recorded.
  let execution: LlmExecution | undefined;
  const recordExecution = (e: LlmExecution): void => { execution = e; };
  // Captured before the executor runs so a failed step still records its inputs.
  let inputs: StepValues | undefined;
  try {
    inputs = resolveInputs(step, trigger, previous);
    const produced = await registry.resolve(step.kind)({ step, inputs, recordExecution, runId });
    const outputs = buildOutputs(step, inputs, produced);
    return { stepRun: { stepId: step.id, status: "succeeded", startedAt, finishedAt: now(), ...bag("inputs", inputs), ...bag("outputs", outputs), ...(execution && { execution }) }, outputs };
  } catch (error) {
    log.error("runStep", `step "${step.id}" failed`, error);
    return { stepRun: { stepId: step.id, status: "failed", startedAt, finishedAt: now(), note: message(error), ...bag("inputs", inputs), ...(execution && { execution }) } };
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

// Attaches a resolved IO bag to a StepRun only when it carries values, so a step
// with no inputs/outputs round-trips equal to a record that never had them
// (deep-equal: { inputs: {} } !== {}). Mirrored by the db hydrate side.
function bag(name: "inputs" | "outputs", values: StepValues | undefined): { inputs?: StepValues } | { outputs?: StepValues } {
  if (values === undefined || Object.keys(values).length === 0) return {};
  return { [name]: values };
}

// Runs the optional teardown on both the success and failure paths (finally), so
// the clone is removed even mid-process. A teardown error is logged, never thrown
// — it must not flip a finished run's result.
async function runCleanup(cleanup: RunJobOptions["cleanup"], trigger: StepValues): Promise<void> {
  if (cleanup === undefined) return;
  try {
    await cleanup(trigger);
  } catch (error) {
    log.warn("cleanup", `workspace teardown failed: ${message(error)}`);
  }
}

// The run the poller persists at enqueue time so a job waiting behind others in
// the queue is visible in the dashboard before its first step starts. Every step
// is pending; startRun later flips it to "running" — re-stamping startedAt to the
// real start — when execution actually begins.
export function queuedRun(job: Job, id: string, startedAt: string): JobRun {
  if (!job || typeof job.id !== "string" || !Array.isArray(job.steps)) {
    throw new Error("[Scheduler.queuedRun] job must be a valid Job");
  }
  if (typeof id !== "string" || id.trim() === "") throw new Error("[Scheduler.queuedRun] id must be a non-empty string");
  if (typeof startedAt !== "string" || startedAt.trim() === "") throw new Error("[Scheduler.queuedRun] startedAt must be a non-empty string");
  return {
    id,
    jobId: job.id,
    status: "queued",
    startedAt,
    stepRuns: job.steps.map((step) => ({ stepId: step.id, status: "pending" })),
  };
}

// Seeds the run as "running" with every step pending, so the dashboard renders
// the whole process map the instant a job starts and fills it in as steps run.
function startRun(job: Job, id: string, startedAt: string): JobRun {
  return { ...queuedRun(job, id, startedAt), status: "running" };
}

function finishRun(run: JobRun, failed: boolean, finishedAt: string): void {
  run.status = failed ? "failed" : "succeeded";
  run.finishedAt = finishedAt;
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
