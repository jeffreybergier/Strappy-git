import "dotenv/config";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

export class StructuredRunError extends Error {
  constructor(message: string, readonly execution: LlmExecution) {
    super(message);
    this.name = "StructuredRunError";
  }
}

export function executionFromStructuredError(error: unknown): LlmExecution | undefined {
  return error instanceof StructuredRunError ? error.execution : undefined;
}

// Tuning for a structured call.
export interface RunStructuredOptions {
  // Default true: the model keeps the built-in read/write/edit/bash tools
  // alongside the submit tool (the implement step explores + edits the clone).
  // False runs SUBMIT-ONLY (no built-ins), for a step whose input is untrusted
  // and must never reach the filesystem/shell — the security gate.
  builtinTools?: boolean;
  // Overrides the model for THIS call (default config.openRouter.model). The
  // code-review step uses it to run a different reviewer model than implement.
  model?: string;
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

function resolveModel(modelId?: string) {
  const id = modelId ?? config.openRouter.model;
  const model = getRegistry().find(config.openRouter.provider, id);
  if (model === undefined || model === null) {
    throw new Error(
      `[PiClient.resolveModel] model not found: ${config.openRouter.provider}/${id} (check config/models.json)`,
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
    const session = await openSession(SessionManager.inMemory(), systemPrompt);
    log.info("runPrompt", `prompting ${config.openRouter.provider}/${config.openRouter.model}`);
    const execution = await collect(session, prompt);
    logExecution(execution);
    return execution;
  } catch (error) {
    log.error("runPrompt", "failed", error);
    throw error;
  }
}

// Runs the model with a submit tool whose schema is the step's declared outputs
// (optionally alongside the built-in read/write/edit/bash tools), then returns
// the validated arguments (the structured outputs) plus the execution. cwd binds
// any built-in tools to the checked-out repo, so the model reads/edits the cloned
// branch — not the server's own working directory. With options.builtinTools
// false the built-ins are dropped and only the submit tool remains (cwd then has
// no tool to bind, so it just anchors the transcript session).
export async function runStructured(
  prompt: string,
  systemPrompt: string | undefined,
  schema: TObject,
  toolName: string,
  cwd: string,
  runId?: string,
  options?: RunStructuredOptions,
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
  if (options?.model !== undefined && (typeof options.model !== "string" || options.model.trim() === "")) {
    throw new Error("[PiClient.runStructured] options.model, when provided, must be a non-empty string");
  }
  requireOpenRouterKey();
  let sm: SessionManager | undefined;
  let session: AgentSession | undefined;
  let execution: LlmExecution | undefined;
  try {
    let values: Record<string, unknown> | undefined;
    const submit = buildSubmitTool(schema, toolName, (args) => { values = args; });
    sm = transcriptSession(cwd, runId);
    session = await openSession(sm, systemPrompt, [submit], cwd, options?.builtinTools ?? true, options?.model);
    log.info("runStructured", `prompting ${config.openRouter.provider}/${config.openRouter.model} for ${toolName} in ${cwd}`);
    execution = await collect(session, prompt);
    logExecution(execution);
    if (values === undefined) {
      throw new StructuredRunError(`[PiClient.runStructured] model did not call ${toolName}`, execution);
    }
    logValues(values);
    return { values, execution };
  } catch (error) {
    log.error("runStructured", "failed", error);
    throw error;
  } finally {
    // Render the transcript on EVERY exit — success, an app-level block, a model
    // error, or a no-submit-call. A failed step is exactly when the session is
    // most worth keeping. Best-effort (saveTranscript never throws); when the
    // session never opened, just discard the temp dir so it can't leak. The
    // rendered path is stamped onto the execution so a recorded run links to the
    // artifact (mutating execution here lands in the already-evaluated return or
    // StructuredRunError).
    if (sm !== undefined && session !== undefined) {
      const transcriptPath = await saveTranscript(sm, runId, session);
      if (execution !== undefined && transcriptPath !== undefined) execution.transcriptPath = transcriptPath;
    } else if (sm !== undefined) {
      discardTempSession(sm);
    }
  }
}

// The submit tool captures the step's typed outputs and ends the agent loop on
// the first call. Self-review is not forced here — the model already gets
// "always double check your work / compile / test" from its persona
// (prompts/personality.md), so a mechanical second round-trip only re-sent the
// whole growing context (cost) and added another window for a provider error.
function buildSubmitTool(schema: TObject, toolName: string, capture: (args: Record<string, unknown>) => void): ToolDefinition {
  if (typeof capture !== "function") throw new Error("[PiClient.buildSubmitTool] capture must be a function");
  return defineTool({
    name: toolName,
    label: toolName,
    description: "Report the result for this step when you are done.",
    parameters: schema,
    execute: async (_id, params) => {
      capture(params as Record<string, unknown>);
      return { content: [{ type: "text", text: "recorded" }], details: params, terminate: true };
    },
  });
}

async function openSession(sm: SessionManager, stepPrompt?: string, customTools?: ToolDefinition[], cwd?: string, builtinTools = true, modelId?: string): Promise<AgentSession> {
  const sessionCwd = cwd ?? process.cwd();
  const base = {
    model: resolveModel(modelId),
    cwd: sessionCwd,
    authStorage: getAuth(),
    modelRegistry: getRegistry(),
    sessionManager: sm,
    resourceLoader: await cleanLoader(appendLayers(stepPrompt), sessionCwd),
  };
  // Tool exposure: no customTools -> empty allowlist disables every tool (plain
  // text completion). With customTools, built-in read/write/edit/bash stay active
  // alongside it — unless builtinTools is false, where noTools "builtin" drops the
  // built-ins but keeps the custom tool (submit-only, for an untrusted-input step).
  const opts = customTools
    ? { ...base, customTools, ...(builtinTools ? {} : { noTools: "builtin" as const }) }
    : { ...base, tools: [] };
  const { session } = await createAgentSession(opts);
  return session;
}

// pi's HTML exporter signature (it is not part of the package's public exports).
// `state` is the live AgentState — passing it makes the report include the
// resolved system prompt and tool schemas; undefined omits those two sections.
type HtmlExporter = (
  sm: SessionManager,
  state: unknown,
  options: { outputPath?: string; themeName?: string },
) => Promise<string>;

// Per-step transcript: with a runId the session is file-backed so it can be
// rendered to HTML once the step finishes; without one it stays in memory (e.g.
// plain runPrompt). The jsonl lives in a throwaway temp dir — only the rendered
// report under data/sessions/ is kept.
function transcriptSession(cwd: string, runId?: string): SessionManager {
  if (runId === undefined || runId.trim() === "") return SessionManager.inMemory(cwd);
  return SessionManager.create(cwd, mkdtempSync(join(tmpdir(), "strappy-session-")));
}

// Best-effort: render the finished session to data/sessions/<runId>.html with
// pi's own exporter, then drop the temp jsonl. The live AgentState (session.state)
// is passed so the report also captures the resolved system prompt and tool
// schemas. Never throws — a transcript is a diagnostic artifact and must not fail
// the job (e.g. the PR) it documents.
async function saveTranscript(sm: SessionManager, runId: string | undefined, session: AgentSession): Promise<string | undefined> {
  if (runId === undefined || runId.trim() === "") return undefined;
  try {
    const exportHtml = await loadHtmlExporter();
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const outputPath = join(dir, `${transcriptSlug(runId)}.html`);
    await exportHtml(sm, session.state, { outputPath });
    log.info("saveTranscript", `wrote HTML transcript ${outputPath}`);
    return relative(process.cwd(), outputPath);
  } catch (error) {
    log.warn("saveTranscript", `could not render transcript for ${runId}`, error);
    return undefined;
  } finally {
    discardTempSession(sm);
  }
}

// data/sessions/, anchored to the configured DB dir so it tracks DB_PATH. Exported
// so the server can serve this dir at /sessions and the stored transcript paths
// resolve to a clickable link.
export function sessionsDir(): string {
  return join(dirname(config.dbPath), "sessions");
}

// The run id (owner/name#42/process-issue/<stem>/<step>, step-qualified by the
// kind so each LLM step gets its own file) made filename-safe: every path
// separator or non-portable char collapses to a dash, so "/" and "#" become "-"
// while ".", "-" and alphanumerics survive (e.g. github.io stays intact).
export function transcriptSlug(runId: string): string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("[PiClient.transcriptSlug] runId must be a non-empty string");
  }
  return runId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

// pi's HTML exporter is not in the package's public exports, so reach it by its
// on-disk path next to the resolved entry point and import the file directly
// (Node's exports gate only applies to bare specifiers). Cached after first use.
let htmlExporter: HtmlExporter | null = null;
async function loadHtmlExporter(): Promise<HtmlExporter> {
  if (htmlExporter !== null) return htmlExporter;
  const resolve = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve !== "function") {
    throw new Error("[PiClient.loadHtmlExporter] import.meta.resolve unavailable");
  }
  const distDir = dirname(fileURLToPath(resolve("@earendil-works/pi-coding-agent")));
  const moduleUrl = pathToFileURL(join(distDir, "core/export-html/index.js")).href;
  const mod = (await import(moduleUrl)) as { exportSessionToHtml?: HtmlExporter };
  if (typeof mod.exportSessionToHtml !== "function") {
    throw new Error("[PiClient.loadHtmlExporter] exportSessionToHtml missing (pi internal layout changed?)");
  }
  htmlExporter = mod.exportSessionToHtml;
  return htmlExporter;
}

// Remove the throwaway jsonl dir once rendered. Guarded to temp paths so a
// misconfiguration can never delete a real directory.
function discardTempSession(sm: SessionManager): void {
  const dir = sm.getSessionDir();
  if (typeof dir !== "string" || !dir.startsWith(tmpdir())) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
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
