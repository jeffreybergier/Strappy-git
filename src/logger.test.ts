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

test("warn leads with [WARNING] before the scope; info and error do not", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const info = t.mock.method(console, "info", () => {});
  const log = createLogger("Test");
  log.warn("method", "be careful");
  log.info("method", "all good");
  assert.equal(warn.mock.calls[0]?.arguments[0], "[WARNING] [Test.method] be careful");
  assert.equal(info.mock.calls[0]?.arguments[0], "[Test.method] all good");
});
