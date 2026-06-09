import { Router } from "express";
import type { JobReadStore } from "../jobs/store.js";
import type { Job, ProcessStep, StepIO } from "../jobs/types.js";
import { triggerInputs } from "../jobs/triggers.js";
import { groupOutputs, relayedOnFailure } from "./ioGroups.js";
import type { OutputGroup } from "./ioGroups.js";

interface StepView extends ProcessStep {
  outputGroups: OutputGroup[];
  // Marked values the error step receives if THIS step fails (produced earlier).
  relayedOnFailure: string[];
  // Marked values THIS step produces — relayed only if a LATER step fails, not on
  // this step's own failure (it hasn't produced them yet). Reconciles the footer
  // with the step's "Relayed on failure" output on the producer step.
  producesOnFailure: string[];
}

interface JobView extends Omit<Job, "steps"> {
  steps: StepView[];
  triggerInputs: StepIO[];
}

export function dashboardRouter(store: JobReadStore): Router {
  if (!store) throw new Error("[dashboardRouter] store is required");
  const router = Router();
  router.get("/", (_req, res) => {
    res.render("dashboard", { jobs: store.listJobs().map(toView) });
  });
  return router;
}

function toView(job: Job): JobView {
  const relayed = relayedOnFailure(job.steps);
  return {
    ...job,
    steps: job.steps.map((step, i) => ({
      ...step,
      outputGroups: groupOutputs(step.outputs),
      relayedOnFailure: relayed[i] ?? [],
      producesOnFailure: step.outputs.filter((o) => o.feedsFailure).map((o) => o.key),
    })),
    triggerInputs: triggerInputs(job.trigger),
  };
}
