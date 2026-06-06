import type { Job, JobRun } from "./types.js";
import { processIssueJob } from "./processIssueJob.js";

export function seedJobs(): Job[] {
  return [
    {
      id: "triage-issue",
      name: "Triage New Issue",
      description: "Classify and label new GitHub issues, then post a summary.",
      trigger: "github.issue.opened",
      steps: [
        {
          id: "fetch-issue",
          kind: "github.fetchIssue",
          name: "Fetch Issue",
          description: "Pull the issue payload from the GitHub API.",
          inputs: [
            { key: "repo", type: "string", description: "owner/name" },
            { key: "issueNumber", type: "number", description: "Issue id" },
          ],
          outputs: [{ key: "issue", type: "Issue", description: "Title, body, author" }],
        },
        {
          id: "classify",
          kind: "llm",
          name: "Classify (LLM)",
          description: "Ask an open-source model via OpenRouter to label and summarize.",
          inputs: [{ key: "issue", type: "Issue", description: "From fetch-issue" }],
          outputs: [
            { key: "labels", type: "string[]", description: "Suggested labels" },
            { key: "summary", type: "string", description: "One-paragraph summary" },
          ],
        },
        {
          id: "apply-labels",
          kind: "github.applyLabels",
          name: "Apply Labels",
          description: "Write the suggested labels back to the issue.",
          inputs: [{ key: "labels", type: "string[]", description: "From classify" }],
          outputs: [{ key: "applied", type: "boolean", description: "Whether labels were set" }],
        },
        {
          id: "post-summary",
          kind: "github.postComment",
          name: "Post Summary",
          description: "Comment the summary on the issue.",
          inputs: [{ key: "summary", type: "string", description: "From classify" }],
          outputs: [{ key: "commentId", type: "number", description: "Created comment id" }],
        },
      ],
    },
    {
      id: "review-pr",
      name: "Review Pull Request",
      description: "Analyze a new PR diff and post review notes.",
      trigger: "github.pull_request.opened",
      steps: [
        {
          id: "fetch-diff",
          kind: "github.fetchDiff",
          name: "Fetch Diff",
          description: "Retrieve the unified diff for the pull request.",
          inputs: [
            { key: "repo", type: "string", description: "owner/name" },
            { key: "prNumber", type: "number", description: "PR id" },
          ],
          outputs: [{ key: "diff", type: "string", description: "Unified diff" }],
        },
        {
          id: "analyze",
          kind: "llm",
          name: "Analyze (LLM)",
          description: "Ask the model to find issues and suggestions in the diff.",
          inputs: [{ key: "diff", type: "string", description: "From fetch-diff" }],
          outputs: [{ key: "findings", type: "Finding[]", description: "Review findings" }],
        },
        {
          id: "post-review",
          kind: "github.postReview",
          name: "Post Review",
          description: "Publish the findings as a PR review.",
          inputs: [{ key: "findings", type: "Finding[]", description: "From analyze" }],
          outputs: [{ key: "reviewId", type: "number", description: "Created review id" }],
        },
      ],
    },
    processIssueJob(),
  ];
}

export function seedRuns(): JobRun[] {
  return [
    {
      id: "run-1001",
      jobId: "triage-issue",
      status: "succeeded",
      startedAt: "2026-06-06T09:12:03.000Z",
      finishedAt: "2026-06-06T09:12:19.000Z",
      stepRuns: [
        { stepId: "fetch-issue", status: "succeeded" },
        { stepId: "classify", status: "succeeded" },
        { stepId: "apply-labels", status: "succeeded" },
        { stepId: "post-summary", status: "succeeded" },
      ],
    },
    {
      id: "run-1002",
      jobId: "review-pr",
      status: "running",
      startedAt: "2026-06-06T10:01:44.000Z",
      stepRuns: [
        { stepId: "fetch-diff", status: "succeeded" },
        { stepId: "analyze", status: "running" },
        { stepId: "post-review", status: "pending" },
      ],
    },
    {
      id: "run-1003",
      jobId: "triage-issue",
      status: "failed",
      startedAt: "2026-06-06T08:40:10.000Z",
      finishedAt: "2026-06-06T08:40:12.000Z",
      stepRuns: [
        { stepId: "fetch-issue", status: "succeeded" },
        { stepId: "classify", status: "failed", note: "OpenRouter rate limit" },
        { stepId: "apply-labels", status: "skipped" },
        { stepId: "post-summary", status: "skipped" },
      ],
    },
  ];
}
