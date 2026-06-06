import { DatabaseSync } from "node:sqlite";

// Bump whenever SCHEMA_SQL changes shape. openDatabase() rebuilds an on-disk DB
// stamped with an older version, so a stale file self-heals instead of crashing
// on a column it predates (the data dir is disposable by design).
export const SCHEMA_VERSION = 3;

// Relational mirror of the ISO 9001 process-map model in types.ts.
// process_steps keep `position` so ordered steps survive a round-trip;
// step_io folds inputs + outputs into one table via the `direction` column.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS process_steps (
  id            TEXT NOT NULL,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  system_prompt TEXT,
  PRIMARY KEY (job_id, id)
);

CREATE TABLE IF NOT EXISTS step_io (
  job_id      TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  position    INTEGER NOT NULL,
  key         TEXT NOT NULL,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('trigger', 'static', 'step', 'pass', 'receipt')),
  description TEXT NOT NULL,
  PRIMARY KEY (job_id, step_id, direction, key),
  FOREIGN KEY (job_id, step_id) REFERENCES process_steps(job_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS step_runs (
  run_id      TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  note        TEXT,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS step_executions (
  run_id        TEXT NOT NULL,
  step_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  stop_reason   TEXT NOT NULL,
  text          TEXT NOT NULL,
  thinking      TEXT,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens  INTEGER NOT NULL,
  cost_total    REAL NOT NULL,
  tool_calls    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id, step_id) REFERENCES step_runs(run_id, step_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS processed_triggers (
  repo         TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  run_id       TEXT,
  status       TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (repo, issue_number)
);
`;

export function applySchema(db: DatabaseSync): void {
  if (!db) throw new Error("[schema.applySchema] db is required");
  db.exec(SCHEMA_SQL);
}
