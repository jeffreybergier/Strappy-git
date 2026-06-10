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

export function requireGitHubToken(): string {
  const token = process.env[config.github.tokenEnv];
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`[config.requireGitHubToken] missing env ${config.github.tokenEnv}`);
  }
  return token;
}
