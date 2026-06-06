// The closed vocabulary for StepIO.type. Keeping it a union (not a free string)
// means a typo like "sting" is a compile error at the declaration site, and an
// out-of-vocabulary value read back from SQLite is rejected on hydration.
export const IO_TYPES = ["string", "number", "integer", "boolean"] as const;
export type IoType = (typeof IO_TYPES)[number];

export function isIoType(value: unknown): value is IoType {
  return typeof value === "string" && (IO_TYPES as readonly string[]).includes(value);
}

export function asIoType(value: unknown): IoType {
  if (!isIoType(value)) throw new Error(`[io.asIoType] invalid io type "${String(value)}"`);
  return value;
}

// Where a StepIO's value comes from. "trigger" is an ambient run constant the
// poller seeds (available to every step); "static" is loaded from disk into the
// step (e.g. a systemPrompt); "step" is produced by / consumed from the
// immediately preceding step; "pass" is a value carried through a step unchanged
// (declared as both an input and an output) so a later step can still read it.
// "derived" is an output-only fact the harness fills from the step's recorded
// execution (an LLM call's model id, spend, token split) — never asked of the
// model, but it feeds later steps like a "step" output. "receipt" is an
// output-only terminal: a produced side-effect acknowledgement (e.g. "pushed",
// "closed") deliberately consumed by no later step, so the graph verifier treats
// it as an intended endpoint rather than dangling waste.
export const IO_SOURCES = ["trigger", "static", "step", "pass", "derived", "receipt"] as const;
export type IoSource = (typeof IO_SOURCES)[number];

export function isIoSource(value: unknown): value is IoSource {
  return typeof value === "string" && (IO_SOURCES as readonly string[]).includes(value);
}

export function asIoSource(value: unknown): IoSource {
  if (!isIoSource(value)) throw new Error(`[io.asIoSource] invalid io source "${String(value)}"`);
  return value;
}

// Does a runtime value satisfy a declared StepIO.type? "number" rejects NaN and
// Infinity; "integer" is the stricter whole-number form.
export function matchesIoType(value: unknown, type: IoType): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
  }
}

// Short, safe label for a value in contract-violation errors (typeof, but with
// null and arrays called out so the message is actionable).
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
