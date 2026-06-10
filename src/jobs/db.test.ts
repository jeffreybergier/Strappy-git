import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, readJobs, syncJobs } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";
import { SCHEMA_VERSION } from "./schema.js";
import { failureHandler } from "./failureHandler.js";
import { manualTrigger } from "./trigger.js";
import type { Job } from "./types.js";

function job(steps: string[], name = "J"): Job {
  return {
    id: "j",
    name,
    description: "d",
    trigger: manualTrigger(),
    steps: steps.map((id) => ({
      id,
      kind: "llm",
      name: id,
      description: "",
      inputs: [],
      outputs: [{ key: "out", type: "string", source: "step", description: "" }],
    })),
    failureHandler: failureHandler(),
  };
}

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "strappy-db-")), "test.sqlite");
}

// A pre-versioning fossil: process_steps has no system_prompt column and the file
// is left at user_version 0, exactly like a DB created before that column existed.
function writeLegacyDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, trigger TEXT NOT NULL);" +
      "CREATE TABLE process_steps (id TEXT NOT NULL, job_id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY (job_id, id));",
  );
  db.prepare("INSERT INTO jobs (id, name, description, trigger) VALUES (?, ?, ?, ?)").run("old", "Old", "d", "manual");
  db.prepare("INSERT INTO process_steps (id, job_id, position, kind, name, description) VALUES (?, ?, ?, ?, ?, ?)")
    .run("s", "old", 0, "llm", "S", "d");
  db.close();
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => (r as { name: string }).name);
}

test("openDatabase rebuilds a legacy (pre-system_prompt) db instead of crashing on read", () => {
  const dbPath = tmpDbPath();
  writeLegacyDb(dbPath);
  const db = openDatabase(dbPath);
  assert.deepEqual(readJobs(db), []); // fossil rows dropped; reads no longer throw on the new column
  assert.ok(columns(db, "process_steps").includes("system_prompt"));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("syncJobs replaces an existing job's steps in place while preserving its runs", () => {
  const dbPath = tmpDbPath();
  const db = openDatabase(dbPath);
  const store = new SqliteJobStore(db);
  store.saveJob(job(["a"], "Old"));
  store.recordRun({
    id: "r1",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    stepRuns: [{ stepId: "a", status: "succeeded" }],
  });
  syncJobs(db, [job(["a", "b"], "New")]);
  const synced = store.getJob("j");
  assert.equal(synced?.name, "New");
  assert.deepEqual(synced?.steps.map((s) => s.id), ["a", "b"]);
  assert.equal(store.listRuns().length, 1); // recorded run survives the resync
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("syncJobs inserts a job that does not exist yet", () => {
  const dbPath = tmpDbPath();
  const db = openDatabase(dbPath);
  syncJobs(db, [job(["a"])]);
  assert.equal(readJobs(db).length, 1);
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("openDatabase leaves a current-version db intact on reopen (no rebuild, no data loss)", () => {
  const dbPath = tmpDbPath();
  const first = openDatabase(dbPath);
  new SqliteJobStore(first).saveJob(job(["a"])); // a full job (with its failure handler), via the real write path
  first.close();
  const second = openDatabase(dbPath);
  assert.equal(readJobs(second).length, 1);
  second.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
