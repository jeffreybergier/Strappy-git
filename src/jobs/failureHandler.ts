import type { IoSource, IoType } from "./io.js";
import type { FailureHandler, StepIO } from "./types.js";

function io(key: string, type: IoType, source: IoSource, description: string): StepIO {
  return { key, type, source, description };
}

// The one generic failure handler shared by every job: on ANY step failure the
// scheduler stops the run and the poller posts this comment back on the issue
// (see poller.failureComment / failureBody). The handling is identical for every
// step, so the contract lives here once. `inputs` document what the comment is
// built from: the trigger constants that address it, plus the run-level "failure"
// facts read off the failed run. "guaranteed" facts are present on every failure;
// attemptedSummary is best-effort — only populated once an earlier step recorded
// the model's PR summary (a failure before the model speaks omits it).
// numberKey names the trigger constant carrying the comment target's number
// ("issueNumber" for the issue job, "prNumber" for the PR job — a PR is an
// issue to GitHub's comment API, so the posting path is identical).
export function failureHandler(numberKey: string = "issueNumber"): FailureHandler {
  if (typeof numberKey !== "string" || numberKey.trim() === "") {
    throw new Error("[failureHandler] numberKey must be a non-empty string");
  }
  return {
    id: "post-failure-comment",
    name: "Post Failure Comment",
    description: "On any step failure, comment the outcome back on the issue or PR so a human sees it.",
    inputs: [
      io("repo", "string", "trigger", "owner/name — addresses the comment"),
      io(numberKey, "number", "trigger", "Issue or pull request the comment is posted on"),
      io("failedStep", "string", "failure", "Id of the step that failed"),
      io("errorNote", "string", "failure", "The failed step's recorded error message (fenced in the comment)"),
      io("runId", "string", "failure", "The run id, shown in the comment"),
      io("attemptedSummary", "string", "failure", "Best-effort: the model's PR summary, if it spoke before failing"),
    ],
  };
}
