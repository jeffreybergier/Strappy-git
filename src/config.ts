import "dotenv/config";
import path from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`[config] ${name} must be an integer`);
  return value;
}

export const config = {
  port: intFromEnv("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  modelsPath: path.resolve(process.cwd(), "config/models.json"),
  openRouter: {
    provider: "openrouter",
    model: process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
} as const;

export function requireOpenRouterKey(): string {
  const key = process.env[config.openRouter.apiKeyEnv];
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`[config.requireOpenRouterKey] missing env ${config.openRouter.apiKeyEnv}`);
  }
  return key;
}
