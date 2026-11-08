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
import { scanUiFile, verifyArtifact } from "../tools/verify-artifact.mjs";
import { REPO_ROOT } from "../tools/vendor-lock.mjs";
import { UI_METHOD_NAMES } from "../out/contracts/uiContract.js";

const pin = readPin();
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "teamuq-memory-build-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function tempKey(t) {
  const key = createTempKey({ keyIdPrefix: "memory-tmp-" });
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
  assert.equal(paths.length, computeStageRecord().length);
  assert.equal(paths.filter((path) => path.startsWith("core/")).length, computeStageRecord().filter((entry) => entry.path.startsWith("core/")).length);
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
  assert.equal(staged.files, pin.stage.files.length);
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
  assert.equal(manifest.name, "Cairn記憶管理");
  assert.equal(manifest.minCoreVersion, ">=1.7.12");
  assert.deepEqual(
    { id: manifest.id, publisher: manifest.publisher, trustTier: manifest.trustTier, entry: manifest.entry, permissions: manifest.permissions, data: manifest.data },
    { id: "teamuq.memory", publisher: "teamuq", trustTier: "full-trust", entry: { ui: "ui/index.html", backend: "backend.mjs" }, permissions: ["ui:view", "backend:invoke", "agent:avatar-read", "work-records:read", "agent-directory:read", "project-directory:read", "plugin-state:read", "data:legacy-migrate", "settings:plugin", "ai:chat", "program:data:projects:write", "program:data:tasks:write"], data: { uninstall: "keep", legacyMigrations: [{ id: "cairn-v1", source: "memory-cairn-v1", target: "memory-cairn-v1" }] } },
  );
  assert.deepEqual(manifest.contributes.views, [
    { id: "memory", title: "Cairn記憶管理", icon: "cairn-icon.png", entry: "ui/index.html", presentations: ["tab", "fullpage"], defaultPresentation: "tab" },
  ]);
  assert.equal(manifest.resources.maxSessions, 4);
  assert.deepEqual(manifest.hostApis, [{ id: "teamuq.host-data", range: "^1.1.0" }]);
  assert.equal(manifest.settingsSchema.fields.find((field) => field.key === "organizationEnabled").default, true);
  const frequency = manifest.settingsSchema.fields.find((field) => field.key === "organizationFrequency");
  assert.deepEqual(frequency, {
    key: "organizationFrequency", type: "choice", label: "整理頻率",
    options: [{ value: "daily", label: "每天一輪" }, { value: "immediate", label: "即時整理" }],
    default: "daily", help: "每天一輪預設使用本機時間 02:00；即時整理會處理同步後的等待項目。",
  });
  assert.equal(manifest.settingsSchema.fields.find((field) => field.key === "organizationDailyTime").default, "02:00");
  assert.deepEqual(manifest.backendMethods, UI_METHOD_NAMES);
  assert.equal(manifest.backendMethods.some((method) => method.startsWith("memory.")), false);
  assert.equal(manifest.backendMethods.includes("memory.profile.sync@1"), false);
  assert.equal(UI_METHOD_NAMES.some((method) => method.includes("profile")), false);
  const html = readFileSync(join(dist, "stage", "ui", "index.html"), "utf8");
  assert.match(html, /<title>Cairn記憶管理<\/title>/u);
  assert.match(html, /<a id="brand-home" class="hdr-brand" href="#\/" aria-label="Cairn記憶管理，回到總覽">/u);
  assert.match(html, /<nav id="primary-nav" class="hdr-nav" aria-label="主要導覽">\s*<a id="nav-overview" href="#\/">總覽<\/a>\s*<a id="nav-linked" href="#\/linked">外掛記憶<\/a>\s*<a id="nav-settings" href="#\/settings">設定<\/a>/u);
  assert.match(html, /<img class="hdr-logo" src="\.\.\/cairn-icon\.png" width="24" height="24" alt="">/u);
  assert.equal(sha256Bytes(readFileSync(join(dist, "stage", "cairn-icon.png"))), "48a8a8c7b2fbefa172def0acadec39670cc68c4959538d311a9ad0d06519fc02");
  assert.deepEqual(scanUiFile("ui/index.html", html), []);
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/gu)].map((match) => match[0]), ['<script src="app.js" defer>']);
  for (const name of ["app.js", "app.css"]) assert.ok(readFileSync(join(dist, "stage", "ui", name), "utf8").length > 0, name);
  const diagnoseSource = readFileSync(join(REPO_ROOT, "src", "backend", "diagnose.ts"), "utf8");
  assert.ok(diagnoseSource.includes(`PLUGIN_VERSION = "${manifest.version}"`));
});

