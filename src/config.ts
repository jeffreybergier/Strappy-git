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

export const config = {
  port: intFromEnv("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  modelsPath: path.resolve(process.cwd(), "config/models.json"),
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH ?? "data/strappy.sqlite"),
  openRouter: {
    provider: "openrouter",
    model: process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  github: {
    tokenEnv: "GITHUB_TOKEN",
    // Fail-closed allowlist: empty => Strappy acts for nobody. Lower-cased so
    // author comparison is case-insensitive.
    userWhitelist: listFromEnv("STRAPPY_USER_WHITELIST").map((u) => u.toLowerCase()),
    pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 60000),
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
