import { test } from "node:test";
import assert from "node:assert/strict";
import { TriggerPoller, issueSource, pullRequestSource, isReviewablePullRequest, isAllowedAuthor, isPushProtected, formatRunId, failureNote, failureComment, attemptedSummary, failureOutputKeys } from "./poller.js";
import type { Watcher } from "./poller.js";
import type { GitHubClient, IssueComment, IssueRef, PullRequestRef } from "./client.js";
import { openDatabase } from "../jobs/db.js";
import { SqliteJobStore } from "../jobs/sqliteStore.js";
import { StepKindRegistry, stubExecutor } from "../jobs/stepKinds.js";
import { llmDerivableKeys } from "../jobs/llmKind.js";
import { processIssueJob } from "../jobs/processIssueJob.js";
import { processPullRequestJob } from "../jobs/processPullRequestJob.js";
import { failureHandler } from "../jobs/failureHandler.js";
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

// ---- TriggerPoller (ledger-only dedupe + sequential queue, no network) ------

function issue(repo: string, number: number, author: string): IssueRef {
  return { repo, number, author, title: `t${number}`, body: "", createdAt: "2030-01-01T00:00:00.000Z" };
}

// A same-repo PR by default; pass headRepo to simulate a fork.
function pr(repo: string, number: number, author: string, headRef = `feature/${number}`, headRepo = repo): PullRequestRef {
  return { repo, number, author, title: `t${number}`, body: "", headRef, headRepo, createdAt: "2030-01-01T00:00:00.000Z" };
}

interface CapturedComment { repo: string; issueNumber: number; body: string; }

// Inbound comment threads, keyed "repo#number" — what listComments returns, so
// tests can drop a whitelisted reply in and assert the re-trigger.
type Thread = Record<string, IssueComment[]>;

