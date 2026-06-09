# Strappy

A Node.js + TypeScript web server that watches GitHub issues from a
whitelisted set of users, runs an explicit typed job process, and records each
run in SQLite for auditability.

LLM access goes through [pi.dev](https://pi.dev) using the
`@earendil-works/pi-*` packages as a library, pointed at
[OpenRouter](https://openrouter.ai) through an OpenAI-compatible provider
configured in `config/models.json`.

## Status

This repo is beyond the initial scaffold:

- Express dashboard and JSON API are implemented.
- SQLite persistence stores jobs, process steps, IO contracts, runs, step IO
  values, LLM executions, transcripts, and trigger ledger state.
- The GitHub issue poller is implemented. It auto-discovers repos the token can
  push to, gates triggers by a user whitelist, and runs jobs sequentially.
- The scheduler is implemented. It executes steps in order, threads typed
  outputs into later inputs, records in-progress and final run state, and skips
  remaining steps after a failure.
- The real `process-issue` job is defined: fetch issue, security scan, comment
  the verdict, clone, branch, implement with an LLM, commit/push, open a PR,
  review with a second LLM, comment on the PR, and close the issue.

## Prerequisites

- Node.js >= 22.19.0 (`node:sqlite` and the pi.dev packages require Node 22)
- npm
- A GitHub token with repo access for the bot account
- An OpenRouter API key for LLM-backed steps

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env`:

- `GITHUB_TOKEN` enables the poller and GitHub mutations.
- `STRAPPY_USER_WHITELIST` is comma-separated and fail-closed when empty.
- `OPENROUTER_API_KEY` is required when an LLM step runs.
- `OPENROUTER_MODEL` and `OPENROUTER_REVIEW_MODEL` must be declared in
  `config/models.json`.

## Run

```bash
npm run dev
# or
npm run build && npm start
```

Open `http://localhost:3000` for the dashboard.

JSON endpoints:

- `GET /api/jobs` - all process definitions
- `GET /api/jobs/:id` - one process definition
- `GET /api/runs` - recorded runs

## Test

```bash
npm run typecheck
npm test
```

## Docker Compose

From the repo root on the host:

```bash
docker compose up serve
docker compose run --rm test
docker compose run --rm shell "npm test"
```

The `serve` service builds once and runs `dist/server.js` on port 3000.

## Project Layout

```text
config/models.json       OpenRouter provider and model declarations
compose.yml              local container services
prompts/                 system prompts used by LLM-backed steps
src/config.ts            strict env loading
src/logger.ts            namespaced logger
src/server.ts            Express bootstrap and poller startup
src/github/              Octokit wrapper, git helpers, issue poller
src/jobs/                process types, scheduler, stores, SQLite, step kinds
src/llm/                 pi.dev/OpenRouter integration and submit schemas
src/routes/              dashboard and JSON API routes
views/dashboard.ejs      Bootstrap dashboard
```

## Process Model

A `Job` is an ordered process map. Each `ProcessStep` declares typed inputs and
outputs (`StepIO[]`). The scheduler resolves inputs from trigger constants,
static prompt content, or the previous step's outputs. Values that must cross
multiple steps are explicitly carried as `pass` IO.

Every run records a `JobRun` with per-step status, timing, resolved IO values,
and LLM execution metadata when present. The dashboard renders both the static
process map and live run state from SQLite.
