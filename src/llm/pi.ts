import "dotenv/config";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { config, requireOpenRouterKey } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("PiClient");

// Derive the session type from the SDK return value so we stay type-safe
// without depending on a named export that may change.
type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface CompletionResult {
  text: string;
}

let auth: AuthStorage | null = null;
let registry: ModelRegistry | null = null;

function getRegistry(): ModelRegistry {
  if (registry !== null) return registry;
  auth = AuthStorage.create();
  registry = ModelRegistry.create(auth, config.modelsPath);
  return registry;
}

function getAuth(): AuthStorage {
  getRegistry();
  if (auth === null) throw new Error("[PiClient.getAuth] auth storage not initialized");
  return auth;
}

function resolveModel() {
  const model = getRegistry().find(config.openRouter.provider, config.openRouter.model);
  if (model === undefined || model === null) {
    throw new Error(
      `[PiClient.resolveModel] model not found: ${config.openRouter.provider}/${config.openRouter.model} (check config/models.json)`,
    );
  }
  return model;
}

// Runs a single text prompt through the configured OpenRouter model and
// returns the full assistant text. This is the seam the job scheduler will
// call from its LLM-backed process steps.
export async function runPrompt(prompt: string): Promise<CompletionResult> {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("[PiClient.runPrompt] prompt must be a non-empty string");
  }
  requireOpenRouterKey();
  try {
    const model = resolveModel();
    const { session } = await createAgentSession({
      model,
      tools: [],
      authStorage: getAuth(),
      modelRegistry: getRegistry(),
      sessionManager: SessionManager.inMemory(),
    });
    log.info("runPrompt", `prompting ${config.openRouter.provider}/${config.openRouter.model}`);
    return await collect(session, prompt);
  } catch (error) {
    log.error("runPrompt", "failed", error);
    throw error;
  }
}

function collect(session: AgentSession, prompt: string): Promise<CompletionResult> {
  return new Promise<CompletionResult>((resolve, reject) => {
    let buffer = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") return finish(unsubscribe, () => resolve({ text: buffer }));
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type !== "text_delta") return;
      buffer += event.assistantMessageEvent.delta;
    });
    session.prompt(prompt).catch((error: unknown) => finish(unsubscribe, () => reject(error)));
  });
}

function finish(unsubscribe: () => void, action: () => void): void {
  unsubscribe();
  action();
}
