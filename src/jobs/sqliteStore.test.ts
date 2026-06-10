import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, seedDatabase } from "./db.js";
import { SqliteJobStore } from "./sqliteStore.js";
import { seedJobs, seedRuns } from "./seed.js";
import { failureHandler } from "./failureHandler.js";
import { manualTrigger } from "./trigger.js";
import { issueTrigger } from "./processIssueJob.js";
import type { Job, JobRun } from "./types.js";

function freshStore(): SqliteJobStore {
  const db = openDatabase(":memory:");
  seedDatabase(db, seedJobs(), seedRuns());
  return new SqliteJobStore(db);
}

// A minimal job (no steps) carrying the generic failure handler, for run-focused
// round-trip tests that only need a job row to hang a run off.
function bareJob(): Job {
  return { id: "j", name: "J", description: "d", trigger: manualTrigger(), steps: [], failureHandler: failureHandler() };
}

function triggerStatus(db: ReturnType<typeof openDatabase>, repo: string, issueNumber: number): string {
  const row = db
    .prepare("SELECT status FROM processed_triggers WHERE repo = ? AND issue_number = ?")
    .get(repo, issueNumber) as Record<string, unknown> | undefined;
  const status = row?.status;
  if (typeof status !== "string") throw new Error("missing trigger status");
  return status;
}

test("seeded sqlite store exposes the seeded jobs", () => {
  const store = freshStore();
  assert.equal(store.listJobs().length, seedJobs().length);
});

test("getJob hydrates steps with ordered inputs and outputs", () => {
  const store = freshStore();
  const job = store.getJob("process-issue");
  assert.equal(job?.id, "process-issue");
  assert.deepEqual(job, seedJobs().find((j) => j.id === "process-issue"));
});

test("getJob returns null when absent", () => {
  const store = freshStore();
  assert.equal(store.getJob("does-not-exist"), null);
});

test("the failure handler round-trips through sqlite with its typed inputs and sources", () => {
  const store = freshStore();
  const handler = store.getJob("process-issue")?.failureHandler;
  assert.deepEqual(handler, failureHandler());
  assert.ok(handler?.inputs.some((io) => io.source === "failure")); // a run-level "failure" fact survived
});

test("getJob throws on a non-string id", () => {
  const store = freshStore();
  assert.throws(() => store.getJob(123 as never), /id must be a string/);
});

test("seeded sqlite store starts with no runs", () => {
  assert.equal(freshStore().listRuns().length, 0);
  assert.equal(seedRuns().length, 0);
});

test("listRuns preserves step runs, statuses and optional notes", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  const run: JobRun = {
    id: "run-note",
    jobId: "j",
    status: "failed",
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:02.000Z",
    stepRuns: [
      { stepId: "a", status: "succeeded" },
      { stepId: "b", status: "failed", note: "OpenRouter rate limit" },
      { stepId: "c", status: "skipped" },
    ],
  };
  store.recordRun(run);
  const runs = store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.stepRuns.find((s) => s.stepId === "b")?.note, "OpenRouter rate limit");
});

test("recordRun persists and round-trips a full LLM execution on a step run", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  const run: JobRun = {
    id: "run-llm",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:03.000Z",
    stepRuns: [
      {
        stepId: "ask",
        status: "succeeded",
        startedAt: "2026-06-06T00:00:01.000Z",
        finishedAt: "2026-06-06T00:00:03.000Z",
        execution: {
          provider: "openrouter",
          model: "meta-llama/llama-3.3-70b-instruct",
          stopReason: "stop",
          text: "Labelled as bug.",
          thinking: "the title mentions a crash",
          toolCalls: [{ id: "c1", name: "applyLabels", arguments: { labels: ["bug"] } }],
          usage: { inputTokens: 1200, outputTokens: 64, totalTokens: 1264, costTotal: 0.00042 },
          transcriptPath: "data/sessions/run-llm-ask.html",
        },
      },
    ],
  };
  store.recordRun(run);
  assert.deepEqual(store.listRuns(), [run]);
});

