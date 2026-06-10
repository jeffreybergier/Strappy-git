import type { Job, ProcessStep, StepIO, TriggerSpec } from "./types.js";
import type { IoSource, IoType } from "./io.js";
import { loadGuidanceKey, loadPrompt } from "./prompts.js";
import { failureHandler } from "./failureHandler.js";
import { validateJobGraph } from "./validateJobGraph.js";
import { validateWatchedTrigger } from "./trigger.js";

function io(key: string, type: IoType, source: IoSource, description: string, guidance?: string, feedsFailure?: boolean): StepIO {
  return { key, type, source, description, ...(guidance !== undefined && { guidance }), ...(feedsFailure && { feedsFailure: true }) };
}

// The values the poller seeds onto the run for a github.pull_request.commented
// trigger (see pullRequestReplyTrigger below). The gate is the COMMENT author,
// not the PR author: any same-repo PR (including Strappy's own strappy/...
// branches) qualifies once a whitelisted user replies on it. prAuthor is seeded
// for traceability and may be anyone with write access.
export function pullRequestCommentTriggerInputs(): StepIO[] {
  return [
    io("repo", "string", "trigger", "owner/name"),
    io("prNumber", "number", "trigger", "Pull request number"),
    io("prAuthor", "string", "trigger", "GitHub login that opened the pull request (not whitelist-gated)"),
    io("prBranch", "string", "trigger", "Head branch of the pull request (a branch in this repo, never a fork)"),
    io("baseBranch", "string", "trigger", "Base branch the pull request targets"),
    io("jobUuid", "string", "trigger", "Per-job UUID"),
  ];
}

