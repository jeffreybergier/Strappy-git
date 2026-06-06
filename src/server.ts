import "dotenv/config";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { JobStore } from "./jobs/store.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { apiRouter } from "./routes/api.js";

const log = createLogger("Server");

function createApp(store: JobStore): express.Express {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.resolve(process.cwd(), "views"));
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

function start(): void {
  const store = JobStore.seeded();
  const app = createApp(store);
  warnIfNoKey();
  app.listen(config.port, config.host, () => {
    log.info("start", `dashboard listening on ${config.host}:${config.port} (browse http://localhost:${config.port})`);
  });
}

start();
