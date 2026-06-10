import type { Job, ProcessStep, StepIO } from "./types.js";
import type { IoSource, IoType } from "./io.js";
import { loadPrompt } from "./prompts.js";
import { failureHandler } from "./failureHandler.js";
import { validateJobGraph } from "./validateJobGraph.js";
import { REVIEW_GUIDANCE } from "./processIssueJob.js";

function io(key: string, type: IoType, source: IoSource, description: string, guidance?: string, feedsFailure?: boolean): StepIO {
  return { key, type, source, description, ...(guidance !== undefined && { guidance }), ...(feedsFailure && { feedsFailure: true }) };
}

// The values the poller seeds onto the run for a github.pull_request.opened
// trigger (see poller.pullRequestSource). Only a whitelisted user's PR whose
// head branch lives in THIS repo (never a fork) gets here — both gates sit at
// the poller. prAuthor is seeded for traceability, though no step reads it.
export function pullRequestTriggerInputs(): StepIO[] {
  return [
    io("repo", "string", "trigger", "owner/name"),
    io("prNumber", "number", "trigger", "Pull request number"),
    io("prAuthor", "string", "trigger", "GitHub login that opened the pull request"),
    io("prBranch", "string", "trigger", "Head branch of the pull request (a branch in this repo, never a fork)"),
    io("baseBranch", "string", "trigger", "Base branch the pull request targets"),
    io("jobUuid", "string", "trigger", "Per-job UUID"),
  ];
}

function step(
  id: string, kind: string, name: string, description: string,
  inputs: StepIO[], outputs: StepIO[], systemPrompt?: string,
): ProcessStep {
  return { id, kind, name, description, ...(systemPrompt !== undefined && { systemPrompt }), inputs, outputs };
}

// The PR twin of process-issue's tail: when a whitelisted user opens a PR from a
// same-repo branch, fetch the PR's title/description/thread (the review user
// message), clone the repo, check the PR head branch out against its real base
// branch (the shallow clone is single-branch, so both refs are fetched
// explicitly), run the SAME llm.review kind over it — it inspects the diff
// (git diff origin/HEAD..HEAD), runs the tests/program,
// and authors a review — then post that review (with a spend footer) on the PR
// via the same github.commentPr kind the issue job ends with. Nothing is edited,
// committed, or pushed. Each step reads only ambient trigger constants, its own
// static prompt, or the immediately preceding step's outputs; userPrompt and
// workingDirectory are carried forward as explicit "pass" values exactly as in
// process-issue.
export function processPullRequestJob(): Job {
  const job: Job = {
    id: "process-pull-request",
    name: "Process New Pull Request",
    description: "Review a whitelisted user's same-repo pull request with the LLM and post the verdict as a PR comment.",
    trigger: "github.pull_request.opened",
    steps: [
      step("fetch-pr", "github.fetchPullRequest", "Fetch Pull Request",
        "Read the PR title, description, and comment thread and render the review user message.",
        [io("repo", "string", "trigger", "owner/name"), io("prNumber", "number", "trigger", "Pull request number")],
        [io("userPrompt", "string", "step", "PR rendered as the review user message")]),
      step("clone-repo", "git.cloneRepo", "Clone Repo",
        "Clone into <tempDir>/jobs/<uuid>/<reponame> so the reviewer can explore and run it.",
        [io("repo", "string", "trigger", "owner/name"), io("jobUuid", "string", "trigger", "Per-job UUID"),
          io("userPrompt", "string", "pass", "Carried to the review step")],
        [io("workingDirectory", "string", "step", "Local clone path"),
          io("userPrompt", "string", "pass", "Carried to the review step")]),
      step("checkout-branch", "git.checkoutBranch", "Checkout PR Branch",
        "Fetch the PR base/head branches into the shallow clone and check the head out, so the diff under review is origin/HEAD..HEAD.",
        [io("workingDirectory", "string", "pass", "Local clone path; used here and carried to the review step"),
          io("prBranch", "string", "trigger", "Head branch to check out"),
          io("baseBranch", "string", "trigger", "Base branch the PR targets"),
          io("userPrompt", "string", "pass", "Carried to the review step")],
        [io("checkedOut", "boolean", "receipt", "Terminal: the PR head branch is checked out"),
          io("workingDirectory", "string", "pass", "Carried to the review step"),
          io("userPrompt", "string", "pass", "Carried to the review step")]),
      step("review", "llm.review", "Code Review",
        "Review the PR branch against the base: inspect the diff, run the tests/program, and author a PR review comment.",
        [io("systemPrompt", "string", "static", "Static instructions (loaded from prompts/review-pull-request.md)"),
          io("userPrompt", "string", "step", "The PR title/description/thread (the review user message)"),
          io("workingDirectory", "string", "step", "Local clone (PR branch checked out) the reviewer inspects and runs in")],
        [io("reviewComment", "string", "step", "Markdown code-review comment to post on the PR", REVIEW_GUIDANCE,
            true), // feedsFailure: relayed into the failure comment if posting it fails
          io("cost", "number", "derived", "Review LLM spend, reported by Pi (comment footer)"),
          io("model", "string", "derived", "Review model id Pi ran (comment footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (comment footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (comment footer)")],
        loadPrompt("review-pull-request")),
      step("comment-pr", "github.commentPr", "Comment Review on PR",
        "Post the review model's comment (with a spend footer) on the pull request.",
        [io("repo", "string", "trigger", "owner/name"),
          io("prNumber", "number", "trigger", "PR to comment on"),
          io("reviewComment", "string", "step", "Review comment body from the review step"),
          io("cost", "number", "step", "Review LLM spend, rendered into the comment footer"),
          io("model", "string", "step", "Review model id, rendered into the comment footer"),
          io("inputTokens", "integer", "step", "Prompt tokens, rendered into the comment footer"),
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the comment footer")],
        [io("commentId", "number", "receipt", "Terminal: the review comment was created")]),
    ],
    // Same generic handler as process-issue, addressed by the PR number.
    failureHandler: failureHandler("prNumber"),
  };
  // Strict init: refuse to hand back a job whose step contract doesn't hold.
  validateJobGraph(job, pullRequestTriggerInputs());
  return job;
}
