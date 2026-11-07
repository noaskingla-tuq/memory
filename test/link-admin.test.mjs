import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serializedBytes } from "../out/application/ui/budget.js";
import { createLinkStore } from "../out/link/linkStore.js";
import { createFsIo, fileIdOf, serializePartition } from "../out/link/storeFile.js";
import { assertWithinCoreLimit, startLink } from "./uiHarness.mjs";

const BUDGET = 56_000;
const dirOf = (base) => join(base, "memory-link-v1");
const fileOf = (base, source) => join(dirOf(base), `${fileIdOf(source)}.json`);
const sourceRow = async (link, source) => (await link.ui("ui.linkSources", {})).sources.find((row) => row.source === source);

function memoryIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async list() { return [...files.keys()]; },
    async stat(id) { return files.has(id) ? { size: 1000, mtimeMs: 1, regular: true } : undefined; },
    async read(id) {
      if (!files.has(id)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(id);
    },
    async write(id, text) { files.set(id, text); },
    async remove(id) { files.delete(id); },
  };
}

const item = (id, extra = {}) => ({ id, payload: { text: id }, rev: 1, updatedAtMs: 1000, ...extra });
const seed = (link, source, items) => link.store.commit(source, () => ({ items, result: items.length }));

async function walk(link, source, limit) {
  const pages = [];
  let cursor;
  do {
    const response = await link.ui("ui.linkList", { source, limit, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(response.ok, true, JSON.stringify(response).slice(0, 200));
    pages.push(response);
    cursor = response.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

test("T-4.1: the sources view agrees with link inspect on count, size and revision", async (t) => {
  const link = startLink(t);
  const a = await link.connect("plugin-a");
  const b = await link.connect("plugin-b");
  for (let index = 0; index < 15; index += 1) {
    await a("remember", { payload: { n: index, text: "甲".repeat(index + 1) }, key: `a${index}`, tags: ["t"] });
    await b("remember", { payload: { n: index }, key: `b${index}` });
  }
  const response = await link.ui("ui.linkSources", {});
  assert.equal(response.ok, true);
  assert.equal(response.sources.length, 2);
  for (const [caller, source] of [[a, "plugin:plugin-a"], [b, "plugin:plugin-b"]]) {
    const row = response.sources.find((entry) => entry.source === source);
    const summary = (await caller("inspect")).value.summary;
    assert.equal(row.count, summary.count);
    assert.equal(row.sizeBytes, summary.sizeBytes);
    assert.equal(row.revision, 15);
    assert.equal(row.state, "ok");
    assert.match(row.fileId, /^[0-9a-f]{64}$/u);
  }
  assert.deepEqual(response.totals, { sources: 2, count: 30, sizeBytes: response.sources[0].sizeBytes + response.sources[1].sizeBytes, corrupt: 0 });
  assert.deepEqual(response.limits, { items: 2000, bytes: 2097152, sources: 32 });
});

test("T-4.2: worst-case list pages stay within the budget, never repeat and never skip", async (t) => {
  const tags = Array.from({ length: 8 }, (_, index) => String.fromCodePoint(0x4e00 + index).repeat(32));
  const heavy = Array.from({ length: 2000 }, (_, index) => ({
    id: `${String(index).padStart(4, "0")}${"識".repeat(124)}`,
    payload: { t: "記".repeat(12_200) },
    tags,
    rev: 1,
    updatedAtMs: 5000 + (index % 7),
  }));
  const escapes = Array.from({ length: 300 }, (_, index) => ({ id: `e${index}`, payload: { t: "\"\\\u0001\n".repeat(1000) }, tags: ["\"\\<>"], rev: 1, updatedAtMs: 7000 + (index % 5) }));
  const io = memoryIo({
    [fileIdOf("plugin:heavy")]: serializePartition({ source: "plugin:heavy", revision: 9, items: heavy }),
    [fileIdOf("plugin:escapes")]: serializePartition({ source: "plugin:escapes", revision: 3, items: escapes }),
  });
  const link = startLink(t, { io });
  for (const [source, items] of [["plugin:heavy", heavy], ["plugin:escapes", escapes]]) {
    for (const limit of source === "plugin:heavy" ? [24, 12, 1] : [24, 12]) {
      const pages = await walk(link, source, limit);
      const seen = [];
      for (const page of pages) {
        assert.ok(serializedBytes(page) <= BUDGET, `${source} limit ${limit}: ${serializedBytes(page)}`);
        assertWithinCoreLimit(page);
        assert.ok(page.items.length >= 1);
        assert.ok(page.items.length <= limit);
        if (page.nextCursor !== null) assert.ok(page.nextCursor.length <= 1024);
        assert.equal(page.total, items.length);
        seen.push(...page.items.map((entry) => entry.id));
      }
      assert.equal(new Set(seen).size, seen.length, `${source} limit ${limit} repeated an id`);
      assert.deepEqual([...seen].sort(), items.map((entry) => entry.id).sort());
    }
  }
});

test("T-4.3: ui.linkGet and ui.linkSources stay within the budget in their worst cases and the text round-trips", async (t) => {
  let deep = "leaf";
  for (let level = 0; level < 120; level += 1) deep = [deep];
  const wide = { t: "記".repeat(12_200) };
  const quotes = { t: "\"\\".repeat(3000) };
  const items = [
    { id: "deep", payload: deep, rev: 1, updatedAtMs: 10 },
    { id: "wide", payload: wide, tags: ["記".repeat(32)], rev: 1, updatedAtMs: 11 },
    { id: "quotes", payload: quotes, rev: 1, updatedAtMs: 12 },
    { id: "text", payload: "字".repeat(12_000), rev: 1, updatedAtMs: 13 },
  ];
  const link = startLink(t);
  await seed(link, "plugin:worst", items);
  assert.ok(JSON.stringify(deep, null, 2).length > 16_000 && JSON.stringify(deep).length < 12_288);
  for (const entry of items) {
    const response = await link.ui("ui.linkGet", { source: "plugin:worst", id: entry.id });
    assert.equal(response.ok, true, entry.id);
    assert.ok(serializedBytes(response) <= BUDGET, `${entry.id} ${serializedBytes(response)}`);
    assertWithinCoreLimit(response);
    assert.deepEqual(JSON.parse(response.item.text), entry.payload, entry.id);
    assert.ok(response.item.text.length <= 16_000);
  }
  const names = Array.from({ length: 32 }, (_, index) => `plugin:${"源".repeat(186)}${String(index).padStart(4, "0")}`);
  const many = startLink(t);
  for (const name of names) await seed(many, name, [item("x")]);
  const sources = await many.ui("ui.linkSources", {});
  assert.equal(sources.ok, true);
  assert.equal(sources.sources.length, 32);
  assert.ok(serializedBytes(sources) <= BUDGET, String(serializedBytes(sources)));
  assertWithinCoreLimit(sources);
});

test("T-4.4: after deleting one item the link side agrees at once and after a restart", async (t) => {
  const link = startLink(t);
  const call = await link.connect("p");
  for (const key of ["k1", "k3"]) await call("remember", { payload: { v: key, word: "common" }, key, tags: ["x"] });
  const args = { payload: { v: "k2", word: "common" }, key: "k2", tags: ["x"] };
  const first = await call.withId("r1", "remember", args);
  assert.equal(first.value.created, true);
  const before = (await call("inspect")).value.summary;
  const listed = await link.ui("ui.linkList", { source: "plugin:p" });
  const target = listed.items.find((entry) => entry.id === "k2");
  const forgotten = await link.ui("ui.linkForget", { action: "item", source: "plugin:p", id: "k2", expectedItemRev: target.rev });
  assert.deepEqual(forgotten, { ok: true, forgotten: 1, revision: forgotten.revision });
  assert.equal(typeof forgotten.revision, "number");

  for (const query of [{ ids: ["k2"] }, { tags: ["x"] }, { query: "common" }, {}]) {
    const found = (await call("recall", { limit: 50, ...query })).value.items.map((entry) => entry.id);
    assert.equal(found.includes("k2"), false, JSON.stringify(query));
  }
  const after = (await call("inspect")).value.summary;
  assert.equal(after.count, before.count - 1);
  assert.equal(after.sizeBytes, before.sizeBytes - target.sizeBytes);
  const row = await sourceRow(link, "plugin:p");
  assert.equal(row.count, after.count);
  assert.equal(row.sizeBytes, after.sizeBytes);
  assert.equal((await call("diagnose")).value.checks[1].note, `已用 ${after.count}／2000 筆`);

  const restarted = createLinkStore({ dataDir: link.base });
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.snapshot("plugin:p")).items.map((entry) => entry.id).sort(), ["k1", "k3"]);

  link.clock.now += 30_000;
  assert.deepEqual(await call.withId("r1", "remember", args), first);
  assert.equal((await call("recall", { limit: 50, ids: ["k2"] })).value.items.length, 0);
  link.clock.now += 30_001;
  assert.equal((await call.withId("r1", "remember", args)).value.created, true);
  assert.equal((await call("recall", { limit: 50, ids: ["k2"] })).value.items.length, 1);

  const again = (await link.ui("ui.linkList", { source: "plugin:p" })).items.find((entry) => entry.id === "k2");
  await link.ui("ui.linkForget", { action: "item", source: "plugin:p", id: "k2", expectedItemRev: again.rev });
  assert.equal((await call("remember", { payload: "new", key: "k2" })).value.created, true);
});

test("T-4.5: deleting a whole source empties only it and frees one of the 32 slots", async (t) => {
  const link = startLink(t);
  const a = await link.connect("A");
  const b = await link.connect("B");
  for (const key of ["1", "2", "3"]) await a("remember", { payload: key, key });
  for (const key of ["1", "2"]) await b("remember", { payload: key, key });
  const bFile = readFileSync(fileOf(link.base, "plugin:B"), "utf8");
  const row = await sourceRow(link, "plugin:A");
  const response = await link.ui("ui.linkForget", { action: "source", source: "plugin:A", expectedRevision: row.revision });
  assert.deepEqual(response, { ok: true, forgotten: 3, revision: null });
  assert.equal((await a("recall", { limit: 10 })).value.items.length, 0);
  assert.equal((await b("recall", { limit: 10 })).value.items.length, 2);
  assert.equal(existsSync(fileOf(link.base, "plugin:A")), false);
  assert.equal(readFileSync(fileOf(link.base, "plugin:B"), "utf8"), bFile);

  const full = startLink(t);
  for (let index = 0; index < 32; index += 1) await seed(full, `plugin:s${index}`, [item("x")]);
  const extra = await full.connect("extra");
  await assert.rejects(extra("remember", { payload: 1 }), { code: "quota_exceeded" });
  const victim = await sourceRow(full, "plugin:s7");
  await full.ui("ui.linkForget", { action: "source", source: "plugin:s7", expectedRevision: victim.revision });
  assert.equal((await extra("remember", { payload: 1 })).value.created, true);
});

test("T-4.6: stale revisions are conflicts, concurrent writes are not lost and paging survives a deletion", async (t) => {
  const link = startLink(t);
  const call = await link.connect("c");
  await call("remember", { payload: "old", key: "k" });
  const seen = (await link.ui("ui.linkList", { source: "plugin:c" })).items[0];
  await call("remember", { payload: "newer", key: "k" });
  assert.deepEqual(await link.ui("ui.linkForget", { action: "item", source: "plugin:c", id: "k", expectedItemRev: seen.rev }), { ok: false, code: "REVISION_CONFLICT", retryable: false });
  assert.equal((await call("recall", { limit: 5 })).value.items[0].payload, "newer");

  const listed = await link.ui("ui.linkList", { source: "plugin:c" });
  await call("remember", { payload: "extra" });
  assert.deepEqual(await link.ui("ui.linkForget", { action: "source", source: "plugin:c", expectedRevision: listed.revision }), { ok: false, code: "REVISION_CONFLICT", retryable: false });
  assert.equal((await call("recall", { limit: 5 })).value.items.length, 2);

  const race = startLink(t);
  const racer = await race.connect("race");
  for (let index = 0; index < 5; index += 1) await racer("remember", { payload: index, key: `d${index}` });
  const writes = Array.from({ length: 20 }, (_, index) => racer("remember", { payload: index, key: `w${index}` }));
  const deletes = Array.from({ length: 5 }, (_, index) => race.ui("ui.linkForget", { action: "item", source: "plugin:race", id: `d${index}`, expectedItemRev: 1 }));
  const outcomes = await Promise.all([...writes, ...deletes]);
  assert.ok(outcomes.slice(20).every((outcome) => outcome.ok === true));
  const recalled = (await racer("recall", { limit: 50 })).value.items.map((entry) => entry.id).sort();
  const onDisk = JSON.parse(readFileSync(fileOf(race.base, "plugin:race"), "utf8")).items.map((entry) => entry.id).sort();
  const row = await sourceRow(race, "plugin:race");
  assert.deepEqual(recalled, Array.from({ length: 20 }, (_, index) => `w${index}`).sort());
  assert.deepEqual(onDisk, recalled);
  assert.equal(row.count, 20);

  const paging = startLink(t);
  const items = Array.from({ length: 6 }, (_, index) => item(`i${index}`, { updatedAtMs: 100 + index }));
  await seed(paging, "plugin:pg", items);
  const first = await paging.ui("ui.linkList", { source: "plugin:pg", limit: 2 });
  assert.deepEqual(first.items.map((entry) => entry.id), ["i5", "i4"]);
  await paging.ui("ui.linkForget", { action: "item", source: "plugin:pg", id: "i4", expectedItemRev: 1 });
  const second = await paging.ui("ui.linkList", { source: "plugin:pg", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((entry) => entry.id), ["i3", "i2"]);
  const third = await paging.ui("ui.linkList", { source: "plugin:pg", limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map((entry) => entry.id), ["i1", "i0"]);
  assert.equal(third.nextCursor, null);
});

test("T-4.7: a failing write keeps the item and reports retryable only for transient codes", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-link-admin-io-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = createFsIo(base);
  const failure = { code: undefined };
  const io = { ...real, async write(id, text) { if (failure.code !== undefined) throw Object.assign(new Error("injected"), { code: failure.code }); return real.write(id, text); }, async remove(id) { if (failure.code !== undefined) throw Object.assign(new Error("injected"), { code: failure.code }); return real.remove(id); } };
  const link = startLink(t, { base, io });
  const call = await link.connect("w");
  await call("remember", { payload: "keep", key: "k" });
  const bytes = readFileSync(fileOf(base, "plugin:w"), "utf8");
  failure.code = "ENOSPC";
  assert.deepEqual(await link.ui("ui.linkForget", { action: "item", source: "plugin:w", id: "k", expectedItemRev: 1 }), { ok: false, code: "STORAGE_BUSY", retryable: true });
  failure.code = "EIO";
  assert.deepEqual(await link.ui("ui.linkForget", { action: "item", source: "plugin:w", id: "k", expectedItemRev: 1 }), { ok: false, code: "STORAGE_UNSUPPORTED", retryable: false });
  assert.equal((await call("recall", { limit: 5 })).value.items.length, 1);
  assert.equal(readFileSync(fileOf(base, "plugin:w"), "utf8"), bytes);
});

test("T-4.8: a damaged file is isolated, reported, removable and never confused with a healthy one", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-link-admin-bad-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const first = startLink(t, { base });
  const a = await first.connect("A");
  const b = await first.connect("B");
  await a("remember", { payload: 1, key: "a" });
  await b("remember", { payload: 2, key: "b" });
  await first.close();
  const aFile = fileOf(base, "plugin:A");
  const bBytes = readFileSync(fileOf(base, "plugin:B"), "utf8");
  const variants = [
    "{not json",
    "",
    JSON.stringify({ version: 1, source: "plugin:other", revision: 1, items: [{ id: "x", payload: 1, rev: 1, updatedAtMs: 1 }] }),
    " ".repeat(4 * 1024 * 1024 + 1),
  ];
  for (const bytes of variants) {
    writeFileSync(aFile, bytes);
    const link = startLink(t, { base });
    const sources = await link.ui("ui.linkSources", {});
    const bad = sources.sources.find((row) => row.state === "corrupt");
    assert.deepEqual(bad, { source: null, fileId: fileIdOf("plugin:A"), state: "corrupt", count: 0, sizeBytes: 0, revision: 0, updatedAtMs: null });
    assert.equal(sources.totals.corrupt, 1);
    assert.equal((await link.ui("ui.linkList", { source: "plugin:B" })).ok, true);
    assert.equal((await link.ui("ui.linkList", { source: "plugin:A" })).code, "STORAGE_UNSUPPORTED");
    assert.equal((await link.ui("ui.linkGet", { source: "plugin:A", id: "a" })).code, "STORAGE_UNSUPPORTED");
    assert.equal((await link.ui("ui.linkForget", { action: "item", source: "plugin:A", id: "a", expectedItemRev: 1 })).code, "STORAGE_UNSUPPORTED");
    assert.equal((await link.ui("ui.linkForget", { action: "source", source: "plugin:A", expectedRevision: 1 })).code, "STORAGE_UNSUPPORTED");
    const call = await link.connect("A");
    await assert.rejects(call("recall", { limit: 1 }), { code: "provider_error" });
    assert.equal((await call("diagnose")).value.checks[0].ok, false);
    assert.deepEqual(await link.ui("ui.linkForget", { action: "damaged", fileId: fileIdOf("plugin:B") }), { ok: false, code: "REVISION_CONFLICT", retryable: false });
    assert.deepEqual(await link.ui("ui.linkForget", { action: "damaged", fileId: fileIdOf("plugin:A") }), { ok: true, forgotten: 0, revision: null });
    assert.equal(existsSync(aFile), false);
    assert.equal(readFileSync(fileOf(base, "plugin:B"), "utf8"), bBytes);
    assert.equal((await call("remember", { payload: "again", key: "a" })).value.created, true);
    await link.close();
  }
  assert.equal((await startLink(t, { base }).ui("ui.linkForget", { action: "damaged", fileId: "f".repeat(64) })).code, "NOT_FOUND");
});

test("T-4.8b: a symlinked partition file is damaged and removing it leaves the target alone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-link-admin-sym-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(dirOf(base));
  const target = join(base, "target.json");
  const content = serializePartition({ source: "plugin:A", revision: 1, items: [item("a")] });
  writeFileSync(target, content);
  try {
    symlinkSync(target, fileOf(base, "plugin:A"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.diagnostic("file symlink fixture unavailable on this platform");
      return;
    }
    throw error;
  }
  const link = startLink(t, { base });
  assert.equal((await link.ui("ui.linkSources", {})).sources[0].state, "corrupt");
  assert.equal((await link.ui("ui.linkForget", { action: "damaged", fileId: fileIdOf("plugin:A") })).ok, true);
  assert.equal(existsSync(fileOf(base, "plugin:A")), false);
  assert.equal(readFileSync(target, "utf8"), content);
});

test("T-4.9: cursors, parameters, missing and expired items are validated", async (t) => {
  const link = startLink(t);
  await seed(link, "plugin:A", [item("a1", { updatedAtMs: 1 }), item("a2", { updatedAtMs: 2 }), item("a3", { updatedAtMs: 3 })]);
  await seed(link, "plugin:B", [item("b1", { updatedAtMs: 1 }), item("b2", { updatedAtMs: 2 }), item("b3", { updatedAtMs: 3 })]);
  const page = await link.ui("ui.linkList", { source: "plugin:A", limit: 1 });
  assert.equal(typeof page.nextCursor, "string");
  assert.equal((await link.ui("ui.linkList", { source: "plugin:A", limit: 1, cursor: page.nextCursor })).ok, true);
  assert.equal((await link.ui("ui.linkList", { source: "plugin:B", limit: 1, cursor: page.nextCursor })).code, "CURSOR_STALE");
  assert.equal((await link.ui("ui.linkList", { source: "plugin:A", limit: 1, cursor: `${page.nextCursor}x` })).code, "CURSOR_STALE");
  assert.equal((await link.ui("ui.linkList", { source: "plugin:A", limit: 1, cursor: "zzz" })).code, "CURSOR_STALE");
  const invalid = [
    ["ui.linkList", { source: "plugin:A\u0001" }], ["ui.linkList", { source: "other" }], ["ui.linkList", { source: "plugin:A", extra: 1 }],
    ["ui.linkList", { source: "plugin:A", limit: 0 }], ["ui.linkList", { source: "plugin:A", limit: 25 }],
    ["ui.linkGet", { source: "plugin:A" }], ["ui.linkSources", { x: 1 }],
    ["ui.linkForget", { action: "item", source: "plugin:A", id: "a1", expectedItemRev: 0 }],
    ["ui.linkForget", { action: "source", source: "plugin:A", expectedRevision: 0 }],
    ["ui.linkForget", { action: "damaged", fileId: "xyz" }], ["ui.linkForget", { action: "nope" }],
  ];
  for (const [method, params] of invalid) assert.equal((await link.ui(method, params)).code, "INVALID_PARAMS", `${method} ${JSON.stringify(params)}`);
  assert.equal((await link.ui("ui.linkGet", { source: "plugin:A", id: "nope" })).code, "NOT_FOUND");
  assert.equal((await link.ui("ui.linkGet", { source: "plugin:never", id: "x" })).code, "NOT_FOUND");
  assert.equal((await link.ui("ui.linkList", { source: "plugin:never" })).code, "NOT_FOUND");
  assert.equal((await link.ui("ui.linkForget", { action: "item", source: "plugin:A", id: "nope", expectedItemRev: 1 })).code, "NOT_FOUND");

  const clocked = startLink(t);
  const call = await clocked.connect("T");
  await call("remember", { payload: "soon gone", key: "gone", ttlSec: 5 });
  await call("remember", { payload: "stays", key: "stays" });
  assert.equal((await clocked.ui("ui.linkList", { source: "plugin:T" })).total, 2);
  clocked.clock.now += 5_000;
  const listed = await clocked.ui("ui.linkList", { source: "plugin:T" });
  assert.deepEqual(listed.items.map((entry) => entry.id), ["stays"]);
  assert.equal(listed.total, 1);
  assert.equal((await clocked.ui("ui.linkGet", { source: "plugin:T", id: "gone" })).code, "NOT_FOUND");
  assert.equal((await sourceRow(clocked, "plugin:T")).count, 1);
});

test("T-4.10: after dispose the four methods answer STORAGE_BUSY and write nothing; a missing port is unsupported; Cairn trouble does not matter", async (t) => {
  const link = startLink(t);
  const call = await link.connect("D");
  await call("remember", { payload: 1, key: "k" });
  const before = readFileSync(fileOf(link.base, "plugin:D"), "utf8");
  const unavailable = { storageStatus: () => "storage_unsupported" };
  assert.equal((await link.ui("ui.linkSources", {}, unavailable)).ok, true);
  assert.equal((await link.ui("ui.linkList", { source: "plugin:D" }, unavailable)).ok, true);
  assert.deepEqual(await link.ui("ui.linkSources", {}, { link: undefined }), { ok: false, code: "STORAGE_UNSUPPORTED", retryable: false });
  await link.close();
  const busy = { ok: false, code: "STORAGE_BUSY", retryable: true };
  assert.deepEqual(await link.ui("ui.linkSources", {}), busy);
  assert.deepEqual(await link.ui("ui.linkList", { source: "plugin:D" }), busy);
  assert.deepEqual(await link.ui("ui.linkGet", { source: "plugin:D", id: "k" }), busy);
  assert.deepEqual(await link.ui("ui.linkForget", { action: "item", source: "plugin:D", id: "k", expectedItemRev: 1 }), busy);
  assert.deepEqual(await link.ui("ui.linkForget", { action: "source", source: "plugin:D", expectedRevision: 1 }), busy);
  assert.equal(readFileSync(fileOf(link.base, "plugin:D"), "utf8"), before);
  assert.deepEqual(readdirSync(dirOf(link.base)), [`${fileIdOf("plugin:D")}.json`]);
});
