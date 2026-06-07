import { createLogger } from "../logger.js";
import type { LlmExecution, ProcessStep, StepIO } from "./types.js";

const log = createLogger("StepKinds");

// A bag of values flowing between steps, keyed by StepIO.key.
export type StepValues = Record<string, unknown>;

export interface StepContext {
  step: ProcessStep;
  inputs: StepValues;
  // LLM-backed executors call this to attach a full model execution to the
  // step's StepRun; non-LLM executors ignore it.
  recordExecution?: (execution: LlmExecution) => void;
  // The JobRun id (Poller.formatRunId output). LLM-backed executors use it to
  // name the saved HTML transcript; absent for runs that set none (seed/tests).
  runId?: string;
}

// A reusable, named unit of step behavior: resolved inputs in, declared outputs
// out (sync or async). The scheduler dispatches to one executor per step.
export type StepExecutor = (ctx: StepContext) => StepValues | Promise<StepValues>;

// Maps step-kind keys to executors so a kind is defined once and reused across
// jobs. register() returns this, so a registry composes in one expression.
export class StepKindRegistry {
  private readonly kinds = new Map<string, StepExecutor>();

  register(kind: string, executor: StepExecutor): this {
    if (typeof kind !== "string" || kind.trim() === "") {
      throw new Error("[StepKindRegistry.register] kind must be a non-empty string");
    }
    if (typeof executor !== "function") {
      throw new Error(`[StepKindRegistry.register] executor for "${kind}" must be a function`);
    }
    if (this.kinds.has(kind)) {
      throw new Error(`[StepKindRegistry.register] kind already registered: ${kind}`);
    }
    this.kinds.set(kind, executor);
    return this;
  }

  resolve(kind: string): StepExecutor {
    const executor = this.kinds.get(kind);
    if (executor === undefined) throw new Error(`[StepKindRegistry.resolve] unknown step kind: ${kind}`);
    return executor;
  }

  has(kind: string): boolean {
    return this.kinds.has(kind);
  }

  list(): string[] {
    return [...this.kinds.keys()];
  }
}

// Placeholder executor: emits a deterministic, type-correct value for each
// freshly-produced output so a job runs end-to-end (and passes the scheduler's
// output type check) before real handlers exist. "pass" outputs are skipped —
// the scheduler auto-fills those from the matching input. Each registered kind
// below is a seam to replace with a real GitHub/LLM executor.
export function stubExecutor(ctx: StepContext): StepValues {
  const outputs: StepValues = {};
  for (const io of ctx.step.outputs) {
    if (io.source !== "pass") outputs[io.key] = stubValue(ctx.step.id, io);
  }
  return outputs;
}

function stubValue(stepId: string, io: StepIO): unknown {
  switch (io.type) {
    case "number":
    case "integer": return 1;
    case "boolean": return true;
    case "string": return `<${stepId}.${io.key}>`;
  }
}

// The kinds the seeded jobs reference today, all stubbed for now. "llm" is
// registered once but reused by both the classify and analyze steps.
export function defaultStepKinds(): StepKindRegistry {
  const registry = new StepKindRegistry()
    .register("llm", stubExecutor)
    .register("github.fetchIssue", stubExecutor)
    .register("security.scan", stubExecutor)
    .register("github.applyLabels", stubExecutor)
    .register("github.postComment", stubExecutor)
    .register("github.fetchDiff", stubExecutor)
    .register("github.postReview", stubExecutor)
    .register("git.cloneRepo", stubExecutor)
    .register("git.createBranch", stubExecutor)
    .register("git.commitPush", stubExecutor)
    .register("github.openPullRequest", stubExecutor)
    .register("github.commentIssue", stubExecutor)
    .register("github.closeIssue", stubExecutor);
  log.info("defaultStepKinds", `registered ${registry.list().length} step kinds`);
  return registry;
}
