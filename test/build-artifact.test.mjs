import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPlugin } from "../tools/build.mjs";
import { checkPinStage, computeStageRecord, readPin, sha256Bytes } from "../tools/cairn-files.mjs";
import { runDevkit } from "../tools/devkit.mjs";
import { release } from "../tools/release.mjs";
import { stageCairn } from "../tools/stage-cairn.mjs";
import { createTempKey } from "../tools/temp-key.mjs";
import { verifyArtifact } from "../tools/verify-artifact.mjs";
import { REPO_ROOT } from "../tools/vendor-lock.mjs";

const pin = readPin();
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "teamuq-memory-build-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function tempKey(t) {
  const key = createTempKey();
  t.after(() => key.cleanup());
  return key;
}

function failedChecks(report) {
  return report.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
}

async function tamperedArtifact(t, tamper) {
  const dist = scratch(t);
  await buildPlugin({ dist, stageOnly: true });
  const stageDir = join(dist, "stage");
  tamper(stageDir);
  const key = tempKey(t);
  const packed = release({
    stageDir,
    keyFile: key.keyFile,
    keyId: key.keyId,
    pubFile: key.pubFile,
    anchors: "self",
    outFile: join(dist, "tampered.tuqplugin"),
    passphraseForTests: key.passphrase,
  });
  return verifyArtifact(packed.file, { anchors: "self", pubFile: key.pubFile });
}