test("a full build signs with a throwaway key, verifies itself and leaves no key behind", async (t) => {
  const dist = scratch(t);
  const info = await buildPlugin({ dist });
  assert.equal(info.ephemeralKey, true);
  assert.equal(info.anchors, "self");
  assert.equal(info.signer.kind, "teamuq");
  assert.match(info.signer.keyId, /^memory-tmp-[0-9a-f]{8}$/u);
  assert.equal(info.file, join(dist, `teamuq.memory-${packageJson.version}.tuqplugin`));
  const report = verifyArtifact(info.file, { anchors: "self", pubFile: info.pubFile });
  assert.deepEqual(failedChecks(report), []);
  const pluginFiles = [
    "backend.mjs", "cairn-pin.json", "cairn-icon.png", "manifest.json",
    "ui/index.html", "ui/app.js", "ui/app.css", "integrity.json", "signature.json",
  ];
  assert.equal(report.fileCount, pluginFiles.length + pin.stage.files.length);
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

test("verify-artifact resolves a directory URL joined with a file name and rejects a missing file or a bare directory URL", async (t) => {
  const RESOLVES = "every relative import and asset URL of a staged .mjs resolves inside the artifact";
  const missingWorker = await tamperedArtifact(t, (stageDir) => rmSync(join(stageDir, "cairn", "core", "context-product-worker.mjs")));
  assert.ok(failedChecks(missingWorker).includes(RESOLVES));
  const bare = await tamperedArtifact(t, (stageDir) => rewrite(stageDir, "cairn/core/context-product-reader-pool.mjs", (text) => `${text}\nvoid new URL('.', import.meta.url);\n`));
  assert.ok(failedChecks(bare).includes(RESOLVES));
});

test("verify-artifact rejects a manifest that permits a Core older than the pinned public API", async (t) => {
  const report = await tamperedArtifact(t, (stageDir) => {
    const file = join(stageDir, "manifest.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(">=1.7.12", ">=1.7.0"));
  });
  assert.equal(report.ok, false);
  assert.ok(failedChecks(report).includes("manifest pluginApi is set and minCoreVersion is >=1.7.12"));
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

function rewrite(stageDir, relative, change) {
  const file = join(stageDir, ...relative.split("/"));
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

const CSP_CHECK = "CSP safety: no inline script, event handler attribute, javascript: URL, eval, new Function, http(s):// URL, fetch( or WebSocket in ui/**, and index.html loads only app.js and app.css";

test("verify-artifact rejects every CSP-unsafe construct in the UI files", async (t) => {
  const cases = [
    ["inline script", "ui/index.html", (text) => text.replace("</body>", "<script>window.x = 1</script></body>"), /inline script/u],
    ["inline module script", "ui/index.html", (text) => text.replace("</body>", '<script type="module">window.x = 1</script></body>'), /inline script/u],
    ["second external script", "ui/index.html", (text) => text.replace("</body>", '<script src="other.js"></script></body>'), /other than app\.js/u],
    ["inline event handler", "ui/index.html", (text) => text.replace("<main>", '<main onclick="void 0">'), /event handler/u],
    ["javascript: URL", "ui/index.html", (text) => text.replace("<main>", '<main><a href="javascript:void 0">x</a>'), /javascript: URL/u],
    ["fetch(", "ui/app.js", (text) => `${text}\nfetch("x");\n`, /fetch\( in ui\/app\.js/u],
    ["eval", "ui/app.js", (text) => `${text}\neval("1");\n`, /eval in ui\/app\.js/u],
    ["new Function", "ui/app.js", (text) => `${text}\nnew Function("return 1");\n`, /new Function in ui\/app\.js/u],
    ["http URL", "ui/app.js", (text) => `${text}\nvoid "http://example.com";\n`, /http\(s\):\/\/ URL in ui\/app\.js/u],
    ["https URL in css", "ui/app.css", (text) => `${text}\n@import url("https://example.com/a.css");\n`, /http\(s\):\/\/ URL in ui\/app\.css/u],
    ["WebSocket", "ui/app.js", (text) => `${text}\nvoid WebSocket;\n`, /WebSocket in ui\/app\.js/u],
  ];
  for (const [label, relative, change, expected] of cases) {
    const report = await tamperedArtifact(t, (stageDir) => rewrite(stageDir, relative, change));
    assert.equal(report.ok, false, label);
    const failed = report.checks.find((entry) => entry.name === CSP_CHECK);
    assert.equal(failed.ok, false, label);
    assert.match(failed.detail, expected, label);
  }
});

test("verify-artifact rejects a manifest that exposes memory.* methods, adds a permission or lowers maxSessions", async (t) => {
  const exposed = await tamperedArtifact(t, (stageDir) => rewrite(stageDir, "manifest.json", (text) => text.replace('"ui.status"', '"ui.status",\n    "memory.remember@1"')));
  assert.ok(failedChecks(exposed).some((name) => name.startsWith("no memory.* method")));
  assert.ok(failedChecks(exposed).some((name) => name.startsWith("manifest backendMethods are exactly")));
  const permissions = await tamperedArtifact(t, (stageDir) => rewrite(stageDir, "manifest.json", (text) => text.replace('"ui:view"', '"ui:view", "storage:plugin-data"')));
  assert.ok(failedChecks(permissions).some((name) => name.startsWith("manifest permissions are exactly")));
  const sessions = await tamperedArtifact(t, (stageDir) => rewrite(stageDir, "manifest.json", (text) => text.replace('"maxSessions": 4', '"maxSessions": 2')));
  assert.ok(failedChecks(sessions).some((name) => name.startsWith("manifest resources follow")));
});

test("verify-artifact rejects a manifest whose backendMethods list memory.profile.sync@1 in any spelling", async (t) => {
  for (const spelling of ["memory.profile.sync@1", "profile.sync", "ui.profile.sync"]) {
    const report = await tamperedArtifact(t, (stageDir) => rewrite(stageDir, "manifest.json", (text) => text.replace('"ui.status"', `"ui.status",
    "${spelling}"`)));
    const failed = failedChecks(report);
    assert.equal(report.ok, false, spelling);
    assert.ok(failed.some((name) => name.startsWith("manifest backendMethods do not list memory.profile.sync@1")), spelling);
  }
});

test("verify-artifact rejects a missing UI file and a smuggled extra file under ui/", async (t) => {
  const missing = await tamperedArtifact(t, (stageDir) => rmSync(join(stageDir, "ui", "app.css")));
  assert.ok(failedChecks(missing).some((name) => name.startsWith("file set equals")));
  const extra = await tamperedArtifact(t, (stageDir) => writeFileSync(join(stageDir, "ui", "extra.js"), "export {}\n"));
  assert.ok(failedChecks(extra).some((name) => name.startsWith("file set equals")));
});

test("release refuses a key path inside this repository or inside any git work tree", (t) => {
  const inside = join(REPO_ROOT, "dist", "teamuq-x.key.pem");
  assert.throws(() => release({ keyFile: inside, keyId: "teamuq-x", anchors: "self", pubFile: inside }), /inside this repository/u);
  const base = scratch(t);
  mkdirSync(join(base, ".git"));
  const keyFile = join(base, "teamuq-x.key.pem");
  assert.throws(() => release({ keyFile, keyId: "teamuq-x", anchors: "self", pubFile: keyFile }), /inside the git work tree/u);
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
