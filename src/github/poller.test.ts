import { test } from "node:test";
import assert from "node:assert/strict";
import { IssuePoller, isAllowedAuthor, formatRunId, failureNote, failureComment } from "./poller.js";
import type { GitHubClient, IssueRef } from "./client.js";
import { openDatabase } from "../jobs/db.js";
import { SqliteJobStore } from "../jobs/sqliteStore.js";
import { defaultStepKinds, StepKindRegistry } from "../jobs/stepKinds.js";
import { processIssueJob } from "../jobs/processIssueJob.js";
import type { Job, JobRun } from "../jobs/types.js";

// ---- isAllowedAuthor (the security gate) ------------------------------------

test("isAllowedAuthor allows a whitelisted user (case-insensitive both ways)", () => {
  assert.equal(isAllowedAuthor("JeffreyBergier", ["jeffreybergier"]), true);
  assert.equal(isAllowedAuthor("jeffreybergier", ["JeffreyBergier"]), true);
});

test("isAllowedAuthor denies a user not on the list", () => {
  assert.equal(isAllowedAuthor("rando", ["jeffreybergier"]), false);
});

test("isAllowedAuthor fails closed on an empty whitelist", () => {
  assert.equal(isAllowedAuthor("jeffreybergier", []), false);
});

test("isAllowedAuthor denies an empty login", () => {
  assert.equal(isAllowedAuthor("", ["jeffreybergier"]), false);
});

test("isAllowedAuthor throws on a non-string login", () => {
  assert.throws(() => isAllowedAuthor(123 as never, ["x"]), /login must be a string/);
});

// ---- formatRunId (informative run names) ------------------------------------

test("formatRunId builds <repo>#<issue>/<process>/<uuid8>", () => {
  assert.equal(
    formatRunId("owner/name", 42, "process-issue", "16498324-4dab-425b-93ca-3f49310dfe8e"),
    "owner/name#42/process-issue/16498324",
  );
});

test("formatRunId throws on invalid args", () => {
  assert.throws(() => formatRunId("", 1, "p", "u"), /repo must be a non-empty string/);
  assert.throws(() => formatRunId("o/r", 1.5, "p", "u"), /issueNumber must be an integer/);
  assert.throws(() => formatRunId("o/r", 1, "", "u"), /process must be a non-empty string/);
  assert.throws(() => formatRunId("o/r", 1, "p", ""), /jobUuid must be a non-empty string/);
});

// ---- IssuePoller (ledger-only dedupe + sequential queue, no network) --------

function issue(repo: string, number: number, author: string): IssueRef {
  return { repo, number, author, title: `t${number}`, body: "", createdAt: "2030-01-01T00:00:00.000Z" };
}

interface CapturedComment { repo: string; issueNumber: number; body: string; }

// Only listAccessibleRepos + listOpenIssues are exercised under the stub
// registry; the rest satisfy the interface but are never called — except
// commentOnIssue, which records into the sink so failure-reporting is asserted.
function fakeClient(issuesByRepo: Record<string, IssueRef[]>, comments: CapturedComment[]): GitHubClient {
  return {
    listAccessibleRepos: async () => Object.keys(issuesByRepo),
    listOpenIssues: async (repo) => issuesByRepo[repo] ?? [],
    getIssue: async () => { throw new Error("getIssue not used in stub run"); },
    getDefaultBranch: async () => "main",
    openPullRequest: async () => ({ number: 1, url: "x" }),
    commentOnIssue: async (repo, issueNumber, body) => { comments.push({ repo, issueNumber, body }); return comments.length; },
    closeIssue: async () => {},
  };
}

function setup(issuesByRepo: Record<string, IssueRef[]>, opts: { whitelist?: string[]; job?: Job; registry?: StepKindRegistry } = {}) {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = opts.job ?? processIssueJob();
  store.saveJob(job);
  const comments: CapturedComment[] = [];
  const poller = new IssuePoller({
    client: fakeClient(issuesByRepo, comments),
    store,
    registry: opts.registry ?? defaultStepKinds(),
    job,
    whitelist: opts.whitelist ?? ["jeffreybergier"],
    intervalMs: 1000,
  });
  return { store, poller, comments };
}

// A one-step job whose only step throws, so the poller's failure path runs
// without any network or LLM. Mirrors the real job id/step id so assertions read
// naturally.
function failingJob(): Job {
  return {
    id: "process-issue",
    name: "Process New Issue",
    description: "Fails on purpose to exercise failure reporting.",
    trigger: "github.issue.opened",
    steps: [
      {
        id: "implement-issue",
        kind: "boom",
        name: "Implement Issue",
        description: "Throws to simulate a failed step.",
        inputs: [{ key: "repo", type: "string", source: "trigger", description: "owner/name" }],
        outputs: [],
      },
    ],
  };
}