test("the pin records exactly the Cairn core without test directories, redact.mjs and LICENSE", () => {
  assert.deepEqual(checkPinStage(pin), []);
  const paths = pin.stage.files.map((entry) => entry.path);
  assert.equal(paths.length, 58);
  assert.equal(paths.filter((path) => path.startsWith("core/")).length, 56);
  assert.ok(paths.includes("plugins/cairn-memory/lib/redact.mjs"));
  assert.ok(paths.includes("LICENSE"));
  assert.equal(paths.some((path) => /(^|\/)(?:test|testing)\//u.test(path)), false);
  assert.equal(pin.stage.files.find((entry) => entry.path === "plugins/cairn-memory/lib/redact.mjs").sha256, pin.redactSha256);
});

test("the stage check names a changed hash, a missing entry and an unlisted file", (t) => {
  const changed = structuredClone(pin);
  changed.stage.files[0].sha256 = "0".repeat(64);
  assert.match(checkPinStage(changed).join("|"), /sha256 differs from the pin record/u);
  const dropped = structuredClone(pin);
  dropped.stage.files.pop();
  assert.match(checkPinStage(dropped).join("|"), /unlisted/u);
  const extra = structuredClone(pin);
  extra.stage.files.push({ path: "core/ghost.mjs", sha256: "0".repeat(64) });
  assert.match(checkPinStage(extra).join("|"), /missing: core\/ghost\.mjs/u);
  const base = scratch(t);
  mkdirSync(join(base, "core"), { recursive: true });
  writeFileSync(join(base, "core", "only.mjs"), "export {}\n");
  assert.notDeepEqual(checkPinStage(pin, base), []);
  assert.deepEqual(computeStageRecord().map((entry) => entry.path), pin.stage.files.map((entry) => entry.path));
});

test("stageCairn copies the recorded files byte for byte and the pin next to backend.mjs", (t) => {
  const stageDir = scratch(t);
  const staged = stageCairn(stageDir);
  assert.equal(staged.files, 58);
  for (const entry of pin.stage.files) {
    assert.equal(sha256Bytes(readFileSync(join(stageDir, "cairn", ...entry.path.split("/")))), entry.sha256, entry.path);
  }
  assert.equal(existsSync(join(stageDir, "cairn", "core", "test")), false);
  assert.equal(existsSync(join(stageDir, "cairn", "core", "testing")), false);
  assert.equal(readFileSync(join(stageDir, "cairn-pin.json"), "utf8"), readFileSync(join(REPO_ROOT, "cairn-pin.json"), "utf8"));
});

test("the stage holds a self-contained backend.mjs and a manifest built from the template", async (t) => {
  const dist = scratch(t);
  const report = await buildPlugin({ dist, stageOnly: true });
  assert.equal(report.validated, true);
  const backend = readFileSync(join(dist, "stage", "backend.mjs"), "utf8");
  assert.match(backend, /from "\.\/cairn\/core\/index\.mjs"/u);
  assert.doesNotMatch(backend, /from "cairn-memory/u);
  assert.doesNotMatch(backend, /from "zod"/u);
  const manifest = JSON.parse(readFileSync(join(dist, "stage", "manifest.json"), "utf8"));
  assert.equal(manifest.version, packageJson.version);
  assert.deepEqual(
    { id: manifest.id, publisher: manifest.publisher, trustTier: manifest.trustTier, entry: manifest.entry, permissions: manifest.permissions, data: manifest.data },
    { id: "teamuq.memory", publisher: "teamuq", trustTier: "full-trust", entry: { backend: "backend.mjs" }, permissions: [], data: { uninstall: "keep" } },
  );
  const diagnoseSource = readFileSync(join(REPO_ROOT, "src", "backend", "diagnose.ts"), "utf8");
  assert.ok(diagnoseSource.includes(`PLUGIN_VERSION = "${manifest.version}"`));
});

test("a full build signs with a throwaway key, verifies itself and leaves no key behind", async (t) => {
  const dist = scratch(t);
  const info = await buildPlugin({ dist });
  assert.equal(info.ephemeralKey, true);
  assert.equal(info.anchors, "self");
  assert.equal(info.signer.kind, "teamuq");
  assert.match(info.signer.keyId, /^teamuq-tmp-[0-9a-f]{8}$/u);
  assert.equal(info.file, join(dist, "teamuq.memory-1.0.0.tuqplugin"));
  const report = verifyArtifact(info.file, { anchors: "self", pubFile: info.pubFile });
  assert.deepEqual(failedChecks(report), []);
  assert.equal(report.fileCount, 5 + 58);
  assert.equal(report.sha256, info.sha256);
  const publicFile = JSON.parse(readFileSync(info.pubFile, "utf8"));
  assert.deepEqual(Object.keys(publicFile).sort(), ["keyId", "publicKey"]);
  const entries = readdirSync(dist, { recursive: true });
  assert.equal(entries.some((name) => /\.(?:pem|key)$/iu.test(name)), false);
});

test("verify-artifact rejects an artifact whose Cairn file was changed after staging", async (t) => {
  const report = await tamperedArtifact(t, (stageDir) => appendFileSync(join(stageDir, "cairn", "core", "index.mjs"), "\n// changed\n"));
  assert.equal(report.ok, false);
  assert.ok(failedChecks(report).includes("every Cairn file hashes equal to node_modules and to the pin record"));
});

test("verify-artifact rejects a missing Cairn file, a smuggled test directory and a missing LICENSE", async (t) => {
  const missing = await tamperedArtifact(t, (stageDir) => rmSync(join(stageDir, "cairn", "core", "validation.mjs")));
  assert.ok(failedChecks(missing).includes("every relative import and asset URL of a staged .mjs resolves inside the artifact"));
  assert.ok(failedChecks(missing).some((name) => name.startsWith("file set equals")));
  const smuggled = await tamperedArtifact(t, (stageDir) => {
    mkdirSync(join(stageDir, "cairn", "core", "test"), { recursive: true });
    writeFileSync(join(stageDir, "cairn", "core", "test", "store.test.mjs"), "export {}\n");
  });
  assert.ok(failedChecks(smuggled).includes("no Cairn test or testing directory"));
  const unlicensed = await tamperedArtifact(t, (stageDir) => rmSync(join(stageDir, "cairn", "LICENSE")));
  assert.ok(failedChecks(unlicensed).includes("cairn/LICENSE is present"));
});

test("verify-artifact rejects a backend that imports Cairn or a package by a bare name", async (t) => {
  const report = await tamperedArtifact(t, (stageDir) => {
    const file = join(stageDir, "backend.mjs");
    writeFileSync(file, `import { openMemoryCore } from "cairn-memory/core/index.mjs";\nimport z from "zod";\n${readFileSync(file, "utf8")}`);
  });
  const failed = failedChecks(report);
  assert.ok(failed.includes("backend.mjs imports Cairn only as ./cairn/core/index.mjs"));
  assert.ok(failed.includes("backend.mjs has no bare package import (zod is inlined)"));
});

test("release refuses a key path inside this repository or inside any git work tree", (t) => {
  const inside = join(REPO_ROOT, "dist", "teamuq-x.key.pem");
  assert.throws(() => release({ keyFile: inside, keyId: "teamuq-x", anchors: "self", pubFile: inside }), /inside this repository/u);
  const base = scratch(t);
  mkdirSync(join(base, ".git"));
  const keyFile = join(base, "teamuq-x.key.pem");
  assert.throws(() => release({ keyFile, keyId: "teamuq-x", anchors: "self", pubFile: keyFile }), /inside the git work tree/u);
});

test("the passphrase environment variable of the parent never reaches the devkit", (t) => {
  const key = tempKey(t);
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

test("the throwaway key lives outside the repository and its cleanup removes it", () => {
  const key = createTempKey();
  try {
    assert.equal(key.keyFile.startsWith(REPO_ROOT), false);
    assert.equal(existsSync(key.keyFile), true);
    assert.match(readFileSync(key.keyFile, "utf8"), /ENCRYPTED/u);
  } finally {
    key.cleanup();
  }
  assert.equal(existsSync(key.keyFile), false);
});
