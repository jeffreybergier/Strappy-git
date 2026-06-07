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
import { loadPrompt } from "../jobs/prompts.js";

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
type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

let auth: AuthStorage | null = null;
let registry: ModelRegistry | null = null;
let personality: string | null = null;

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
    const execution = await collect(session, prompt);
    logExecution(execution);
    return execution;
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
    logExecution(execution);
    if (values === undefined) throw new Error(`[PiClient.runStructured] model did not call ${toolName}`);
    logValues(values);
    return { values, execution };
  } catch (error) {
    log.error("runStructured", "failed", error);
    throw error;
  }
}

// The submit tool doubles as a one-shot reflection gate. Its execute defers to a
// pure gate (createSubmitGate): the first call returns the double-check prompt and
// keeps the loop running so the model must re-examine its work; the next call
// finalizes (terminate). This wrapper only adapts the gate to the SDK's tool
// result shape — the logic lives in the pure helper so it stays unit-testable.
function buildSubmitTool(schema: TObject, toolName: string, capture: (args: Record<string, unknown>) => void): ToolDefinition {
  const gate = createSubmitGate(schema, toolName, capture);
  return defineTool({
    name: toolName,
    label: toolName,
    description: "Report the result for this step when you believe you are done. You may be asked to double-check your work before it is finalized.",
    parameters: schema,
    execute: async (_id, params) => {
      const { text, terminate } = gate(params as Record<string, unknown>);
      return { content: [{ type: "text", text }], details: params, terminate };
    },
  });
}

// One mandatory pass of self-review, modelled as a tiny state machine so it is
// pure and unit-testable (no SDK tool signature needed). Every call captures the
// latest args, so the answer is never lost if the model declines to resubmit; the
// first call withholds termination and returns the checklist, any later call
// finalizes. Bounded to a single extra pass by construction.
export interface GateResult {
  text: string;
  terminate: boolean;
}

export function createSubmitGate(
  schema: TObject,
  toolName: string,
  capture: (args: Record<string, unknown>) => void,
): (args: Record<string, unknown>) => GateResult {
  if (typeof capture !== "function") throw new Error("[PiClient.createSubmitGate] capture must be a function");
  let calls = 0;
  return (args) => {
    calls += 1;
    capture(args);
    if (calls === 1) return { text: reflectionPrompt(schema, toolName), terminate: false };
    return { text: "recorded", terminate: true };
  };
}

// The double-check message returned on the first submit: a concrete checklist that
// names the step's own required outputs (read off the submit schema) and prompts
// the model to verify against the repo (build/tests) rather than assume. Grounded
// reflection like this is where self-review actually helps a weaker model.
export function reflectionPrompt(schema: TObject, toolName: string): string {
  if (typeof toolName !== "string" || toolName.trim() === "") {
    throw new Error("[PiClient.reflectionPrompt] toolName must be a non-empty string");
  }
  const keys = Object.keys(schema.properties);
  if (keys.length === 0) throw new Error("[PiClient.reflectionPrompt] schema declares no outputs");
  return [
    "Before this is finalized, stop and double-check your work. Think hard:",
    "- Did you do everything the task asked for?",
    "- Did you verify your changes (run the build and the tests), not just assume they work?",
    `- Are all required outputs present and correct: ${keys.join(", ")}?`,
    "- Is there anything left to re-read or reconsider?",
    `If anything is missing or wrong, fix it now. When you are confident it is complete and correct, call ${toolName} again to submit your final answer.`,
  ].join("\n");
}

async function openSession(stepPrompt?: string, customTools?: ToolDefinition[], cwd?: string): Promise<AgentSession> {
  const sessionCwd = cwd ?? process.cwd();
  const base = {
    model: resolveModel(),
    cwd: sessionCwd,
    authStorage: getAuth(),
    modelRegistry: getRegistry(),
    sessionManager: SessionManager.inMemory(),
    resourceLoader: await cleanLoader(appendLayers(stepPrompt), sessionCwd),
  };
  // With customTools we omit the allowlist so the built-in read/write/edit/bash
  // tools stay active alongside the custom tool. Without them (plain text
  // completion) an empty allowlist disables every tool.
  const opts = customTools ? { ...base, customTools } : { ...base, tools: [] };
  const { session } = await createAgentSession(opts);
  return session;
}

// The system prompt is layered beneath pi's coding base: the global Strappy
// persona first, then this step's own instructions (when it has any). Both ride
// in appendSystemPrompt so pi's built-in tool guidance still leads.
function appendLayers(stepPrompt?: string): string[] {
  const layers = [loadPersonality()];
  if (stepPrompt !== undefined) layers.push(stepPrompt);
  return layers;
}

