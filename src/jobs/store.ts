import type { Job, JobRun } from "./types.js";
import { seedJobs, seedRuns } from "./seed.js";

// Read surface shared by the in-memory JobStore and the SqliteJobStore so the
// routes can depend on either without knowing the backing store.
export interface JobReadStore {
  listJobs(): Job[];
  getJob(id: string): Job | null;
  listRuns(): JobRun[];
}

// Write surface the scheduler uses to persist jobs and record executed runs.
export interface JobWriteStore {
  saveJob(job: Job): void;
  recordRun(run: JobRun): void;
}

// De-dupe surface the poller uses so each trigger (a new issue, or a new
// whitelisted comment) is acted on exactly once. lastProcessedComment is the
// watermark the poller compares the newest whitelisted comment against.
export interface TriggerLedger {
  isProcessed(repo: string, issueNumber: number): boolean;
  lastProcessedComment(repo: string, issueNumber: number): number;
  claimProcessing(repo: string, issueNumber: number, runId: string, lastCommentId: number): boolean;
  markProcessing(repo: string, issueNumber: number, runId: string, lastCommentId: number): void;
  setStatus(repo: string, issueNumber: number, runId: string, status: string): void;
}

// Administrative surface over the ledger, used by boot-time crash recovery and
// the manual retry endpoint — deliberately separate from TriggerLedger so the
// poller's contract (and its test fakes) stay untouched. runTrigger maps a
// recorded run back to the ledger row it claimed; releaseTrigger deletes the
// claim so the poller fires the trigger again.
export interface TriggerAdmin {
  runTrigger(runId: string): { repo: string; issueNumber: number; status: string } | null;
  releaseTrigger(repo: string, issueNumber: number): boolean;
}

export class JobStore implements JobReadStore {
  private readonly jobs: Map<string, Job>;
  private readonly runs: JobRun[];

  constructor(jobs: Job[], runs: JobRun[]) {
    if (!Array.isArray(jobs)) throw new Error("[JobStore.constructor] jobs must be an array");
    if (!Array.isArray(runs)) throw new Error("[JobStore.constructor] runs must be an array");
    this.jobs = new Map(jobs.map((job) => [job.id, job]));
    this.runs = runs;
  }

  static seeded(): JobStore {
    return new JobStore(seedJobs(), seedRuns());
  }

  listJobs(): Job[] {
    return [...this.jobs.values()];
  }

  getJob(id: string): Job | null {
    if (typeof id !== "string") throw new Error("[JobStore.getJob] id must be a string");
    return this.jobs.get(id) ?? null;
  }

  listRuns(): JobRun[] {
    return [...this.runs];
  }
}