function boomRegistry(): StepKindRegistry {
  return new StepKindRegistry().register("boom", () => {
    throw new Error("model did not call submit_implement_issue");
  });
}

test("poller enqueues and processes a whitelisted user's new issue", async () => {
  const { store, poller } = setup({ "o/r": [issue("o/r", 1, "jeffreybergier")] });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 1), true);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.listRuns()[0]?.status, "succeeded");
});

test("poller ignores an issue from a non-whitelisted user", async () => {
  const { store, poller } = setup({ "o/r": [issue("o/r", 2, "attacker")] });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 2), false);
  assert.equal(store.listRuns().length, 0);
});

test("poller decides via the ledger — a handled issue is never re-processed", async () => {
  const { store, poller } = setup({ "o/r": [issue("o/r", 3, "jeffreybergier")] });
  await poller.tick();
  await poller.whenIdle();
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 1);
});

test("poller names runs <repo>#<issue>/<process>/<uuid8>", async () => {
  const { store, poller } = setup({ "o/r": [issue("o/r", 7, "jeffreybergier")] });
  await poller.tick();
  await poller.whenIdle();
  assert.match(store.listRuns()[0]?.id ?? "", /^o\/r#7\/process-issue\/[0-9a-f]{8}$/);
});

test("poller processes a whole pre-existing backlog (no time window)", async () => {
  const { store, poller } = setup({
    "o/r": [
      issue("o/r", 4, "jeffreybergier"),
      issue("o/r", 5, "jeffreybergier"),
      issue("o/r", 6, "jeffreybergier"),
    ],
  });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 3);
  for (const n of [4, 5, 6]) assert.equal(store.isProcessed("o/r", n), true);
});

// ---- failure reporting (post the error back to the issue, no LLM) -----------

test("poller comments the failure back on the issue when a step fails", async () => {
  const { store, poller, comments } = setup(
    { "o/r": [issue("o/r", 9, "jeffreybergier")] },
    { job: failingJob(), registry: boomRegistry() },
  );
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns()[0]?.status, "failed");
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.issueNumber, 9);
  assert.match(comments[0]?.body ?? "", /model did not call submit_implement_issue/);
  assert.match(comments[0]?.body ?? "", /implement-issue/);
});

test("poller does not comment when the job succeeds", async () => {
  const { store, poller, comments } = setup({ "o/r": [issue("o/r", 10, "jeffreybergier")] });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns()[0]?.status, "succeeded");
  assert.equal(comments.length, 0);
});

// ---- failureNote / failureComment (pure helpers) ----------------------------

function failedRun(stepRuns: JobRun["stepRuns"]): JobRun {
  return { id: "o/r#1/process-issue/abc", jobId: "process-issue", status: "failed", startedAt: "2030-01-01T00:00:00.000Z", stepRuns };
}

test("failureNote surfaces the failed step's recorded note, step-qualified", () => {
  const run = failedRun([
    { stepId: "fetch-issue", status: "succeeded" },
    { stepId: "implement-issue", status: "failed", note: "model did not call submit_implement_issue" },
    { stepId: "open-pr", status: "skipped" },
  ]);
  assert.equal(failureNote(run), 'step "implement-issue" failed: model did not call submit_implement_issue');
});

test("failureNote falls back when the failed step recorded no note", () => {
  assert.equal(failureNote(failedRun([{ stepId: "implement-issue", status: "failed" }])), 'step "implement-issue" failed');
});

test("failureNote falls back when no step is marked failed", () => {
  assert.match(failureNote(failedRun([{ stepId: "fetch-issue", status: "succeeded" }])), /no step reported an error/);
});

test("failureNote throws on a non-JobRun", () => {
  assert.throws(() => failureNote(null as never), /run must be a JobRun/);
});

test("failureComment embeds the run id and the error in a fenced block", () => {
  const body = failureComment("o/r#9/process-issue/abc", "model did not call submit_implement_issue");
  assert.match(body, /o\/r#9\/process-issue\/abc/);
  assert.match(body, /```\nmodel did not call submit_implement_issue\n```/);
  assert.match(body, /nothing got pushed/);
});

test("failureComment throws on empty args", () => {
  assert.throws(() => failureComment("", "boom"), /runId must be a non-empty string/);
  assert.throws(() => failureComment("run", ""), /detail must be a non-empty string/);
});
