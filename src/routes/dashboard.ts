import { Router } from "express";
import type { JobReadStore } from "../jobs/store.js";
import type { Job, StepIO } from "../jobs/types.js";
import { triggerInputs } from "../jobs/triggers.js";

interface JobView extends Job {
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
  return { ...job, triggerInputs: triggerInputs(job.trigger) };
}
