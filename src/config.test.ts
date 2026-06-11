import { test } from "node:test";
import assert from "node:assert/strict";
import { config, gitHubToken, requireGitHubToken, requireOpenRouterKey } from "./config.js";

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

// The push credential must never be readable from the environment after module
// load: it is captured once at startup and deleted from process.env, so the
// LLM's bash tool (which inherits the server env) can never see it.
test("the GitHub token is scrubbed from process.env at startup", () => {
  assert.equal(process.env[config.github.tokenEnv], undefined);
});

test("gitHubToken ignores env values set after startup", () => {
  process.env[config.github.tokenEnv] = "set-after-startup";
  try {
    assert.notEqual(gitHubToken(), "set-after-startup");
    if (gitHubToken() === undefined) {
      assert.throws(() => requireGitHubToken(), /missing env GITHUB_TOKEN/);
    } else {
      assert.equal(requireGitHubToken(), gitHubToken());
    }
  } finally {
    delete process.env[config.github.tokenEnv];
  }
});
