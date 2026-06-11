import "dotenv/config";
import path from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`[config] ${name} must be an integer`);
  return value;
}

function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

// The default model id, shared by the implement step and used as the fallback
// for the review step, so OPENROUTER_REVIEW_MODEL only has to be set to differ.
const defaultModel = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-pro";

// The GitHub token (the push credential) is captured once at startup and then
// REMOVED from process.env, so no child process — in particular the LLM's bash
// tool — can ever read it from the environment (`echo $GITHUB_TOKEN`,
// /proc/<pid>/environ). The server passes it explicitly where needed. The
// OpenRouter key cannot get the same treatment: pi re-resolves it from
// process.env on every API request, so it is scrubbed per-spawn in llm/pi.ts
// instead.
const capturedGitHubToken = captureEnv("GITHUB_TOKEN");

function captureEnv(name: string): string | undefined {
  const value = process.env[name];
  delete process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

export const config = {
  port: intFromEnv("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  modelsPath: path.resolve(process.cwd(), "config/models.json"),
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH ?? "data/strappy.sqlite"),
  openRouter: {
    provider: "openrouter",
    model: defaultModel,
    // The code-review step runs against this model; defaults to the main model
    // so a single-model setup still works. Must be declared in config/models.json.
    reviewModel: process.env.OPENROUTER_REVIEW_MODEL ?? defaultModel,
    // The security.scan gate runs against this model; same single-model fallback.
    securityModel: process.env.OPENROUTER_SECURITY_MODEL ?? defaultModel,
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  github: {
    tokenEnv: "GITHUB_TOKEN",
    // Fail-closed allowlist: empty => Strappy acts for nobody. Lower-cased so
    // author comparison is case-insensitive.
    userWhitelist: listFromEnv("STRAPPY_USER_WHITELIST").map((u) => u.toLowerCase()),
    pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 300000),
    tempDir: process.env.STRAPPY_TEMP_DIR ?? "/strappy-temp",
    committerName: process.env.STRAPPY_GIT_NAME ?? "strappy",
    committerEmail: process.env.STRAPPY_GIT_EMAIL ?? "strappy@users.noreply.github.com",
  },
} as const;

export function requireOpenRouterKey(): string {
  const key = process.env[config.openRouter.apiKeyEnv];
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`[config.requireOpenRouterKey] missing env ${config.openRouter.apiKeyEnv}`);
  }
  return key;
}

// Both accessors return the value captured (and scrubbed from process.env) at
// startup; setting the env var after module load has no effect by design.
export function gitHubToken(): string | undefined {
  return capturedGitHubToken;
}

export function requireGitHubToken(): string {
  if (capturedGitHubToken === undefined) {
    throw new Error(`[config.requireGitHubToken] missing env ${config.github.tokenEnv}`);
  }
  return capturedGitHubToken;
}
