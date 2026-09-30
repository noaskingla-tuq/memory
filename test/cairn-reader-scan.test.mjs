import assert from "node:assert/strict";
import test from "node:test";
import { readCairn } from "../out/adapters/ui/cairnReader.js";
import { binCounts, countAtLeast, firstAtMost } from "../out/application/ui/dayBins.js";
import { parsePunchContent } from "../out/application/ui/punchContent.js";
import { daysAgo, databasePath, newestFirst, punchContent, seed, startStore } from "./uiHarness.mjs";

const AGENT = "sw/scanner";
const NAMESPACE = { ownerId: AGENT, scope: "personal", projectId: null };
const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

async function buildRows(t) {
  const store = startStore(t);
  const specs = [];
  for (let index = 0; index < 40; index += 1) {
    const cli = index % 3 === 0 ? "codex" : "claude";
    const startMs = Date.parse(daysAgo(index % 6));
    specs.push({
      agentId: AGENT,
      content: punchContent({ startMs, cli, model: "m-1", title: `Task ${index} 登入`, body: `${index % 2 === 0 ? "Alpha" : "beta"} ${index % 5 === 0 ? "GAMMA" : "delta"} 記錄 ${index}` }),
      // why: groups of five rows share one updated_at so chunk edges land inside a tie and only the id decides the order
      updatedAt: daysAgo(Math.floor(index / 5), 3),
      sessionId: `s-${index % 4}`,
    });
  }
  const made = await seed(store, specs);
  return { store, made, path: databasePath(store.dataRoot, AGENT) };
}

const withFolded = (made) => made.map((row) => ({ ...row, folded: asciiLower(row.content.normalize("NFKC")) }));

function scanAll(path, options, stopEvery) {
  const rows = [];
  let anchor = options.after;
  let calls = 0;
  for (;;) {
    const read = readCairn(path, (reader) => reader.scan(NAMESPACE, { ...options, ...(anchor === undefined ? {} : { after: anchor }), ...(stopEvery ? { stop: () => true } : {}) }));
    assert.equal(read.ok, true);
    calls += 1;
    rows.push(...read.value.rows);
    if (read.value.resume === null) return { rows, calls, exhausted: read.value.exhausted };
    anchor = read.value.resume;
    assert.ok(calls < 200, "resume must make progress");
  }
}

test("scan with terms returns exactly the rows a brute-force filter finds, in list order, for any chunk size", async (t) => {
  const { made, path } = await buildRows(t);
  const rows = withFolded(made);
  for (const terms of [["alpha"], ["alpha", "gamma"], ["beta", "delta"], ["登入"], ["nomatchzz"], ["alpha", "beta"]]) {
    const expected = rows.filter((row) => terms.every((term) => row.folded.includes(term))).sort(newestFirst).map((row) => row.id);
    for (const chunkRows of [1, 3, 7, 800]) {
      const found = scanAll(path, { want: 1000, headChars: 640, terms, chunkRows }, false);
      assert.deepEqual(found.rows.map((row) => row.id), expected, `terms ${terms} chunk ${chunkRows}`);
      assert.equal(found.exhausted, true);
    }
  }
});

test("a scan that is stopped after every chunk resumes to the same rows and never repeats or skips one", async (t) => {
  const { made, path } = await buildRows(t);
  const rows = withFolded(made);
  const expected = rows.filter((row) => row.folded.includes("delta")).sort(newestFirst).map((row) => row.id);
  const found = scanAll(path, { want: 1000, headChars: 640, terms: ["delta"], chunkRows: 3 }, true);
  assert.deepEqual(found.rows.map((row) => row.id), expected);
  assert.ok(found.calls > 3, "the scan really was interrupted between chunks");
  const limited = readCairn(path, (reader) => reader.scan(NAMESPACE, { want: 4, headChars: 640, terms: ["delta"], chunkRows: 3 }));
  assert.deepEqual(limited.value.rows.map((row) => row.id), expected.slice(0, 4));
  assert.equal(limited.value.resume, null);
  assert.equal(limited.value.exhausted, false, "stopping at want is not exhaustion");
});

test("scan bounds: updatedFrom is inclusive, updatedBefore exclusive, after is strictly behind the anchor", async (t) => {
  const { made, path } = await buildRows(t);
  const all = [...made].sort(newestFirst);
  const from = daysAgo(3, 3);
  const before = daysAgo(1, 3);
  const inWindow = all.filter((row) => row.updatedAt >= from && row.updatedAt < before).map((row) => row.id);
  assert.ok(inWindow.length > 0);
  const windowed = scanAll(path, { want: 1000, headChars: 64, terms: ["記錄"], updatedFrom: from, updatedBefore: before, chunkRows: 3 }, false);
  assert.deepEqual(windowed.rows.map((row) => row.id), inWindow);
  const plain = scanAll(path, { want: 1000, headChars: 64, updatedFrom: from, updatedBefore: before }, false);
  assert.deepEqual(plain.rows.map((row) => row.id), inWindow);
  const anchor = all[9];
  const behind = scanAll(path, { want: 1000, headChars: 64, after: { updatedAt: anchor.updatedAt, id: anchor.id } }, false);
  assert.deepEqual(behind.rows.map((row) => row.id), all.slice(10).map((row) => row.id));
  const filteredBehind = scanAll(path, { want: 1000, headChars: 64, terms: ["記錄"], after: { updatedAt: anchor.updatedAt, id: anchor.id }, chunkRows: 2 }, false);
  assert.deepEqual(filteredBehind.rows.map((row) => row.id), all.slice(10).filter((row) => row.content.normalize("NFKC").includes("記錄")).map((row) => row.id));
});

