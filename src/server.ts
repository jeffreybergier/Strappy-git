import "dotenv/config";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import { config, gitHubToken } from "./config.js";
import { createLogger } from "./logger.js";
import type { JobReadStore } from "./jobs/store.js";
import { openDatabase, seedDatabase, syncJobs } from "./jobs/db.js";
import { SqliteJobStore } from "./jobs/sqliteStore.js";
import { seedJobs, seedRuns } from "./jobs/seed.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { apiRouter } from "./routes/api.js";
import type { RetryDeps } from "./routes/api.js";
import { createGitHubClient } from "./github/client.js";
import type { GitHubClient } from "./github/client.js";
import { sessionsDir } from "./llm/pi.js";
import { githubStepKinds, githubCleanup } from "./jobs/githubKinds.js";
import { TriggerPoller, watcherFor } from "./github/poller.js";
import { reconcileInterruptedRuns } from "./github/recovery.js";
import { processIssueJob } from "./jobs/processIssueJob.js";
import { processPullRequestJob } from "./jobs/processPullRequestJob.js";
import { processPullRequestCommentJob } from "./jobs/processPullRequestCommentJob.js";
import type { JobRun } from "./jobs/types.js";
import { RunEventHub } from "./routes/runEvents.js";

const log = createLogger("Server");

function openStore(onRunRecorded?: (run: JobRun) => void): SqliteJobStore {
  const db = openDatabase(config.dbPath);
  seedDatabase(db, seedJobs(), seedRuns());
  syncJobs(db, seedJobs()); // keep persisted job definitions in step with the code
  return new SqliteJobStore(db, onRunRecorded);
}

function createApp(store: JobReadStore, retry: RetryDeps, runEvents: RunEventHub): express.Express {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.resolve(process.cwd(), "views"));
  // Serve rendered LLM transcripts so a step run's stored transcript_path
  // (data/sessions/<run>-<step>.html) resolves to a clickable /sessions/ link.
  app.use("/sessions", express.static(sessionsDir()));
  app.use("/", dashboardRouter(store));
  app.use("/api", apiRouter(store, retry, runEvents));
  return app;
}

function warnIfNoKey(): void {
  const key = process.env[config.openRouter.apiKeyEnv];
  if (typeof key === "string" && key.trim() !== "") return;
  log.warn(
    "start",
    `${config.openRouter.apiKeyEnv} not set — LLM steps will fail until you add it to .env`,
  );
}

// Starts the trigger poller (new issues, new same-repo PRs, and whitelisted
// replies on same-repo PRs) when a token is set (repos are auto-discovered). An
// empty whitelist is allowed but warned (fail-closed: it would act for nobody).
function startPoller(store: SqliteJobStore, client: GitHubClient | null, token: string | undefined): TriggerPoller | null {
  if (client === null || token === undefined) {
    log.warn("startPoller", `${config.github.tokenEnv} not set — trigger poller disabled`);
    return null;
  }
  if (config.github.userWhitelist.length === 0) {
    log.warn("startPoller", "STRAPPY_USER_WHITELIST empty — poller will act for nobody (fail-closed)");
  }
  const deps = {
    client,
    token,
    tempDir: config.github.tempDir,
    committer: { name: config.github.committerName, email: config.github.committerEmail },
    reviewModel: config.openRouter.reviewModel,
    securityModel: config.openRouter.securityModel,
  };
  const poller = new TriggerPoller({
    client,
    store,
    registry: githubStepKinds(deps),
    cleanup: githubCleanup(deps),
    // Each watcher is derived from the job's own TriggerSpec (subject,
    // activation, conditions, failure policy) — see the *Trigger() builders in
    // src/jobs/process*Job.ts. Order matters for PRs sharing one ledger row:
    // the review watcher claims a PR at creation first, so the reply watcher
    // only ever fires on later comments.
    watchers: [
      watcherFor(processIssueJob(), client),
      watcherFor(processPullRequestJob(), client),
      watcherFor(processPullRequestCommentJob(), client),
    ],
    whitelist: config.github.userWhitelist,
    intervalMs: config.github.pollIntervalMs,
  });
  poller.start();
  return poller;
}

// SIGTERM/SIGINT: stop polling, stop accepting connections, give the in-flight
// job up to shutdownTimeoutMs to drain, then close the DB and exit. A second
// signal skips the wait. A run abandoned by the timeout is reconciled (marked
// "interrupted", reported on its thread) on the next boot.
function registerShutdown(server: Server, poller: TriggerPoller | null, store: SqliteJobStore, runEvents: RunEventHub): void {
  let draining = false;
  const shutdown = (signal: string): void => {
    if (draining) {
      log.warn("shutdown", `second ${signal} — exiting immediately`);
      process.exit(1);
    }
    draining = true;
    log.info("shutdown", `${signal} received — draining (up to ${config.shutdownTimeoutMs}ms)`);
    void drain(server, poller, store, runEvents);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function drain(server: Server, poller: TriggerPoller | null, store: SqliteJobStore, runEvents: RunEventHub): Promise<void> {
  try {
    poller?.stop();
    runEvents.close();
    server.close();
    if (poller !== null) await Promise.race([poller.whenIdle(), delay(config.shutdownTimeoutMs)]);
    store.close();
    log.info("shutdown", "drained; exiting");
    process.exit(0);
  } catch (error) {
    log.error("shutdown", "drain failed", error);
    process.exit(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function start(): Promise<void> {
  const runEvents = new RunEventHub();
  const store = openStore((run) => runEvents.publishRun(run));
  const token = gitHubToken();
  const client = token === undefined ? null : createGitHubClient(token);
  // Before the poller starts: terminal-mark any run a previous process abandoned
  // mid-flight and report it on its thread, so nothing stays "running" forever.
  await reconcileInterruptedRuns({ store, ...(client !== null && { client }) });
  const app = createApp(store, { admin: store, ...(client !== null && { client }) }, runEvents);
  warnIfNoKey();
  const poller = startPoller(store, client, token);
  const server = app.listen(config.port, config.host, () => {
    log.info("start", `dashboard listening on ${config.host}:${config.port} (browse http://localhost:${config.port})`);
  });
  registerShutdown(server, poller, store, runEvents);
}

start().catch((error: unknown) => {
  log.error("start", "boot failed", error);
  process.exit(1);
});
