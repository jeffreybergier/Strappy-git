import { test } from "node:test";
import assert from "node:assert/strict";
import { IssuePoller, isAllowedAuthor, formatRunId, failureNote, failureComment } from "./poller.js";
import type { GitHubClient, IssueComment, IssueRef } from "./client.js";
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

// Inbound comment threads, keyed "repo#number" — what listComments returns, so
// tests can drop a whitelisted reply in and assert the re-trigger.
type Thread = Record<string, IssueComment[]>;

function comment(id: number, author: string, body: string): IssueComment {
  return { id, author, body, createdAt: "2030-01-01T00:00:00.000Z" };
}

// listComments reads the inbound thread; commentOnIssue records into the outbound
// sink so failure-reporting is asserted. The remaining methods satisfy the
// interface but are never called under the stub registry.
function fakeClient(issuesByRepo: Record<string, IssueRef[]>, posted: CapturedComment[], thread: Thread): GitHubClient {
  return {
    listAccessibleRepos: async () => Object.keys(issuesByRepo),
    listOpenIssues: async (repo) => issuesByRepo[repo] ?? [],
    getIssue: async () => { throw new Error("getIssue not used in stub run"); },
    listComments: async (repo, issueNumber) => thread[`${repo}#${issueNumber}`] ?? [],
    getDefaultBranch: async () => "main",
    openPullRequest: async () => ({ number: 1, url: "x" }),
    commentOnIssue: async (repo, issueNumber, body) => { posted.push({ repo, issueNumber, body }); return posted.length; },
    closeIssue: async () => {},
  };
}

function setup(issuesByRepo: Record<string, IssueRef[]>, opts: { whitelist?: string[]; job?: Job; registry?: StepKindRegistry; thread?: Thread } = {}) {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = opts.job ?? processIssueJob();
  store.saveJob(job);
  const comments: CapturedComment[] = [];
  const thread = opts.thread ?? {};
  const poller = new IssuePoller({
    client: fakeClient(issuesByRepo, comments, thread),
    store,
    registry: opts.registry ?? defaultStepKinds(),
    job,
    whitelist: opts.whitelist ?? ["jeffreybergier"],
    intervalMs: 1000,
  });
  return { store, poller, comments, thread };
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

test("a backlog shows queued runs in the dashboard before they start", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  // The queue runs jobs one at a time. Holding the first run open on a barrier
  // keeps the second issue's run parked behind it, so it must read "queued".
  const registry = new StepKindRegistry().register("wait", async () => {
    await barrier;
    return {};
  });
  const oneStep: Job = {
    id: "process-issue",
    name: "Process New Issue",
    description: "",
    trigger: "github.issue.opened",
    steps: [{ id: "s1", kind: "wait", name: "s1", description: "", inputs: [], outputs: [] }],
  };
  const { store, poller } = setup(
    { "o/r": [issue("o/r", 20, "jeffreybergier"), issue("o/r", 21, "jeffreybergier")] },
    { job: oneStep, registry },
  );
  await poller.tick(); // both enqueued; the first run starts and blocks on the barrier
  assert.deepEqual(store.listRuns().map((r) => r.status).sort(), ["queued", "running"]);
  release();
  await poller.whenIdle();
});

// ---- reply-triggered re-runs (watermark on the comment id) ------------------

test("a whitelisted reply to a seen (open) issue re-triggers a fresh run", async () => {
  const thread: Thread = {};
  const { store, poller, comments } = setup(
    { "o/r": [issue("o/r", 11, "jeffreybergier")] },
    { job: failingJob(), registry: boomRegistry(), thread },
  );
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 1, "the new issue runs once");
  assert.equal(comments.length, 1, "and posts one failure comment");
  // A whitelisted human replies; the next tick sees a newer comment id.
  thread["o/r#11"] = [comment(5, "jeffreybergier", "please try again")];
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 2, "the reply re-triggers exactly one re-run");
  assert.equal(store.lastProcessedComment("o/r", 11), 5, "and the watermark advances to it");
});

test("the same comment never re-triggers twice (watermark holds)", async () => {
  const thread: Thread = { "o/r#13": [comment(3, "jeffreybergier", "context already here at creation")] };
  const { store, poller } = setup(
    { "o/r": [issue("o/r", 13, "jeffreybergier")] },
    { job: failingJob(), registry: boomRegistry(), thread },
  );
  await poller.tick();
  await poller.whenIdle();
  await poller.tick(); // same thread, no newer comment
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 1, "a comment present at first run is baselined, not re-fired");
});

test("a non-whitelisted reply does not re-trigger, no matter who posts", async () => {
  const thread: Thread = {};
  const { store, poller } = setup(
    { "o/r": [issue("o/r", 14, "jeffreybergier")] },
    { job: failingJob(), registry: boomRegistry(), thread },
  );
  await poller.tick();
  await poller.whenIdle();
  thread["o/r#14"] = [comment(9, "rando", "drive-by comment")];
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 1, "an outsider's comment never raises the watermark");
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