test("the cli filter equals the cli the punch parser reads from the same rows", async (t) => {
  const { made, path } = await buildRows(t);
  for (const cli of ["codex", "claude", "gemini"]) {
    const expected = [...made].filter((row) => parsePunchContent(row.content.normalize("NFKC")).work?.cli === cli).sort(newestFirst).map((row) => row.id);
    const found = scanAll(path, { want: 1000, headChars: 640, cli, chunkRows: 4 }, false);
    assert.deepEqual(found.rows.map((row) => row.id), expected, cli);
    const combined = scanAll(path, { want: 1000, headChars: 640, cli, terms: ["alpha"], chunkRows: 4 }, false);
    assert.deepEqual(combined.rows.map((row) => row.id), [...made].filter((row) => parsePunchContent(row.content.normalize("NFKC")).work?.cli === cli && asciiLower(row.content).includes("alpha")).sort(newestFirst).map((row) => row.id));
  }
});

test("head, content and receipt counts follow the options", async (t) => {
  const { made, path } = await buildRows(t);
  const first = [...made].sort(newestFirst)[0];
  const lean = readCairn(path, (reader) => reader.scan(NAMESPACE, { want: 1, headChars: 10, withReceipts: false })).value.rows[0];
  assert.equal(lean.id, first.id);
  assert.equal([...lean.head].length, 10);
  assert.equal(lean.content, null);
  assert.equal(lean.receiptCount, 0);
  const full = readCairn(path, (reader) => reader.scan(NAMESPACE, { want: 1, headChars: 10, withContent: true })).value.rows[0];
  assert.equal(full.content, first.content.normalize("NFKC"));
  assert.equal(full.receiptCount, 1);
});

test("namespaces() carries the whole update-time series and the day bins computed from it equal a brute-force count", async (t) => {
  const { made, path } = await buildRows(t);
  const summary = readCairn(path, (reader) => reader.namespaces()).value;
  assert.equal(summary.length, 1);
  const [personal] = summary;
  const sorted = [...made].sort(newestFirst);
  assert.deepEqual([...personal.timesMs], sorted.map((row) => Date.parse(row.updatedAt)), "newest first, one entry per live memory");
  assert.equal(personal.count, made.length);
  assert.equal(personal.lastAt, sorted[0].updatedAt);
  assert.equal(personal.firstAt, sorted.at(-1).updatedAt);
  const edges = Array.from({ length: 15 }, (_, step) => Date.parse(daysAgo(13 - step + 1, 0)));
  const expected = edges.slice(0, -1).map((low, index) => made.filter((row) => Date.parse(row.updatedAt) >= low && Date.parse(row.updatedAt) < edges[index + 1]).length);
  assert.deepEqual(binCounts(personal.timesMs, edges), expected);
  assert.ok(expected.some((count) => count > 0));
  const times = personal.timesMs;
  for (const probe of [times[0] + 1, times[0], times[5], times[5] - 1, times.at(-1), times.at(-1) - 1, 0, Number.POSITIVE_INFINITY]) {
    assert.equal(countAtLeast(times, probe), [...times].filter((value) => value >= probe).length, `countAtLeast ${probe}`);
    assert.equal(firstAtMost(times, probe), [...times].findIndex((value) => value <= probe) === -1 ? times.length : [...times].findIndex((value) => value <= probe), `firstAtMost ${probe}`);
  }
});

test("receiptCounts and sameSession answer per memory", async (t) => {
  const { made, path } = await buildRows(t);
  const ids = made.slice(0, 3).map((row) => row.id);
  const counts = readCairn(path, (reader) => reader.receiptCounts([...ids, "not-an-id"])).value;
  assert.deepEqual([...counts.entries()], [...ids.map((id) => [id, 1]), ["not-an-id", 0]]);
  const target = made[0];
  const sessions = readCairn(path, (reader) => reader.receiptSessions(target.id)).value;
  assert.deepEqual(sessions, [target.sessionId]);
  const top = readCairn(path, (reader) => reader.receiptRowidMax()).value;
  assert.ok(top >= made.length);
  const expectedMates = [...made].filter((row) => row.sessionId === target.sessionId && row.id !== target.id).sort(newestFirst);
  for (const chunk of [1, 3, top]) {
    const found = [];
    for (let low = 0; low < top; low += chunk) found.push(...readCairn(path, (reader) => reader.sessionMatches(AGENT, target.id, sessions, low, low + chunk)).value);
    assert.deepEqual(found.map((row) => row.id).sort(), expectedMates.map((row) => row.id).sort(), `chunk ${chunk} sees every neighbour exactly once`);
  }
  assert.deepEqual(readCairn(path, (reader) => reader.sessionMatches(AGENT, target.id, [], 0, top)).value, []);
  const loaded = readCairn(path, (reader) => reader.memoriesById(AGENT, [...expectedMates.map((row) => row.id), "no-such-id"], 64)).value;
  assert.deepEqual(loaded.map((row) => row.id), expectedMates.map((row) => row.id), "order follows the ids, unknown ids are dropped");
  assert.ok(loaded.every((row) => row.namespace.ownerId === AGENT && row.receiptCount === 1));
});
