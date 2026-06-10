import type { StepIO } from "./types.js";
import { issueTriggerInputs } from "./processIssueJob.js";
import { pullRequestTriggerInputs } from "./processPullRequestJob.js";
import { pullRequestCommentTriggerInputs } from "./processPullRequestCommentJob.js";

// Maps a Job.trigger to the typed values the poller seeds onto the bus, so the
// dashboard can render the trigger as the process map's first producer. This is
// the single code-level source for trigger contracts, shared with the steps'
// own validation. An unknown trigger has no declared contract (returns []), so
// the dashboard still renders the job rather than crashing.
const TRIGGER_INPUTS: Record<string, () => StepIO[]> = {
  "github.issue.opened": issueTriggerInputs,
  "github.pull_request.opened": pullRequestTriggerInputs,
  "github.pull_request.commented": pullRequestCommentTriggerInputs,
};

export function triggerInputs(trigger: string): StepIO[] {
  if (typeof trigger !== "string") throw new Error("[triggers.triggerInputs] trigger must be a string");
  const build = TRIGGER_INPUTS[trigger];
  return build ? build() : [];
}
