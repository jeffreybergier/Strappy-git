import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { queuedRun, runJob } from "../jobs/scheduler.js";
import { SequentialQueue } from "../jobs/queue.js";
import { StepKindRegistry } from "../jobs/stepKinds.js";
import type { StepValues } from "../jobs/stepKinds.js";
import { validateJobRegistry } from "../jobs/validateJobRegistry.js";
import { promptCheckComment } from "../jobs/githubKinds.js";
import type { JobWriteStore, TriggerLedger } from "../jobs/store.js";
import type { Activation, Job, JobRun, StepRun, TriggerCondition } from "../jobs/types.js";
import { validateTriggerPartition, validateWatchedTrigger } from "../jobs/trigger.js";
import { uuidStem } from "./git.js";
import type { GitHubClient, PullRequestRef } from "./client.js";

const log = createLogger("Poller");

// One poll-able trigger candidate, shaped independently of issues vs PRs:
// (repo, number) keys the ledger and addresses comments (GitHub numbers issues
// and PRs from one sequence, and a PR is an issue to the comment API), author
// gates the whitelist, and inputs are the ambient trigger constants the job's
// steps read — everything except the per-run jobUuid, which the poller mints.
export interface TriggerItem {
  repo: string;
  number: number;
  author: string;
  inputs: StepValues;
}

// Where a watcher's candidates come from (open issues, open PRs, ...). `name`
// labels log lines only.
export interface TriggerSource {
  name: string;
  list(repo: string): Promise<TriggerItem[]>;
}

// A job bound to the trigger source that feeds it candidates. The poller runs
// any number of watchers over the same repo discovery, ledger, and sequential
// queue, so runs from different processes still execute one at a time. The
// firing rules (activation, gates, failure policy) are NOT stored here — they
// are read off job.trigger, the declared TriggerSpec, so the wiring cannot
// drift from the contract the dashboard renders.
export interface Watcher {
  job: Job;
  source: TriggerSource;
}

// Derives a watcher from the job's own TriggerSpec: the spec picks the feed
// (subject), the feed filter (branch conditions), the activation, and the
// failure policy. Refuses a spec that doesn't declare the gates the poller
// enforces (validateWatchedTrigger), so watching an undeclared job is an error.
export function watcherFor(job: Job, client: GitHubClient): Watcher {
  if (!job || !job.trigger) throw new Error("[Poller.watcherFor] job with a trigger spec is required");
  if (!client) throw new Error("[Poller.watcherFor] client is required");
  validateWatchedTrigger(job.trigger);
  const source = job.trigger.subject === "issue"
    ? issueSource(client)
    : pullRequestSource(client, conditionFilter(job.trigger.conditions));
  return { job, source };
}

// Adapts the open-issue feed to the generic poller; inputs mirror
// processIssueJob.issueTriggerInputs.
export function issueSource(client: GitHubClient): TriggerSource {
  if (!client) throw new Error("[Poller.issueSource] client is required");
  return {
    name: "issue(s)",
    list: async (repo) => (await client.listOpenIssues(repo)).map((issue) => ({
      repo: issue.repo,
      number: issue.number,
      author: issue.author,
      inputs: { repo: issue.repo, issueNumber: issue.number, issueAuthor: issue.author },
    })),
  };
}

// Same-repo gate behind the "head-branch-in-same-repo" condition: only a PR
// whose head branch lives in THIS repo can be checked out or pushed to — a
// fork's branch is outside the trust boundary (and headRepo is "" when the fork
// was deleted, which also fails).
export function isSameRepoPullRequest(pr: PullRequestRef): boolean {
  if (!pr || typeof pr.headRepo !== "string" || typeof pr.headRef !== "string" || typeof pr.baseRef !== "string") {
    throw new Error("[Poller.isSameRepoPullRequest] pr must be a PullRequestRef");
  }
  return pr.headRepo === pr.repo;
}

