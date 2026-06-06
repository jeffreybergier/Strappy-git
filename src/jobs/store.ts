import type { Job, JobRun } from "./types.js";
import { seedJobs, seedRuns } from "./seed.js";

export class JobStore {
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
