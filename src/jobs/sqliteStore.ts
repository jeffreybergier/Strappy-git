import { DatabaseSync } from "node:sqlite";
import {
  insertJob,
  isTriggerProcessed,
  markTriggerProcessing,
  readJob,
  readJobs,
  readRuns,
  setTriggerStatus,
  upsertRun,
} from "./db.js";
import type { JobReadStore, JobWriteStore, TriggerLedger } from "./store.js";
import type { Job, JobRun } from "./types.js";

// JobReadStore backed by SQLite. Reads hydrate full Job/JobRun trees; the
// write methods are the persistence seam for the future scheduler.
export class SqliteJobStore implements JobReadStore, JobWriteStore, TriggerLedger {
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
    upsertRun(this.db, run);
  }

  isProcessed(repo: string, issueNumber: number): boolean {
    return isTriggerProcessed(this.db, repo, issueNumber);
  }

  markProcessing(repo: string, issueNumber: number, runId: string): void {
    markTriggerProcessing(this.db, repo, issueNumber, runId);
  }

  setStatus(repo: string, issueNumber: number, status: string): void {
    setTriggerStatus(this.db, repo, issueNumber, status);
  }
}