// Compiles a spec's branch conditions into one feed filter — the executable
// side of the declared TriggerCondition data, like StepKindRegistry resolves a
// step kind. Author and once-per-trigger conditions return no predicate here:
// they are the poller core's own whitelist and ledger gates.
export function conditionFilter(conditions: TriggerCondition[]): (pr: PullRequestRef) => boolean {
  if (!Array.isArray(conditions)) throw new Error("[Poller.conditionFilter] conditions must be an array");
  const checks = conditions.map((c) => conditionPredicate(c)).filter((p) => p !== null);
  return (pr) => checks.every((check) => check(pr));
}

function conditionPredicate(condition: TriggerCondition): ((pr: PullRequestRef) => boolean) | null {
  if (condition.kind === "head-branch-in-same-repo") return isSameRepoPullRequest;
  if (condition.kind === "head-branch-not-prefixed") return (pr) => !pr.headRef.startsWith(condition.prefix);
  return null;
}

// Adapts the open-PR feed to the generic poller; inputs mirror
// pullRequestTriggerInputs / pullRequestCommentTriggerInputs (one shape).
export function pullRequestSource(client: GitHubClient, filter: (pr: PullRequestRef) => boolean): TriggerSource {
  if (!client) throw new Error("[Poller.pullRequestSource] client is required");
  if (typeof filter !== "function") throw new Error("[Poller.pullRequestSource] filter must be a function");
  return {
    name: "pull request(s)",
    list: async (repo) => (await client.listOpenPullRequests(repo))
      .filter((pr) => filter(pr))
      .map((pr) => triggerItem(pr)),
  };
}

function triggerItem(pr: PullRequestRef): TriggerItem {
  return {
    repo: pr.repo,
    number: pr.number,
    author: pr.author,
    inputs: { repo: pr.repo, prNumber: pr.number, prAuthor: pr.author, prBranch: pr.headRef, baseBranch: pr.baseRef },
  };
}

// Security gate: only whitelisted GitHub users may trigger Strappy. Fails
// closed — an empty whitelist authorizes nobody. GitHub logins are
// case-insensitive, so the comparison is too.
export function isAllowedAuthor(login: string, whitelist: readonly string[]): boolean {
  if (typeof login !== "string") throw new Error("[Poller.isAllowedAuthor] login must be a string");
  if (!Array.isArray(whitelist)) throw new Error("[Poller.isAllowedAuthor] whitelist must be an array");
  if (login.trim() === "" || whitelist.length === 0) return false;
  const needle = login.trim().toLowerCase();
  return whitelist.some((u) => u.trim().toLowerCase() === needle);
}

// Push-protection gate: a branch rejects direct pushes when an active ruleset
// requires a pull request before merging. The other rule types (non_fast_forward,
// deletion, …) do not block a plain push, so only "pull_request" counts.
export function isPushProtected(ruleTypes: readonly string[]): boolean {
  if (!Array.isArray(ruleTypes)) throw new Error("[Poller.isPushProtected] ruleTypes must be an array");
  return ruleTypes.includes("pull_request");
}

// Informative run id: <repo>#<issue>/<process>/<first uuid segment>, e.g.
// owner/name#42/process-issue/16498324 — readable in place of run-<full uuid>.
export function formatRunId(repo: string, issueNumber: number, process: string, jobUuid: string): string {
  if (typeof repo !== "string" || repo.trim() === "") throw new Error("[Poller.formatRunId] repo must be a non-empty string");
  if (!Number.isInteger(issueNumber)) throw new Error("[Poller.formatRunId] issueNumber must be an integer");
  if (typeof process !== "string" || process.trim() === "") throw new Error("[Poller.formatRunId] process must be a non-empty string");
  return `${repo}#${issueNumber}/${process}/${uuidStem(jobUuid)}`;
}

// The error to surface on the issue: the failed step's recorded note (its error
// message), step-qualified, or a generic line when a run failed without one.
// Reads straight off the recorded run, so no LLM is involved.
export function failureNote(run: JobRun): string {
  if (run === null || typeof run !== "object" || !Array.isArray(run.stepRuns)) {
    throw new Error("[Poller.failureNote] run must be a JobRun");
  }
  const failed = run.stepRuns.find((s) => s.status === "failed");
  if (failed === undefined) return "the run failed but no step reported an error";
  const note = failed.note?.trim();
  return note ? `step "${failed.stepId}" failed: ${note}` : `step "${failed.stepId}" failed`;
}

