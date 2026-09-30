import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scratchDirectory } from "./readerHarness.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const READER = "adapters/ui/cairnReader.ts";

function gate(srcRoot) {
  const run = spawnSync(process.execPath, [join(repoRoot, "tools", "verify-source-untouched.mjs"), "--src", srcRoot], { encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function copyOfSrc(t, label) {
  const base = scratchDirectory(t, label);
  const src = join(base, "src");
  cpSync(join(repoRoot, "src"), src, { recursive: true });
  return src;
}

const ROGUE = 'import { DatabaseSync } from "node:sqlite";\nexport const open = (path: string) => new DatabaseSync(path).prepare("SELECT 1").get();\n';

test("the gate accepts a copy of the real source tree", (t) => {
  const run = gate(copyOfSrc(t, "gate-clean"));
  assert.equal(run.status, 0, run.output);
});

test("the gate exits 1 when any file other than cairnReader.ts issues SQL", (t) => {
  for (const [label, relative] of [
    ["adapter", "adapters/ui/rogue.ts"],
    ["application", "application/ui/rogue.ts"],
    ["backend", "backend/rogue.ts"],
    ["ui", "ui/rogue.ts"],
  ]) {
    const src = copyOfSrc(t, `gate-${label}`);
    mkdirSync(dirname(join(src, relative)), { recursive: true });
    writeFileSync(join(src, relative), ROGUE);
    const run = gate(src);
    assert.equal(run.status, 1, `${label}: ${run.output}`);
    assert.match(run.output, /SQL outside cairnReader\.ts: src\//u, label);
  }
});

test("the gate exits 1 when an existing file gains a database open, or the older exceptions are widened", (t) => {
  const storage = copyOfSrc(t, "gate-storage");
  appendFileSync(join(storage, "adapters/storage/dataLayout.ts"), '\nimport { DatabaseSync as Sneaky } from "node:sqlite";\nexport const sneaky = Sneaky;\n');
  assert.equal(gate(storage).status, 1);

  const diagnose = copyOfSrc(t, "gate-diagnose");
  appendFileSync(join(diagnose, "backend/diagnose.ts"), '\nexport const other = new DatabaseSync("data.sqlite");\n');
  const run = gate(diagnose);
  assert.equal(run.status, 1);
  assert.match(run.output, /diagnose\.ts opens something other than :memory:/u);
});

test("the gate exits 1 when cairnReader.ts stops being read-only", (t) => {
  const cases = [
    ["readonly-flag", (text) => text.replace("{ timeout: BUSY_TIMEOUT_MS }", "{ timeout: BUSY_TIMEOUT_MS, readOnly: true }"), /readOnly/u],
    ["no-query-only", (text) => text.replace("PRAGMA query_only = ON;", "PRAGMA trusted_schema = OFF;"), /query_only/u],
    ["write-word", (text) => text.replace("SELECT count(*) AS n FROM receipts", "DELETE FROM receipts"), /write statement keyword/u],
    ["pragma-assign", (text) => text.replace("PRAGMA trusted_schema = OFF", "PRAGMA user_version = 1"), /assigns PRAGMA user_version/u],
  ];
  for (const [label, mutate, expected] of cases) {
    const src = copyOfSrc(t, `gate-${label}`);
    const file = join(src, READER);
    const before = readFileSync(file, "utf8");
    const after = mutate(before);
    assert.notEqual(after, before, `${label}: the mutation applies`);
    writeFileSync(file, after);
    const run = gate(src);
    assert.equal(run.status, 1, `${label}: ${run.output}`);
    assert.match(run.output, expected, label);
  }
});

test("the gate exits 1 when cairnReader.ts is missing", (t) => {
  const src = copyOfSrc(t, "gate-missing");
  writeFileSync(join(src, READER), "export {};\n");
  assert.equal(gate(src).status, 1);
});
