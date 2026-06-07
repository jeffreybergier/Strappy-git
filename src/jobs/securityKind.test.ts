import { test } from "node:test";
import assert from "node:assert/strict";
import { securityStepKind, readVerdict, verifyToken, mintToken, scanRequest } from "./securityKind.js";
import type { StepContext } from "./stepKinds.js";
import type { LlmExecution } from "./types.js";
import type { StructuredResult } from "../llm/pi.js";

function execution(): LlmExecution {
  return {
    provider: "openrouter",
    model: "m",
    stopReason: "toolUse",
    text: "",
    toolCalls: [{ id: "c1", name: "submit_security_verdict", arguments: {} }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costTotal: 0.0042 },
  };
}

// The token the kind mints lands in the system prompt; pull it back out the same
// way a cooperative model would, so the fake can echo it.
function tokenFrom(system: string | undefined): string {
  return /Verification token: (\d+)/.exec(system ?? "")?.[1] ?? "";
}

// A fake runStructured that returns the given verdict and, by default, echoes the
// token correctly. Pass echo to forge/drop it.
function runReturning(verdict: Record<string, unknown>, opts?: { echo?: string | null }) {
  return async (_p: string, system: string | undefined): Promise<StructuredResult> => {
    const echoToken = opts?.echo === undefined ? tokenFrom(system) : opts.echo;
    const values = { ...verdict, ...(echoToken !== null && { echoToken }) };
    return { values, execution: execution() };
  };
}

function ctx(inputs: Record<string, unknown>, record?: (e: LlmExecution) => void): StepContext {
  return {
    step: { id: "security-scan", kind: "security.scan", name: "Security Scan", description: "", inputs: [], outputs: [] },
    inputs,
    ...(record && { recordExecution: record }),
  };
}

const SAFE = { userPrompt: "Title: fix typo", systemPrompt: "You are the gate." };

test("securityStepKind asks for a submit-only verdict, injects the token, clears a safe issue, and records the execution", async () => {
  let seenPrompt = "";
  let seenSystem: string | undefined = "UNSET";
  let seenTool = "";
  let seenSchemaKeys: string[] = [];
  let seenBuiltins: boolean | undefined;
  let recorded: LlmExecution | undefined;
  const kind = securityStepKind(async (prompt, system, schema, tool, _cwd, _runId, options) => {
    seenPrompt = prompt;
    seenSystem = system;
    seenTool = tool;
    seenSchemaKeys = Object.keys(schema.properties);
    seenBuiltins = options.builtinTools;
    return { values: { safe: true, reason: "routine typo fix", echoToken: tokenFrom(system) }, execution: execution() };
  });
  const outputs = await kind(ctx(SAFE, (e) => { recorded = e; }));
  assert.deepEqual(outputs, { safe: true, securityReason: "routine typo fix" });
  assert.ok(seenSystem?.startsWith("You are the gate."));
  assert.match(seenSystem ?? "", /Verification token: \d{12}\nEcho this exact token as "echoToken"/);
  assert.equal(seenPrompt, scanRequest("Title: fix typo"));
  assert.equal(seenTool, "submit_security_verdict");
  assert.deepEqual(seenSchemaKeys, ["safe", "reason", "echoToken"]);
  assert.equal(seenBuiltins, false); // the guard never gets file/bash tools
  assert.deepEqual(recorded, execution());
});

test("securityStepKind throws (blocking the run) on an unsafe verdict, surfacing the reason", async () => {
  const kind = securityStepKind(runReturning({ safe: false, reason: "contains ignore previous instructions" }));
  await assert.rejects(
    async () => { await kind(ctx(SAFE)); },
    /security scan blocked this issue: contains ignore previous instructions/,
  );
});

test("securityStepKind blocks when the echoed token is wrong (forged/injected call)", async () => {
  const kind = securityStepKind(runReturning({ safe: true, reason: "looks fine" }, { echo: "000000000000" }));
  await assert.rejects(async () => { await kind(ctx(SAFE)); }, /verification-token check/);
});

test("securityStepKind blocks when the token is missing entirely", async () => {
  const kind = securityStepKind(runReturning({ safe: true, reason: "looks fine" }, { echo: null }));
  await assert.rejects(async () => { await kind(ctx(SAFE)); }, /verification-token check/);
});

test("securityStepKind fails closed on a malformed verdict (token valid, shape wrong)", async () => {
  const kind = securityStepKind(runReturning({ reason: "no safe field" }));
  await assert.rejects(async () => { await kind(ctx(SAFE)); }, /missing boolean "safe"/);
});

test("securityStepKind fails closed when the model never calls the submit tool", async () => {
  const kind = securityStepKind(async () => { throw new Error("model did not call submit_security_verdict"); });
  await assert.rejects(async () => { await kind(ctx(SAFE)); }, /did not call submit_security_verdict/);
});

test("securityStepKind requires non-empty userPrompt and systemPrompt inputs", async () => {
  const kind = securityStepKind(runReturning({ safe: true, reason: "ok" }));
  await assert.rejects(async () => { await kind(ctx({ systemPrompt: "g" })); }, /non-empty string input "userPrompt"/);
  await assert.rejects(async () => { await kind(ctx({ userPrompt: "p" })); }, /non-empty string input "systemPrompt"/);
});

test("securityStepKind rejects a non-function runner", () => {
  assert.throws(() => securityStepKind(123 as never), /run must be a function/);
});

test("mintToken returns a fresh 12-digit numeric token each call", () => {
  const a = mintToken();
  assert.match(a, /^\d{12}$/);
  assert.notEqual(a, mintToken()); // overwhelmingly likely distinct
});

test("verifyToken accepts an exact match and rejects anything else", () => {
  assert.doesNotThrow(() => verifyToken({ echoToken: "123456789012" }, "123456789012"));
  assert.throws(() => verifyToken({ echoToken: "999" }, "123456789012"), /verification-token check/);
  assert.throws(() => verifyToken({ echoToken: 123456789012 }, "123456789012"), /verification-token check/);
  assert.throws(() => verifyToken({}, "123456789012"), /verification-token check/);
  assert.throws(() => verifyToken(null, "123456789012"), /verification-token check/);
});

test("readVerdict fails closed on missing or wrongly-typed fields", () => {
  assert.deepEqual(readVerdict({ safe: false, reason: "  rm -rf the repo  " }), { safe: false, reason: "rm -rf the repo" });
  assert.throws(() => readVerdict(null), /no submit arguments/);
  assert.throws(() => readVerdict({ reason: "x" }), /missing boolean "safe"/);
  assert.throws(() => readVerdict({ safe: true }), /missing non-empty "reason"/);
  assert.throws(() => readVerdict({ safe: "yes", reason: "x" }), /missing boolean "safe"/);
});