function comment(id: number, author: string, body: string): IssueComment {
  return { id, author, body, createdAt: "2030-01-01T00:00:00.000Z" };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// listComments reads the inbound thread; commentOnIssue records into the outbound
// sink so failure-reporting is asserted. The remaining methods satisfy the
// interface but are never called under the stub registry.
function fakeClient(issuesByRepo: Record<string, IssueRef[]>, posted: CapturedComment[], thread: Thread, prsByRepo: Record<string, PullRequestRef[]> = {}): GitHubClient {
  return {
    listAccessibleRepos: async () => [...new Set([...Object.keys(issuesByRepo), ...Object.keys(prsByRepo)])],
    listOpenIssues: async (repo) => issuesByRepo[repo] ?? [],
    listOpenPullRequests: async (repo) => prsByRepo[repo] ?? [],
    getIssue: async () => { throw new Error("getIssue not used in stub run"); },
    listComments: async (repo, issueNumber) => thread[`${repo}#${issueNumber}`] ?? [],
    getDefaultBranch: async () => "main",
    listBranchRules: async () => ["pull_request", "non_fast_forward", "deletion"],
    openPullRequest: async () => ({ number: 1, url: "x" }),
    commentOnIssue: async (repo, issueNumber, body) => { posted.push({ repo, issueNumber, body }); return posted.length; },
    closeIssue: async () => {},
  };
}

interface SetupOpts {
  whitelist?: string[];
  job?: Job;
  registry?: StepKindRegistry;
  thread?: Thread;
  listBranchRules?: GitHubClient["listBranchRules"];
  // Open PRs by repo; providing them adds a process-pull-request watcher.
  prs?: Record<string, PullRequestRef[]>;
}

function setup(issuesByRepo: Record<string, IssueRef[]>, opts: SetupOpts = {}) {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = opts.job ?? processIssueJob();
  store.saveJob(job);
  const comments: CapturedComment[] = [];
  const thread = opts.thread ?? {};
  const client = { ...fakeClient(issuesByRepo, comments, thread, opts.prs ?? {}), ...(opts.listBranchRules && { listBranchRules: opts.listBranchRules }) };
  const watchers: Watcher[] = [{ job, source: issueSource(client) }];
  if (opts.prs !== undefined) {
    const prJob = processPullRequestJob();
    store.saveJob(prJob);
    watchers.push({ job: prJob, source: pullRequestSource(client) });
  }
  const poller = new TriggerPoller({
    client,
    store,
    registry: opts.registry ?? stubRegistryForJobs(watchers.map((w) => w.job)),
    watchers,
    whitelist: opts.whitelist ?? ["jeffreybergier"],
    intervalMs: 1000,
  });
  return { store, poller, comments, thread };
}

// Stub registry that backs the real jobs in tests: every kind they use, run as a
// stub, with the llm kinds declaring their derivers so the poller's strict-init
// validateJobRegistry check passes (production wires githubStepKinds, which
// declares the same derivers).
function stubRegistryForJobs(jobs: Job[]): StepKindRegistry {
  const registry = new StepKindRegistry();
  for (const kind of new Set(jobs.flatMap((job) => job.steps.map((s) => s.kind)))) {
    const caps = kind === "llm" || kind === "llm.review" ? { derivableKeys: llmDerivableKeys() } : undefined;
    registry.register(kind, stubExecutor, caps);
  }
  return registry;
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
    failureHandler: failureHandler(),
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

test("overlapping ticks join the in-flight scan instead of enqueueing twice", async () => {
  const listedComments = deferred();
  const releaseComments = deferred();
  let repoLists = 0;
  let commentLists = 0;
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = processIssueJob();
  store.saveJob(job);
  const client: GitHubClient = {
    listAccessibleRepos: async () => { repoLists += 1; return ["o/r"]; },
    listOpenIssues: async () => [issue("o/r", 31, "jeffreybergier")],
    listOpenPullRequests: async () => [],
    getIssue: async () => { throw new Error("getIssue not used in stub run"); },
    listComments: async () => {
      commentLists += 1;
      listedComments.resolve();
      await releaseComments.promise;
      return [];
    },
    getDefaultBranch: async () => "main",
    listBranchRules: async () => ["pull_request"],
    openPullRequest: async () => ({ number: 1, url: "x" }),
    commentOnIssue: async () => 1,
    closeIssue: async () => {},
  };
  const poller = new TriggerPoller({
    client,
    store,
    registry: stubRegistryForJobs([job]),
    watchers: [{ job, source: issueSource(client) }],
    whitelist: ["jeffreybergier"],
    intervalMs: 1000,
  });
  const first = poller.tick();
  await listedComments.promise;
  const second = poller.tick();
  releaseComments.resolve();
  await Promise.all([first, second]);
  await poller.whenIdle();
  assert.equal(repoLists, 1);
  assert.equal(commentLists, 1);
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
    failureHandler: failureHandler(),
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

// ---- pull-request watcher (same-repo PRs reviewed via the shared queue) -----

test("isReviewablePullRequest accepts a same-repo branch and rejects forks", () => {
  assert.equal(isReviewablePullRequest(pr("o/r", 1, "u", "feature/x", "o/r")), true);
  assert.equal(isReviewablePullRequest(pr("o/r", 1, "u", "feature/x", "fork-owner/r")), false);
  assert.equal(isReviewablePullRequest(pr("o/r", 1, "u", "feature/x", "")), false); // deleted head repo
});

test("isReviewablePullRequest rejects Strappy's own strappy/ branches", () => {
  assert.equal(isReviewablePullRequest(pr("o/r", 1, "u", "strappy/issue-3/8e6e2f89")), false);
});

test("isReviewablePullRequest throws on a non-PullRequestRef", () => {
  assert.throws(() => isReviewablePullRequest(null as never), /pr must be a PullRequestRef/);
});

test("poller enqueues and processes a whitelisted user's same-repo PR", async () => {
  const { store, poller } = setup({}, { prs: { "o/r": [pr("o/r", 8, "jeffreybergier")] } });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 8), true);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.listRuns()[0]?.status, "succeeded");
  assert.match(store.listRuns()[0]?.id ?? "", /^o\/r#8\/process-pull-request\/[0-9a-f]{8}$/);
});

test("poller ignores a PR opened from a fork", async () => {
  const { store, poller } = setup({}, { prs: { "o/r": [pr("o/r", 9, "jeffreybergier", "feature/x", "fork-owner/r")] } });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 9), false);
  assert.equal(store.listRuns().length, 0);
});

