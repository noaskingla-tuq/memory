import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const cache = new Map();
let scratch = null;
let serial = 0;

process.on("exit", () => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
});

// why: a bundle carries its own copy of every module it imports, so tests that mix modules must load them through one bundle or class identity checks (SafeHtml) would fail across copies
export async function loadUiModule(...relatives) {
  const key = relatives.join("|");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  scratch ??= mkdtempSync(join(tmpdir(), "teamuq-memory-ui-test-"));
  serial += 1;
  const outfile = join(scratch, `bundle-${serial}.mjs`);
  await build({
    stdin: {
      contents: relatives.map((relative) => `export * from ${JSON.stringify(`./${relative}`)};`).join("\n"),
      resolveDir: join(ROOT, "src", "ui"),
      loader: "ts",
    },
    absWorkingDir: ROOT,
    tsconfig: join(ROOT, "tsconfig.ui.json"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile,
    logLevel: "silent",
  });
  const loaded = import(pathToFileURL(outfile).href);
  cache.set(key, loaded);
  return loaded;
}

export const UI_ROOT = join(ROOT, "src", "ui");
export const REPO = ROOT;
