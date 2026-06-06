import type { Job, ProcessStep, StepIO } from "./types.js";

function io(key: string, type: string, description: string): StepIO {
  return { key, type, description };
}

function step(id: string, kind: string, name: string, description: string, inputs: StepIO[], outputs: StepIO[]): ProcessStep {
  return { id, kind, name, description, inputs, outputs };
}

// The no-AI end-to-end flow: fetch the issue, clone, branch, touch a placeholder
// file (the seam the LLM will fill later), push, open a PR, comment the PR
// number back, and close the issue. Each step's outputs feed the next's inputs.
export function processIssueJob(): Job {
  return {
    id: "process-issue",
    name: "Process New Issue",
    description: "Open a PR from a fresh branch in response to a whitelisted user's issue (no AI yet).",
    trigger: "github.issue.opened",
    steps: [
      step("fetch-issue", "github.fetchIssue", "Fetch Issue",
        "Read the issue title and body.",
        [io("repo", "string", "owner/name"), io("issueNumber", "number", "Issue number")],
        [io("issueTitle", "string", "Issue title"), io("issueBody", "string", "Issue body")]),
      step("clone-repo", "git.cloneRepo", "Clone Repo",
        "Clone into <tempDir>/jobs/<uuid>/<reponame>.",
        [io("repo", "string", "owner/name"), io("jobUuid", "string", "Per-job UUID")],
        [io("workdir", "string", "Local clone path"), io("baseBranch", "string", "Default branch")]),
      step("create-branch", "git.createBranch", "Create Branch",
        "Create branch strappy/issue-<n>.",
        [io("workdir", "string", "Local clone path"), io("issueNumber", "number", "Issue number")],
        [io("branch", "string", "New branch name")]),
      step("apply-change", "agent.applyChange", "Apply Change (placeholder)",
        "Touch an empty file; this is where the LLM will edit code later.",
        [io("workdir", "string", "Local clone path"), io("issueNumber", "number", "Issue number")],
        [io("changedPath", "string", "Path of the touched file")]),
      step("commit-push", "git.commitPush", "Commit & Push",
        "Commit the change and push the branch.",
        [io("workdir", "string", "Local clone path"), io("branch", "string", "Branch to push")],
        [io("pushed", "boolean", "Whether the branch was pushed")]),
      step("open-pr", "github.openPullRequest", "Open Pull Request",
        "Open a PR from the branch into the default branch.",
        [io("repo", "string", "owner/name"), io("branch", "string", "Head branch"),
          io("baseBranch", "string", "Base branch"), io("issueNumber", "number", "Issue number")],
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
