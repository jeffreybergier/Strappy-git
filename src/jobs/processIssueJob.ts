import type { Job, ProcessStep, StepIO } from "./types.js";
import { loadPrompt } from "./prompts.js";

function io(key: string, type: string, description: string): StepIO {
  return { key, type, description };
}

function step(
  id: string, kind: string, name: string, description: string,
  inputs: StepIO[], outputs: StepIO[], systemPrompt?: string,
): ProcessStep {
  return { id, kind, name, description, ...(systemPrompt !== undefined && { systemPrompt }), inputs, outputs };
}

// Implementation flow: fetch the issue, clone the repo, branch, run the LLM
// implementation step (it edits the clone and returns a commit message + PR
// summary alongside the triage fields), then commit/push the changes, open a PR
// from the model's summary, comment the PR number back, and close the issue.
// Each step's outputs feed the next's inputs.
export function processIssueJob(): Job {
  return {
    id: "process-issue",
    name: "Process New Issue",
    description: "Implement a whitelisted user's new issue with the LLM and open a PR with the changes.",
    trigger: "github.issue.opened",
    steps: [
      step("fetch-issue", "github.fetchIssue", "Fetch Issue",
        "Read the issue title and body and render the implementation user message.",
        [io("repo", "string", "owner/name"), io("issueNumber", "number", "Issue number")],
        [io("issueTitle", "string", "Issue title"), io("issueBody", "string", "Issue body"),
          io("userPrompt", "string", "Issue rendered as the implementation user message")]),
      step("clone-repo", "git.cloneRepo", "Clone Repo",
        "Clone into <tempDir>/jobs/<uuid>/<reponame> so the model can explore it.",
        [io("repo", "string", "owner/name"), io("jobUuid", "string", "Per-job UUID")],
        [io("workingDirectory", "string", "Local clone path"), io("baseBranch", "string", "Default branch")]),
      step("create-branch", "git.createBranch", "Create Branch",
        "Create branch strappy/issue-<n> before the model edits.",
        [io("workingDirectory", "string", "Local clone path"), io("issueNumber", "number", "Issue number")],
        [io("branch", "string", "New branch name")]),
      step("implement-issue", "llm", "Implement Issue",
        "Explore the cloned repo, make the changes, and report a commit message + PR summary.",
        [io("systemPrompt", "string", "Static instructions (loaded from prompts/implement-issue.md)"),
          io("userPrompt", "string", "Issue rendered as the user message"),
          io("workingDirectory", "string", "Local clone path the model explores and edits")],
        [io("commitMessage", "string", "Git commit message for the changes the model made"),
          io("pullRequestSummary", "string", "Markdown summary of the changes, used as the PR body"),
          io("cost", "number", "LLM spend for this step, reported by Pi")],
        loadPrompt("implement-issue")),
      step("commit-push", "git.commitPush", "Commit & Push",
        "Commit the model's changes with its commit message and push the branch.",
        [io("workingDirectory", "string", "Local clone path"), io("branch", "string", "Branch to push"),
          io("commitMessage", "string", "Commit message from the implement step")],
        [io("pushed", "boolean", "Whether the branch was pushed")]),
      step("open-pr", "github.openPullRequest", "Open Pull Request",
        "Open a PR from the branch into the default branch using the model's summary as the body.",
        [io("repo", "string", "owner/name"), io("branch", "string", "Head branch"),
          io("baseBranch", "string", "Base branch"), io("issueNumber", "number", "Issue number"),
          io("pullRequestSummary", "string", "PR body from the implement step")],
        [io("prNumber", "number", "Created PR number"), io("prUrl", "string", "PR URL")]),
      step("comment-issue", "github.commentIssue", "Comment PR Number",
        "Comment the PR number back on the issue.",
        [io("repo", "string", "owner/name"), io("issueNumber", "number", "Issue number"),
          io("prNumber", "number", "PR number")],
        [io("commentId", "number", "Created comment id")]),
      step("close-issue", "github.closeIssue", "Close Issue",
        "Close the issue now that the PR is open.",
        [io("repo", "string", "owner/name"), io("issueNumber", "number", "Issue number")],
        [io("closed", "boolean", "Whether the issue was closed")]),
    ],
  };
}
