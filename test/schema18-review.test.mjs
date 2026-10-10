import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCairn } from "../out/adapters/ui/cairnReader.js";
import { callInspect, callRemember, op, startBackend } from "./backendHarness.mjs";
import { databasePathOf, installFixture, openStore, rawWrite, scratchDirectory } from "./readerHarness.mjs";

test("schema18 awaiting memories stay hidden across Cairn and every reader/UI surface", async (t) => {
  const { backend, dataRoot } = startBackend(t);
  const actor = { agentId: "sw/review", projectId: null, sessionId: "same-session", providerId: "mock" };
  const result = await callRemember(backend, [op("Normal review fixture", "normal"), op("Confirmed review fixture", "confirmed"), op("Awaiting review fixture", "awaiting")], actor);
  const [normal, confirmed, awaiting] = result.results.map((row) => row.value.memory.id);
  const path = databasePathOf(dataRoot, actor.agentId);
  rawWrite(path, (db) => {
    db.prepare("UPDATE memories SET review_state = 'confirmed' WHERE id = ?").run(confirmed);
    db.prepare("UPDATE memories SET review_state = 'awaiting' WHERE id = ?").run(awaiting);
  });
  const ns = { ownerId: actor.agentId, scope: "personal", projectId: null };
  const inspected = await callInspect(backend, { scope: "personal", limit: 12 }, actor);
  const visible = [normal, confirmed].sort();
  assert.deepEqual(inspected.result.value.memories.map((row) => row.id).sort(), visible);
  assert.equal((await callInspect(backend, { scope: "personal", memoryId: awaiting }, actor)).result.ok, false);
  const read = readCairn(path, (reader) => ({
    namespaces: reader.namespaces(), list: reader.list(ns, { limit: 12 }), scan: reader.scan(ns, { want: 12, headChars: 100, terms: ["review"] }),
    awaiting: reader.get(ns, awaiting, 12), confirmed: reader.get(ns, confirmed, 12),
    mates: reader.sessionMatches(actor.agentId, normal, ["same-session"], 0, reader.receiptRowidMax()), byId: reader.memoriesById(actor.agentId, [normal, confirmed, awaiting], 100),
  }));
  assert.equal(read.ok, true);
  assert.equal(read.value.namespaces.reduce((sum, row) => sum + row.count, 0), 2);
  assert.deepEqual(read.value.list.map((row) => row.id).sort(), visible);
  assert.deepEqual(read.value.scan.rows.map((row) => row.id).sort(), visible);
  assert.equal(read.value.awaiting, null); assert.ok(read.value.confirmed);
  assert.deepEqual(read.value.mates.map((row) => row.id), [confirmed]);
  assert.deepEqual(read.value.byId.map((row) => row.id).sort(), visible);
  const listed = await backend.call("ui.list", { agentId: actor.agentId });
  assert.deepEqual(listed.items.map((row) => row.ref.memoryId).sort(), visible);
  const searched = await backend.call("ui.search", { agentId: actor.agentId, q: "review" });
  assert.deepEqual(searched.items.map((row) => row.ref.memoryId).sort(), visible);
  const overview = await backend.call("ui.overview", { tzOffsetMin: 0, dayStartIso: "2026-10-10T00:00:00.000Z" });
  assert.equal(overview.tiles.totalMemories, 2);
  const stats = await backend.call("ui.agentStats", { agentId: actor.agentId, tzOffsetMin: 0 });
  assert.equal(stats.namespaces.reduce((sum, row) => sum + row.count, 0), 2);
  const get = await backend.call("ui.get", { agentId: actor.agentId, scope: "personal", projectId: null, memoryId: normal });
  assert.deepEqual(get.sameSession.map((row) => row.ref.memoryId), [confirmed]);
  assert.equal((await backend.call("ui.get", { agentId: actor.agentId, scope: "personal", projectId: null, memoryId: awaiting })).code, "NOT_FOUND");
});
test("real schema13 fixture is backed up before migration to18 and the backup retains schema13", async (t) => {
  const pin = JSON.parse(readFileSync(new URL("../cairn-pin.json", import.meta.url), "utf8"));
  const old = pin.accepted.find((commit) => commit !== pin.commit);
  const base = scratchDirectory(t, "schema13-migrate");
  const { databasePath, meta } = installFixture(base, old);
  const version = (path) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("PRAGMA user_version").get().user_version; } finally { db.close(); } };
  assert.equal(version(databasePath), 13);
  assert.equal(readCairn(databasePath, () => 1).code, "unsupported_schema");
  const { app, root } = openStore(base, t);
  const migrated = await app.execute("memory_inspect", { scope: "personal", limit: 12 }, meta.actor);
  assert.equal(migrated.ok, true);
  assert.equal(version(databasePath), 18);
  const backups = readdirSync(join(root, "backups"), { recursive: true }).filter((name) => name.endsWith("memory.sqlite"));
  assert.equal(backups.length, 1);
  assert.equal(version(join(root, "backups", backups[0])), 13);
  assert.equal(readCairn(databasePath, (reader) => reader.namespaces().length).ok, true);
});
