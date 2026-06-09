# Strappy

A Node.js + TypeScript web server that watches a whitelist of GitHub repos for
new issues and pull requests, then runs **ISO 9001-inspired job process maps**
(steps with explicit, typed inputs and outputs) backed by an LLM.

LLM access goes through **[pi.dev](https://pi.dev)** (the `@earendil-works/pi-*`
packages) talking to **[OpenRouter](https://openrouter.ai)**, so you can run
open-source models (Llama, Qwen, DeepSeek, …) behind one API.

> Status: scaffold. This step sets up dependencies, the web server, and a basic
> jobs dashboard. The GitHub poller and the job scheduler come next.

## Prerequisites

- Node.js >= 20
- An OpenRouter API key — https://openrouter.ai/keys

## Setup

```bash
npm install
cp .env.example .env
# then edit .env and paste your OPENROUTER_API_KEY
```

## Run

```bash
npm run dev      # hot-reloading dev server (tsx)
# or
npm run build && npm start
```

Open http://localhost:3000 for the dashboard. JSON endpoints:

- `GET /api/jobs` — all jobs
- `GET /api/jobs/:id` — one job
- `GET /api/runs` — recent runs

## How OpenRouter is wired

`config/models.json` declares an `openrouter` provider (an OpenAI-compatible
endpoint) and the open-source models you want to expose. Pi loads this file via
`ModelRegistry.create(authStorage, "config/models.json")` and resolves the API
key from the `OPENROUTER_API_KEY` environment variable.

To use a different model, either change `OPENROUTER_MODEL` in `.env` or add a new
entry to `config/models.json` (any [OpenRouter model id](https://openrouter.ai/models)).

The integration lives in `src/llm/pi.ts` — `runPrompt(text)` is the single seam
the future scheduler will call from LLM-backed steps.

## Project layout

```
config/models.json     OpenRouter provider + model declarations (pi.dev format)
src/
  config.ts            strict env loading (throws on missing/invalid)
  logger.ts            namespaced logger -> [Scope.method]
  server.ts            Express bootstrap
  jobs/
    types.ts           ISO 9001 process-map types (Job, ProcessStep, StepIO, JobRun)
    seed.ts            sample jobs + runs
    store.ts           in-memory JobStore
  routes/
    dashboard.ts       GET /  (server-rendered EJS)
    api.ts             GET /api/*  (JSON)
  llm/
    pi.ts              pi.dev + OpenRouter integration (runPrompt)
views/dashboard.ejs    Bootstrap 3 dashboard
```

## The process-map idea

Each `Job` is a process composed of ordered `ProcessStep`s. Every step declares
typed `inputs` and `outputs`, so one step's output contract feeds the next step's
input — the foundation for a traceable, ISO 9001-style scheduler. See the two
seeded jobs (`Triage New Issue`, `Review Pull Request`) on the dashboard.