test("poller ignores a PR from a non-whitelisted user", async () => {
  const { store, poller } = setup({}, { prs: { "o/r": [pr("o/r", 10, "attacker")] } });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 10), false);
  assert.equal(store.listRuns().length, 0);
});

test("issues and PRs run through one shared poller, ledger, and queue", async () => {
  const { store, poller } = setup(
    { "o/r": [issue("o/r", 1, "jeffreybergier")] },
    { prs: { "o/r": [pr("o/r", 2, "jeffreybergier")] } },
  );
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 2);
  const ids = store.listRuns().map((r) => r.id).sort();
  assert.match(ids[0] ?? "", /^o\/r#1\/process-issue\//);
  assert.match(ids[1] ?? "", /^o\/r#2\/process-pull-request\//);
  assert.ok(store.listRuns().every((r) => r.status === "succeeded"));
});

test("a whitelisted reply on a reviewed PR re-triggers a fresh review", async () => {
  const thread: Thread = {};
  const { store, poller } = setup({}, { prs: { "o/r": [pr("o/r", 12, "jeffreybergier")] }, thread });
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 1, "the new PR runs once");
  thread["o/r#12"] = [comment(6, "jeffreybergier", "pushed fixes, look again")];
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns().length, 2, "the reply re-triggers exactly one re-run");
  assert.equal(store.lastProcessedComment("o/r", 12), 6, "and the watermark advances to it");
});

// ---- branch-protection check (advisory: warn per tick, never block) ---------

test("isPushProtected requires an active pull_request rule", () => {
  assert.equal(isPushProtected(["pull_request", "non_fast_forward", "deletion"]), true);
  assert.equal(isPushProtected(["non_fast_forward", "deletion"]), false);
  assert.equal(isPushProtected([]), false);
});

test("isPushProtected throws on a non-array", () => {
  assert.throws(() => isPushProtected(null as never), /ruleTypes must be an array/);
});

test("an unprotected repo is still polled — the check only warns", async () => {
  const { store, poller } = setup(
    { "o/r": [issue("o/r", 40, "jeffreybergier")] },
    { listBranchRules: async () => [] },
  );
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 40), true);
  assert.equal(store.listRuns().length, 1);
});

test("an unverifiable protection check never blocks polling (e.g. plan-gated 403)", async () => {
  const { store, poller } = setup(
    { "o/r": [issue("o/r", 41, "jeffreybergier")] },
    { listBranchRules: async () => { throw new Error("Upgrade to GitHub Pro or make this repository public to enable this feature."); } },
  );
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.isProcessed("o/r", 41), true);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.listRuns()[0]?.status, "succeeded");
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

// A security.scan step that rejects by throwing its (markdown) reason — the real
// kind's failure shape — so the poller's prompt-check branch can be exercised.
function blockedJob(): Job {
  return {
    id: "process-issue", name: "Process New Issue", description: "blocks at the security gate",
    trigger: "github.issue.opened",
    steps: [{ id: "security-scan", kind: "security.scan", name: "Security Scan", description: "", inputs: [], outputs: [] }],
    failureHandler: failureHandler(),
  };
}

