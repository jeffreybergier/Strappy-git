# AGENTS.md — Strappy

Context for AI agents working on this repo. Read this first to avoid
re-deriving setup. (`AGENTS.md` is the agent-native doc for the
AltivecIntelligence toolchain; it is symlinked as `CLAUDE.md` / `GEMINI.md`
inside the image.)

## What this project is

A Node.js + TypeScript web server that will watch a whitelist of GitHub repos
for new issues and pull requests, then run **ISO 9001-inspired job process
maps** (steps with explicit, typed inputs and outputs) backed by an LLM.

LLM access goes through **[pi.dev](https://pi.dev)** (the `@earendil-works/pi-*`
packages, used as an **SDK / library — not the CLI**) talking to
**[OpenRouter](https://openrouter.ai)**, so we can run open-source models
(Llama, Qwen, DeepSeek, …) behind one OpenAI-compatible endpoint.

> Status: **scaffold**. Web server + dashboard + LLM seam + SQLite persistence
> + tests are done. The GitHub poller and the job scheduler are not built yet.

## Environment / where things live

- Repo root (host-mounted): **`/repo/strappy-git`** — git origin
  `git@github.com:jeffreybergier/Strappy-git.git`.
- Runs inside the `ghcr.io/jeffreybergier/altivec-intelligence:latest` container
  (macOS host runs Docker Desktop). Node v22, npm 11.
- The repo is bind-mounted into the container at `/repo/strappy-git`
  (`.:/repo/strappy-git`). **Files written there persist on the Mac host.**
- ⚠️ **Past gotcha (fixed):** `compose.yml` `working_dir` was once set to a
  path that didn't match the bind-mount, so it had no host backing — files
  written there vanished. Always keep `working_dir` == the bind-mount target
  (`/repo/strappy-git`).

## Commands

Local (inside the container shell):

| Command | What it does |
|---|---|
| `npm run dev` | Hot-reloading dev server (`tsx watch`) on `0.0.0.0:3000` |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run the compiled server (`node dist/server.js`) |
| `npm run typecheck` | `tsc --noEmit` (strict; also checks `*.test.ts`) |
| `npm test` | Node built-in test runner: `node --import tsx --test "src/**/*.test.ts"` |

Via Docker Compose (from the Mac, in the repo root):

| Command | What it does |
|---|---|
| `docker compose up serve` | Start the dashboard; browse `http://localhost:3000` on the Mac |
| `docker compose run --rm test` | Run the test suite once; exits with the test result code |
| `docker compose run --rm altivec-intelligence` | Interactive AI CLI chooser |
| `docker compose run --rm shell "<cmd>"` | One-off command in the toolchain shell |

`compose.yml` services: `altivec-intelligence`, `shell`, `serve`, `test`.
(Names `serve`/`shell` were chosen by the maintainer; don't rename without
asking.)

## How OpenRouter + pi.dev is wired

- `config/models.json` declares an `openrouter` provider — an OpenAI-compatible
  endpoint (`api: "openai-completions"`, `baseUrl:
  "https://openrouter.ai/api/v1"`, `apiKey: "$OPENROUTER_API_KEY"`) and a list
  of open-source models. Pi resolves `$OPENROUTER_API_KEY` from the environment.
- `src/llm/pi.ts` is the **single LLM seam**: `runPrompt(text)` →
  `CompletionResult`. The future scheduler calls this from LLM-backed steps.
  - `AuthStorage.create()` resolves credentials; `ModelRegistry.create(auth,
    config.modelsPath)` loads built-in + custom models from the **repo-local**
    `config/models.json`; `modelRegistry.find(provider, id)` resolves the model.
  - Session: `createAgentSession({ model, tools: [], authStorage,
    modelRegistry, sessionManager: SessionManager.inMemory() })`, then
    `session.subscribe(event => …)` (accumulate `event.assistantMessageEvent.delta`
    when `event.type === "message_update"` and
    `event.assistantMessageEvent.type === "text_delta"`; finish on
    `event.type === "agent_end"`) and `session.prompt(text)`.
- Default model: `OPENROUTER_MODEL` env, falling back to
  `meta-llama/llama-3.3-70b-instruct`. Add models in `config/models.json`
  (any [OpenRouter model id](https://openrouter.ai/models)).
- ⚠️ **Not yet verified end-to-end:** `runPrompt()` typechecks against the real
  Pi SDK types but no live OpenRouter call has been made (needs a key). Verify
  this once `OPENROUTER_API_KEY` is available.

## How persistence (SQLite) is wired

- Jobs, process steps, typed inputs/outputs, and runs persist to a **local
  SQLite file** via Node's **built-in `node:sqlite`** (`DatabaseSync`) — no npm
  dependency, no native build. It's synchronous, so the store stays synchronous.
- File path: `config.dbPath` → `DB_PATH` env, default **`data/strappy.sqlite`**
  (resolved from `process.cwd()`). The whole **`data/` dir is gitignored** along
  with `*.sqlite`/`-wal`/`-shm` — runtime data is never checked in. `data/` is
  created on demand; the DB is **seeded from `seed.ts` only when empty**
  (idempotent), so deleting the file just regenerates the sample jobs.
- Schema lives in `src/jobs/schema.ts` (one `CREATE TABLE IF NOT EXISTS` block):
  `jobs → process_steps → step_io` (inputs + outputs in one table keyed by a
  `direction` column) and `job_runs → step_runs`. Ordered relations carry an
  explicit `position` column so `ORDER BY` round-trips step/IO order. Composite
  FKs cascade; `PRAGMA foreign_keys = ON` + WAL are set on open.
- `src/jobs/db.ts` is the **data-access seam**: `openDatabase()`,
  `seedDatabase()`, hydrating reads (`readJobs/readJob/readRuns`) and inserts.
  Row coercion is strict — it throws on unexpected column shapes/statuses.
- `src/jobs/sqliteStore.ts` (`SqliteJobStore`) implements the shared
  `JobReadStore` interface (same read surface as the in-memory `JobStore`, so
  routes accept either) and adds `saveJob()` / `recordRun()` write methods — the
  persistence seam the future scheduler will call to record real `JobRun`s.

## Environment variables

Copy `.env.example` → `.env` (the repo `.gitignore` ignores `.env`, keeps
`.env.example`). `dotenv` loads `.env` from the working dir.

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | (none) | OpenRouter key; required only when an LLM step runs |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct` | Default model id |
| `PORT` | `3000` | Dashboard port |
| `HOST` | `0.0.0.0` | Bind interface (keep `0.0.0.0` for Docker reachability) |
| `DB_PATH` | `data/strappy.sqlite` | SQLite file path (gitignored; auto-created + seeded) |

## Project structure

```
config/models.json     OpenRouter provider + model declarations (pi.dev format)
compose.yml            Docker services: altivec-intelligence, shell, serve, test
src/
  config.ts            strict env loading (throws on missing/invalid)
  logger.ts            namespaced logger -> [Scope.method]
  server.ts            Express bootstrap; binds config.host:config.port
  jobs/
    types.ts           ISO 9001 types: Job, ProcessStep, StepIO, JobRun, StepRun
    seed.ts            sample jobs (Triage New Issue, Review Pull Request) + runs
    store.ts           in-memory JobStore + JobReadStore interface
    store.test.ts      JobStore tests
    schema.ts          SQLite DDL (jobs, process_steps, step_io, *_runs)
    db.ts              node:sqlite data-access: open/seed/read/insert
    sqliteStore.ts     SqliteJobStore (JobReadStore + saveJob/recordRun)
    sqliteStore.test.ts  SqliteJobStore round-trip tests (in-memory db)
  routes/
    dashboard.ts       GET /  (server-rendered EJS)
    api.ts             GET /api/jobs|/api/jobs/:id|/api/runs (JSON)
  llm/
    pi.ts              pi.dev + OpenRouter integration (runPrompt) — the LLM seam
  config.test.ts       requireOpenRouterKey tests
  logger.test.ts       createLogger tests
views/dashboard.ejs    Bootstrap 3 (CDN) dashboard rendering the process maps
```

## The ISO 9001 process-map model

A `Job` is a process of ordered `ProcessStep`s. Every step declares typed
`inputs` and `outputs` (`StepIO[]`), so one step's output contract feeds the
next step's input — the foundation for a traceable scheduler. A `JobRun` (with
per-step `StepRun`s) records an execution. See the two seeded jobs on the
dashboard. The scheduler should thread each step's `outputs` into the next
step's `inputs` and record a real `JobRun`.

## Conventions this codebase follows

- TypeScript **ESM + `NodeNext`** module resolution → relative imports use `.js`
  extensions in `.ts` source (e.g. `import { config } from "./config.js"`).
  This is required, not a typo.
- **Strict TS** (`strict`, `noUncheckedIndexedAccess`). Functions validate args
  and **throw on invalid input or missing dependencies** (strict init).
- Functions stay **short**; avoid nesting deeper than 2 levels; **minimal
  comments**; **2-space** indentation.
- **Namespaced logging** via `createLogger(scope)` → `[Scope.method] message`.
- Wrap async / complex logic in `try/catch`.
- Path resolution uses `process.cwd()` (views, `config/models.json`), so the app
  **must be run from the repo root** (the compose `working_dir`).
- Tests use Node's built-in runner (`node:test` + `node:assert/strict`), no
  extra test deps; run through the `tsx` loader. Node 22's `--test` glob +
  loader propagation to child processes is what makes `*.test.ts` run.

## Verified working

- `npm install` clean; `npm run typecheck` clean (incl. `*.test.ts`).
- `npm test` → 18 passing (9 store/logger/config + 9 SqliteJobStore).
- Dashboard boots, binds `0.0.0.0:3000`, `GET /` returns 200, renders the
  seeded process maps **served from SQLite**; `GET /api/jobs` / `/api/runs`
  return JSON hydrated from `data/strappy.sqlite` (auto-created + seeded; the
  file is gitignored — `git check-ignore` confirms).
- (Could not run `docker compose` in the build sandbox — no daemon. The maintainer
  confirmed `docker compose up serve` works from the Mac.)

## Next steps / open items

1. **GitHub poller** — whitelist + interval check for new issues/PRs (likely
   `octokit`), emitting trigger events keyed to `Job.trigger`
   (`github.issue.opened`, `github.pull_request.opened`).
2. **Scheduler engine** — execute a `Job`'s steps in order, threading
   `outputs → inputs`, recording a real `JobRun`/`StepRun`s (persist via
   `SqliteJobStore.recordRun()`), calling `runPrompt()` from LLM-backed steps.
3. **Live-verify** `runPrompt()` against OpenRouter once a key is set.
4. Optional: wire `OPENROUTER_API_KEY` into the `serve` service (e.g.
   `env_file: .env`) so LLM steps work under compose.
5. Optional tidy-up: `*.test.ts` under `src/` get emitted to `dist/` on build
   (inert, gitignored). Add a `tsconfig.build.json` that excludes tests if a
   clean `dist/` is wanted.

## House rules

- Do **not** commit or push unless explicitly asked.
- Prefer debug builds; only do release builds when asked.
- Keep changes small and incremental (Kaizen).