// The closing line of a failure comment — what happens next. RETRY_EPILOGUE is
// for comment-retriggerable threads (PRs: a whitelisted reply runs the update
// job); CLOSED_EPILOGUE is for one-shot issue runs that failed before code side
// effects; LEFT_OPEN_EPILOGUE is for issue runs that already pushed code or
// opened a PR, so closing them as not planned would be misleading.
export const RETRY_EPILOGUE =
  "This is an automatic report from the harness. To retry, reply here — a comment from a whitelisted user re-runs the job on the whole thread.";
export const CLOSED_EPILOGUE =
  "This is an automatic report from the harness. This issue is now closed as failed; replies here will not re-run the job. To retry, open a new issue.";
export const LEFT_OPEN_EPILOGUE =
  "This is an automatic report from the harness. This issue was left open because code was already pushed or a PR was opened; replies here will not re-run the issue job. Continue on the PR or branch, or open a new issue to retry from scratch.";

// The issue comment posted when a generic job step fails (not the prompt check —
// that gets its own promptCheckComment). The harness frame is fixed, plain text —
// NOT the model's voice — so faking Strappy's sass here never puts words in a
// model's mouth. The underlying error is a verbatim ``` fence (it is a plain
// technical message, not markdown). When the model spoke before the failure, its
// own recorded PR summary is appended verbatim under an attributed header (its
// genuine words, never synthesized) so a human learns what it set out to do.
// States what side effects already happened and what happens next (the epilogue),
// so a human knows whether there is code or a PR to inspect.
export function failureComment(
  runId: string,
  detail: string,
  summary?: string | null,
  epilogue: string = RETRY_EPILOGUE,
  stateLine: string = "No code was pushed.",
): string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("[Poller.failureComment] runId must be a non-empty string");
  }
  if (typeof detail !== "string" || detail.trim() === "") {
    throw new Error("[Poller.failureComment] detail must be a non-empty string");
  }
  if (typeof epilogue !== "string" || epilogue.trim() === "") {
    throw new Error("[Poller.failureComment] epilogue must be a non-empty string");
  }
  if (typeof stateLine !== "string" || stateLine.trim() === "") {
    throw new Error("[Poller.failureComment] stateLine must be a non-empty string");
  }
  const lines = [
    "**⚠️ Job failed**",
    "",
    "---",
    "",
    `${stateLine.trim()} Run \`${runId}\` failed with:`,
    "",
    "```",
    detail.trim(),
    "```",
  ];
  if (typeof summary === "string" && summary.trim() !== "") {
    lines.push("", "---", "", "**What the model was trying to do**", "", summary.trim());
  }
  lines.push("", epilogue.trim());
  return lines.join("\n");
}

// The output keys the job marks `feedsFailure` — the values to relay into the
// failure comment. Derived from the graph (not hardcoded), so renaming or moving
// the summary output updates the failure path automatically.
export function failureOutputKeys(job: Job): string[] {
  if (!job || !Array.isArray(job.steps)) throw new Error("[Poller.failureOutputKeys] job must be a Job");
  const keys = new Set<string>();
  for (const step of job.steps) {
    for (const output of step.outputs) if (output.feedsFailure) keys.add(output.key);
  }
  return [...keys];
}

// The model's best-effort summary, read off whichever recorded step carried one
// of the `feedsFailure` keys — the producer step records it on its outputs, later
// steps carry it as a pass value (so a failed commit-push still has it on the
// inputs it resolved before failing). Lets a failure AFTER the model spoke relay
// what it set out to do, reading the recorded run only (no LLM call). Returns
// null when no step carried a value (a failure at or before the producer).
export function attemptedSummary(run: JobRun, keys: readonly string[]): string | null {
  if (run === null || typeof run !== "object" || !Array.isArray(run.stepRuns)) {
    throw new Error("[Poller.attemptedSummary] run must be a JobRun");
  }
  if (!Array.isArray(keys)) throw new Error("[Poller.attemptedSummary] keys must be an array");
  for (const step of run.stepRuns) {
    const summary = summaryOf(step, keys);
    if (summary !== null) return summary;
  }
  return null;
}

