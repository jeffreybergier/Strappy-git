import { DatabaseSync } from "node:sqlite";
import { insertJob, insertRun, readJob, readJobs, readRuns } from "./db.js";
import type { JobReadStore } from "./store.js";
import type { Job, JobRun } from "./types.js";

// JobReadStore backed by SQLite. Reads hydrate full Job/JobRun trees; the
// write methods are the persistence seam for the future scheduler.
export class SqliteJobStore implements JobReadStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    if (!(db instanceof DatabaseSync)) throw new Error("[SqliteJobStore.constructor] db is required");
    this.db = db;
  }

  listJobs(): Job[] {
    return readJobs(this.db);
  }

  getJob(id: string): Job | null {
    if (typeof id !== "string") throw new Error("[SqliteJobStore.getJob] id must be a string");
    return readJob(this.db, id);
  }

  listRuns(): JobRun[] {
    return readRuns(this.db);
  }

  saveJob(job: Job): void {
    if (!job) throw new Error("[SqliteJobStore.saveJob] job is required");
    insertJob(this.db, job);
  }

  recordRun(run: JobRun): void {
    if (!run) throw new Error("[SqliteJobStore.recordRun] run is required");
    insertRun(this.db, run);
  }
}