// The global Strappy persona, shared by every LLM step. Loaded once from
// prompts/personality.md (throws loudly if missing/empty) and cached.
function loadPersonality(): string {
  if (personality !== null) return personality;
  personality = loadPrompt("personality");
  return personality;
}

// A resource loader that keeps pi's coding base (slot 1) and layers our persona
// + per-step instructions beneath it via appendSystemPrompt — but drops skills,
// extensions, and crucially project context files, so a task-scoped step is
// never fed the cloned target repo's CLAUDE.md/AGENTS.md.
async function cleanLoader(appendSystemPrompt: string[], cwd: string): Promise<DefaultResourceLoader> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    appendSystemPrompt,
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
    const printer = createStreamPrinter();
    const unsubscribe = session.subscribe((event) => {
      printer.handle(event);
      if (event.type !== "agent_end" || event.willRetry) return;
      printer.end();
      finish(unsubscribe, () => resolve(summarizeExecution(event.messages)));
    });
    session.prompt(prompt).catch((error: unknown) => {
      printer.end();
      finish(unsubscribe, () => reject(error));
    });
  });
}

// Live-prints model output to the server log as the agent streams it: assistant
// text and reasoning are flushed line-by-line under distinct labels ([.text] vs
// [.think], kept namespaced via the logger), and each tool the model runs is
// logged as it starts — so a tool-heavy step shows its actions in real time
// instead of only at the end.
export function createStreamPrinter(): { handle: (event: SessionEvent) => void; end: () => void } {
  let line = "";
  let label = "text";
  const flush = (): void => {
    if (line.trim() !== "") log.info(label, line.trim());
    line = "";
  };
  const onDelta = (kind: string, delta: string): void => {
    if (kind !== label) flush();
    label = kind;
    line += delta;
    let nl = line.indexOf("\n");
    while (nl !== -1) {
      const out = line.slice(0, nl).trim();
      if (out !== "") log.info(label, out);
      line = line.slice(nl + 1);
      nl = line.indexOf("\n");
    }
  };
  const handle = (event: SessionEvent): void => {
    if (event.type === "message_end") return flush();
    if (event.type === "tool_execution_start") return logTool(event.toolName, event.args);
    if (event.type === "tool_execution_end" && event.isError) return void log.warn("stream", `tool ${event.toolName} failed`);
    if (event.type !== "message_update") return;
    const ev = event.assistantMessageEvent;
    if (ev.type === "text_delta") return onDelta("text", ev.delta);
    if (ev.type === "thinking_delta") return onDelta("think", ev.delta);
  };
  return { handle, end: flush };
}

function logTool(name: string, args: unknown): void {
  log.info("stream", `tool ${name}${describeArgs(args)}`);
}

// Surfaces the one telling argument (the command/path) so the log stays readable
// rather than dumping a whole file's contents from a write/edit call. For a tool
// with no telling key (e.g. the submit tool, whose args are the step's answer) it
// falls back to a compact JSON preview so the response is not silently dropped.
function describeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const key = ["command", "path", "file_path", "pattern", "url"].find((k) => typeof record[k] === "string");
  if (key !== undefined) return `: ${truncate(String(record[key]))}`;
  return `: ${truncate(JSON.stringify(record))}`;
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

function finish(unsubscribe: () => void, action: () => void): void {
  unsubscribe();
  action();
}

// Echoes the model's reasoning, final answer text, and token/cost usage to the
// server log once a step finishes, so the full thinking + response is visible
// even when a model streams nothing live (it went straight to tool calls).
export function logExecution(execution: LlmExecution): void {
  if (!execution || typeof execution.text !== "string") {
    throw new Error("[PiClient.logExecution] execution is required");
  }
  if (execution.thinking) logBlock("thinking", execution.thinking);
  if (execution.text.trim() !== "") logBlock("response", execution.text);
  const u = execution.usage;
  log.info(
    "usage",
    `${execution.model} (${execution.stopReason}) — ${u.totalTokens} tokens [in ${u.inputTokens}, out ${u.outputTokens}], $${u.costTotal.toFixed(4)}`,
  );
}

// Dumps the structured tool answer (the step's typed outputs) as pretty JSON, so
// the actual deliverable — not just the tool name — lands in the log.
export function logValues(values: Record<string, unknown>): void {
  if (values === null || typeof values !== "object") {
    throw new Error("[PiClient.logValues] values must be an object");
  }
  logBlock("answer", JSON.stringify(values, null, 2));
}

// Logs a multi-line string one line per entry, each kept namespaced via the
// logger, so a long reasoning/answer block stays readable in the server log.
function logBlock(label: string, value: string): void {
  for (const part of value.split("\n")) {
    if (part.trim() !== "") log.info(label, part);
  }
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
