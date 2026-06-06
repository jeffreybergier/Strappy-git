import { Router } from "express";
import type { JobReadStore } from "../jobs/store.js";

export function apiRouter(store: JobReadStore): Router {
  if (!store) throw new Error("[apiRouter] store is required");
  const router = Router();
  router.get("/jobs", (_req, res) => {
    res.json(store.listJobs());
  });
  router.get("/runs", (_req, res) => {
    res.json(store.listRuns());
  });
  router.get("/jobs/:id", (req, res) => {
    const job = store.getJob(req.params.id);
    if (job === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(job);
  });
  return router;
}