test("recordRun round-trips a step run's resolved inputs and outputs across types", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  const run: JobRun = {
    id: "run-io",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:01.000Z",
    stepRuns: [
      {
        stepId: "s",
        status: "succeeded",
        inputs: { repo: "o/r", issueNumber: 7 },
        outputs: { pushed: true, prNumber: 42, prUrl: "https://x/y/42" },
      },
    ],
  };
  store.recordRun(run);
  assert.deepEqual(store.listRuns(), [run]);
});

test("a step run without recorded IO values stays value-free after a round-trip", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  store.recordRun({
    id: "r",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    stepRuns: [{ stepId: "s", status: "succeeded" }],
  });
  const sr = store.listRuns()[0]?.stepRuns[0] ?? {};
  assert.equal("inputs" in sr, false);
  assert.equal("outputs" in sr, false);
});

test("a step run without an execution stays execution-free after a round-trip", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  store.recordRun({
    id: "r",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    stepRuns: [{ stepId: "s", status: "succeeded" }],
  });
  assert.equal("execution" in (store.listRuns()[0]?.stepRuns[0] ?? {}), false);
});

test("seedDatabase is idempotent (no duplicate rows on a second call)", () => {
  const db = openDatabase(":memory:");
  seedDatabase(db, seedJobs(), seedRuns());
  seedDatabase(db, seedJobs(), seedRuns());
  assert.equal(new SqliteJobStore(db).listJobs().length, seedJobs().length);
});

test("saveJob + getJob round-trips a new job with its IO contract", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job: Job = {
    id: "echo",
    name: "Echo",
    description: "Round-trip a single step.",
    trigger: manualTrigger(),
    steps: [
      {
        id: "say",
        kind: "noop",
        name: "Say",
        description: "Echo the input.",
        inputs: [{ key: "in", type: "string", source: "trigger", description: "text in" }],
        outputs: [{ key: "out", type: "string", source: "step", description: "text out" }],
      },
    ],
    failureHandler: failureHandler(),
  };
  store.saveJob(job);
  assert.deepEqual(store.getJob("echo"), job);
});

test("a feedsFailure output marker round-trips through sqlite; a plain output stays unmarked", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job: Job = {
    id: "mark",
    name: "Mark",
    description: "Mark one output as feeding the failure comment.",
    trigger: manualTrigger(),
    steps: [
      {
        id: "s",
        kind: "llm",
        name: "S",
        description: "",
        inputs: [],
        outputs: [
          { key: "summary", type: "string", source: "step", description: "feeds the error comment", feedsFailure: true },
          { key: "plain", type: "string", source: "step", description: "ordinary output" },
        ],
      },
    ],
    failureHandler: failureHandler(),
  };
  store.saveJob(job);
  assert.deepEqual(store.getJob("mark"), job); // marked stays true; plain gains no feedsFailure key
});

test("saveJob + getJob round-trips a step's authored systemPrompt", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job: Job = {
    id: "triage",
    name: "Triage",
    description: "Triage an issue.",
    trigger: issueTrigger(),
    steps: [
      {
        id: "classify",
        kind: "llm",
        name: "Classify",
        description: "Classify the issue.",
        systemPrompt: "You are a triage bot. Categorise the issue.",
        inputs: [{ key: "prompt", type: "string", source: "trigger", description: "issue text" }],
        outputs: [{ key: "answer", type: "string", source: "step", description: "decision" }],
      },
    ],
    failureHandler: failureHandler(),
  };
  store.saveJob(job);
  assert.deepEqual(store.getJob("triage"), job);
});

test("saveJob + getJob round-trips output guidance and a derived source", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job: Job = {
    id: "implement",
    name: "Implement",
    description: "Implement and report.",
    trigger: issueTrigger(),
    steps: [
      {
        id: "implement-issue",
        kind: "llm",
        name: "Implement Issue",
        description: "Make the change and report.",
        inputs: [{ key: "userPrompt", type: "string", source: "step", description: "issue text" }],
        outputs: [
          { key: "commitMessage", type: "string", source: "step", description: "commit msg", guidance: "An imperative commit message." },
          { key: "cost", type: "number", source: "derived", description: "LLM spend" },
        ],
      },
    ],
    failureHandler: failureHandler(),
  };
  store.saveJob(job);
  assert.deepEqual(store.getJob("implement"), job);
});

