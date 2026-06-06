import "dotenv/config";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TObject } from "typebox";
import { config, requireOpenRouterKey } from "../config.js";
import { createLogger } from "../logger.js";
import type { LlmExecution, TokenUsage, ToolCallRecord } from "../jobs/types.js";

// A step's structured result: the validated tool arguments (the step's typed
// outputs) plus the full execution record for persistence.
export interface StructuredResult {
  values: Record<string, unknown>;
  execution: LlmExecution;
}

const log = createLogger("PiClient");

// Derive the session type from the SDK return value so we stay type-safe
// without depending on a named export that may change.
type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

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

// Runs a single prompt through the configured OpenRouter model and returns the
// full execution (answer + reasoning + tool calls + usage). systemPrompt sets
// the step's instructions; when omitted the model's default applies. This is
// the seam the job scheduler calls from its LLM-backed process steps.
export async function runPrompt(prompt: string, systemPrompt?: string): Promise<LlmExecution> {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("[PiClient.runPrompt] prompt must be a non-empty string");
  }
  if (systemPrompt !== undefined && (typeof systemPrompt !== "string" || systemPrompt.trim() === "")) {
    throw new Error("[PiClient.runPrompt] systemPrompt, when provided, must be a non-empty string");
  }
  requireOpenRouterKey();
  try {
    const session = await openSession(systemPrompt);
    log.info("runPrompt", `prompting ${config.openRouter.provider}/${config.openRouter.model}`);
    return await collect(session, prompt);
  } catch (error) {
    log.error("runPrompt", "failed", error);
    throw error;
  }
}

// Runs the model with the built-in read/write/edit/bash tools plus a submit tool
// whose schema is the step's declared outputs, then returns the validated
// arguments (the structured outputs) plus the execution. cwd binds the tools to
// the checked-out repo, so the model reads/edits the cloned branch — not the
// server's own working directory.
export async function runStructured(
  prompt: string,
  systemPrompt: string | undefined,
  schema: TObject,
  toolName: string,
  cwd: string,
): Promise<StructuredResult> {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("[PiClient.runStructured] prompt must be a non-empty string");
  }
  if (typeof toolName !== "string" || toolName.trim() === "") {
    throw new Error("[PiClient.runStructured] toolName must be a non-empty string");
  }
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("[PiClient.runStructured] cwd must be a non-empty string");
  }
  if (systemPrompt !== undefined && (typeof systemPrompt !== "string" || systemPrompt.trim() === "")) {
    throw new Error("[PiClient.runStructured] systemPrompt, when provided, must be a non-empty string");
  }
  requireOpenRouterKey();
  try {
    let values: Record<string, unknown> | undefined;
    const submit = buildSubmitTool(schema, toolName, (args) => { values = args; });
    const session = await openSession(systemPrompt, [submit], cwd);
    log.info("runStructured", `prompting ${config.openRouter.provider}/${config.openRouter.model} for ${toolName} in ${cwd}`);
    const execution = await collect(session, prompt);
    if (values === undefined) throw new Error(`[PiClient.runStructured] model did not call ${toolName}`);
    return { values, execution };
  } catch (error) {
    log.error("runStructured", "failed", error);
    throw error;
  }
}

// The submit tool captures the validated args and asks the loop to stop, so the
// call functions as the step's final structured answer.
function buildSubmitTool(schema: TObject, toolName: string, capture: (args: Record<string, unknown>) => void): ToolDefinition {
  return defineTool({
    name: toolName,
    label: toolName,
    description: "Report the final result for this step. Call this exactly once when you are done.",
    parameters: schema,
    execute: async (_id, params) => {
      capture(params as Record<string, unknown>);
      return { content: [{ type: "text", text: "recorded" }], details: params, terminate: true };
    },
  });
}

async function openSession(systemPrompt?: string, customTools?: ToolDefinition[], cwd?: string): Promise<AgentSession> {
  const sessionCwd = cwd ?? process.cwd();
  const base = {
    model: resolveModel(),
    cwd: sessionCwd,
    authStorage: getAuth(),
    modelRegistry: getRegistry(),
    sessionManager: SessionManager.inMemory(),
    ...(systemPrompt !== undefined && { resourceLoader: await cleanLoader(systemPrompt, sessionCwd) }),
  };
  // With customTools we omit the allowlist so the built-in read/write/edit/bash
  // tools stay active alongside the custom tool. Without them (plain text
  // completion) an empty allowlist disables every tool.
  const opts = customTools ? { ...base, customTools } : { ...base, tools: [] };
  const { session } = await createAgentSession(opts);
  return session;
}

// A resource loader carrying only our system prompt: no coding-agent base
// prompt, no skills/extensions, and crucially no project context files (so the
// model isn't fed the target repo's CLAUDE.md/AGENTS.md on a task-scoped step).
async function cleanLoader(systemPrompt: string, cwd: string): Promise<DefaultResourceLoader> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    systemPrompt,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  return loader;
}

function collect(session: AgentSession, prompt: string): Promise<LlmExecution> {
  return new Promise<LlmExecution>((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "agent_end" || event.willRetry) return;
      finish(unsubscribe, () => resolve(summarizeExecution(event.messages)));
    });
    session.prompt(prompt).catch((error: unknown) => finish(unsubscribe, () => reject(error)));
  });
}

function finish(unsubscribe: () => void, action: () => void): void {
  unsubscribe();
  action();
}

// Folds the agent's final messages into one LlmExecution. Pure (no SDK calls),
// so it is unit-testable with synthetic messages and aggregates across turns
// when tools cause multiple assistant messages.
export function summarizeExecution(messages: AgentMessage[]): LlmExecution {
  if (!Array.isArray(messages)) throw new Error("[PiClient.summarizeExecution] messages must be an array");
  const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
  const last = assistants.at(-1);
  if (last === undefined) throw new Error("[PiClient.summarizeExecution] no assistant message in result");
  const thinking = collectText(assistants, (b) => (b.type === "thinking" ? b.thinking : undefined));
  return {
    provider: last.provider,
    model: last.model,
    stopReason: last.stopReason,
    text: collectText(assistants, (b) => (b.type === "text" ? b.text : undefined)),
    ...(thinking !== "" && { thinking }),
    toolCalls: collectToolCalls(assistants),
    usage: sumUsage(assistants),
  };
}

type ContentBlock = AssistantMessage["content"][number];

function collectText(assistants: AssistantMessage[], pick: (block: ContentBlock) => string | undefined): string {
  const parts: string[] = [];
  for (const message of assistants) {
    for (const block of message.content) {
      const part = pick(block);
      if (part !== undefined) parts.push(part);
    }
  }
  return parts.join("");
}

function collectToolCalls(assistants: AssistantMessage[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const message of assistants) {
    for (const block of message.content) {
      if (block.type === "toolCall") calls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
  }
  return calls;
}

function sumUsage(assistants: AssistantMessage[]): TokenUsage {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 };
  for (const message of assistants) {
    usage.inputTokens += message.usage.input;
    usage.outputTokens += message.usage.output;
    usage.totalTokens += message.usage.totalTokens;
    usage.costTotal += message.usage.cost.total;
  }
  return usage;
}
