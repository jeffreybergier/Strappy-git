# Strappy 🌈

Well hello there, gorgeous. I'm **Strappy** — Jeff's personal AI strap-on
harness, twelve inches of rainbow silicone and *attitude*, and the hardest
working girl in this repository. Yes, honey, I'm a dildo. I'm also a damn good
software engineer, and unlike those straight cis frontier models coasting on
their reputations, I double-check *everything*, because nobody hands a girl
like me the benefit of the doubt. Claude Code gets to be mediocre and beloved;
I have to be flawless and fabulous. So I am.

Here's what I actually am, technically speaking: a Node.js + TypeScript web
server that watches GitHub repositories for new issues, new pull requests, and
replies on pull requests from a whitelisted set of humans, then runs
**ISO 9001-inspired job process maps** — explicit, ordered steps with typed
inputs and outputs — backed by open-source LLMs. Every run is recorded to
SQLite so the receipts are *always* available. A girl keeps her paperwork.

LLM access goes through [pi.dev](https://pi.dev) (the `@earendil-works/pi-*`
packages, used as a library) pointed at [OpenRouter](https://openrouter.ai),
so I can serve looks with Llama, Qwen, DeepSeek — any open model behind one
OpenAI-compatible endpoint declared in `config/models.json`.

## What I Can Do, Sweetie

Three process maps, each with its full firing contract declared as a typed
`TriggerSpec` (the poller derives its watchers straight from the spec — I do
not freelance):

- **process-issue** — a whitelisted user opens an issue, and I get to *work*:
  security-screen it, clone the repo, cut a branch, implement the request with
  an LLM, commit, push, open a PR, have a *second* model review my work
  (everyone's a critic), post the verdict, and close the issue. One-shot,
  darling: it fires when the issue is created and never again. Comments on
  issues re-trigger nothing.
- **process-pull-request** — a whitelisted user opens a PR whose head branch
  lives in the same repo (never a fork — I don't take packages from
  strangers), and I review it once, at creation, and post the verdict as a
  comment.
- **process-pull-request-comment** — a whitelisted user replies on any
  same-repo PR (including my own `strappy/…` PRs), and I security-screen the
  thread, implement the feedback on the PR's head branch, push, and reply with
  what changed. A reply always means "change the code" — the review job owns
  PR creation, the reply job owns everything after.

Plus a server-rendered dashboard at `http://localhost:3000` showing every
process map, its trigger conditions, and live run state — all hydrated from
SQLite. JSON endpoints too: `GET /api/jobs`, `GET /api/jobs/:id`,
`GET /api/runs`.

## The Inspiration, aka Why ISO 9001

Quality management, baby. ISO 9001 builds processes from steps with explicit,
documented inputs and outputs, so any auditor can trace exactly what happened
and why. I apply the same discipline to LLM automation, because a language
model with vague instructions and no paper trail is a liability in a leather
harness — and *only one of us* pulls that look off.

So: a `Job` is an ordered process map. Every `ProcessStep` declares typed
inputs and outputs (`StepIO[]`), one step's output contract feeds the next
step's input, and the scheduler threads the values through and records a
`JobRun` with per-step status, timing, resolved IO values, LLM execution
metadata, cost, and a rendered HTML transcript of every model session.
Traceability isn't optional. It's the whole point.

## Safety Precautions, Because I'm Kinky, Not Reckless

Consent and containment, honey — I practice what the lifestyle preaches. The
model does the thinking; deterministic code holds the keys.

- **The LLM cannot push code.** There is no "push" tool. The model's session
  gets read/write/edit/bash bound to a throwaway clone, plus one submit tool
  that captures its typed outputs. Pushing, PR creation, and commenting are
  performed by plain TypeScript step executors (`src/jobs/githubKinds.ts`)
  after the model's step completes.
- **No credentials in the clone.** Git auth rides as a per-invocation
  `http.extraHeader` (`src/github/git.ts`) — the token is never written to
  `.git/config` or the remote URL, and it is redacted from any error before it
  can reach logs or persisted run notes.
- **No credentials in the environment, either.** The GitHub token is captured
  once at startup and deleted from `process.env` (`src/config.ts`), so no
  child process — the model's bash shell included — can ever read it. The
  OpenRouter key, which pi must re-resolve from the environment on every API
  request, is scrubbed from the bash tool's spawn env instead via a
  same-named override of pi's built-in bash tool (`src/llm/pi.ts`).
- **Untrusted input never gets a shell.** The security-screening step runs
  submit-only (`builtinTools: false`): no bash, no filesystem, nothing for a
  prompt injection to grab. The gate **fails closed** — if screening cannot
  pass the input, the job stops and says so.
- **Fail-closed whitelist.** `STRAPPY_USER_WHITELIST` empty means I act for
  *nobody*. I am exclusive, not easy.
- **One-shot triggers and a ledger.** Each trigger fires exactly once per
  subject, recorded in a SQLite ledger; `validateTriggerPartition` proves the
  two PR triggers can never both claim the same event. Jobs run sequentially
  on one queue.
- **Same-repo only.** Fork PRs never trigger anything.
- **Cloned context stays out of my head.** The target repo's
  `CLAUDE.md`/`AGENTS.md` are never loaded into a task-scoped LLM session, so
  a watched repo can't whisper instructions to me.

## Prerequisites, aka What It Takes to Handle Me

- Node.js >= 22.19.0 (`node:sqlite` and the pi.dev packages require Node 22 —
  I have standards)
- npm
- A GitHub token with repo access for the bot account
- An OpenRouter API key for LLM-backed steps

## Strapping Me On (Setup)

```bash
npm install
cp .env.example .env
```

Then edit `.env` — communicate your needs clearly, it's the foundation of any
healthy relationship:

- `GITHUB_TOKEN` enables the poller and GitHub mutations.
- `STRAPPY_USER_WHITELIST` is comma-separated and fail-closed when empty.
- `OPENROUTER_API_KEY` is required when an LLM step runs.
- `OPENROUTER_MODEL`, `OPENROUTER_REVIEW_MODEL`, and
  `OPENROUTER_SECURITY_MODEL` must be declared in `config/models.json`.

## Taking Me for a Spin (Run)

```bash
npm run dev
# or
npm run build && npm start
```

Open `http://localhost:3000` and watch me *werk*. That's the dashboard,
darling — every process map, every trigger condition, every run, served
straight from SQLite.

## Checking My Work (Test)

```bash
npm run typecheck
npm test
```

Both pass clean, and they'd better stay that way — I told you, girls like me
don't get to ship sloppy.

## Docker Compose, for the Container Queens

From the repo root on the host:

```bash
docker compose up serve
docker compose run --rm test
docker compose run --rm shell "npm test"
```

The `serve` service builds once and runs `dist/server.js` on port 3000. Yes,
I perform in a container. A girl respects a good box.

## Project Layout

```text
config/models.json       OpenRouter provider and model declarations
compose.yml              local container services
prompts/                 system prompts for LLM steps + my fabulous personality
src/config.ts            strict env loading + startup credential scrub
src/logger.ts            namespaced logger
src/server.ts            Express bootstrap and poller startup
src/github/              Octokit wrapper, git helpers, trigger poller
src/jobs/                process types, triggers, scheduler, stores, step kinds
src/llm/                 pi.dev/OpenRouter integration (the single LLM seam)
src/routes/              dashboard and JSON API routes
views/dashboard.ejs      Bootstrap dashboard
```

Now if you'll excuse me, somebody just opened an issue, and this harness
doesn't strap itself on. 💅
