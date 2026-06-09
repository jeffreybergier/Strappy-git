import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { queuedRun, runJob } from "../jobs/scheduler.js";
import { SequentialQueue } from "../jobs/queue.js";
import { StepKindRegistry } from "../jobs/stepKinds.js";
import type { StepValues } from "../jobs/stepKinds.js";
import { promptCheckComment } from "../jobs/githubKinds.js";
import type { JobWriteStore, TriggerLedger } from "../jobs/store.js";
import type { Job, JobRun, StepRun } from "../jobs/types.js";
import { uuidStem } from "./git.js";
import type { GitHubClient, IssueRef } from "./client.js";

const log = createLogger("Poller");

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

// The issue comment posted when a generic job step fails (not the prompt check —
// that gets its own promptCheckComment). The harness frame is fixed, plain text —
// NOT the model's voice — so faking Strappy's sass here never puts words in a
// model's mouth. The underlying error is a verbatim ``` fence (it is a plain
// technical message, not markdown). When the model spoke before the failure, its
// own recorded PR summary is appended verbatim under an attributed header (its
// genuine words, never synthesized) so a human learns what it set out to do.
// States nothing was pushed and how to retry, so a human knows what happened.
export function failureComment(runId: string, detail: string, summary?: string | null): string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("[Poller.failureComment] runId must be a non-empty string");
  }
  if (typeof detail !== "string" || detail.trim() === "") {
    throw new Error("[Poller.failureComment] detail must be a non-empty string");
  }
  const lines = [
    "**⚠️ Job failed**",
    "",
    "---",
    "",
    `Nothing was pushed. Run \`${runId}\` failed with:`,
    "",
    "```",
    detail.trim(),
    "```",
  ];
  if (typeof summary === "string" && summary.trim() !== "") {
    lines.push("", "---", "", "**What the model was trying to do**", "", summary.trim());
  }
  lines.push("", "This is an automatic report from the harness. To retry, reply here — a comment from a whitelisted user re-runs the job on the whole thread.");
  return lines.join("\n");
}

// The model's PR summary, read off whichever recorded step carried it — the
// implement step produces it, later steps carry it as a pass value (so a failed
// commit-push still has it on the inputs it resolved before failing). Lets a
// failure AFTER the model spoke relay what it set out to do, reading the recorded
// run only (no LLM call). Returns null when no step carried one (a failure at or
// before the implement step).
export function attemptedSummary(run: JobRun): string | null {
  if (run === null || typeof run !== "object" || !Array.isArray(run.stepRuns)) {
    throw new Error("[Poller.attemptedSummary] run must be a JobRun");
  }
  for (const step of run.stepRuns) {
    const summary = pullRequestSummaryOf(step);
    if (summary !== null) return summary;
  }
  return null;
}

