import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidStem } from "./git.js";

test("uuidStem returns the first segment of a UUID", () => {
  assert.equal(uuidStem("8e6e2f89-4dab-425b-93ca-3f49310dfe8e"), "8e6e2f89");
});

test("uuidStem falls back to the whole value when there is no dash", () => {
  assert.equal(uuidStem("nodash"), "nodash");
});

test("uuidStem rejects a blank or non-string jobUuid", () => {
  assert.throws(() => uuidStem(""), /jobUuid must be a non-empty string/);
  assert.throws(() => uuidStem("   "), /jobUuid must be a non-empty string/);
  assert.throws(() => uuidStem(undefined as never), /jobUuid must be a non-empty string/);
});
