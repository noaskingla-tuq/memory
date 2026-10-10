import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CAIRN_APPLICATION_ID, CAIRN_USER_VERSION, readCairn } from "../out/adapters/ui/cairnReader.js";
import {
  actorOf,
  cairnGet,
  cairnListAll,
  databasePathOf,
  fillNamespace,
  installFixture,
  openStore,
  rawWrite,
  readerListAll,
  scratchDirectory,
} from "./readerHarness.mjs";

const PERSONAL = (ownerId) => ({ ownerId, scope: "personal", projectId: null });
const PROJECT = (ownerId, projectId) => ({ ownerId, scope: "project", projectId });

async function buildDataset(t) {
  const base = scratchDirectory(t, "reader");
  const first = openStore(base);
  const dev = actorOf("sw/developer", "proj-a");
  const devB = actorOf("sw/developer", "proj-b");
  const reviewer = actorOf("sw/reviewer");
  const gone = actorOf("ops/gone");
  await fillNamespace(first.app, dev, "personal", 30, "d");
  await fillNamespace(first.app, dev, "project", 16, "da");
  await fillNamespace(first.app, devB, "project", 5, "db");
  await fillNamespace(first.app, reviewer, "personal", 9, "r");
  const doomed = await first.app.execute("memory_remember", { scope: "personal", kind: "fact", content: "only memory of an agent that forgets it", operationId: "gone-1" }, gone);
  assert.equal(doomed.ok, true);
  const forgotten = await first.app.execute("memory_forget", { scope: "personal", memoryId: doomed.value.memory.id, expectedRevision: doomed.value.memory.revision, operationId: "gone-2" }, gone);
  assert.equal(forgotten.ok, true);
  await first.app.close();

  // why: Cairn stamps millisecond times, so ties in updated_at are rare by chance and are forced here to prove the id tie-break
  rawWrite(databasePathOf(first.root, "sw/developer"), (db) => {
    const ids = db.prepare("SELECT id FROM memories WHERE scope = 'personal' AND deleted = 0 ORDER BY id LIMIT 4").all().map((row) => row.id);
    const update = db.prepare("UPDATE memories SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = ?");
    for (const id of ids) update.run(id);
  });
  const second = openStore(base, t);
  return { base, root: first.root, layout: second.layout, app: second.app, dev, devB, reviewer, gone };
}

function mapCairnRow(memory) {
  return { id: memory.id, revision: memory.revision, updatedAt: memory.updatedAt, receiptCount: memory.receiptCount };
}

function mapReaderRow(row) {
  return { id: row.id, revision: row.revision, updatedAt: row.updatedAt, receiptCount: row.receiptCount };
}

async function assertNamespaceParity(app, path, actor, scope) {
  const namespace = scope === "personal" ? PERSONAL(actor.agentId) : PROJECT(actor.agentId, actor.projectId);
  const expected = await cairnListAll(app, actor, scope, 5);
  assert.ok(expected.length > 0, `${actor.agentId}/${scope} has memories`);
  const read = readCairn(path, (reader) => ({
    paged: readerListAll(reader, namespace, 5),
    whole: reader.list(namespace, { limit: 1000 }),
    single: readerListAll(reader, namespace, 1),
    details: expected.map((memory) => reader.get(namespace, memory.id, 12)),
  }));
  assert.equal(read.ok, true);
  assert.deepEqual(read.value.paged.map(mapReaderRow), expected.map(mapCairnRow));
  assert.deepEqual(read.value.whole.map(mapReaderRow), expected.map(mapCairnRow));
  assert.deepEqual(read.value.single.map(mapReaderRow), expected.map(mapCairnRow));
  for (const [index, memory] of expected.entries()) {
    const cairn = await cairnGet(app, actor, scope, memory.id);
    const mine = read.value.details[index];
    assert.notEqual(mine, null);
    assert.equal(mine.memory.content, cairn.memory.content);
    assert.deepEqual(mine.receipts, cairn.receipts);
    assert.deepEqual({ ...mine.memory, filing: { status: mine.memory.filing } }, cairn.memory);
    const listed = read.value.whole[index];
    assert.equal(listed.kind, cairn.memory.kind);
    assert.equal(listed.snippet, [...cairn.memory.content].slice(0, 160).join(""));
  }
  return expected;
}

test("reader list order, updatedAt, revision, receiptCount and get content and receipts equal the Cairn API for every namespace", async (t) => {
  const store = await buildDataset(t);
  const seen = [];
  seen.push(...(await assertNamespaceParity(store.app, databasePathOf(store.root, "sw/developer"), store.dev, "personal")));
  seen.push(...(await assertNamespaceParity(store.app, databasePathOf(store.root, "sw/developer"), store.dev, "project")));
  seen.push(...(await assertNamespaceParity(store.app, databasePathOf(store.root, "sw/developer"), store.devB, "project")));
  seen.push(...(await assertNamespaceParity(store.app, databasePathOf(store.root, "sw/reviewer"), store.reviewer, "personal")));
  assert.ok(seen.some((memory) => memory.receiptCount >= 3), "some memory carries several receipts");
  assert.ok(seen.some((memory) => memory.revision >= 3), "some memory was revised");
  const ties = seen.filter((memory) => memory.updatedAt === "2026-09-01T00:00:00.000Z");
  assert.equal(ties.length, 4, "the forced updated_at ties are part of the compared order");
});

