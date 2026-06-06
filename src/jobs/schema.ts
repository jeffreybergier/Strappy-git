import { DatabaseSync } from "node:sqlite";

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
  id          TEXT NOT NULL,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (job_id, id)
);

CREATE TABLE IF NOT EXISTS step_io (
  job_id      TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  position    INTEGER NOT NULL,
  key         TEXT NOT NULL,
  type        TEXT NOT NULL,
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
`;

export function applySchema(db: DatabaseSync): void {
  if (!db) throw new Error("[schema.applySchema] db is required");
  db.exec(SCHEMA_SQL);
}
