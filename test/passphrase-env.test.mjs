import assert from "node:assert/strict";
import test from "node:test";
import { runDevkit } from "../tools/devkit.mjs";
import { createTempKey } from "../tools/temp-key.mjs";

test("the passphrase environment variable of the parent never reaches the devkit", (t) => {
  const key = { ...createTempKey(), keyId: "memory-test-key" };
  t.after(() => key.cleanup());
  const previous = process.env.TEAMUQ_KEY_PASSPHRASE_FOR_TESTS;
  process.env.TEAMUQ_KEY_PASSPHRASE_FOR_TESTS = key.passphrase;
  t.after(() => {
    if (previous === undefined) delete process.env.TEAMUQ_KEY_PASSPHRASE_FOR_TESTS;
    else process.env.TEAMUQ_KEY_PASSPHRASE_FOR_TESTS = previous;
  });
  const leaked = runDevkit(["selftest-key", "--key", key.keyFile, "--key-id", key.keyId]);
  assert.notEqual(leaked.status, 0);
  assert.match(leaked.stderr, /interactive terminal/u);
  const injected = runDevkit(["selftest-key", "--key", key.keyFile, "--key-id", key.keyId], { passphraseForTests: key.passphrase });
  assert.equal(injected.status, 0);
});