test("the reader keyset paging honours the time window filters and never repeats or skips a row", async (t) => {
  const store = await buildDataset(t);
  const path = databasePathOf(store.root, "sw/developer");
  const namespace = PERSONAL("sw/developer");
  const result = readCairn(path, (reader) => {
    const all = reader.list(namespace, { limit: 1000 });
    const middle = all[Math.floor(all.length / 2)].updatedAt;
    return {
      all,
      middle,
      since: readerListAll(reader, namespace, 4, { updatedFrom: middle }),
      until: readerListAll(reader, namespace, 4, { updatedBefore: middle }),
    };
  });
  assert.equal(result.ok, true);
  const { all, middle, since, until } = result.value;
  assert.deepEqual(since.map((row) => row.id), all.filter((row) => row.updatedAt >= middle).map((row) => row.id));
  assert.deepEqual(until.map((row) => row.id), all.filter((row) => row.updatedAt < middle).map((row) => row.id));
  assert.equal(new Set(all.map((row) => row.id)).size, all.length);
});

test("get answers null for a forgotten memory, a wrong namespace and an unknown id", async (t) => {
  const store = await buildDataset(t);
  const path = databasePathOf(store.root, "sw/developer");
  const result = readCairn(path, (reader) => {
    const first = reader.list(PERSONAL("sw/developer"), { limit: 1 })[0];
    return {
      wrongScope: reader.get(PROJECT("sw/developer", "proj-a"), first.id, 6),
      wrongOwner: reader.get(PERSONAL("sw/other"), first.id, 6),
      unknown: reader.get(PERSONAL("sw/developer"), "no-such-id", 6),
    };
  });
  assert.deepEqual(result.value, { wrongScope: null, wrongOwner: null, unknown: null });
});

test("the reader also equals the Cairn API on the legacy fixture of every accepted commit", async (t) => {
  const pin = JSON.parse(readFileSync(new URL("../cairn-pin.json", import.meta.url), "utf8"));
  for (const commit of pin.accepted) {
    const base = scratchDirectory(t, "legacy");
    const { databasePath, meta } = installFixture(base, commit);
    assert.equal(meta.cairnCommit, commit);
    const { app } = openStore(base, t);
    for (const [scope, projectId] of [["personal", null], ["project", meta.actor.projectId]]) {
      const actor = { ...meta.actor, projectId: scope === "project" ? projectId : meta.actor.projectId };
      const expected = await cairnListAll(app, actor, scope, 5);
      const namespace = scope === "personal" ? PERSONAL(meta.agentId) : PROJECT(meta.agentId, projectId);
      const read = readCairn(databasePath, (reader) => ({ rows: readerListAll(reader, namespace, 5), details: expected.map((memory) => reader.get(namespace, memory.id, 12)) }));
      assert.equal(read.ok, true, `${commit} ${scope}`);
      assert.equal(expected.length, meta.memories.filter((memory) => memory.scope === scope).length);
      assert.deepEqual(read.value.rows.map(mapReaderRow), expected.map(mapCairnRow));
      for (const [index, memory] of expected.entries()) {
        const cairn = await cairnGet(app, actor, scope, memory.id);
        assert.equal(read.value.details[index].memory.content, cairn.memory.content);
        assert.deepEqual(read.value.details[index].receipts, cairn.receipts);
      }
    }
  }
});

test("a database whose user_version or application_id is not Cairn v18 is unsupported_schema and is never modified", async (t) => {
  const base = scratchDirectory(t, "schema");
  const { databasePath } = installFixture(base);
  assert.equal(readCairn(databasePath, (reader) => reader.namespaces().length).ok, true);
  const digest = () => createHash("sha256").update(readFileSync(databasePath)).digest("hex");
  for (const version of [13, 17, 19, 0]) {
    rawWrite(databasePath, (db) => db.exec(`PRAGMA user_version = ${version}`));
    const before = digest();
    assert.deepEqual(readCairn(databasePath, () => 1), { ok: false, code: "unsupported_schema" }, `user_version ${version}`);
    assert.equal(digest(), before, "a refused database is not modified");
  }
  rawWrite(databasePath, (db) => db.exec(`PRAGMA user_version = ${CAIRN_USER_VERSION}; PRAGMA application_id = 7`));
  assert.deepEqual(readCairn(databasePath, () => 1), { ok: false, code: "unsupported_schema" });
  rawWrite(databasePath, (db) => db.exec(`PRAGMA application_id = ${CAIRN_APPLICATION_ID}`));
  assert.equal(readCairn(databasePath, () => 1).ok, true);
});

test("a file that is not a database is unsupported_schema and a missing file is not_found without creating anything", async (t) => {
  const base = scratchDirectory(t, "garbage");
  const garbage = join(base, "garbage.sqlite");
  writeFileSync(garbage, "this is not a sqlite database, only text ".repeat(200));
  assert.deepEqual(readCairn(garbage, () => 1), { ok: false, code: "unsupported_schema" });
  const missing = join(base, "missing.sqlite");
  assert.deepEqual(readCairn(missing, () => 1), { ok: false, code: "not_found" });
  assert.equal(existsSync(missing), false, "opening a missing path must not create an empty database");
  assert.deepEqual(readCairn(join(base, "no-dir", "x.sqlite"), () => 1), { ok: false, code: "not_found" });
  assert.deepEqual(readCairn("relative.sqlite", () => 1), { ok: false, code: "unsafe_path" });
  assert.deepEqual(readCairn(base, () => 1), { ok: false, code: "unsafe_path" });
});

test("reading leaves the database bytes untouched and no journal, wal or shm file behind", async (t) => {
  const base = scratchDirectory(t, "untouched");
  const { databasePath, agentRoot } = installFixture(base);
  const before = { hash: createHash("sha256").update(readFileSync(databasePath)).digest("hex"), files: readdirSync(agentRoot).sort() };
  for (let round = 0; round < 3; round += 1) assert.equal(readCairn(databasePath, (reader) => reader.namespaces()).ok, true);
  assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), before.hash);
  assert.deepEqual(readdirSync(agentRoot).sort(), before.files);
  assert.equal(statSync(databasePath).isFile(), true);
});
