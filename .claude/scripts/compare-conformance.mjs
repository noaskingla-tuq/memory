import { readFileSync } from "node:fs";

function load(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(report.results)) throw new Error(`${path} has no results array`);
  return report.results;
}

function ids(results, status) {
  return new Set(results.filter((entry) => entry.status === status).map((entry) => entry.id));
}

const [candidatePath, baselinePath] = process.argv.slice(2);
if (candidatePath === undefined || baselinePath === undefined) {
  process.stderr.write("usage: node compare-conformance.mjs <candidate-report.json> <baseline-report.json>\n");
  process.exit(2);
}

const candidate = load(candidatePath);
const baseline = load(baselinePath);
const passed = ids(candidate, "passed");
const missing = [...ids(baseline, "passed")].filter((id) => !passed.has(id)).sort();
const added = [...passed].filter((id) => !ids(baseline, "passed").has(id)).sort();
const failed = [...ids(candidate, "failed")].sort();
const blocked = [...ids(candidate, "blocked")].sort();

process.stdout.write(`${JSON.stringify({ candidatePassed: passed.size, baselinePassed: ids(baseline, "passed").size, missing, added, failed, blocked })}\n`);
process.exit(missing.length === 0 && failed.length === 0 && blocked.length === 0 ? 0 : 1);