export interface FailureSideEffects {
  pushed: boolean;
  branch: string | null;
  openedPrNumber: number | null;
  openedPrUrl: string | null;
}

// Reads completed side-effect receipts from the recorded run. Only outputs count
// for PR creation, so a PR job's trigger prNumber is not mistaken for a PR opened
// by this run.
export function failureSideEffects(run: JobRun): FailureSideEffects {
  if (run === null || typeof run !== "object" || !Array.isArray(run.stepRuns)) {
    throw new Error("[Poller.failureSideEffects] run must be a JobRun");
  }
  const effects: FailureSideEffects = { pushed: false, branch: null, openedPrNumber: null, openedPrUrl: null };
  for (const step of run.stepRuns) collectSideEffects(step, effects);
  return effects;
}

export function hasCodeSideEffects(run: JobRun): boolean {
  const effects = failureSideEffects(run);
  return effects.pushed || effects.openedPrNumber !== null;
}

export function failureStateLine(run: JobRun): string {
  const effects = failureSideEffects(run);
  if (effects.openedPrNumber !== null) {
    const link = effects.openedPrUrl === null ? "" : ` (${effects.openedPrUrl})`;
    return `Code was pushed and PR #${effects.openedPrNumber}${link} was opened before this failure.`;
  }
  if (effects.pushed) {
    const target = effects.branch === null ? "" : ` to branch \`${effects.branch}\``;
    return `Code was pushed${target} before this failure, but a later step did not complete.`;
  }
  return "No code was pushed.";
}

function collectSideEffects(step: StepRun, effects: FailureSideEffects): void {
  if (step.inputs !== undefined && effects.branch === null) {
    const branch = stringValue(step.inputs, "newBranch");
    if (branch !== null) effects.branch = branch;
  }
  if (step.outputs === undefined) return;
  if (step.outputs["pushed"] === true) effects.pushed = true;
  const branch = stringValue(step.outputs, "newBranch");
  if (branch !== null) effects.branch = branch;
  const prNumber = numberValue(step.outputs, "prNumber");
  if (prNumber !== null) effects.openedPrNumber = prNumber;
  const prUrl = stringValue(step.outputs, "prUrl");
  if (prUrl !== null) effects.openedPrUrl = prUrl;
}

