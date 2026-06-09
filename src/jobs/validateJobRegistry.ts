import { createLogger } from "../logger.js";
import { StepKindRegistry } from "./stepKinds.js";
import type { Job, ProcessStep, StepIO } from "./types.js";

const log = createLogger("validateJobRegistry");

// The registry-aware second pass, run once at startup when BOTH the job graph and
// its executor registry are known (validateJobGraph runs earlier, at job
// construction, with no registry). It proves every step's kind is registered and
// that each "derived" output names a key that kind can actually fill from its
// recorded execution — closing the gap where a typo'd or misplaced "derived"
// output passes the kind-agnostic graph check but throws mid-run, after LLM spend.
export function validateJobRegistry(job: Job, registry: StepKindRegistry): void {
  validateArgs(job, registry);
  for (const step of job.steps) checkStep(step, registry);
  log.info("validateJobRegistry", `job "${job.id}" checked against ${registry.list().length} kinds`);
}

function checkStep(step: ProcessStep, registry: StepKindRegistry): void {
  if (!registry.has(step.kind)) {
    throw new Error(`[validateJobRegistry] step "${step.id}" has unregistered kind "${step.kind}"`);
  }
  const derivable = registry.derivableKeys(step.kind);
  for (const output of step.outputs) checkDerived(step, output, derivable);
}

function checkDerived(step: ProcessStep, output: StepIO, derivable: ReadonlySet<string>): void {
  if (output.source !== "derived") return;
  if (!derivable.has(output.key)) {
    throw new Error(`[validateJobRegistry] step "${step.id}" derived output "${output.key}" has no deriver in kind "${step.kind}"`);
  }
}

function validateArgs(job: Job, registry: StepKindRegistry): void {
  if (!job || !Array.isArray(job.steps)) throw new Error("[validateJobRegistry] job must be a valid Job");
  if (!(registry instanceof StepKindRegistry)) throw new Error("[validateJobRegistry] registry must be a StepKindRegistry");
}
