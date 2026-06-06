import { Router } from "express";
import type { JobReadStore } from "../jobs/store.js";

export function dashboardRouter(store: JobReadStore): Router {
  if (!store) throw new Error("[dashboardRouter] store is required");
  const router = Router();
  router.get("/", (_req, res) => {
    res.render("dashboard", { jobs: store.listJobs() });
  });
  return router;
}
