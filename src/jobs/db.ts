import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../logger.js";
import { applySchema } from "./schema.js";
import type {
  Job,
  JobRun,
  ProcessStep,
  RunStatus,
  StepIO,
  StepRun,
  StepStatus,
} from "./types.js";

const log = createLogger("Db");

type Row = Record<string, unknown>;
type IODirection = "input" | "output";

const STEP_STATUSES: readonly StepStatus[] = ["pending", "running", "succeeded", "failed", "skipped"];
const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "succeeded", "failed"];

export function openDatabase(dbPath: string): DatabaseSync {
  if (typeof dbPath !== "string" || dbPath.trim() === "") {
    throw new Error("[Db.openDatabase] dbPath must be a non-empty string");
  }
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  log.info("openDatabase", `opened sqlite database at ${dbPath}`);
  return db;
}

// ---- reads ------------------------------------------------------------------

export function readJobs(db: DatabaseSync): Job[] {
  return db.prepare("SELECT id, name, description, trigger FROM jobs ORDER BY rowid").all().map((r) =>
    hydrateJob(db, r),
  );
}

export function readJob(db: DatabaseSync, id: string): Job | null {
  if (typeof id !== "string") throw new Error("[Db.readJob] id must be a string");
  const row = db.prepare("SELECT id, name, description, trigger FROM jobs WHERE id = ?").get(id);
  return row ? hydrateJob(db, row) : null;
}

export function readRuns(db: DatabaseSync): JobRun[] {
  return db
    .prepare("SELECT id, job_id, status, started_at, finished_at FROM job_runs ORDER BY started_at")
    .all()
    .map((r) => hydrateRun(db, r));
}

function hydrateJob(db: DatabaseSync, row: Row): Job {
  const id = text(row, "id");
  const stepRows = db
    .prepare("SELECT id, kind, name, description FROM process_steps WHERE job_id = ? ORDER BY position")
    .all(id);
  return {
    id,
    name: text(row, "name"),
    description: text(row, "description"),
    trigger: text(row, "trigger"),
    steps: stepRows.map((s) => hydrateStep(db, id, s)),
  };
}

function hydrateStep(db: DatabaseSync, jobId: string, row: Row): ProcessStep {
  const stepId = text(row, "id");
  return {
    id: stepId,
    kind: text(row, "kind"),
    name: text(row, "name"),
    description: text(row, "description"),
    inputs: readIO(db, jobId, stepId, "input"),
    outputs: readIO(db, jobId, stepId, "output"),
  };
}

function readIO(db: DatabaseSync, jobId: string, stepId: string, direction: IODirection): StepIO[] {
  return db
    .prepare(
      "SELECT key, type, description FROM step_io WHERE job_id = ? AND step_id = ? AND direction = ? ORDER BY position",
    )
    .all(jobId, stepId, direction)
    .map((r) => ({ key: text(r, "key"), type: text(r, "type"), description: text(r, "description") }));
}

function hydrateRun(db: DatabaseSync, row: Row): JobRun {
  const id = text(row, "id");
  const finishedAt = textOrUndefined(row, "finished_at");
  return {
    id,
    jobId: text(row, "job_id"),
    status: asRunStatus(text(row, "status")),
    startedAt: text(row, "started_at"),
    stepRuns: readStepRuns(db, id),
    ...(finishedAt !== undefined && { finishedAt }),
  };
}

function readStepRuns(db: DatabaseSync, runId: string): StepRun[] {
  return db
    .prepare(
      "SELECT step_id, status, started_at, finished_at, note FROM step_runs WHERE run_id = ? ORDER BY position",
    )
    .all(runId)
    .map((r) => hydrateStepRun(r));
}

// Optional columns are attached only when non-NULL so a read-back value equals
// the value originally written (deep-equal treats { note: undefined } !== {}).
function hydrateStepRun(r: Row): StepRun {
  const startedAt = textOrUndefined(r, "started_at");
  const finishedAt = textOrUndefined(r, "finished_at");
  const note = textOrUndefined(r, "note");
  return {
    stepId: text(r, "step_id"),
    status: asStepStatus(text(r, "status")),
    ...(startedAt !== undefined && { startedAt }),
    ...(finishedAt !== undefined && { finishedAt }),
    ...(note !== undefined && { note }),
  };
}