function stringValue(values: StepValues, key: string): string | null {
  const value = values[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberValue(values: StepValues, key: string): number | null {
  const value = values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summaryOf(step: StepRun, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = step.outputs?.[key] ?? step.inputs?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface QueueItem {
  job: Job;
  trigger: TriggerItem;
  jobUuid: string;
  runId: string;
}

export interface TriggerPollerDeps {
  client: GitHubClient;
  store: JobWriteStore & TriggerLedger;
  registry: StepKindRegistry;
  watchers: Watcher[];
  whitelist: readonly string[];
  intervalMs: number;
  // Teardown handed to the scheduler; removes the run's clone workspace.
  cleanup?: (triggerInputs: StepValues) => Promise<void> | void;
}

// Watches auto-discovered repos for each watcher's trigger items (new issues,
// new same-repo PRs). The whole "should we act?" decision is the SQLite ledger:
// if there is no row for (repo, number) and the author is whitelisted, the item
// is claimed in the ledger and pushed onto a queue that runs jobs one at a time
// — so a boot that finds a 10-issue backlog processes them sequentially, not
// all at once.
export class TriggerPoller {
  private readonly client: GitHubClient;
  private readonly store: JobWriteStore & TriggerLedger;
  private readonly registry: StepKindRegistry;
  private readonly watchers: Watcher[];
  private readonly whitelist: readonly string[];
  private readonly intervalMs: number;
  private readonly cleanup?: (triggerInputs: StepValues) => Promise<void> | void;
  private readonly queue: SequentialQueue<QueueItem>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(deps: TriggerPollerDeps) {
    if (!deps || !deps.client) throw new Error("[TriggerPoller] client is required");
    if (!deps.store) throw new Error("[TriggerPoller] store is required");
    if (!(deps.registry instanceof StepKindRegistry)) throw new Error("[TriggerPoller] registry is required");
    if (!Array.isArray(deps.watchers) || deps.watchers.length === 0) {
      throw new Error("[TriggerPoller] watchers must be a non-empty array");
    }
    for (const watcher of deps.watchers) {
      if (!watcher || !watcher.job || !watcher.source) throw new Error("[TriggerPoller] each watcher needs a job and a source");
      // Strict init: a watched job must declare every gate the poller enforces.
      validateWatchedTrigger(watcher.job.trigger);
    }
    // Watchers sharing a subject share ledger rows; their activations must
    // partition the events or one trigger would steal the other's claims.
    validateTriggerPartition(deps.watchers.map((w) => w.job.trigger));
    if (!Array.isArray(deps.whitelist)) throw new Error("[TriggerPoller] whitelist must be an array");
    if (!Number.isInteger(deps.intervalMs) || deps.intervalMs <= 0) {
      throw new Error("[TriggerPoller] intervalMs must be a positive integer");
    }
    if (deps.cleanup !== undefined && typeof deps.cleanup !== "function") {
      throw new Error("[TriggerPoller] cleanup must be a function");
    }
    this.client = deps.client;
    this.store = deps.store;
    this.registry = deps.registry;
    this.watchers = deps.watchers;
    this.whitelist = deps.whitelist;
    this.intervalMs = deps.intervalMs;
    this.cleanup = deps.cleanup;
    // Strict init: this registry must be able to run every watched job's contract.
    for (const watcher of this.watchers) validateJobRegistry(watcher.job, this.registry);
    this.queue = new SequentialQueue((item) => this.runItem(item));
  }

  start(): void {
    if (this.timer !== null) throw new Error("[TriggerPoller.start] already started");
    const jobs = this.watchers.map((w) => w.job.id).join(",");
    log.info("start", `watching auto-discovered repos every ${this.intervalMs}ms; jobs=[${jobs}]; whitelist=[${this.whitelist.join(",")}]`);
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // Resolves once the queue has drained everything enqueued so far (tests/shutdown).
  whenIdle(): Promise<void> {
    return this.queue.whenIdle();
  }

  async tick(): Promise<void> {
    if (this.ticking !== null) {
      log.warn("tick", "previous tick still running; joining it instead of starting another");
      return this.ticking;
    }
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const repos = await this.resolveRepos();
    log.info("tick", `discovered ${repos.length} repo(s): ${repos.join(", ") || "(none)"}`);
    for (const repo of repos) await this.pollRepo(repo);
  }

  // Discover (and refresh, every tick) the repos the bot can push to. A
  // discovery failure skips this cycle rather than crashing the poller.
  private async resolveRepos(): Promise<string[]> {
    try {
      return await this.client.listAccessibleRepos();
    } catch (error) {
      log.error("resolveRepos", "failed to auto-discover repos this cycle", error);
      return [];
    }
  }

  private async pollRepo(repo: string): Promise<void> {
    await this.warnIfUnprotected(repo);
    for (const watcher of this.watchers) await this.pollWatcher(repo, watcher);
  }

  // One watcher's failure (e.g. the PR list call) never blocks the others.
  private async pollWatcher(repo: string, watcher: Watcher): Promise<void> {
    try {
      const items = await watcher.source.list(repo);
      log.info("pollRepo", `${repo}: ${items.length} open ${watcher.source.name}`);
      for (const item of items) await this.maybeEnqueue(watcher, item);
    } catch (error) {
      log.error("pollRepo", `${watcher.source.name} failed for ${repo}`, error);
    }
  }

  // Advisory check, never blocking: the repo is polled either way, but a
  // default branch that accepts direct pushes (or can't be verified — e.g. a
  // private repo on a plan without rulesets) gets exactly one warn line per
  // tick. One line, no error dump: this fires every cycle until fixed.
  private async warnIfUnprotected(repo: string): Promise<void> {
    try {
      const branch = await this.client.getDefaultBranch(repo);
      if (isPushProtected(await this.client.listBranchRules(repo, branch))) return;
      log.warn("pollRepo", `${repo}: main branch protection is OFF — ${branch} accepts direct pushes; add a ruleset requiring a pull request`);
    } catch (error) {
      log.warn("pollRepo", `${repo}: could not verify main branch protection (${message(error)})`);
    }
  }

  // Enqueue at most one job per never-before-seen trigger. Claiming the row with
  // the triggering comment id makes every later tick a no-op until a strictly
  // newer whitelisted comment appears, so each trigger runs exactly once — the
  // spec's declared "once-per-trigger" condition.
  private async maybeEnqueue(watcher: Watcher, item: TriggerItem): Promise<void> {
    const commentId = await this.triggerCommentId(watcher.job.trigger.activation, item);
    if (commentId === null) return;
    const job = watcher.job;
    const jobUuid = randomUUID();
    const runId = formatRunId(item.repo, item.number, job.id, jobUuid);
    if (!this.store.claimProcessing(item.repo, item.number, runId, commentId)) {
      log.info("skip", `${item.repo}#${item.number}: trigger was already claimed`);
      return;
    }
    this.store.recordRun(queuedRun(job, runId, new Date().toISOString())); // visible as queued until it starts
    this.queue.enqueue({ job, trigger: item, jobUuid, runId });
    log.info("enqueue", `${item.repo}#${item.number} queued (depth ${this.queue.size}, comment ${commentId})`);
  }

  // The comment id to claim for this run, or null when nothing should run for
  // this watcher. An item already in the ledger re-triggers only a comment-
  // activated watcher, and only on a whitelisted comment strictly newer than
  // the watermark; a never-seen item is decided by firstSight.
  private async triggerCommentId(activation: Activation, item: TriggerItem): Promise<number | null> {
    if (!this.store.isProcessed(item.repo, item.number)) return this.firstSight(activation, item);
    if (activation === "creation") return null;
    const newest = await this.newestWhitelistedComment(item);
    return newest > this.store.lastProcessedComment(item.repo, item.number) ? newest : null;
  }

  // First sight of an item (no ledger row yet). A comment-activated watcher
  // ignores the item's author and fires only once a whitelisted comment exists.
  // A creation-activated watcher fires on a whitelisted author, baselining the
  // watermark to the newest whitelisted comment so replies already present at
  // creation ride along in the prompt instead of re-firing later.
  private async firstSight(activation: Activation, item: TriggerItem): Promise<number | null> {
    if (activation === "comment") {
      const newest = await this.newestWhitelistedComment(item);
      return newest > 0 ? newest : null;
    }
    if (!isAllowedAuthor(item.author, this.whitelist)) {
      log.info("skip", `${item.repo}#${item.number}: author @${item.author} not whitelisted`);
      return null;
    }
    return this.newestWhitelistedComment(item);
  }

  // The id of the newest comment authored by a whitelisted user, or 0 if none.
  // Strappy's own comments are not whitelisted, so they never raise this — the
  // poller can never re-trigger off its own PR-link, review, or error replies.
  // (A PR is an issue to the comment API, so this serves both watchers.)
  private async newestWhitelistedComment(item: TriggerItem): Promise<number> {
    const comments = await this.client.listComments(item.repo, item.number);
    let newest = 0;
    for (const c of comments) {
      if (c.id > newest && isAllowedAuthor(c.author, this.whitelist)) newest = c.id;
    }
    return newest;
  }

  private async runItem(item: QueueItem): Promise<void> {
    const { repo, number } = item.trigger;
    log.info("run", `${repo}#${number} — starting (${item.runId})`);
    try {
      const run = await runJob(
        item.job,
        { ...item.trigger.inputs, jobUuid: item.jobUuid },
        { registry: this.registry, store: this.store, newRunId: () => item.runId, ...(this.cleanup && { cleanup: this.cleanup }) },
      );
      this.store.setStatus(repo, number, item.runId, run.status);
      log.info("run", `${repo}#${number} -> ${run.status} (${item.runId})`);
      if (run.status === "failed") await this.reportFailure(item, this.failureBody(item, run), run);
    } catch (error) {
      this.store.setStatus(repo, number, item.runId, "failed");
      log.error("run", `${repo}#${number} crashed`, error);
      await this.reportFailure(item, failureComment(item.runId, message(error), null, this.epilogue(item)));
    }
  }

  // Every failure surfaces the same way: comment first, then — for a job whose
  // spec declares "close-not-planned" and whose run had no code side effects —
  // close the issue as failed so it leaves the open feed for good.
  private async reportFailure(item: QueueItem, body: string, run?: JobRun): Promise<void> {
    await this.postComment(item, body);
    if (this.shouldCloseAsFailed(item, run)) await this.closeAsFailed(item);
  }

  // The job's declared failure policy (TriggerSpec.onFailure). Only an issue
  // trigger may declare closing — validateWatchedTrigger rejects it on a PR
  // subject, where closeIssue would close the PR itself.
  private closesOnFailure(item: QueueItem): boolean {
    return item.job.trigger.onFailure === "close-not-planned";
  }

  private shouldCloseAsFailed(item: QueueItem, run?: JobRun): boolean {
    if (!this.closesOnFailure(item)) return false;
    return run === undefined || !hasCodeSideEffects(run);
  }

  private epilogue(item: QueueItem): string {
    return this.closesOnFailure(item) ? CLOSED_EPILOGUE : RETRY_EPILOGUE;
  }

  private failureEpilogue(item: QueueItem, run: JobRun): string {
    if (!this.closesOnFailure(item)) return RETRY_EPILOGUE;
    return hasCodeSideEffects(run) ? LEFT_OPEN_EPILOGUE : CLOSED_EPILOGUE;
  }

  // Best-effort, like postComment: a close failure is logged, never thrown. The
  // worst case is an issue left open whose ledger row already blocks re-runs.
  private async closeAsFailed(item: QueueItem): Promise<void> {
    const { repo, number } = item.trigger;
    try {
      await this.client.closeIssue(repo, number, "not_planned");
      log.info("closeAsFailed", `closed ${repo}#${number} as not planned`);
    } catch (error) {
      log.error("closeAsFailed", `could not close ${repo}#${number}`, error);
    }
  }

  // The comment for a failed run: a prompt-check rejection gets its own
  // "Prompt Check Failed" comment (the guard model's voiced reason as markdown);
  // any other failure gets the generic harness report.
  private failureBody(item: QueueItem, run: JobRun): string {
    const rejection = this.promptCheckRejection(item.job, run);
    if (rejection !== null) return promptCheckComment(false, rejection);
    return failureComment(
      item.runId,
      failureNote(run),
      attemptedSummary(run, failureOutputKeys(item.job)),
      this.failureEpilogue(item, run),
      failureStateLine(run),
    );
  }

  // The guard model's voiced reason when THIS run failed at the security gate, or
  // null for any other failure. Keys off the failed step's kind (security.scan),
  // so it tracks the job definition rather than a hard-coded step id; the security
  // step throws its reason as the error, so the recorded note carries it verbatim.
  private promptCheckRejection(job: Job, run: JobRun): string | null {
    const failed = run.stepRuns.find((s) => s.status === "failed");
    if (failed === undefined || !failed.note) return null;
    const kind = job.steps.find((s) => s.id === failed.stepId)?.kind;
    return kind === "security.scan" ? failed.note : null;
  }

  // Best-effort: post a comment back on the issue/PR so a human sees the outcome
  // without reading the server log. A comment failure is logged, never thrown — it
  // must not crash the queue or mask the job failure it is reporting.
  private async postComment(item: QueueItem, body: string): Promise<void> {
    const { repo, number } = item.trigger;
    try {
      const id = await this.client.commentOnIssue(repo, number, body);
      log.info("postComment", `commented on ${repo}#${number} (comment ${id})`);
    } catch (error) {
      log.error("postComment", `could not comment on ${repo}#${number}`, error);
    }
  }
}
