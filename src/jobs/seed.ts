import type { Job, JobRun } from "./types.js";
import { processIssueJob } from "./processIssueJob.js";

// process-issue is the only real process today. Add more here as they exist.
export function seedJobs(): Job[] {
  return [processIssueJob()];
}

// Runs are created by the scheduler/poller at runtime; none are seeded so the
// dashboard starts empty until real executions are recorded.
export function seedRuns(): JobRun[] {
  return [];
}
