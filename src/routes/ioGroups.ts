import type { ProcessStep, StepIO } from "../jobs/types.js";

// One labelled bucket of a step's outputs for the process-map view. `key` is a
// stable, single-token css suffix (io-cat-<key>); `label` is the free human text.
export interface OutputGroup {
  key: string;
  label: string;
  items: StepIO[];
}

// Buckets a step's outputs for the dashboard, one group per source so the view
// reflects the real contract: model/executor-authored "Produced" (step) and
// harness-filled "Derived" are split (matching the runs view), then carried
// passthroughs, terminal receipts, and any marked to be relayed into the failure
// comment. A feedsFailure output lands in "Relayed on failure" regardless of its
// source, so it appears once rather than twice — it is not a per-step failure
// path (every step routes to the handler), but the value this step contributes to
// that comment. Empty groups are dropped.
export function groupOutputs(outputs: StepIO[]): OutputGroup[] {
  if (!Array.isArray(outputs)) throw new Error("[ioGroups.groupOutputs] outputs must be an array");
  const groups: OutputGroup[] = [
    { key: "step", label: "Produced", items: outputs.filter((io) => !io.feedsFailure && io.source === "step") },
    { key: "derived", label: "Derived", items: outputs.filter((io) => !io.feedsFailure && io.source === "derived") },
    { key: "pass", label: "Passthrough", items: outputs.filter((io) => !io.feedsFailure && io.source === "pass") },
    { key: "receipt", label: "Receipt", items: outputs.filter((io) => !io.feedsFailure && io.source === "receipt") },
    { key: "relayed", label: "Relayed on failure", items: outputs.filter((io) => io.feedsFailure === true) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// Per step (in order), the feedsFailure keys the error step receives if THAT step
// fails — i.e. the marked values produced by EARLIER steps. A step's own outputs
// are excluded: a failed step never produced them, so its failure relays only
// what predecessors already recorded (matching attemptedSummary, which scans the
// recorded run). The set only grows down the chain; the producer relays nothing
// for its own failure. Deduped, so a key marked on both a producer and a carried
// passthrough still appears once.
export function relayedOnFailure(steps: ProcessStep[]): string[][] {
  if (!Array.isArray(steps)) throw new Error("[ioGroups.relayedOnFailure] steps must be an array");
  const perStep: string[][] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    perStep.push([...seen]);
    for (const output of step.outputs) if (output.feedsFailure) seen.add(output.key);
  }
  return perStep;
}