test("a security-scan rejection posts a 'Prompt Check Failed' comment carrying the model's voiced reason", async () => {
  const registry = new StepKindRegistry().register("security.scan", () => {
    throw new Error("Hard pass, babe — this reeks of **prompt injection**. 🚫");
  });
  const { store, poller, comments } = setup(
    { "o/r": [issue("o/r", 30, "jeffreybergier")] },
    { job: blockedJob(), registry },
  );
  await poller.tick();
  await poller.whenIdle();
  assert.equal(store.listRuns()[0]?.status, "failed");
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /\*\*🚫 Prompt Check Failed\*\*/);
  assert.match(comments[0]?.body ?? "", /\*\*prompt injection\*\*/); // markdown survives, not fenced
  assert.doesNotMatch(comments[0]?.body ?? "", /nothing was pushed/); // not the generic failure report
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

test("failureComment leads with a bold heading and embeds the error in a verbatim fenced block, plain (no sass)", () => {
  const body = failureComment("o/r#9/process-issue/abc", "model did not call submit_implement_issue");
  assert.match(body, /^\*\*⚠️ Job failed\*\*\n\n---\n\n/);
  assert.match(body, /o\/r#9\/process-issue\/abc/);
  assert.match(body, /```\nmodel did not call submit_implement_issue\n```/);
  assert.match(body, /Nothing was pushed/);
});

test("failureComment throws on empty args", () => {
  assert.throws(() => failureComment("", "boom"), /runId must be a non-empty string/);
  assert.throws(() => failureComment("run", ""), /detail must be a non-empty string/);
});

test("failureComment appends the model's summary under an attributed header, markdown intact (not fenced)", () => {
  const body = failureComment("o/r#9/process-issue/abc", "nothing to commit, working tree clean", "## What I did\nMade it **sparkle** ✨");
  assert.match(body, /```\nnothing to commit, working tree clean\n```/); // the error still fenced
  assert.match(body, /\*\*What the model was trying to do\*\*/);
  assert.match(body, /## What I did\nMade it \*\*sparkle\*\* ✨/); // the model's markdown survives, not fenced
});

test("failureComment omits the summary section when none is given", () => {
  assert.doesNotMatch(failureComment("run", "boom"), /What the model was trying to do/);
  assert.doesNotMatch(failureComment("run", "boom", null), /What the model was trying to do/);
  assert.doesNotMatch(failureComment("run", "boom", "   "), /What the model was trying to do/);
});

test("failureOutputKeys reads the graph's feedsFailure markers (process-issue marks the PR summary)", () => {
  assert.deepEqual(failureOutputKeys(processIssueJob()), ["pullRequestSummary"]);
});

test("failureOutputKeys is empty for a job that marks nothing", () => {
  assert.deepEqual(failureOutputKeys(failingJob()), []);
});

test("failureOutputKeys throws on a non-Job", () => {
  assert.throws(() => failureOutputKeys(null as never), /job must be a Job/);
});

test("attemptedSummary reads a marked-key value off a succeeded step's recorded outputs", () => {
  const run = failedRun([
    { stepId: "implement-issue", status: "succeeded", outputs: { pullRequestSummary: "Refactored the thing 💅" } },
    { stepId: "commit-push", status: "failed", note: "nothing to commit" },
  ]);
  assert.equal(attemptedSummary(run, ["pullRequestSummary"]), "Refactored the thing 💅");
});

test("attemptedSummary falls back to a failed step's resolved inputs (the carried pass value)", () => {
  const run = failedRun([
    { stepId: "implement-issue", status: "succeeded" },
    { stepId: "commit-push", status: "failed", inputs: { pullRequestSummary: "Carried summary" }, note: "boom" },
  ]);
  assert.equal(attemptedSummary(run, ["pullRequestSummary"]), "Carried summary");
});

test("attemptedSummary returns null when no step carried a marked value (or no keys are marked)", () => {
  const carried = failedRun([{ stepId: "implement-issue", status: "succeeded", outputs: { pullRequestSummary: "x" } }]);
  assert.equal(attemptedSummary(failedRun([{ stepId: "fetch-issue", status: "failed", note: "404" }]), ["pullRequestSummary"]), null);
  assert.equal(attemptedSummary(carried, []), null); // nothing marked -> nothing relayed
});

test("attemptedSummary throws on a non-JobRun or non-array keys", () => {
  assert.throws(() => attemptedSummary(null as never, []), /run must be a JobRun/);
  assert.throws(() => attemptedSummary(failedRun([]), null as never), /keys must be an array/);
});
