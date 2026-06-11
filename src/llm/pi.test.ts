import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { summarizeExecution, mergeExecutions, nudgePrompt, createStreamPrinter, logExecution, logValues, transcriptSlug, scrubSpawnEnv, scrubbedBashTool } from "./pi.js";
import { config } from "../config.js";
import type { LlmExecution } from "../jobs/types.js";

// Synthetic session events for the stream printer; cast past the SDK's event union.
const ev = (e: Record<string, unknown>): never => e as never;

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const { info, warn } = console;
  console.info = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    Object.assign(console, { info, warn });
  }
  return lines;
}

test("createStreamPrinter logs tool calls and flushes streamed text line-by-line", () => {
  const printer = createStreamPrinter();
  const lines = capture(() => {
    printer.handle(ev({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "ls -R" } }));
    printer.handle(ev({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "first line\nsecond " } }));
    printer.handle(ev({ type: "tool_execution_end", toolCallId: "2", toolName: "write", isError: true }));
    printer.end(); // flushes the trailing partial line
  });
  assert.ok(lines.some((l) => l.includes("tool bash") && l.includes("ls -R")));
  assert.ok(lines.some((l) => l.includes("first line")));
  assert.ok(lines.some((l) => l.includes("second")));
  assert.ok(lines.some((l) => l.includes("tool write failed")));
});

test("createStreamPrinter surfaces a write's path but truncates long arguments", () => {
  const longCmd = `echo ${"a".repeat(500)}`;
  const lines = capture(() => {
    createStreamPrinter().handle(ev({ type: "tool_execution_start", toolCallId: "1", toolName: "write", args: { path: "src/x.ts", content: "z".repeat(999) } }));
    createStreamPrinter().handle(ev({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: longCmd } }));
  });
  const writeLine = lines.find((l) => l.includes("tool write"));
  const bashLine = lines.find((l) => l.includes("tool bash"));
  assert.ok(writeLine?.includes("src/x.ts") && !writeLine.includes("zzz")); // path shown, content not dumped
  assert.ok(bashLine?.includes("…") && bashLine.length < longCmd.length); // long arg truncated
});

test("createStreamPrinter previews a submit-style tool's args as JSON (no telling key)", () => {
  const lines = capture(() => {
    createStreamPrinter().handle(ev({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "submit_implement_issue",
      args: { prTitle: "Fix typo", summary: "corrected a spelling mistake" },
    }));
  });
  const line = lines.find((l) => l.includes("tool submit_implement_issue"));
  assert.ok(line?.includes("Fix typo") && line.includes("prTitle"));
});

test("createStreamPrinter labels streamed thinking distinctly from response text", () => {
  const lines = capture(() => {
    const printer = createStreamPrinter();
    printer.handle(ev({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "weighing options\n" } }));
    printer.handle(ev({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "final answer\n" } }));
  });
  assert.ok(lines.some((l) => l.includes("PiClient.think") && l.includes("weighing options")));
  assert.ok(lines.some((l) => l.includes("PiClient.text") && l.includes("final answer")));
});

test("transcriptSlug turns a run id into a filename-safe stem (/ and # become -)", () => {
  const runId = "jeffreybergier/jeffreybergier.github.io#8/process-issue/8e6e2f89";
  assert.equal(transcriptSlug(runId), "jeffreybergier-jeffreybergier.github.io-8-process-issue-8e6e2f89");
});

test("transcriptSlug preserves dots and existing dashes and rejects blanks", () => {
  assert.equal(transcriptSlug("owner/repo#1/process-issue/abcdef12"), "owner-repo-1-process-issue-abcdef12");
  assert.throws(() => transcriptSlug("   "), /runId must be a non-empty string/);
  assert.throws(() => transcriptSlug(undefined as never), /runId must be a non-empty string/);
});

function exec(over: Partial<LlmExecution>): LlmExecution {
  return {
    provider: "openrouter",
    model: "google/gemma-4-31b-it",
    stopReason: "stop",
    text: "",
    toolCalls: [],
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costTotal: 0.0021 },
    ...over,
  };
}

test("logExecution echoes thinking, response and a usage summary", () => {
  const lines = capture(() => logExecution(exec({ thinking: "step one\nstep two", text: "the response" })));
  assert.ok(lines.some((l) => l.includes("PiClient.thinking") && l.includes("step one")));
  assert.ok(lines.some((l) => l.includes("PiClient.thinking") && l.includes("step two")));
  assert.ok(lines.some((l) => l.includes("PiClient.response") && l.includes("the response")));
  assert.ok(lines.some((l) => l.includes("PiClient.usage") && l.includes("15 tokens") && l.includes("$0.0021")));
});

test("logExecution omits an empty response and absent thinking", () => {
  const lines = capture(() => logExecution(exec({})));
  assert.ok(!lines.some((l) => l.includes("PiClient.response")));
  assert.ok(!lines.some((l) => l.includes("PiClient.thinking")));
  assert.ok(lines.some((l) => l.includes("PiClient.usage")));
});

test("logValues dumps the structured answer as JSON", () => {
  const lines = capture(() => logValues({ prTitle: "Fix typo", branch: "strappy/issue-8" }));
  assert.ok(lines.some((l) => l.includes("PiClient.answer") && l.includes("prTitle")));
  assert.ok(lines.some((l) => l.includes("Fix typo")));
});

test("logExecution and logValues reject invalid input", () => {
  assert.throws(() => logExecution(undefined as never), /execution is required/);
  assert.throws(() => logValues(null as never), /values must be an object/);
});

