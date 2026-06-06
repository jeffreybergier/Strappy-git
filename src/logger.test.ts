import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.js";

test("createLogger throws on an empty scope", () => {
  assert.throws(() => createLogger(""), /scope must be a non-empty string/);
  assert.throws(() => createLogger("   "), /scope must be a non-empty string/);
});

test("createLogger returns info/warn/error functions", () => {
  const log = createLogger("Test");
  assert.equal(typeof log.info, "function");
  assert.equal(typeof log.warn, "function");
  assert.equal(typeof log.error, "function");
});