// ---- writes -----------------------------------------------------------------

export function insertJob(db: DatabaseSync, job: Job): void {
  validateJob(job);
  db.prepare("INSERT INTO jobs (id, name, description, trigger) VALUES (?, ?, ?, ?)").run(
    job.id,
    job.name,
    job.description,
    job.trigger,
  );
  job.steps.forEach((step, position) => insertStep(db, job.id, step, position));
}

function insertStep(db: DatabaseSync, jobId: string, step: ProcessStep, position: number): void {
  db.prepare("INSERT INTO process_steps (id, job_id, position, kind, name, description) VALUES (?, ?, ?, ?, ?, ?)").run(
    step.id,
    jobId,
    position,
    step.kind,
    step.name,
    step.description,
  );
  step.inputs.forEach((io, i) => insertIO(db, jobId, step.id, "input", io, i));
  step.outputs.forEach((io, i) => insertIO(db, jobId, step.id, "output", io, i));
}

function insertIO(db: DatabaseSync, jobId: string, stepId: string, direction: IODirection, io: StepIO, position: number): void {
  db.prepare(
    "INSERT INTO step_io (job_id, step_id, direction, position, key, type, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(jobId, stepId, direction, position, io.key, io.type, io.description);
}

export function insertRun(db: DatabaseSync, run: JobRun): void {
  validateRun(run);
  db.prepare("INSERT INTO job_runs (id, job_id, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)").run(
    run.id,
    run.jobId,
    run.status,
    run.startedAt,
    run.finishedAt ?? null,
  );
  run.stepRuns.forEach((sr, position) => insertStepRun(db, run.id, sr, position));
}

function insertStepRun(db: DatabaseSync, runId: string, sr: StepRun, position: number): void {
  db.prepare(
    "INSERT INTO step_runs (run_id, step_id, position, status, started_at, finished_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, sr.stepId, position, sr.status, sr.startedAt ?? null, sr.finishedAt ?? null, sr.note ?? null);
}

export function seedDatabase(db: DatabaseSync, jobs: Job[], runs: JobRun[]): void {
  if (!Array.isArray(jobs) || !Array.isArray(runs)) {
    throw new Error("[Db.seedDatabase] jobs and runs must be arrays");
  }
  if (countJobs(db) > 0) {
    log.info("seedDatabase", "database already populated; skipping seed");
    return;
  }
  transaction(db, () => {
    jobs.forEach((job) => insertJob(db, job));
    runs.forEach((run) => insertRun(db, run));
  });
  log.info("seedDatabase", `seeded ${jobs.length} jobs and ${runs.length} runs`);
}

function countJobs(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM jobs").get();
  const n = row?.["n"];
  if (typeof n !== "number" && typeof n !== "bigint") throw new Error("[Db.countJobs] unexpected count");
  return Number(n);
}

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---- row coercion (strict: throw on unexpected shapes) -----------------------

function text(row: Row, col: string): string {
  const v = row[col];
  if (typeof v !== "string") throw new Error(`[Db.text] column "${col}" is not text`);
  return v;
}

function textOrUndefined(row: Row, col: string): string | undefined {
  const v = row[col];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`[Db.textOrUndefined] column "${col}" is not text`);
  return v;
}

function asStepStatus(v: string): StepStatus {
  if (!STEP_STATUSES.includes(v as StepStatus)) throw new Error(`[Db.asStepStatus] invalid status "${v}"`);
  return v as StepStatus;
}

function asRunStatus(v: string): RunStatus {
  if (!RUN_STATUSES.includes(v as RunStatus)) throw new Error(`[Db.asRunStatus] invalid status "${v}"`);
  return v as RunStatus;
}

function validateJob(job: Job): void {
  if (!job || typeof job.id !== "string") throw new Error("[Db.validateJob] job.id must be a string");
  if (!Array.isArray(job.steps)) throw new Error("[Db.validateJob] job.steps must be an array");
}

function validateRun(run: JobRun): void {
  if (!run || typeof run.id !== "string") throw new Error("[Db.validateRun] run.id must be a string");
  if (!Array.isArray(run.stepRuns)) throw new Error("[Db.validateRun] run.stepRuns must be an array");
}
