import { test } from "node:test";
import assert from "node:assert/strict";
import { asIoSource, asIoType, isIoSource, isIoType, matchesIoType } from "./io.js";

test("isIoType accepts the vocabulary and rejects everything else", () => {
  for (const t of ["string", "number", "integer", "boolean"]) assert.equal(isIoType(t), true);
  for (const t of ["sting", "", "object", 1, null, undefined]) assert.equal(isIoType(t), false);
});

test("asIoType returns valid types and throws on invalid ones", () => {
  assert.equal(asIoType("integer"), "integer");
  assert.throws(() => asIoType("sting"), /invalid io type "sting"/);
});

test("isIoSource accepts the vocabulary and rejects everything else", () => {
  for (const s of ["trigger", "static", "step", "pass", "derived", "receipt"]) assert.equal(isIoSource(s), true);
  for (const s of ["bus", "", "input", 1, null, undefined]) assert.equal(isIoSource(s), false);
});

test("asIoSource returns valid sources and throws on invalid ones", () => {
  assert.equal(asIoSource("pass"), "pass");
  assert.throws(() => asIoSource("bus"), /invalid io source "bus"/);
});

test("matchesIoType enforces each declared type", () => {
  assert.equal(matchesIoType("hi", "string"), true);
  assert.equal(matchesIoType(3, "string"), false);
  assert.equal(matchesIoType(3.5, "number"), true);
  assert.equal(matchesIoType(NaN, "number"), false);
  assert.equal(matchesIoType(Infinity, "number"), false);
  assert.equal(matchesIoType(3, "integer"), true);
  assert.equal(matchesIoType(3.5, "integer"), false);
  assert.equal(matchesIoType(true, "boolean"), true);
  assert.equal(matchesIoType("true", "boolean"), false);
});
