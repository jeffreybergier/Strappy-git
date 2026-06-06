import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { runJob } from "../jobs/scheduler.js";
import { SequentialQueue } from "../jobs/queue.js";
import { StepKindRegistry } from "../jobs/stepKinds.js";
import type { JobWriteStore, TriggerLedger } from "../jobs/store.js";
import type { Job } from "../jobs/types.js";
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
    this.client = deps.client;
    this.store = deps.store;
    this.registry = deps.registry;
    this.job = deps.job;
    this.whitelist = deps.whitelist;
    this.intervalMs = deps.intervalMs;
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
      for (const issue of issues) this.maybeEnqueue(issue);
    } catch (error) {
      log.error("pollRepo", `failed for ${repo}`, error);
    }
  }

  // The dedupe decision: whitelisted author + no ledger row yet. Claiming the
  // row now stops the next tick from re-enqueuing while this one is pending.
  private maybeEnqueue(issue: IssueRef): void {
    if (!isAllowedAuthor(issue.author, this.whitelist)) {
      log.info("skip", `${issue.repo}#${issue.number}: author @${issue.author} not whitelisted`);
      return;
    }
    if (this.store.isProcessed(issue.repo, issue.number)) return;
    const jobUuid = randomUUID();
    const runId = `run-${jobUuid}`;
    this.store.markProcessing(issue.repo, issue.number, runId);
    this.queue.enqueue({ repo: issue.repo, issueNumber: issue.number, issueAuthor: issue.author, jobUuid, runId });
    log.info("enqueue", `${issue.repo}#${issue.number} queued (depth ${this.queue.size})`);
  }

  private async runItem(item: QueueItem): Promise<void> {
    log.info("run", `${item.repo}#${item.issueNumber} — starting (${item.runId})`);
    try {
      const run = await runJob(
        this.job,
        { repo: item.repo, issueNumber: item.issueNumber, issueAuthor: item.issueAuthor, jobUuid: item.jobUuid },
        { registry: this.registry, store: this.store, newRunId: () => item.runId },
      );
      this.store.setStatus(item.repo, item.issueNumber, run.status);
      log.info("run", `${item.repo}#${item.issueNumber} -> ${run.status} (${item.runId})`);
    } catch (error) {
      this.store.setStatus(item.repo, item.issueNumber, "failed");
      log.error("run", `${item.repo}#${item.issueNumber} crashed`, error);
    }
  }
}
