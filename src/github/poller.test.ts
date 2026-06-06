import { test } from "node:test";
import assert from "node:assert/strict";
import { IssuePoller, isAllowedAuthor, formatRunId } from "./poller.js";
import type { GitHubClient, IssueRef } from "./client.js";
import { openDatabase } from "../jobs/db.js";
import { SqliteJobStore } from "../jobs/sqliteStore.js";
import { defaultStepKinds } from "../jobs/stepKinds.js";
import { processIssueJob } from "../jobs/processIssueJob.js";

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

// Only listAccessibleRepos + listOpenIssues are exercised under the stub
// registry; the rest satisfy the interface but are never called.
function fakeClient(issuesByRepo: Record<string, IssueRef[]>): GitHubClient {
  return {
    listAccessibleRepos: async () => Object.keys(issuesByRepo),
    listOpenIssues: async (repo) => issuesByRepo[repo] ?? [],
    getIssue: async () => { throw new Error("getIssue not used in stub run"); },
    getDefaultBranch: async () => "main",
    openPullRequest: async () => ({ number: 1, url: "x" }),
    commentOnIssue: async () => 1,
    closeIssue: async () => {},
  };
}

function setup(issuesByRepo: Record<string, IssueRef[]>, opts: { whitelist?: string[] } = {}) {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const job = processIssueJob();
  store.saveJob(job);
  const poller = new IssuePoller({
    client: fakeClient(issuesByRepo),
    store,
    registry: defaultStepKinds(),
    job,
    whitelist: opts.whitelist ?? ["jeffreybergier"],
    intervalMs: 1000,
  });
  return { store, poller };
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
