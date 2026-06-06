import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { StepKindRegistry } from "./stepKinds.js";
import type { StepValues } from "./stepKinds.js";
import type { JobWriteStore } from "./store.js";
import type { Job, JobRun, ProcessStep, StepRun } from "./types.js";

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

// Executes a Job's steps in order, threading each step's declared outputs into
// the bag the next step reads its inputs from, then records the JobRun. A
// failed step fails the run and skips the rest (matching the seeded run shape).
export async function runJob(job: Job, triggerInputs: StepValues, options: RunJobOptions): Promise<JobRun> {
  validateArgs(job, triggerInputs, options);
  const now = options.now ?? isoNow;
  const startedAt = now();
  const bus: StepValues = { ...triggerInputs };
  const stepRuns: StepRun[] = [];
  let failed = false;
  for (const step of job.steps) {
    const outcome = failed ? skip(step) : await runStep(step, bus, options.registry, now);
    stepRuns.push(outcome.stepRun);
    if (outcome.stepRun.status === "failed") failed = true;
    else if (outcome.outputs) Object.assign(bus, outcome.outputs);
  }
  const run = buildRun(job, startedAt, now(), failed, stepRuns, options.newRunId ?? defaultRunId);
  options.store?.recordRun(run);
  log.info("runJob", `job "${job.id}" finished: ${run.status} (${run.id})`);
  return run;
}

async function runStep(step: ProcessStep, bus: StepValues, registry: StepKindRegistry, now: () => string): Promise<Outcome> {
  const startedAt = now();
  try {
    const inputs = resolveInputs(step, bus);
    const outputs = await registry.resolve(step.kind)({ step, inputs });
    validateOutputs(step, outputs);
    return { stepRun: { stepId: step.id, status: "succeeded", startedAt, finishedAt: now() }, outputs };
  } catch (error) {
    log.error("runStep", `step "${step.id}" failed`, error);
    return { stepRun: { stepId: step.id, status: "failed", startedAt, finishedAt: now(), note: message(error) } };
  }
}

// Pulls each declared input off the shared bus; a missing key means an upstream
// step never produced it — a contract violation, so the step fails.
function resolveInputs(step: ProcessStep, bus: StepValues): StepValues {
  const inputs: StepValues = {};
  for (const io of step.inputs) {
    if (!(io.key in bus)) throw new Error(`[Scheduler.resolveInputs] step "${step.id}" missing input "${io.key}"`);
    inputs[io.key] = bus[io.key];
  }
  return inputs;
}

// Enforces the output half of the contract: a step must emit every output it
// declares, so the next step can rely on finding it.
function validateOutputs(step: ProcessStep, outputs: StepValues): void {
  if (outputs === null || typeof outputs !== "object") {
    throw new Error(`[Scheduler.validateOutputs] step "${step.id}" executor must return an object`);
  }
  for (const io of step.outputs) {
    if (!(io.key in outputs)) throw new Error(`[Scheduler.validateOutputs] step "${step.id}" did not produce output "${io.key}"`);
  }
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