test("recordRun + listRuns round-trips an execution", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  const run: JobRun = {
    id: "r1",
    jobId: "j",
    status: "succeeded",
    startedAt: "2026-06-06T00:00:00.000Z",
    finishedAt: "2026-06-06T00:00:01.000Z",
    stepRuns: [{ stepId: "s", status: "succeeded" }],
  };
  store.recordRun(run);
  assert.deepEqual(store.listRuns(), [run]);
});

test("recordRun is idempotent: re-recording the same run id transitions running -> succeeded", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  store.saveJob(bareJob());
  const running: JobRun = {
    id: "r1",
    jobId: "j",
    status: "running",
    startedAt: "2026-06-06T00:00:00.000Z",
    stepRuns: [{ stepId: "s", status: "running", startedAt: "2026-06-06T00:00:00.000Z" }],
  };
  store.recordRun(running);
  const done: JobRun = {
    ...running,
    status: "succeeded",
    finishedAt: "2026-06-06T00:00:05.000Z",
    stepRuns: [{ stepId: "s", status: "succeeded", startedAt: "2026-06-06T00:00:00.000Z", finishedAt: "2026-06-06T00:00:05.000Z" }],
  };
  store.recordRun(done);
  assert.deepEqual(store.listRuns(), [done]);
});

test("trigger ledger detects and records processed issues", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  assert.equal(store.isProcessed("o/r", 5), false);
  store.markProcessing("o/r", 5, "run-x", 0);
  assert.equal(store.isProcessed("o/r", 5), true);
  assert.equal(store.isProcessed("o/r", 6), false);
  store.setStatus("o/r", 5, "run-x", "done");
  assert.equal(store.isProcessed("o/r", 5), true);
});

test("trigger ledger tracks the last processed comment id and advances on re-run", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  assert.equal(store.lastProcessedComment("o/r", 7), 0); // no row yet -> 0 clears any id
  store.markProcessing("o/r", 7, "run-a", 0);            // new-issue run, baseline 0
  assert.equal(store.lastProcessedComment("o/r", 7), 0);
  store.markProcessing("o/r", 7, "run-b", 42);           // re-run claims a newer comment
  assert.equal(store.lastProcessedComment("o/r", 7), 42);
});

test("trigger ledger claim succeeds only for a new issue or newer comment watermark", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  assert.equal(store.claimProcessing("o/r", 8, "run-a", 0), true);
  assert.equal(store.claimProcessing("o/r", 8, "run-b", 0), false);
  assert.equal(store.lastProcessedComment("o/r", 8), 0);
  assert.equal(store.claimProcessing("o/r", 8, "run-c", 5), true);
  assert.equal(store.lastProcessedComment("o/r", 8), 5);
  assert.equal(store.claimProcessing("o/r", 8, "run-d", 5), false);
});

test("trigger ledger status updates only the currently claimed run", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  assert.equal(store.claimProcessing("o/r", 9, "run-a", 0), true);
  store.setStatus("o/r", 9, "run-a", "running");
  assert.equal(triggerStatus(db, "o/r", 9), "running");
  assert.equal(store.claimProcessing("o/r", 9, "run-b", 5), true);
  store.setStatus("o/r", 9, "run-a", "failed");
  assert.equal(triggerStatus(db, "o/r", 9), "processing");
  store.setStatus("o/r", 9, "run-b", "succeeded");
  assert.equal(triggerStatus(db, "o/r", 9), "succeeded");
});

test("markProcessing rejects a negative comment id", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  assert.throws(() => store.markProcessing("o/r", 1, "run", -1), /lastCommentId must be a non-negative integer/);
});

test("constructor rejects a missing db", () => {
  assert.throws(() => new SqliteJobStore(undefined as never), /db is required/);
});
