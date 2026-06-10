import "dotenv/config";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { JobReadStore } from "./jobs/store.js";
import { openDatabase, seedDatabase, syncJobs } from "./jobs/db.js";
import { SqliteJobStore } from "./jobs/sqliteStore.js";
import { seedJobs, seedRuns } from "./jobs/seed.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { apiRouter } from "./routes/api.js";
import { createGitHubClient } from "./github/client.js";
import { sessionsDir } from "./llm/pi.js";
import { githubStepKinds, githubCleanup } from "./jobs/githubKinds.js";
import { TriggerPoller, issueSource, pullRequestSource, pullRequestReplySource } from "./github/poller.js";
import { processIssueJob } from "./jobs/processIssueJob.js";
import { processPullRequestJob } from "./jobs/processPullRequestJob.js";
import { processPullRequestCommentJob } from "./jobs/processPullRequestCommentJob.js";

const log = createLogger("Server");

function openStore(): SqliteJobStore {
  const db = openDatabase(config.dbPath);
  seedDatabase(db, seedJobs(), seedRuns());
  syncJobs(db, seedJobs()); // keep persisted job definitions in step with the code
  return new SqliteJobStore(db);
}

function createApp(store: JobReadStore): express.Express {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.resolve(process.cwd(), "views"));
  // Serve rendered LLM transcripts so a step run's stored transcript_path
  // (data/sessions/<run>-<step>.html) resolves to a clickable /sessions/ link.
  app.use("/sessions", express.static(sessionsDir()));
  app.use("/", dashboardRouter(store));
  app.use("/api", apiRouter(store));
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
function startPoller(store: SqliteJobStore): void {
  const token = process.env[config.github.tokenEnv];
  if (token === undefined || token.trim() === "") {
    log.warn("startPoller", `${config.github.tokenEnv} not set — trigger poller disabled`);
    return;
  }
  if (config.github.userWhitelist.length === 0) {
    log.warn("startPoller", "STRAPPY_USER_WHITELIST empty — poller will act for nobody (fail-closed)");
  }
  const client = createGitHubClient(token);
  const deps = {
    client,
    token,
    tempDir: config.github.tempDir,
    committer: { name: config.github.committerName, email: config.github.committerEmail },
    reviewModel: config.openRouter.reviewModel,
  };
  new TriggerPoller({
    client,
    store,
    registry: githubStepKinds(deps),
    cleanup: githubCleanup(deps),
    // Order matters for PRs sharing one ledger row: the review watcher claims a
    // PR at creation first, so the reply watcher only ever fires on later comments.
    // The issue job is one-shot: it fires at creation only, and a failed run
    // closes the issue as failed — replies on an issue never re-trigger anything.
    watchers: [
      { job: processIssueJob(), source: issueSource(client), activation: "creation", closeOnFailure: true },
      { job: processPullRequestJob(), source: pullRequestSource(client), activation: "creation" },
      { job: processPullRequestCommentJob(), source: pullRequestReplySource(client), activation: "comment" },
    ],
    whitelist: config.github.userWhitelist,
    intervalMs: config.github.pollIntervalMs,
  }).start();
}

function start(): void {
  const store = openStore();
  const app = createApp(store);
  warnIfNoKey();
  startPoller(store);
  app.listen(config.port, config.host, () => {
    log.info("start", `dashboard listening on ${config.host}:${config.port} (browse http://localhost:${config.port})`);
  });
}

start();
