import { Type } from "typebox";
import type { TObject, TSchema } from "typebox";
import type { StepIO } from "../jobs/types.js";

// Turns a step's declared outputs into the parameter schema for its submit
// tool, so the process map stays the single source of truth: the model fills
// exactly the keys the step promised, and Pi validates them before we see them.
export function outputsToSchema(outputs: StepIO[]): TObject {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("[schema.outputsToSchema] outputs must be a non-empty array");
  }
  const properties: Record<string, TSchema> = {};
  for (const io of outputs) properties[io.key] = ioToSchema(io);
  return Type.Object(properties);
}

// StepIO.type is a free string today; map the ones we know and fall back to a
// string. The description is passed through so the model sees per-field intent.
function ioToSchema(io: StepIO): TSchema {
  const options = { description: io.description };
  switch (io.type) {
    case "number": return Type.Number(options);
    case "integer": return Type.Integer(options);
    case "boolean": return Type.Boolean(options);
    default: return Type.String(options);
  }
}
