import { test } from "node:test";
import assert from "node:assert/strict";
import { config, requireOpenRouterKey } from "./config.js";

const KEY = config.openRouter.apiKeyEnv;

test("requireOpenRouterKey throws when the key is unset", () => {
  const previous = process.env[KEY];
  delete process.env[KEY];
  assert.throws(() => requireOpenRouterKey(), /missing env/);
  if (previous !== undefined) process.env[KEY] = previous;
});

test("requireOpenRouterKey returns the key when set", () => {
  const previous = process.env[KEY];
  process.env[KEY] = "sk-test-value";
  assert.equal(requireOpenRouterKey(), "sk-test-value");
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
});