function usage(input: number, output: number, cost: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(content: AssistantMessage["content"], u: Usage): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct",
    usage: u,
    stopReason: "stop",
    timestamp: 0,
  };
}

test("summarizeExecution extracts the answer text and provider/model/stop", () => {
  const messages: AgentMessage[] = [assistant([{ type: "text", text: "Hello world" }], usage(10, 5, 0.001))];
  const exec = summarizeExecution(messages);
  assert.equal(exec.text, "Hello world");
  assert.equal(exec.provider, "openrouter");
  assert.equal(exec.model, "meta-llama/llama-3.3-70b-instruct");
  assert.equal(exec.stopReason, "stop");
  assert.deepEqual(exec.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costTotal: 0.001 });
  assert.deepEqual(exec.toolCalls, []);
});

test("summarizeExecution captures thinking and tool calls", () => {
  const messages: AgentMessage[] = [
    assistant(
      [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "c1", name: "search", arguments: { q: "cats" } },
      ],
      usage(20, 8, 0.002),
    ),
  ];
  const exec = summarizeExecution(messages);
  assert.equal(exec.thinking, "let me think");
  assert.equal(exec.text, "answer");
  assert.deepEqual(exec.toolCalls, [{ id: "c1", name: "search", arguments: { q: "cats" } }]);
});

test("summarizeExecution aggregates text and usage across multiple assistant turns", () => {
  const messages: AgentMessage[] = [
    assistant([{ type: "text", text: "part 1 " }], usage(10, 4, 0.001)),
    assistant([{ type: "text", text: "part 2" }], usage(6, 3, 0.0005)),
  ];
  const exec = summarizeExecution(messages);
  assert.equal(exec.text, "part 1 part 2");
  assert.deepEqual(exec.usage, { inputTokens: 16, outputTokens: 7, totalTokens: 23, costTotal: 0.0015 });
});

test("summarizeExecution omits thinking when the model produced none", () => {
  const exec = summarizeExecution([assistant([{ type: "text", text: "hi" }], usage(1, 1, 0))]);
  assert.equal("thinking" in exec, false);
});

test("summarizeExecution throws when there is no assistant message", () => {
  assert.throws(() => summarizeExecution([]), /no assistant message/);
  assert.throws(() => summarizeExecution(undefined as never), /must be an array/);
});

test("nudgePrompt names the tool, is imperative, and rejects a blank tool name", () => {
  const prompt = nudgePrompt("submit_review");
  assert.match(prompt, /`submit_review`/);
  assert.match(prompt, /Call `submit_review` now/);
  assert.doesNotMatch(prompt, /\?/); // no question for the model to answer with more plain text
  assert.throws(() => nudgePrompt("  "), /toolName must be a non-empty string/);
});

test("mergeExecutions sums usage, concatenates tool calls, and keeps the last turn's identity", () => {
  const first = exec({
    text: "Here's my verdict: approve.",
    stopReason: "stop",
    toolCalls: [{ id: "c1", name: "bash", arguments: { command: "git diff" } }],
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costTotal: 0.01 },
  });
  const second = exec({
    text: "Submitting now.",
    stopReason: "toolUse",
    toolCalls: [{ id: "c2", name: "submit_review", arguments: { approve: true } }],
    usage: { inputTokens: 150, outputTokens: 10, totalTokens: 160, costTotal: 0.004 },
  });
  const merged = mergeExecutions(first, second);
  assert.equal(merged.text, "Here's my verdict: approve.\nSubmitting now.");
  assert.equal(merged.stopReason, "toolUse");
  assert.deepEqual(merged.toolCalls.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(merged.usage, { inputTokens: 250, outputTokens: 50, totalTokens: 300, costTotal: 0.014 });
});

test("mergeExecutions joins thinking across turns and omits it when neither turn thought", () => {
  const thought = mergeExecutions(exec({ thinking: "first pass" }), exec({}));
  assert.equal(thought.thinking, "first pass");
  const silent = mergeExecutions(exec({}), exec({}));
  assert.equal("thinking" in silent, false);
});

test("mergeExecutions skips an empty first text instead of leading with a newline", () => {
  assert.equal(mergeExecutions(exec({ text: "" }), exec({ text: "done" })).text, "done");
});

test("mergeExecutions rejects a missing execution", () => {
  assert.throws(() => mergeExecutions(undefined as never, exec({})), /two executions are required/);
});

test("scrubSpawnEnv strips both credentials from the spawn env and keeps the rest", () => {
  const context = {
    command: "env",
    cwd: "/tmp/clone",
    env: {
      [config.openRouter.apiKeyEnv]: "sk-or-secret",
      [config.github.tokenEnv]: "ghp-secret",
      PATH: "/usr/bin",
    },
  };
  const scrubbed = scrubSpawnEnv(context);
  assert.equal(scrubbed.env[config.openRouter.apiKeyEnv], undefined);
  assert.equal(scrubbed.env[config.github.tokenEnv], undefined);
  assert.equal(scrubbed.env.PATH, "/usr/bin");
  assert.equal(scrubbed.command, "env");
  assert.equal(scrubbed.cwd, "/tmp/clone");
  // The original context must not be mutated.
  assert.equal(context.env[config.openRouter.apiKeyEnv], "sk-or-secret");
});

test("scrubbedBashTool is named bash so it shadows the built-in, and rejects a blank cwd", () => {
  assert.equal(scrubbedBashTool("/tmp/clone").name, "bash");
  assert.throws(() => scrubbedBashTool("  "), /cwd must be a non-empty string/);
});
