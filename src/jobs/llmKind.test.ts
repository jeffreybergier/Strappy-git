import { test } from "node:test";
import assert from "node:assert/strict";
import { llmStepKind } from "./llmKind.js";
import type { StepContext } from "./stepKinds.js";
import type { LlmExecution, ProcessStep } from "./types.js";
import { StructuredRunError } from "../llm/pi.js";
import type { RunStructuredOptions, StructuredResult } from "../llm/pi.js";

function execution(): LlmExecution {
  return {
    provider: "openrouter",
    model: "m",
    stopReason: "toolUse",
    text: "",
    toolCalls: [{ id: "c1", name: "submit_ask", arguments: { commitMessage: "m" } }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costTotal: 0.0042 },
  };
}

function result(values: Record<string, unknown>): StructuredResult {
  return { values, execution: execution() };
}

const DERIVED_KEYS = new Set(["cost", "model", "inputTokens", "outputTokens"]);

function step(outputs: string[]): ProcessStep {
  return {
    id: "ask",
    kind: "llm",
    name: "Ask",
    description: "",
    inputs: [{ key: "userPrompt", type: "string", source: "step", description: "" }],
    outputs: outputs.map((key) => ({
      key,
      type: key === "cost" ? "number" : "string",
      source: DERIVED_KEYS.has(key) ? "derived" : "step",
      description: "",
    })),
  };
}

function ctx(inputs: Record<string, unknown>, outputs: string[], record?: (e: LlmExecution) => void): StepContext {
  return { step: step(outputs), inputs, ...(record && { recordExecution: record }) };
}

test("llmStepKind derives the submit schema from outputs, records the execution, and emits the validated values", async () => {
  let seenPrompt = "";
  let seenSystem: string | undefined = "UNSET";
  let seenTool = "";
  let seenCwd = "";
  let seenKeys: string[] = [];
  let recorded: LlmExecution | undefined;
  const kind = llmStepKind(async (userPrompt, system, schema, tool, cwd) => {
    seenPrompt = userPrompt;
    seenSystem = system;
    seenTool = tool;
    seenCwd = cwd;
    seenKeys = Object.keys(schema.properties);
    return result({ commitMessage: "feat: add x", pullRequestSummary: "Added x." });
  });
  const outputs = await kind(
    ctx(
      { systemPrompt: "You are implementation.", userPrompt: "the issue", workingDirectory: "/tmp/jobs/uuid" },
      ["commitMessage", "pullRequestSummary"],
      (e) => { recorded = e; },
    ),
  );
  assert.deepEqual(outputs, { commitMessage: "feat: add x", pullRequestSummary: "Added x." });
  assert.deepEqual(recorded, execution());
  assert.equal(seenPrompt, "the issue");
  assert.equal(seenSystem, "You are implementation.");
  assert.equal(seenTool, "submit_ask");
  assert.equal(seenCwd, "/tmp/jobs/uuid");
  assert.deepEqual(seenKeys, ["commitMessage", "pullRequestSummary"]);
});

test("llmStepKind records execution when the structured call fails after the model ran", async () => {
  let recorded: LlmExecution | undefined;
  const exec = execution();
  const kind = llmStepKind(async () => {
    throw new StructuredRunError("model did not call submit_ask", exec);
  });
  await assert.rejects(
    async () => {
      await kind(ctx({ userPrompt: "go", workingDirectory: "/tmp/r" }, ["out"], (e) => { recorded = e; }));
    },
    /model did not call submit_ask/,
  );
  assert.deepEqual(recorded, exec);
});

test("llmStepKind fills a derived `cost` output from the execution and keeps it out of the model schema", async () => {
  let seenKeys: string[] = [];
  const kind = llmStepKind(async (_prompt, _system, schema) => {
    seenKeys = Object.keys(schema.properties);
    return result({ commitMessage: "m", pullRequestSummary: "s" });
  });
  const outputs = await kind(
    ctx({ userPrompt: "go", workingDirectory: "/tmp/r" }, ["commitMessage", "pullRequestSummary", "cost"]),
  );
  assert.deepEqual(seenKeys, ["commitMessage", "pullRequestSummary"]); // the model is never asked for cost
  assert.equal(outputs.cost, 0.0042); // taken from execution().usage.costTotal
});

test("llmStepKind derives model and token counts from the execution, keeping them out of the model schema", async () => {
  let seenKeys: string[] = [];
  const kind = llmStepKind(async (_prompt, _system, schema) => {
    seenKeys = Object.keys(schema.properties);
    return result({ commitMessage: "m" });
  });
  const outputs = await kind(
    ctx({ userPrompt: "go", workingDirectory: "/tmp/r" }, ["commitMessage", "model", "inputTokens", "outputTokens"]),
  );
  assert.deepEqual(seenKeys, ["commitMessage"]); // model/tokens are never asked of the model
  assert.equal(outputs.model, "m");
  assert.equal(outputs.inputTokens, 10);
  assert.equal(outputs.outputTokens, 5);
});

