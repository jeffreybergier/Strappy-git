import type { Job, ProcessStep, StepIO, TriggerSpec } from "./types.js";
import type { IoSource, IoType } from "./io.js";
import { loadGuidanceKey, loadPrompt } from "./prompts.js";
import { failureHandler } from "./failureHandler.js";
import { validateJobGraph } from "./validateJobGraph.js";
import { validateWatchedTrigger } from "./trigger.js";

function io(key: string, type: IoType, source: IoSource, description: string, guidance?: string, feedsFailure?: boolean): StepIO {
  return { key, type, source, description, ...(guidance !== undefined && { guidance }), ...(feedsFailure && { feedsFailure: true }) };
}

// The values the poller seeds onto the run for a github.issue.opened trigger
// (see poller.issueSource). Declared as a typed, ambient contract (every step
// may read these without threading them) so validateJobGraph can prove the
// steps' "trigger" inputs resolve. issueAuthor is gated at the poller
// (isAllowedAuthor) and seeded here for traceability, though no step reads it.
export function issueTriggerInputs(): StepIO[] {
  return [
    io("repo", "string", "trigger", "owner/name"),
    io("issueNumber", "number", "trigger", "Issue number"),
    io("issueAuthor", "string", "trigger", "GitHub login that opened the issue"),
    io("jobUuid", "string", "trigger", "Per-job UUID"),
  ];
}

// The full trigger contract: this job is one-shot — it fires once when a
// whitelisted user opens an issue, and comments never re-trigger it. A failed
// run closes the issue as not planned (unless code was already pushed), so the
// issue leaves the open feed for good either way.
export function issueTrigger(): TriggerSpec {
  const spec: TriggerSpec = {
    id: "github.issue.opened",
    subject: "issue",
    activation: "creation",
    conditions: [
      { kind: "once-per-trigger" },
      { kind: "author-whitelisted", of: "item" },
    ],
    onFailure: "close-not-planned",
    inputs: issueTriggerInputs(),
  };
  validateWatchedTrigger(spec);
  return spec;
}

function step(
  id: string, kind: string, name: string, description: string,
  inputs: StepIO[], outputs: StepIO[], systemPrompt?: string,
): ProcessStep {
  return { id, kind, name, description, ...(systemPrompt !== undefined && { systemPrompt }), inputs, outputs };
}

// Model-facing guidance for the review step's one authored output, loaded from
// the "code-review" section of prompts/guidance.json. Exported so
// processPullRequestJob's review step (the same llm.review kind) shares it.
export const REVIEW_GUIDANCE = loadGuidanceKey("code-review", "reviewComment");

