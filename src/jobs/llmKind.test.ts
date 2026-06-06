import { test } from "node:test";
import assert from "node:assert/strict";
import { llmStepKind } from "./llmKind.js";
import type { StepContext } from "./stepKinds.js";
import type { LlmExecution, ProcessStep } from "./types.js";
import type { StructuredResult } from "../llm/pi.js";

function execution(): LlmExecution {
  return {
    provider: "openrouter",
    model: "m",
    stopReason: "toolUse",
    text: "",
    toolCalls: [{ id: "c1", name: "submit_ask", arguments: { category: "bug" } }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costTotal: 0 },
  };
}

function result(values: Record<string, unknown>): StructuredResult {
  return { values, execution: execution() };
}

function step(outputs: string[], systemPrompt?: string): ProcessStep {
  return {
    id: "ask",
    kind: "llm",
    name: "Ask",
    description: "",
    ...(systemPrompt !== undefined && { systemPrompt }),
    inputs: [{ key: "prompt", type: "string", description: "" }],
    outputs: outputs.map((key) => ({ key, type: "string", description: "" })),
  };
}

function ctx(
  inputs: Record<string, unknown>,
  outputs: string[],
  record?: (e: LlmExecution) => void,
  systemPrompt?: string,
): StepContext {
  return { step: step(outputs, systemPrompt), inputs, ...(record && { recordExecution: record }) };
}

test("llmStepKind derives a schema from outputs, records the execution, and emits the validated values", async () => {
  let seenPrompt = "";
  let seenSystem: string | undefined = "UNSET";
  let seenTool = "";
  let seenCwd = "";
  let seenKeys: string[] = [];
  let recorded: LlmExecution | undefined;
  const kind = llmStepKind(async (prompt, system, schema, tool, cwd) => {
    seenPrompt = prompt;
    seenSystem = system;
    seenTool = tool;
    seenCwd = cwd;
    seenKeys = Object.keys(schema.properties);
    return result({ category: "bug", difficulty: 2, rationale: "looks like a crash" });
  });
  const outputs = await kind(
    ctx({ prompt: "the issue", workdir: "/tmp/jobs/uuid" }, ["category", "difficulty", "rationale"], (e) => { recorded = e; }, "You are triage."),
  );
  assert.deepEqual(outputs, { category: "bug", difficulty: 2, rationale: "looks like a crash" });
  assert.deepEqual(recorded, execution());
  assert.equal(seenPrompt, "the issue");
  assert.equal(seenSystem, "You are triage.");
  assert.equal(seenTool, "submit_ask");
  assert.equal(seenCwd, "/tmp/jobs/uuid");
  assert.deepEqual(seenKeys, ["category", "difficulty", "rationale"]);
});

test("llmStepKind passes undefined systemPrompt when the step declares none", async () => {
  let seenSystem: string | undefined = "UNSET";
  const kind = llmStepKind(async (_prompt, system) => {
    seenSystem = system;
    return result({ out: "x" });
  });
  await kind(ctx({ prompt: "go", workdir: "/tmp/r" }, ["out"]));
  assert.equal(seenSystem, undefined);
});

test("llmStepKind sanitizes the step id into an identifier-safe tool name", async () => {
  let seenTool = "";
  const kind = llmStepKind(async (_p, _s, _schema, tool) => {
    seenTool = tool;
    return result({ out: "x" });
  });
  const dashed: ProcessStep = {
    id: "triage-issue",
    kind: "llm",
    name: "T",
    description: "",
    inputs: [{ key: "prompt", type: "string", description: "" }],
    outputs: [{ key: "out", type: "string", description: "" }],
  };
  await kind({ step: dashed, inputs: { prompt: "hi", workdir: "/tmp/r" } });
  assert.equal(seenTool, "submit_triage_issue");
});

test("llmStepKind requires a non-empty prompt input", async () => {
  const kind = llmStepKind(async () => result({ category: "x" }));
  await assert.rejects(async () => { await kind(ctx({ workdir: "/tmp/r" }, ["category"])); }, /non-empty string input "prompt"/);
});

test("llmStepKind requires a workdir input so the model runs in the cloned repo", async () => {
  const kind = llmStepKind(async () => result({ out: "x" }));
  await assert.rejects(async () => { await kind(ctx({ prompt: "hi" }, ["out"])); }, /non-empty string input "workdir"/);
});

test("llmStepKind rejects a non-function runner", () => {
  assert.throws(() => llmStepKind(123 as never), /run must be a function/);
});