test("llmStepKind throws when a derived output has no known deriver", async () => {
  const kind = llmStepKind(async () => result({ commitMessage: "m" }));
  const bad: ProcessStep = {
    id: "ask",
    kind: "llm",
    name: "Ask",
    description: "",
    inputs: [{ key: "userPrompt", type: "string", source: "step", description: "" }],
    outputs: [
      { key: "commitMessage", type: "string", source: "step", description: "" },
      { key: "latency", type: "number", source: "derived", description: "" },
    ],
  };
  await assert.rejects(
    async () => { await kind({ step: bad, inputs: { userPrompt: "go", workingDirectory: "/tmp/r" } }); },
    /no deriver for derived output "latency"/,
  );
});

test("llmStepKind passes undefined systemPrompt when the step has no systemPrompt input", async () => {
  let seenSystem: string | undefined = "UNSET";
  const kind = llmStepKind(async (_prompt, system) => {
    seenSystem = system;
    return result({ out: "x" });
  });
  await kind(ctx({ userPrompt: "go", workingDirectory: "/tmp/r" }, ["out"]));
  assert.equal(seenSystem, undefined);
});

test("llmStepKind sanitizes the step id into an identifier-safe tool name", async () => {
  let seenTool = "";
  const kind = llmStepKind(async (_p, _s, _schema, tool) => {
    seenTool = tool;
    return result({ out: "x" });
  });
  const dashed: ProcessStep = {
    id: "implement-issue",
    kind: "llm",
    name: "T",
    description: "",
    inputs: [{ key: "userPrompt", type: "string", source: "step", description: "" }],
    outputs: [{ key: "out", type: "string", source: "step", description: "" }],
  };
  await kind({ step: dashed, inputs: { userPrompt: "hi", workingDirectory: "/tmp/r" } });
  assert.equal(seenTool, "submit_implement_issue");
});

test("llmStepKind requires a non-empty userPrompt input", async () => {
  const kind = llmStepKind(async () => result({ out: "x" }));
  await assert.rejects(async () => { await kind(ctx({ workingDirectory: "/tmp/r" }, ["out"])); }, /non-empty string input "userPrompt"/);
});

test("llmStepKind requires a workingDirectory input so the model runs in the cloned repo", async () => {
  const kind = llmStepKind(async () => result({ out: "x" }));
  await assert.rejects(async () => { await kind(ctx({ userPrompt: "hi" }, ["out"])); }, /non-empty string input "workingDirectory"/);
});

test("llmStepKind rejects a non-function runner", () => {
  assert.throws(() => llmStepKind(123 as never), /run must be a function/);
});

test("llmStepKind forwards a given modelId to the runner as options.model (the review model)", async () => {
  let seenOptions: RunStructuredOptions | undefined = { model: "UNSET" };
  const kind = llmStepKind(async (_p, _s, _schema, _t, _cwd, _runId, options) => {
    seenOptions = options;
    return result({ reviewComment: "lgtm" });
  }, "deepseek/deepseek-v4-pro");
  await kind(ctx({ userPrompt: "review it", workingDirectory: "/tmp/r" }, ["reviewComment"]));
  assert.deepEqual(seenOptions, { model: "deepseek/deepseek-v4-pro" });
});

test("llmStepKind passes no options when no modelId is given (the default model applies)", async () => {
  let seenOptions: RunStructuredOptions | undefined = { model: "UNSET" };
  const kind = llmStepKind(async (_p, _s, _schema, _t, _cwd, _runId, options) => {
    seenOptions = options;
    return result({ out: "x" });
  });
  await kind(ctx({ userPrompt: "go", workingDirectory: "/tmp/r" }, ["out"]));
  assert.equal(seenOptions, undefined);
});

test("llmStepKind rejects a blank modelId", () => {
  assert.throws(() => llmStepKind(undefined, "  "), /modelId, when provided, must be a non-empty string/);
});

test("llmStepKind qualifies the transcript runId with the step id so multiple LLM steps don't collide", async () => {
  let seenRunId: string | undefined = "UNSET";
  const kind = llmStepKind(async (_p, _s, _schema, _t, _cwd, runId) => {
    seenRunId = runId;
    return result({ out: "x" });
  });
  await kind({
    step: step(["out"]),
    inputs: { userPrompt: "go", workingDirectory: "/tmp/r" },
    runId: "owner/repo#8/process-issue/8e6e2f89",
  });
  assert.equal(seenRunId, "owner/repo#8/process-issue/8e6e2f89/ask"); // step(["out"]).id === "ask"
});

test("llmStepKind leaves the transcript runId undefined when the run set none (kept in memory)", async () => {
  let seenRunId: string | undefined = "UNSET";
  const kind = llmStepKind(async (_p, _s, _schema, _t, _cwd, runId) => {
    seenRunId = runId;
    return result({ out: "x" });
  });
  await kind(ctx({ userPrompt: "go", workingDirectory: "/tmp/r" }, ["out"]));
  assert.equal(seenRunId, undefined);
});