// The full trigger contract: comment-activated, so it owns every whitelisted
// reply after the PR opened — on anyone's same-repo PR, Strappy's own strappy/...
// branches included (fixing Strappy's own PR on request is its headline use).
// The ledger watermark makes each comment fire at most once, and a failed run
// leaves the thread open so a whitelisted reply retries.
export function pullRequestReplyTrigger(): TriggerSpec {
  const spec: TriggerSpec = {
    id: "github.pull_request.commented",
    subject: "pull_request",
    activation: "comment",
    conditions: [
      { kind: "once-per-trigger" },
      { kind: "author-whitelisted", of: "comment" },
      { kind: "head-branch-in-same-repo" },
    ],
    onFailure: "comment-and-retry",
    inputs: pullRequestCommentTriggerInputs(),
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

// The reply-driven combo of the other two processes: when a whitelisted user
// comments on a same-repo PR, fetch the PR thread (the newest comments are the
// feedback), screen it at the security gate BEFORE any repo work (the thread on
// a public repo can carry comments from anyone), post the verdict, clone, check
// the PR head branch out, run the implement LLM to address the feedback, then
// commit and push onto the SAME branch and post the model's own summary of what
// it changed back on the PR. Nothing opens or closes here — the PR already
// exists. Each step reads only ambient trigger constants, its own static
// prompt, or the immediately preceding step's outputs; carried values are
// explicit "pass" pairs exactly as in the other jobs.
export function processPullRequestCommentJob(): Job {
  const job: Job = {
    id: "process-pull-request-comment",
    name: "Process Pull Request Reply",
    description: "Implement a whitelisted user's PR feedback with the LLM: update the head branch, push, and reply with what changed.",
    trigger: pullRequestReplyTrigger(),
    steps: [
      step("fetch-pr", "github.fetchPullRequest", "Fetch Pull Request",
        "Read the PR title, description, and comment thread (the feedback) and render the implementation user message.",
        [io("repo", "string", "trigger", "owner/name"), io("prNumber", "number", "trigger", "Pull request number")],
        [io("userPrompt", "string", "step", "PR thread rendered as the implementation user message")]),
      step("security-scan", "security.scan", "Security Scan",
        "Screen the PR thread for prompt-injection / dangerous instructions before any work runs; block the job if unsafe.",
        [io("systemPrompt", "string", "static", "Static instructions (loaded from prompts/security-check.md)"),
          io("userPrompt", "string", "pass", "PR thread to screen, carried on to the clone step")],
        [io("safe", "boolean", "receipt", "Terminal: the thread passed the security screen"),
          io("securityReason", "string", "step", "The guard model's voiced verdict, posted on the PR by the next step"),
          io("cost", "number", "derived", "Guard LLM spend, reported by Pi (comment footer)"),
          io("model", "string", "derived", "Guard model id Pi ran (comment footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (comment footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (comment footer)"),
          io("userPrompt", "string", "pass", "Carried to the comment + clone steps")],
        loadPrompt("security-check")),
      step("comment-security", "github.commentSecurity", "Comment Security Verdict",
        "Post the security gate's verdict on the PR (it passed, with a spend footer) and that the update is now underway.",
        [io("repo", "string", "trigger", "owner/name"), io("prNumber", "number", "trigger", "Pull request number"),
          io("securityReason", "string", "step", "The guard model's voiced verdict from the security step"),
          io("cost", "number", "step", "Guard LLM spend, rendered into the comment footer"),
          io("model", "string", "step", "Guard model id, rendered into the comment footer"),
          io("inputTokens", "integer", "step", "Prompt tokens, rendered into the comment footer"),
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the comment footer"),
          io("userPrompt", "string", "pass", "Carried to the clone step")],
        [io("commentId", "number", "receipt", "Terminal: the security-verdict comment was created"),
          io("userPrompt", "string", "pass", "Carried to the clone step")]),
      step("clone-repo", "git.cloneRepo", "Clone Repo",
        "Clone into <tempDir>/jobs/<uuid>/<reponame> so the model can explore and edit it.",
        [io("repo", "string", "trigger", "owner/name"), io("jobUuid", "string", "trigger", "Per-job UUID"),
          io("userPrompt", "string", "pass", "Carried to the update step")],
        [io("workingDirectory", "string", "step", "Local clone path"),
          io("userPrompt", "string", "pass", "Carried to the update step")]),
      step("checkout-branch", "git.checkoutBranch", "Checkout PR Branch",
        "Fetch the PR base/head branches into the shallow clone and check the head out — the branch the model edits and the push targets.",
        [io("workingDirectory", "string", "pass", "Local clone path; used here and carried to the update step"),
          io("prBranch", "string", "trigger", "Head branch to check out"),
          io("baseBranch", "string", "trigger", "Base branch the PR targets"),
          io("userPrompt", "string", "pass", "Carried to the update step")],
        [io("newBranch", "string", "step", "The checked-out PR head branch, carried on to the commit/push step"),
          io("workingDirectory", "string", "pass", "Carried to the update step"),
          io("userPrompt", "string", "pass", "Carried to the update step")]),
      step("update-pr", "llm", "Update Branch",
        "Explore the cloned PR branch, make the changes the feedback asks for, and report a commit message + update summary.",
        [io("systemPrompt", "string", "static", "Static instructions (loaded from prompts/update-pull-request.md)"),
          io("userPrompt", "string", "step", "PR thread rendered as the user message (the feedback to address)"),
          io("workingDirectory", "string", "pass", "Local clone (PR branch checked out) the model explores and edits"),
          io("newBranch", "string", "pass", "Carried to the commit/push step")],
        [io("commitMessage", "string", "step", "Git commit message for the changes the model made",
            loadGuidanceKey("update-pull-request", "commitMessage")),
          io("updateSummary", "string", "step", "Markdown summary of the pushed changes, posted as the PR reply",
            loadGuidanceKey("update-pull-request", "updateSummary"),
            true), // feedsFailure: relayed into the failure comment as "attemptedSummary" if a later step fails
          io("cost", "number", "derived", "LLM spend for this step, reported by Pi (comment footer)"),
          io("model", "string", "derived", "Model id Pi ran this step against (comment footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (comment footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (comment footer)"),
          io("workingDirectory", "string", "pass", "Carried to the commit/push step"),
          io("newBranch", "string", "pass", "Carried to the commit/push step")],
        loadPrompt("update-pull-request")),
      step("commit-push", "git.commitPush", "Commit & Push",
        "Commit the model's changes with its commit message and push them onto the PR's existing head branch.",
        [io("workingDirectory", "string", "step", "Local clone path"),
          io("newBranch", "string", "step", "The PR head branch to push (fast-forward onto the open PR)"),
          io("commitMessage", "string", "step", "Commit message from the update step"),
          io("updateSummary", "string", "pass", "Carried to the comment step"),
          io("cost", "number", "pass", "Carried to the comment step (comment footer)"),
          io("model", "string", "pass", "Carried to the comment step (comment footer)"),
          io("inputTokens", "integer", "pass", "Carried to the comment step (comment footer)"),
          io("outputTokens", "integer", "pass", "Carried to the comment step (comment footer)")],
        [io("pushed", "boolean", "receipt", "Terminal: the branch was pushed"),
          io("updateSummary", "string", "pass", "Carried to the comment step"),
          io("cost", "number", "pass", "Carried to the comment step (comment footer)"),
          io("model", "string", "pass", "Carried to the comment step (comment footer)"),
          io("inputTokens", "integer", "pass", "Carried to the comment step (comment footer)"),
          io("outputTokens", "integer", "pass", "Carried to the comment step (comment footer)")]),
      step("comment-update", "github.commentUpdate", "Comment Update on PR",
        "Post the model's summary of the pushed update (with a spend footer) as a reply on the pull request.",
        [io("repo", "string", "trigger", "owner/name"),
          io("prNumber", "number", "trigger", "PR to reply on"),
          io("updateSummary", "string", "step", "Update summary from the update step"),
          io("cost", "number", "step", "LLM spend, rendered into the comment footer"),
          io("model", "string", "step", "Model id, rendered into the comment footer"),
          io("inputTokens", "integer", "step", "Prompt tokens, rendered into the comment footer"),
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the comment footer")],
        [io("commentId", "number", "receipt", "Terminal: the update-summary reply was created")]),
    ],
    // Same generic handler as the other jobs, addressed by the PR number.
    failureHandler: failureHandler("prNumber"),
  };
  // Strict init: refuse to hand back a job whose step contract doesn't hold.
  validateJobGraph(job, job.trigger.inputs);
  return job;
}
