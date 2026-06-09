import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../logger.js";
import { applySchema, SCHEMA_VERSION } from "./schema.js";
import { asIoSource, asIoType } from "./io.js";
import type {
  FailureHandler,
  IoValues,
  Job,
  JobRun,
  LlmExecution,
  ProcessStep,
  RunStatus,
  StepIO,
  StepRun,
  StepStatus,
  ToolCallRecord,
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
  migrateSchema(db);
  applySchema(db);
  log.info("openDatabase", `opened sqlite database at ${dbPath}`);
  return db;
}

// Self-heals a stale on-disk schema so a fossil DB reseeds instead of crashing.
// Any user_version other than the current one (a pre-versioning 0, or an older
// numbered schema whose columns predate the current shape) has its tables
// dropped; applySchema() recreates the current shape and the now-empty DB
// re-seeds. Dropping is safe: the data dir is disposable (the documented "delete
// the file to regenerate" recovery), so local runs/ledger regenerate too.
function migrateSchema(db: DatabaseSync): void {
  const version = userVersion(db);
  if (version === SCHEMA_VERSION) return;
  if (hasTable(db, "jobs")) {
    log.warn("migrateSchema", `schema v${version} != v${SCHEMA_VERSION}; rebuilding disposable db`);
    dropAllTables(db);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Row | undefined;
  const v = row?.["user_version"];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error("[Db.userVersion] user_version is not an integer");
  }
  return v;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function dropAllTables(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF;");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${text(t as Row, "name")}"`);
  db.exec("PRAGMA foreign_keys = ON;");
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
    .prepare("SELECT id, kind, name, description, system_prompt FROM process_steps WHERE job_id = ? ORDER BY position")
    .all(id);
  return {
    id,
    name: text(row, "name"),
    description: text(row, "description"),
    trigger: text(row, "trigger"),
    steps: stepRows.map((s) => hydrateStep(db, id, s)),
    failureHandler: readFailureHandler(db, id),
  };
}

function readFailureHandler(db: DatabaseSync, jobId: string): FailureHandler {
  const row = db.prepare("SELECT id, name, description FROM failure_handlers WHERE job_id = ?").get(jobId);
  if (row === undefined) throw new Error(`[Db.readFailureHandler] job "${jobId}" has no failure handler`);
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    description: text(row, "description"),
    inputs: readFailureHandlerIO(db, jobId),
  };
}

function readFailureHandlerIO(db: DatabaseSync, jobId: string): StepIO[] {
  return db
    .prepare("SELECT key, type, source, description, guidance FROM failure_handler_io WHERE job_id = ? ORDER BY position")
    .all(jobId)
    .map((r) => {
      const guidance = textOrUndefined(r, "guidance");
      return {
        key: text(r, "key"),
        type: asIoType(text(r, "type")),
        source: asIoSource(text(r, "source")),
        description: text(r, "description"),
        ...(guidance !== undefined && { guidance }),
      };
    });
}

function hydrateStep(db: DatabaseSync, jobId: string, row: Row): ProcessStep {
  const stepId = text(row, "id");
  const systemPrompt = textOrUndefined(row, "system_prompt");
  return {
    id: stepId,
    kind: text(row, "kind"),
    name: text(row, "name"),
    description: text(row, "description"),
    ...(systemPrompt !== undefined && { systemPrompt }),
    inputs: readIO(db, jobId, stepId, "input"),
    outputs: readIO(db, jobId, stepId, "output"),
  };
}

function readIO(db: DatabaseSync, jobId: string, stepId: string, direction: IODirection): StepIO[] {
  return db
    .prepare(
      "SELECT key, type, source, description, guidance FROM step_io WHERE job_id = ? AND step_id = ? AND direction = ? ORDER BY position",
    )
    .all(jobId, stepId, direction)
    .map((r) => {
      const guidance = textOrUndefined(r, "guidance");
      return {
        key: text(r, "key"),
        type: asIoType(text(r, "type")),
        source: asIoSource(text(r, "source")),
        description: text(r, "description"),
        ...(guidance !== undefined && { guidance }),
      };
    });
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
    .map((r) => hydrateStepRun(db, runId, r));
}

// Optional columns are attached only when non-NULL so a read-back value equals
// the value originally written (deep-equal treats { note: undefined } !== {}).
function hydrateStepRun(db: DatabaseSync, runId: string, r: Row): StepRun {
  const stepId = text(r, "step_id");
  const startedAt = textOrUndefined(r, "started_at");
  const finishedAt = textOrUndefined(r, "finished_at");
  const note = textOrUndefined(r, "note");
  const inputs = readIOValues(db, runId, stepId, "input");
  const outputs = readIOValues(db, runId, stepId, "output");
  const execution = readExecution(db, runId, stepId);
  return {
    stepId,
    status: asStepStatus(text(r, "status")),
    ...(startedAt !== undefined && { startedAt }),
    ...(finishedAt !== undefined && { finishedAt }),
    ...(note !== undefined && { note }),
    ...(inputs !== undefined && { inputs }),
    ...(outputs !== undefined && { outputs }),
    ...(execution !== undefined && { execution }),
  };
}

// Returns undefined (not {}) when nothing was recorded, so a value-free step run
// round-trips equal to one that never had values. JSON.parse restores each
// value's original scalar type (string/number/integer/boolean).
function readIOValues(db: DatabaseSync, runId: string, stepId: string, direction: IODirection): IoValues | undefined {
  const rows = db
    .prepare("SELECT key, value FROM step_io_values WHERE run_id = ? AND step_id = ? AND direction = ? ORDER BY position")
    .all(runId, stepId, direction);
  if (rows.length === 0) return undefined;
  const values: IoValues = {};
  for (const r of rows) values[text(r as Row, "key")] = JSON.parse(text(r as Row, "value"));
  return values;
}

function readExecution(db: DatabaseSync, runId: string, stepId: string): LlmExecution | undefined {
  const row = db
    .prepare("SELECT * FROM step_executions WHERE run_id = ? AND step_id = ?")
    .get(runId, stepId);
  if (row === undefined) return undefined;
  const thinking = textOrUndefined(row, "thinking");
  const transcriptPath = textOrUndefined(row, "transcript_path");
  return {
    provider: text(row, "provider"),
    model: text(row, "model"),
    stopReason: text(row, "stop_reason"),
    text: text(row, "text"),
    ...(thinking !== undefined && { thinking }),
    toolCalls: parseToolCalls(text(row, "tool_calls")),
    usage: {
      inputTokens: integer(row, "input_tokens"),
      outputTokens: integer(row, "output_tokens"),
      totalTokens: integer(row, "total_tokens"),
      costTotal: real(row, "cost_total"),
    },
    ...(transcriptPath !== undefined && { transcriptPath }),
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
  insertFailureHandler(db, job.id, job.failureHandler);
}

// Re-applies canonical (code-defined) job definitions so the dashboard tracks the
// code even when the DB was seeded with an older shape. Call on boot after
// seedDatabase; unlike seeding, it does not skip a populated DB.
export function syncJobs(db: DatabaseSync, jobs: Job[]): void {
  if (!Array.isArray(jobs)) throw new Error("[Db.syncJobs] jobs must be an array");
  jobs.forEach((job) => upsertJob(db, job));
  log.info("syncJobs", `synced ${jobs.length} job definition(s)`);
}

// Upserts one job: the jobs row is updated in place (never deleted, so cascading
// job_runs survive) and its steps + io are replaced wholesale.
export function upsertJob(db: DatabaseSync, job: Job): void {
  validateJob(job);
  transaction(db, () => {
    const exists = db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(job.id) !== undefined;
    if (exists) {
      db.prepare("UPDATE jobs SET name = ?, description = ?, trigger = ? WHERE id = ?").run(
        job.name,
        job.description,
        job.trigger,
        job.id,
      );
      db.prepare("DELETE FROM process_steps WHERE job_id = ?").run(job.id); // cascades step_io
      db.prepare("DELETE FROM failure_handlers WHERE job_id = ?").run(job.id); // cascades failure_handler_io
    } else {
      db.prepare("INSERT INTO jobs (id, name, description, trigger) VALUES (?, ?, ?, ?)").run(
        job.id,
        job.name,
        job.description,
        job.trigger,
      );
    }
    job.steps.forEach((step, position) => insertStep(db, job.id, step, position));
    insertFailureHandler(db, job.id, job.failureHandler);
  });
}

function insertStep(db: DatabaseSync, jobId: string, step: ProcessStep, position: number): void {
  db.prepare(
    "INSERT INTO process_steps (id, job_id, position, kind, name, description, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    step.id,
    jobId,
    position,
    step.kind,
    step.name,
    step.description,
    step.systemPrompt ?? null,
  );
  step.inputs.forEach((io, i) => insertIO(db, jobId, step.id, "input", io, i));
  step.outputs.forEach((io, i) => insertIO(db, jobId, step.id, "output", io, i));
}

function insertIO(db: DatabaseSync, jobId: string, stepId: string, direction: IODirection, io: StepIO, position: number): void {
  db.prepare(
    "INSERT INTO step_io (job_id, step_id, direction, position, key, type, source, description, guidance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(jobId, stepId, direction, position, io.key, io.type, io.source, io.description, io.guidance ?? null);
}

function insertFailureHandler(db: DatabaseSync, jobId: string, handler: FailureHandler): void {
  db.prepare("INSERT INTO failure_handlers (job_id, id, name, description) VALUES (?, ?, ?, ?)").run(
    jobId,
    handler.id,
    handler.name,
    handler.description,
  );
  handler.inputs.forEach((io, position) => insertFailureHandlerIO(db, jobId, io, position));
}

function insertFailureHandlerIO(db: DatabaseSync, jobId: string, io: StepIO, position: number): void {
  db.prepare(
    "INSERT INTO failure_handler_io (job_id, position, key, type, source, description, guidance) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(jobId, position, io.key, io.type, io.source, io.description, io.guidance ?? null);
}

// Idempotent record of one run: the existing row is deleted (the ON DELETE
// CASCADE chain clears its step_runs + step_executions) and reinserted, so the
// scheduler can persist the same run id repeatedly — first as "running", then
// after each step, then finalized — and the dashboard sees it live.
export function upsertRun(db: DatabaseSync, run: JobRun): void {
  validateRun(run);
  transaction(db, () => {
    db.prepare("DELETE FROM job_runs WHERE id = ?").run(run.id);
    insertRun(db, run);
  });
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
  if (sr.inputs) insertIOValues(db, runId, sr.stepId, "input", sr.inputs);
  if (sr.outputs) insertIOValues(db, runId, sr.stepId, "output", sr.outputs);
  if (sr.execution) insertExecution(db, runId, sr.stepId, sr.execution);
}

// Persists a step's resolved IO bag as one JSON-encoded row per key, preserving
// iteration order via `position` so a read-back orders stably.
function insertIOValues(db: DatabaseSync, runId: string, stepId: string, direction: IODirection, values: IoValues): void {
  Object.entries(values).forEach(([key, value], position) => {
    db.prepare(
      "INSERT INTO step_io_values (run_id, step_id, direction, position, key, value) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(runId, stepId, direction, position, key, JSON.stringify(value));
  });
}

function insertExecution(db: DatabaseSync, runId: string, stepId: string, exec: LlmExecution): void {
  validateExecution(exec);
  db.prepare(
    "INSERT INTO step_executions (run_id, step_id, provider, model, stop_reason, text, thinking, input_tokens, output_tokens, total_tokens, cost_total, tool_calls, transcript_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    runId,
    stepId,
    exec.provider,
    exec.model,
    exec.stopReason,
    exec.text,
    exec.thinking ?? null,
    exec.usage.inputTokens,
    exec.usage.outputTokens,
    exec.usage.totalTokens,
    exec.usage.costTotal,
    JSON.stringify(exec.toolCalls),
    exec.transcriptPath ?? null,
  );
}

// ---- de-dupe ledger ---------------------------------------------------------
// One row per (repo, issue) Strappy has acted on. last_comment_id is the id of
// the newest whitelisted comment a run has consumed, so the poller re-runs only
// for a strictly newer one — each new-issue/new-comment trigger fires exactly
// once and the system can never self-trigger (its own comments aren't
// whitelisted, so they never raise the mark).

export function isTriggerProcessed(db: DatabaseSync, repo: string, issueNumber: number): boolean {
  if (typeof repo !== "string" || repo === "") throw new Error("[Db.isTriggerProcessed] repo must be a non-empty string");
  if (!Number.isInteger(issueNumber)) throw new Error("[Db.isTriggerProcessed] issueNumber must be an integer");
  const row = db.prepare("SELECT 1 AS hit FROM processed_triggers WHERE repo = ? AND issue_number = ?").get(repo, issueNumber);
  return row !== undefined;
}

// The watermark: the newest whitelisted comment id already acted on, or 0 when
// the issue has no row yet (so any real comment id clears it).
export function lastProcessedComment(db: DatabaseSync, repo: string, issueNumber: number): number {
  if (typeof repo !== "string" || repo === "") throw new Error("[Db.lastProcessedComment] repo must be a non-empty string");
  if (!Number.isInteger(issueNumber)) throw new Error("[Db.lastProcessedComment] issueNumber must be an integer");
  const row = db.prepare("SELECT last_comment_id FROM processed_triggers WHERE repo = ? AND issue_number = ?").get(repo, issueNumber);
  if (row === undefined) return 0;
  const value = (row as Row).last_comment_id;
  if (typeof value !== "number") throw new Error("[Db.lastProcessedComment] last_comment_id must be a number");
  return value;
}

// Claim a (re-)run: INSERT OR REPLACE so a re-trigger updates the same row with
// the new run id and the comment id that triggered it (0 for a new-issue run).
export function markTriggerProcessing(db: DatabaseSync, repo: string, issueNumber: number, runId: string, lastCommentId: number): void {
  if (typeof repo !== "string" || repo === "") throw new Error("[Db.markTriggerProcessing] repo must be a non-empty string");
  if (!Number.isInteger(issueNumber)) throw new Error("[Db.markTriggerProcessing] issueNumber must be an integer");
  if (typeof runId !== "string" || runId === "") throw new Error("[Db.markTriggerProcessing] runId must be a non-empty string");
  if (!Number.isInteger(lastCommentId) || lastCommentId < 0) throw new Error("[Db.markTriggerProcessing] lastCommentId must be a non-negative integer");
  db.prepare(
    "INSERT OR REPLACE INTO processed_triggers (repo, issue_number, run_id, status, processed_at, last_comment_id) VALUES (?, ?, ?, 'processing', ?, ?)",
  ).run(repo, issueNumber, runId, new Date().toISOString(), lastCommentId);
}

export function setTriggerStatus(db: DatabaseSync, repo: string, issueNumber: number, status: string): void {
  if (typeof status !== "string" || status === "") throw new Error("[Db.setTriggerStatus] status must be a non-empty string");
  db.prepare("UPDATE processed_triggers SET status = ? WHERE repo = ? AND issue_number = ?").run(status, repo, issueNumber);
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

// node:sqlite hands back INTEGER columns as number or, for large values, bigint.
function integer(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new Error(`[Db.integer] column "${col}" is not an integer`);
}

function real(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  throw new Error(`[Db.real] column "${col}" is not a number`);
}

function parseToolCalls(json: string): ToolCallRecord[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("[Db.parseToolCalls] tool_calls is not an array");
  return parsed.map((c) => asToolCall(c));
}

function asToolCall(c: unknown): ToolCallRecord {
  if (c === null || typeof c !== "object") throw new Error("[Db.asToolCall] tool call must be an object");
  const { id, name, arguments: args } = c as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string") throw new Error("[Db.asToolCall] tool call id/name must be strings");
  if (args === null || typeof args !== "object") throw new Error("[Db.asToolCall] tool call arguments must be an object");
  return { id, name, arguments: args as Record<string, unknown> };
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
  if (!job.failureHandler || !Array.isArray(job.failureHandler.inputs)) {
    throw new Error("[Db.validateJob] job.failureHandler must declare inputs");
  }
}

function validateRun(run: JobRun): void {
  if (!run || typeof run.id !== "string") throw new Error("[Db.validateRun] run.id must be a string");
  if (!Array.isArray(run.stepRuns)) throw new Error("[Db.validateRun] run.stepRuns must be an array");
}

function validateExecution(exec: LlmExecution): void {
  if (!exec || typeof exec.text !== "string") throw new Error("[Db.validateExecution] execution.text must be a string");
  if (!Array.isArray(exec.toolCalls)) throw new Error("[Db.validateExecution] execution.toolCalls must be an array");
  if (!exec.usage || typeof exec.usage.totalTokens !== "number") throw new Error("[Db.validateExecution] execution.usage is required");
}
