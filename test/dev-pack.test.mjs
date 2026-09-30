import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { devPack } from "../tools/dev-pack.mjs";
import { runDevkit } from "../tools/devkit.mjs";
import { createTempDevKey, createTempKey } from "../tools/temp-key.mjs";
import { REPO_ROOT } from "../tools/vendor-lock.mjs";

const packageVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
const bump = (version) => version.replace(/\d+$/u, (patch) => String(Number(patch) + 1));

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "teamuq-memory-dev-pack-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function devKey(t) {
  const key = createTempDevKey();
  t.after(() => key.cleanup());
  return key;
}

test("the dev:pack script is wired to tools/dev-pack.mjs", () => {
  assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts["dev:pack"], "node tools/dev-pack.mjs");
});

test("dev-pack signs teamuq.memory with a development key and counts the patch version up on the same output path", async (t) => {
  const key = devKey(t);
  const out = join(scratch(t), "teamuq.memory.tuqplugin");
  const first = await devPack({ keyFile: key.keyFile, outFile: out, passphraseForTests: key.passphrase });
  assert.equal(first.id, "teamuq.memory");
  assert.equal(first.version, bump(packageVersion));
  assert.equal(first.signer.kind, "dev");
  assert.equal(first.signer.keyId, key.keyId);
  assert.equal(first.file, out);
  const second = await devPack({ keyFile: key.keyFile, outFile: out, passphraseForTests: key.passphrase });
  assert.equal(second.version, bump(bump(packageVersion)));
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(second.integritySha256 === first.integritySha256, false);
});

test("the development build is refused by every check that does not opt in to the preplanted id", async (t) => {
  const key = devKey(t);
  const out = join(scratch(t), "teamuq.memory.tuqplugin");
  await devPack({ keyFile: key.keyFile, outFile: out, passphraseForTests: key.passphrase });
  const bare = runDevkit(["verify", out, "--anchors", "self", "--pub-file", key.pubFile]);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /id_reserved/u);
  const core = runDevkit(["verify", out, "--anchors", "core"]);
  assert.notEqual(core.status, 0);
  assert.match(core.stderr, /signer_unknown/u);
  const other = runDevkit(["verify", out, "--anchors", "self", "--pub-file", key.pubFile, "--preplanted-id", "teamuq.other"]);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /id_reserved/u);
  const open = runDevkit(["verify", out, "--anchors", "self", "--pub-file", key.pubFile, "--preplanted-id", "teamuq.memory"]);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(JSON.parse(open.stdout).signer.kind, "dev");
});

test("dev-pack refuses keys that are not development keys, are inside this repository or lack the public file", async (t) => {
  const release = createTempKey();
  t.after(() => release.cleanup());
  await assert.rejects(() => devPack({ keyFile: release.keyFile, outFile: join(scratch(t), "x.tuqplugin"), passphraseForTests: release.passphrase }), /not a development key/u);
  const key = devKey(t);
  const inside = join(REPO_ROOT, "dist", basename(key.keyFile));
  mkdirSync(join(REPO_ROOT, "dist"), { recursive: true });
  copyFileSync(key.keyFile, inside);
  t.after(() => rmSync(inside, { force: true }));
  await assert.rejects(() => devPack({ keyFile: inside, outFile: join(scratch(t), "y.tuqplugin"), passphraseForTests: key.passphrase }), /inside this repository/u);
  const lone = mkdtempSync(join(tmpdir(), "teamuq-memory-dev-pack-lone-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  const loneKey = join(lone, basename(key.keyFile));
  copyFileSync(key.keyFile, loneKey);
  await assert.rejects(() => devPack({ keyFile: loneKey, outFile: join(scratch(t), "z.tuqplugin"), passphraseForTests: key.passphrase }), /public key file/u);
  assert.equal(existsSync(join(lone, "z.tuqplugin")), false);
});