// Implementation flow: fetch the issue, screen it for prompt-injection /
// dangerous instructions (the security gate, which blocks the run before any
// clone/edit/push if it judges the issue unsafe), post the gate's verdict back
// on the issue so the human knows it cleared and work is starting, clone the
// repo, branch, run the
// LLM implementation step (it edits the clone and returns a commit message + PR
// title + PR summary, and Pi's reported model/cost/tokens are derived alongside),
// then commit/push, open a PR from the model's title + summary (with an LLM-cost
// footer), run a SECOND LLM (the review step, on its own model) over the pushed
// branch — it inspects the diff (git diff origin/HEAD..HEAD on the shallow clone),
// runs the tests/program, and authors a review comment posted on the PR — then
// comment the PR number back on the issue and close it. Each step reads only
// ambient trigger constants, its own static prompt, or the immediately preceding
// step's outputs; a value needed by a later step is carried forward as a "pass"
// input+output so the data flow is explicit and strictly enforced
// (validateJobGraph + scheduler). The original issue text (userPrompt) and the
// clone path (workingDirectory) are threaded all the way to the review step, and
// the PR number is threaded on to the comment steps.
export function processIssueJob(): Job {
  const job: Job = {
    id: "process-issue",
    name: "Process New Issue",
    description: "Implement a whitelisted user's new issue with the LLM, open a PR, and have a second LLM review it.",
    trigger: issueTrigger(),
    steps: [
      step("fetch-issue", "github.fetchIssue", "Fetch Issue",
        "Read the issue title and body and render the implementation user message.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number")],
        [io("userPrompt", "string", "step", "Issue rendered as the implementation user message")]),
      step("security-scan", "security.scan", "Security Scan",
        "Screen the issue text for prompt-injection / dangerous instructions before any work runs; block the job if unsafe.",
        [io("systemPrompt", "string", "static", "Static instructions (loaded from prompts/security-check.md)"),
          io("userPrompt", "string", "pass", "Issue text to screen, carried on to the clone step")],
        [io("safe", "boolean", "receipt", "Terminal: the issue passed the security screen"),
          io("securityReason", "string", "step", "The guard model's voiced verdict, posted on the issue by the next step"),
          io("cost", "number", "derived", "Guard LLM spend, reported by Pi (comment footer)"),
          io("model", "string", "derived", "Guard model id Pi ran (comment footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (comment footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (comment footer)"),
          io("userPrompt", "string", "pass", "Carried to the comment + clone steps")],
        loadPrompt("security-check")),
      step("comment-security", "github.commentSecurity", "Comment Security Verdict",
        "Post the security gate's verdict on the issue (it passed, with a spend footer) and that implementation is now underway.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number"),
          io("securityReason", "string", "step", "The guard model's voiced verdict from the security step"),
          io("cost", "number", "step", "Guard LLM spend, rendered into the comment footer"),
          io("model", "string", "step", "Guard model id, rendered into the comment footer"),
          io("inputTokens", "integer", "step", "Prompt tokens, rendered into the comment footer"),
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the comment footer"),
          io("userPrompt", "string", "pass", "Carried to the clone step")],
        [io("commentId", "number", "receipt", "Terminal: the security-verdict comment was created"),
          io("userPrompt", "string", "pass", "Carried to the clone step")]),
      step("clone-repo", "git.cloneRepo", "Clone Repo",
        "Clone into <tempDir>/jobs/<uuid>/<reponame> so the model can explore it.",
        [io("repo", "string", "trigger", "owner/name"), io("jobUuid", "string", "trigger", "Per-job UUID"),
          io("userPrompt", "string", "pass", "Carried to the implement step")],
        [io("workingDirectory", "string", "step", "Local clone path"), io("baseBranch", "string", "step", "Default branch"),
          io("userPrompt", "string", "pass", "Carried to the implement step")]),
      step("create-branch", "git.createBranch", "Create Branch",
        "Create branch strappy/issue-<n>/<uuid stem> before the model edits.",
        [io("workingDirectory", "string", "pass", "Local clone path"), io("issueNumber", "number", "trigger", "Issue number"),
          io("jobUuid", "string", "trigger", "Per-job UUID (its stem suffixes the branch)"),
          io("userPrompt", "string", "pass", "Carried to the implement step"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step")],
        [io("newBranch", "string", "step", "New branch name"),
          io("workingDirectory", "string", "pass", "Local clone path"),
          io("userPrompt", "string", "pass", "Carried to the implement step"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step")]),
      step("implement-issue", "llm", "Implement Issue",
        "Explore the cloned repo, make the changes, and report a commit message + PR summary.",
        [io("systemPrompt", "string", "static", "Static instructions (loaded from prompts/implement-issue.md)"),
          io("userPrompt", "string", "pass", "Issue rendered as the user message; also carried on to the review step"),
          io("workingDirectory", "string", "pass", "Local clone path the model explores and edits"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step"),
          io("newBranch", "string", "pass", "Carried to the commit/push + open-PR steps")],
        [io("commitMessage", "string", "step", "Git commit message for the changes the model made",
            loadGuidanceKey("implement-issue", "commitMessage")),
          io("pullRequestTitle", "string", "step", "Concise PR title describing the change the model made",
            loadGuidanceKey("implement-issue", "pullRequestTitle")),
          io("pullRequestSummary", "string", "step", "Markdown summary of the changes, used as the PR body",
            loadGuidanceKey("implement-issue", "pullRequestSummary"),
            true), // feedsFailure: relayed into the failure comment as "attemptedSummary" if a later step fails
          io("cost", "number", "derived", "LLM spend for this step, reported by Pi"),
          io("model", "string", "derived", "Model id Pi ran this step against (PR footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (PR footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (PR footer)"),
          io("userPrompt", "string", "pass", "Carried to the commit/push → open-PR → review steps"),
          io("workingDirectory", "string", "pass", "Local clone path, carried to the review step"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step"),
          io("newBranch", "string", "pass", "Carried to the commit/push + open-PR steps")],
        loadPrompt("implement-issue")),
      step("commit-push", "git.commitPush", "Commit & Push",
        "Commit the model's changes with its commit message and push the branch.",
        [io("workingDirectory", "string", "pass", "Local clone path; used here and carried to the review step"),
          io("userPrompt", "string", "pass", "Carried to the review step"),
          io("newBranch", "string", "pass", "Branch to push, carried to the open-PR step"),
          io("commitMessage", "string", "step", "Commit message from the implement step"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step"),
          io("pullRequestTitle", "string", "pass", "Carried to the open-PR step"),
          io("pullRequestSummary", "string", "pass", "Carried to the open-PR step"),
          io("cost", "number", "pass", "Carried to the open-PR step (PR footer)"),
          io("model", "string", "pass", "Carried to the open-PR step (PR footer)"),
          io("inputTokens", "integer", "pass", "Carried to the open-PR step (PR footer)"),
          io("outputTokens", "integer", "pass", "Carried to the open-PR step (PR footer)")],
        [io("pushed", "boolean", "receipt", "Terminal: the branch was pushed"),
          io("workingDirectory", "string", "pass", "Carried to the review step"),
          io("userPrompt", "string", "pass", "Carried to the review step"),
          io("newBranch", "string", "pass", "Carried to the open-PR step"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step"),
          io("pullRequestTitle", "string", "pass", "Carried to the open-PR step"),
          io("pullRequestSummary", "string", "pass", "Carried to the open-PR step"),
          io("cost", "number", "pass", "Carried to the open-PR step (PR footer)"),
          io("model", "string", "pass", "Carried to the open-PR step (PR footer)"),
          io("inputTokens", "integer", "pass", "Carried to the open-PR step (PR footer)"),
          io("outputTokens", "integer", "pass", "Carried to the open-PR step (PR footer)")]),
      step("open-pr", "github.openPullRequest", "Open Pull Request",
        "Open a PR from the branch into the default branch: the model's title (prefixed + issue-linked) and its summary plus an LLM-cost footer as the body.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number"),
          io("newBranch", "string", "step", "Head branch"), io("baseBranch", "string", "step", "Base branch"),
          io("pullRequestTitle", "string", "step", "PR title from the implement step"),
          io("pullRequestSummary", "string", "step", "PR body from the implement step"),
          io("cost", "number", "step", "LLM spend, rendered into the PR body footer"),
          io("model", "string", "step", "Model id, rendered into the PR body footer"),
          io("inputTokens", "integer", "step", "Prompt tokens, rendered into the PR body footer"),
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the PR body footer"),
          io("userPrompt", "string", "pass", "Carried to the review step (the original request)"),
          io("workingDirectory", "string", "pass", "Carried to the review step (the clone to inspect)")],
        [io("prNumber", "number", "step", "Created PR number"), io("prUrl", "string", "receipt", "Terminal: created PR URL"),
          io("userPrompt", "string", "pass", "Carried to the review step"),
          io("workingDirectory", "string", "pass", "Carried to the review step")]),
      step("review", "llm.review", "Code Review",
        "Review the pushed PR branch against the base: inspect the diff, run the tests/program, and author a PR review comment.",
        [io("systemPrompt", "string", "static", "Static instructions (loaded from prompts/code-review.md)"),
          io("userPrompt", "string", "step", "The original request the implementation was based on (the review user message)"),
          io("workingDirectory", "string", "step", "Local clone (PR branch checked out) the reviewer inspects and runs in"),
          io("prNumber", "number", "pass", "Carried to the comment-PR step")],
        [io("reviewComment", "string", "step", "Markdown code-review comment to post on the PR", REVIEW_GUIDANCE),
          io("cost", "number", "derived", "Review LLM spend, reported by Pi (comment footer)"),
          io("model", "string", "derived", "Review model id Pi ran (comment footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (comment footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (comment footer)"),
          io("prNumber", "number", "pass", "Carried to the comment-PR step")],
        loadPrompt("code-review")),
      step("comment-pr", "github.commentPr", "Comment Review on PR",
        "Post the review model's comment (with a spend footer) on the pull request.",
        [io("repo", "string", "trigger", "owner/name"),
          io("prNumber", "number", "pass", "PR to comment on"),
          io("reviewComment", "string", "step", "Review comment body from the review step"),
          io("cost", "number", "step", "Review LLM spend, rendered into the comment footer"),
          io("model", "string", "step", "Review model id, rendered into the comment footer"),
          io("inputTokens", "integer", "step", "Prompt tokens, rendered into the comment footer"),
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the comment footer")],
        [io("commentId", "number", "receipt", "Terminal: the review comment was created")]),
      step("close-issue", "github.closeIssue", "Close Issue",
        "Close the issue now that the PR is open.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number")],
        [io("closed", "boolean", "receipt", "Terminal: the issue was closed")]),
    ],
    // Every step routes here on failure; the same generic handler for all of them.
    failureHandler: failureHandler(),
  };
  // Strict init: refuse to hand back a job whose step contract doesn't hold.
  validateJobGraph(job, job.trigger.inputs);
  return job;
}
