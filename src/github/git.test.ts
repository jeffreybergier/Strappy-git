import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitAll, hasChanges, uuidStem } from "./git.js";

const exec = promisify(execFile);

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

test("hasChanges tracks the working tree: clean -> untracked file -> committed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strappy-git-test-"));
  try {
    await exec("git", ["-C", dir, "init"]);
    assert.equal(await hasChanges(dir), false, "a fresh repo is clean");
    await fs.writeFile(path.join(dir, "new.txt"), "hello");
    assert.equal(await hasChanges(dir), true, "an untracked file is a change");
    await commitAll(dir, "add new.txt", { name: "test", email: "test@example.com" });
    assert.equal(await hasChanges(dir), false, "committing returns the tree to clean");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("hasChanges rejects a blank workdir", async () => {
  await assert.rejects(() => hasChanges(""), /workdir is required/);
});
