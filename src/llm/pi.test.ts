import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { summarizeExecution, createStreamPrinter, logExecution, logValues, reflectionPrompt, createSubmitGate } from "./pi.js";
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

test("reflectionPrompt names the step's required outputs and asks for a resubmit", () => {
  const schema = Type.Object({ summary: Type.String(), prTitle: Type.String() });
  const text = reflectionPrompt(schema, "submit_implement_issue");
  assert.match(text, /double-check/i);
  assert.ok(text.includes("summary") && text.includes("prTitle")); // the actual output keys
  assert.ok(text.includes("submit_implement_issue")); // told which tool finalizes
  assert.match(text, /run the build and the tests/i); // grounded, not vague
});

test("reflectionPrompt rejects an empty schema or blank tool name", () => {
  assert.throws(() => reflectionPrompt(Type.Object({}), "submit_x"), /declares no outputs/);
  assert.throws(() => reflectionPrompt(Type.Object({ a: Type.String() }), "  "), /toolName/);
});

test("createSubmitGate withholds the first submit for a reflection pass, then finalizes", () => {
  let captured: Record<string, unknown> | undefined;
  const schema = Type.Object({ summary: Type.String() });
  const gate = createSubmitGate(schema, "submit_x", (a) => { captured = a; });

  const first = gate({ summary: "draft" });
  assert.equal(first.terminate, false); // does not finish the loop
  assert.match(first.text, /double-check/i); // returns the checklist instead
  assert.deepEqual(captured, { summary: "draft" }); // answer captured even pre-reflection

  const second = gate({ summary: "final" });
  assert.equal(second.terminate, true); // second call ends the loop
  assert.equal(second.text, "recorded");
  assert.deepEqual(captured, { summary: "final" }); // latest answer wins
});

test("createSubmitGate stays terminal after the first pass and validates its capture arg", () => {
  const gate = createSubmitGate(Type.Object({ a: Type.String() }), "submit_x", () => {});
  gate({ a: "1" }); // first: reflection
  assert.equal(gate({ a: "2" }).terminate, true);
  assert.equal(gate({ a: "3" }).terminate, true); // never reopens the gate
  assert.throws(() => createSubmitGate(Type.Object({ a: Type.String() }), "submit_x", null as never), /capture must be a function/);
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
