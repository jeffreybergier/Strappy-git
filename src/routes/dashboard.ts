import { Router } from "express";
import type { JobReadStore } from "../jobs/store.js";

const STATUS_CLASS: Record<string, string> = {
  queued: "default",
  pending: "default",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "warning",
};

function badge(status: string): string {
  return STATUS_CLASS[status] ?? "default";
}

export function dashboardRouter(store: JobReadStore): Router {
  if (!store) throw new Error("[dashboardRouter] store is required");
  const router = Router();
  router.get("/", (_req, res) => {
    res.render("dashboard", {
      jobs: store.listJobs(),
      runs: store.listRuns(),
      badge,
    });
  });
  return router;
}
