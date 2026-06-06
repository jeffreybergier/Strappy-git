import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { summarizeExecution } from "./pi.js";

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
