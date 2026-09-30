import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleUi } from "../tools/build.mjs";
import { scanUiFile } from "../tools/verify-artifact.mjs";
import { PLUGIN_OWNED, SYNCED_TOKENS, TOKENS_CSS, TOKENS_LOCK, buildLock, parseCoreTokens, renderTokensCss, verifyTokens } from "../tools/sync-tokens.mjs";
import { REPO_ROOT } from "../tools/vendor-lock.mjs";

const CORE_SAMPLE = `
/* comment with a { brace } */
:root,
html[data-theme="light"] {
  color-scheme: light;
${SYNCED_TOKENS.map((name, index) => `  --${name}: #${String(index + 10).padStart(2, "0")}0000;`).join("\n")}
  --unrelated: 1px;
}
html[data-theme="dark"] {
  --accent: #111111;
  --text-primary: var(--accent);
  --unrelated: 2px;
}
.sidebar { color: red; }
`;

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "teamuq-memory-tokens-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the checked-in tokens.css and tokens.lock.json agree with each other and with sync-tokens.mjs", () => {
  const verdict = verifyTokens();
  assert.deepEqual(verdict, { ok: true, problems: [] });
  const lock = JSON.parse(readFileSync(TOKENS_LOCK, "utf8"));
  assert.equal(lock.source.file, "apps/desktop/src/renderer/styles/base.css");
  assert.match(lock.source.coreCommit, /^[0-9a-f]{40}$/u);
  assert.match(lock.source.fileSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(lock.tokens.light), SYNCED_TOKENS);
});

test("the node script and the npm scripts expose the verify entry, and check runs it", () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;
  assert.equal(scripts["tokens:sync"], "node tools/sync-tokens.mjs");
  assert.equal(scripts["tokens:verify"], "node tools/sync-tokens.mjs --verify");
  assert.match(scripts.check, /npm run tokens:verify/u);
  const run = spawnSync(process.execPath, [join(REPO_ROOT, "tools", "sync-tokens.mjs"), "--verify"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(run.status, 0, run.stderr);
  const noCore = spawnSync(process.execPath, [join(REPO_ROOT, "tools", "sync-tokens.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(noCore.status, 2);
});

test("parseCoreTokens reads the light block and the dark overrides, ignores other rules and comments, and needs every token in light", () => {
  const parsed = parseCoreTokens(CORE_SAMPLE);
  assert.deepEqual(Object.keys(parsed.light), SYNCED_TOKENS);
  assert.equal(parsed.light.accent, "#100000");
  assert.deepEqual(parsed.dark, { accent: "#111111", "text-primary": "var(--accent)" });
  assert.throws(() => parseCoreTokens(CORE_SAMPLE.replace("  --hit-fg:", "  --hit-fx:")), /no light value for --hit-fg/u);
  assert.throws(() => parseCoreTokens(`${CORE_SAMPLE}\nhtml[data-theme="dark"] {\n  --accent: #222222;\n}`), /exactly one top-level rule/u);
  assert.throws(() => parseCoreTokens(".a { color: red; }"), /exactly one top-level rule/u);
});

test("renderTokensCss is deterministic, puts dark in one prefers-color-scheme block and repeats only plugin values that differ", () => {
  const parsed = parseCoreTokens(CORE_SAMPLE);
  const css = renderTokensCss(parsed);
  assert.equal(css, renderTokensCss(parsed));
  assert.equal((css.match(/@media/gu) ?? []).length, 1);
  assert.ok(css.startsWith(":root {\n  color-scheme: light dark;\n"));
  assert.ok(!css.includes("data-theme"));
  const darkBlock = css.slice(css.indexOf("@media"));
  assert.ok(darkBlock.includes("--link: #7cc4ee;"));
  assert.ok(darkBlock.includes("--danger-fg: #1c0b0d;"));
  assert.ok(!darkBlock.includes("--accent-fg"), "accent-fg is the same in both schemes and is not repeated");
  assert.ok(!darkBlock.includes("--font-ui"));
  for (const name of Object.keys(PLUGIN_OWNED.light)) assert.ok(css.includes(`--${name}:`), name);
});

test("verifyTokens catches a hand edit of tokens.css, a lock that no longer renders it, and a drifted plugin-owned value", (t) => {
  const directory = scratch(t);
  const cssFile = join(directory, "tokens.css");
  const lockFile = join(directory, "tokens.lock.json");
  cpSync(TOKENS_CSS, cssFile);
  cpSync(TOKENS_LOCK, lockFile);
  assert.equal(verifyTokens({ cssFile, lockFile }).ok, true);

  writeFileSync(cssFile, readFileSync(cssFile, "utf8").replace("--text-muted: #a0a0a0;", "--text-muted: #000000;"));
  const edited = verifyTokens({ cssFile, lockFile });
  assert.equal(edited.ok, false);
  assert.ok(edited.problems.some((problem) => /edited by hand/u.test(problem)));

  cpSync(TOKENS_CSS, cssFile);
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  lock.tokens.light["text-muted"] = "#000000";
  writeFileSync(lockFile, JSON.stringify(lock));
  const drifted = verifyTokens({ cssFile, lockFile });
  assert.equal(drifted.ok, false);
  assert.ok(drifted.problems.some((problem) => /not what tokens\.lock\.json renders/u.test(problem)));

  cpSync(TOKENS_LOCK, lockFile);
  const owned = JSON.parse(readFileSync(lockFile, "utf8"));
  owned.pluginOwned.light.link = "#000000";
  writeFileSync(lockFile, JSON.stringify(owned));
  assert.ok(verifyTokens({ cssFile, lockFile }).problems.some((problem) => /plugin-owned/u.test(problem)));

  assert.equal(verifyTokens({ cssFile: join(directory, "missing.css"), lockFile }).ok, false);
});

test("buildLock records the source commit, the source hash, both value sets and the hash of the css it renders", () => {
  const parsed = parseCoreTokens(CORE_SAMPLE);
  const lock = buildLock({ ...parsed, coreCommit: "a".repeat(40), fileCommit: "b".repeat(40), sourceSha256: "c".repeat(64) });
  assert.equal(lock.lockVersion, 1);
  assert.deepEqual(lock.source, { repo: "teamuq-electron", file: "apps/desktop/src/renderer/styles/base.css", coreCommit: "a".repeat(40), fileCommit: "b".repeat(40), fileSha256: "c".repeat(64) });
  assert.deepEqual(lock.tokens, { light: parsed.light, dark: parsed.dark });
  assert.equal(lock.output.file, "src/ui/styles/tokens.css");
  assert.match(lock.output.sha256, /^[0-9a-f]{64}$/u);
});

test("the staged UI stylesheet inlines tokens.css into app.css, and every staged ui file passes the CSP scan", async (t) => {
  const stage = scratch(t);
  await bundleUi(stage);
  const css = readFileSync(join(stage, "ui", "app.css"), "utf8");
  assert.ok(!/@import/u.test(css), "app.css has no @import left");
  assert.ok(css.includes("--link: #1d72a8;") && css.includes("@media (prefers-color-scheme: dark)"));
  assert.ok(css.includes(".dlg-wrap"));
  for (const name of ["index.html", "app.js", "app.css"]) assert.deepEqual(scanUiFile(`ui/${name}`, readFileSync(join(stage, "ui", name), "utf8")), [], name);
  const script = readFileSync(join(stage, "ui", "app.js"), "utf8");
  assert.ok(script.includes("data-retry") && !/\bfetch\s*\(|\beval\s*\(/u.test(script));
});