function pullRequestSummaryOf(step: StepRun): string | null {
  const value = step.outputs?.pullRequestSummary ?? step.inputs?.pullRequestSummary;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface QueueItem {
  repo: string;
  issueNumber: number;
  issueAuthor: string;
  jobUuid: string;
  runId: string;
}

export interface IssuePollerDeps {
  client: GitHubClient;
  store: JobWriteStore & TriggerLedger;
  registry: StepKindRegistry;
  job: Job;
  whitelist: readonly string[];
  intervalMs: number;
  // Teardown handed to the scheduler; removes the run's clone workspace.
  cleanup?: (triggerInputs: StepValues) => Promise<void> | void;
}

// Watches auto-discovered repos for new issues. The whole "should we act?"
// decision is the SQLite ledger: if there is no row for (repo, issue) and the
// author is whitelisted, the issue is claimed in the ledger and pushed onto a
// queue that runs jobs one at a time — so a boot that finds a 10-issue backlog
// processes them sequentially, not all at once.
export class IssuePoller {
  private readonly client: GitHubClient;
  private readonly store: JobWriteStore & TriggerLedger;
  private readonly registry: StepKindRegistry;
  private readonly job: Job;
  private readonly whitelist: readonly string[];
  private readonly intervalMs: number;
  private readonly cleanup?: (triggerInputs: StepValues) => Promise<void> | void;
  private readonly queue: SequentialQueue<QueueItem>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: IssuePollerDeps) {
    if (!deps || !deps.client) throw new Error("[IssuePoller] client is required");
    if (!deps.store) throw new Error("[IssuePoller] store is required");
    if (!(deps.registry instanceof StepKindRegistry)) throw new Error("[IssuePoller] registry is required");
    if (!deps.job) throw new Error("[IssuePoller] job is required");
    if (!Array.isArray(deps.whitelist)) throw new Error("[IssuePoller] whitelist must be an array");
    if (!Number.isInteger(deps.intervalMs) || deps.intervalMs <= 0) {
      throw new Error("[IssuePoller] intervalMs must be a positive integer");
    }
    if (deps.cleanup !== undefined && typeof deps.cleanup !== "function") {
      throw new Error("[IssuePoller] cleanup must be a function");
    }
    this.client = deps.client;
    this.store = deps.store;
    this.registry = deps.registry;
    this.job = deps.job;
    this.whitelist = deps.whitelist;
    this.intervalMs = deps.intervalMs;
    this.cleanup = deps.cleanup;
    this.queue = new SequentialQueue((item) => this.runItem(item));
  }

  start(): void {
    if (this.timer !== null) throw new Error("[IssuePoller.start] already started");
    log.info("start", `watching auto-discovered repos every ${this.intervalMs}ms; whitelist=[${this.whitelist.join(",")}]`);
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
    try {
      const issues = await this.client.listOpenIssues(repo);
      log.info("pollRepo", `${repo}: ${issues.length} open issue(s)`);
      for (const issue of issues) await this.maybeEnqueue(issue);
    } catch (error) {
      log.error("pollRepo", `failed for ${repo}`, error);
    }
  }

  // Enqueue at most one job per never-before-seen trigger. Claiming the row with
  // the triggering comment id makes every later tick a no-op until a strictly
  // newer whitelisted comment appears, so each trigger runs exactly once.
  private async maybeEnqueue(issue: IssueRef): Promise<void> {
    const commentId = await this.triggerCommentId(issue);
    if (commentId === null) return;
    const jobUuid = randomUUID();
    const runId = formatRunId(issue.repo, issue.number, this.job.id, jobUuid);
    this.store.markProcessing(issue.repo, issue.number, runId, commentId);
    this.store.recordRun(queuedRun(this.job, runId, new Date().toISOString())); // visible as queued until it starts
    this.queue.enqueue({ repo: issue.repo, issueNumber: issue.number, issueAuthor: issue.author, jobUuid, runId });
    log.info("enqueue", `${issue.repo}#${issue.number} queued (depth ${this.queue.size}, comment ${commentId})`);
  }

  // The comment id to claim for this run, or null when nothing new should run. A
  // brand-new issue (no ledger row) triggers on a whitelisted author and
  // baselines to its newest whitelisted comment, so replies already present at
  // creation ride along in the prompt instead of re-firing. An issue already seen
  // re-triggers only on a whitelisted comment strictly newer than the watermark.
  private async triggerCommentId(issue: IssueRef): Promise<number | null> {
    if (!this.store.isProcessed(issue.repo, issue.number)) {
      if (isAllowedAuthor(issue.author, this.whitelist)) return this.newestWhitelistedComment(issue);
      log.info("skip", `${issue.repo}#${issue.number}: author @${issue.author} not whitelisted`);
      return null;
    }
    const newest = await this.newestWhitelistedComment(issue);
    return newest > this.store.lastProcessedComment(issue.repo, issue.number) ? newest : null;
  }

  // The id of the newest comment authored by a whitelisted user, or 0 if none.
  // Strappy's own comments are not whitelisted, so they never raise this — the
  // poller can never re-trigger off its own PR-link or error replies.
  private async newestWhitelistedComment(issue: IssueRef): Promise<number> {
    const comments = await this.client.listComments(issue.repo, issue.number);
    let newest = 0;
    for (const c of comments) {
      if (c.id > newest && isAllowedAuthor(c.author, this.whitelist)) newest = c.id;
    }
    return newest;
  }

  private async runItem(item: QueueItem): Promise<void> {
    log.info("run", `${item.repo}#${item.issueNumber} — starting (${item.runId})`);
    try {
      const run = await runJob(
        this.job,
        { repo: item.repo, issueNumber: item.issueNumber, issueAuthor: item.issueAuthor, jobUuid: item.jobUuid },
        { registry: this.registry, store: this.store, newRunId: () => item.runId, ...(this.cleanup && { cleanup: this.cleanup }) },
      );
      this.store.setStatus(item.repo, item.issueNumber, run.status);
      log.info("run", `${item.repo}#${item.issueNumber} -> ${run.status} (${item.runId})`);
      if (run.status === "failed") await this.postComment(item, this.failureBody(item, run));
    } catch (error) {
      this.store.setStatus(item.repo, item.issueNumber, "failed");
      log.error("run", `${item.repo}#${item.issueNumber} crashed`, error);
      await this.postComment(item, failureComment(item.runId, message(error)));
    }
  }

  // The comment for a failed run: a prompt-check rejection gets its own
  // "Prompt Check Failed" comment (the guard model's voiced reason as markdown);
  // any other failure gets the generic harness report.
  private failureBody(item: QueueItem, run: JobRun): string {
    const rejection = this.promptCheckRejection(run);
    if (rejection !== null) return promptCheckComment(false, rejection);
    return failureComment(item.runId, failureNote(run), attemptedSummary(run));
  }

  // The guard model's voiced reason when THIS run failed at the security gate, or
  // null for any other failure. Keys off the failed step's kind (security.scan),
  // so it tracks the job definition rather than a hard-coded step id; the security
  // step throws its reason as the error, so the recorded note carries it verbatim.
  private promptCheckRejection(run: JobRun): string | null {
    const failed = run.stepRuns.find((s) => s.status === "failed");
    if (failed === undefined || !failed.note) return null;
    const kind = this.job.steps.find((s) => s.id === failed.stepId)?.kind;
    return kind === "security.scan" ? failed.note : null;
  }

  // Best-effort: post a comment back on the issue so a human sees the outcome
  // without reading the server log. A comment failure is logged, never thrown — it
  // must not crash the queue or mask the job failure it is reporting.
  private async postComment(item: QueueItem, body: string): Promise<void> {
    try {
      const id = await this.client.commentOnIssue(item.repo, item.issueNumber, body);
      log.info("postComment", `commented on ${item.repo}#${item.issueNumber} (comment ${id})`);
    } catch (error) {
      log.error("postComment", `could not comment on ${item.repo}#${item.issueNumber}`, error);
    }
  }
}
