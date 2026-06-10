import type { Job, JobRun } from "./types.js";
import { processIssueJob } from "./processIssueJob.js";
import { processPullRequestJob } from "./processPullRequestJob.js";
import { processPullRequestCommentJob } from "./processPullRequestCommentJob.js";

// The real processes the poller watches for. Add more here as they exist.
export function seedJobs(): Job[] {
  return [processIssueJob(), processPullRequestJob(), processPullRequestCommentJob()];
}

// Runs are created by the scheduler/poller at runtime; none are seeded so the
// dashboard starts empty until real executions are recorded.
export function seedRuns(): JobRun[] {
  return [];
}
