import type { Job, ProcessStep, StepIO } from "./types.js";
import type { IoSource, IoType } from "./io.js";
import { loadPrompt } from "./prompts.js";
import { validateJobGraph } from "./validateJobGraph.js";

function io(key: string, type: IoType, source: IoSource, description: string, guidance?: string): StepIO {
  return { key, type, source, description, ...(guidance !== undefined && { guidance }) };
}

// The values the poller seeds onto the run for a github.issue.opened trigger
// (see IssuePoller.runItem). Declared as a typed, ambient contract (every step
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

function step(
  id: string, kind: string, name: string, description: string,
  inputs: StepIO[], outputs: StepIO[], systemPrompt?: string,
): ProcessStep {
  return { id, kind, name, description, ...(systemPrompt !== undefined && { systemPrompt }), inputs, outputs };
}

// Implementation flow: fetch the issue, clone the repo, branch, run the LLM
// implementation step (it edits the clone and returns a commit message + PR
// title + PR summary, and Pi's reported model/cost/tokens are derived alongside),
// then commit/push, open a PR from the model's title + summary (with an LLM-cost
// footer), comment the PR number back, and close the issue. Each step reads only ambient trigger
// constants, its own static prompt, or the immediately preceding step's outputs;
// a value needed by a later step is carried forward as a "pass" input+output so
// the data flow is explicit and strictly enforced (validateJobGraph + scheduler).
export function processIssueJob(): Job {
  const job: Job = {
    id: "process-issue",
    name: "Process New Issue",
    description: "Implement a whitelisted user's new issue with the LLM and open a PR with the changes.",
    trigger: "github.issue.opened",
    steps: [
      step("fetch-issue", "github.fetchIssue", "Fetch Issue",
        "Read the issue title and body and render the implementation user message.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number")],
        [io("userPrompt", "string", "step", "Issue rendered as the implementation user message")]),
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
          io("userPrompt", "string", "step", "Issue rendered as the user message"),
          io("workingDirectory", "string", "pass", "Local clone path the model explores and edits"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step"),
          io("newBranch", "string", "pass", "Carried to the commit/push + open-PR steps")],
        [io("commitMessage", "string", "step", "Git commit message for the changes the model made",
            "A conventional, imperative git commit message summarizing the change you made (e.g. \"Add retry logic to the HTTP client\"). This is human-facing — write it in your sassy, gay Strappy voice, not the straight tone you use inside the code."),
          io("pullRequestTitle", "string", "step", "Concise PR title describing the change the model made",
            "A short imperative title describing the change you made (e.g. \"Add retry logic to the HTTP client\"). Do not include the issue number — it is appended for you. Keep it under ~70 characters. This is human-facing, so let your sassy Strappy personality show."),
          io("pullRequestSummary", "string", "step", "Markdown summary of the changes, used as the PR body",
            "A markdown summary of what changed and why, used verbatim as the PR body. Do not invent details that are not in the issue. This is a human-facing reply to your friends (not an in-repo doc), so write it in your full sassy, gay Strappy voice — the markdown formatting does NOT make it straight."),
          io("cost", "number", "derived", "LLM spend for this step, reported by Pi"),
          io("model", "string", "derived", "Model id Pi ran this step against (PR footer)"),
          io("inputTokens", "integer", "derived", "Prompt tokens Pi reported (PR footer)"),
          io("outputTokens", "integer", "derived", "Completion tokens Pi reported (PR footer)"),
          io("workingDirectory", "string", "pass", "Local clone path"),
          io("baseBranch", "string", "pass", "Carried to the open-PR step"),
          io("newBranch", "string", "pass", "Carried to the commit/push + open-PR steps")],
        loadPrompt("implement-issue")),
      step("commit-push", "git.commitPush", "Commit & Push",
        "Commit the model's changes with its commit message and push the branch.",
        [io("workingDirectory", "string", "step", "Local clone path"),
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
          io("outputTokens", "integer", "step", "Completion tokens, rendered into the PR body footer")],
        [io("prNumber", "number", "step", "Created PR number"), io("prUrl", "string", "step", "PR URL")]),
      step("comment-issue", "github.commentIssue", "Comment PR Number",
        "Comment the PR number back on the issue.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number"),
          io("prNumber", "number", "step", "PR number")],
        [io("commentId", "number", "receipt", "Terminal: the PR-number comment was created")]),
      step("close-issue", "github.closeIssue", "Close Issue",
        "Close the issue now that the PR is open.",
        [io("repo", "string", "trigger", "owner/name"), io("issueNumber", "number", "trigger", "Issue number")],
        [io("closed", "boolean", "receipt", "Terminal: the issue was closed")]),
    ],
  };
  // Strict init: refuse to hand back a job whose step contract doesn't hold.
  validateJobGraph(job, issueTriggerInputs());
  return job;
}
