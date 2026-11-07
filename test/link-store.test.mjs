import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLinkStore } from "../out/link/linkStore.js";
import { createFsIo, fileIdOf, partitionKeyOf, serializePartition, StoreError } from "../out/link/storeFile.js";

const linkType = process.platform === "win32" ? "junction" : "dir";

function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-link-store-"));
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.dispose();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    open(options = {}) {
      const store = createLinkStore({ dataDir: base, ...options });
      stores.push(store);
      return store;
    },
  };
}

const item = (id, extra = {}) => ({ id, payload: { text: id }, rev: 1, updatedAtMs: 1000, ...extra });
const add = (next) => (snap) => ({ items: [...snap.items.filter((entry) => entry.id !== next.id), next], result: next.id });
const dirOf = (base) => join(base, "memory-link-v1");

test("partition keys follow the caller identity and file names are source hashes", () => {
  assert.equal(partitionKeyOf({ source: { kind: "plugin", pluginId: "a.b" } }), "plugin:a.b");
  assert.equal(partitionKeyOf({ source: { kind: "core" } }), "core");
  assert.match(fileIdOf("core"), /^[0-9a-f]{64}$/u);
});

test("items survive a restart with identical content and a growing revision", async (t) => {
  const { open } = scratch(t);
  const first = open();
  assert.deepEqual(await first.snapshot("plugin:x"), { source: "plugin:x", revision: 0, items: [] });
  await first.commit("plugin:x", add(item("a")));
  const second = await first.commit("plugin:x", add(item("b", { tags: ["t"], expiresAtMs: 99_999_999_999_999 })));
  assert.equal(second.revision, 2);
  await first.dispose();
  const reopened = open();
  const loaded = await reopened.snapshot("plugin:x");
  assert.equal(loaded.revision, 2);
  assert.deepEqual(loaded.items.map((entry) => entry.id).sort(), ["a", "b"]);
  assert.deepEqual(loaded.items.find((entry) => entry.id === "b").tags, ["t"]);
});

test("expired items disappear from snapshots and from the next write, and a rewrite restarts the clock", async (t) => {
  const { base, open } = scratch(t);
  let clock = 10_000;
  const store = open({ now: () => clock });
  await store.commit("core", add(item("short", { expiresAtMs: 11_000 })));
  await store.commit("core", add(item("long", { expiresAtMs: 50_000 })));
  assert.equal((await store.snapshot("core")).items.length, 2);
  clock = 11_000;
  assert.deepEqual((await store.snapshot("core")).items.map((entry) => entry.id), ["long"]);
  await store.commit("core", add(item("other")));
  const onDisk = JSON.parse(readFileSync(join(dirOf(base), `${fileIdOf("core")}.json`), "utf8"));
  assert.deepEqual(onDisk.items.map((entry) => entry.id).sort(), ["long", "other"]);
  await store.commit("core", add(item("long", { expiresAtMs: 70_000 })));
  clock = 60_000;
  assert.deepEqual((await store.snapshot("core")).items.map((entry) => entry.id).sort(), ["long", "other"]);
});

test("two sources never see each other and an emptied source releases its file", async (t) => {
  const { base, open } = scratch(t);
  const store = open();
  await store.commit("plugin:a", add(item("one")));
  await store.commit("plugin:b", add(item("two")));
  assert.deepEqual((await store.snapshot("plugin:a")).items.map((entry) => entry.id), ["one"]);
  assert.equal(readdirSync(dirOf(base)).length, 2);
  const emptied = await store.commit("plugin:a", () => ({ items: [], result: 1 }));
  assert.equal(emptied.revision, 2);
  assert.equal(readdirSync(dirOf(base)).length, 1);
  assert.deepEqual((await store.snapshot("plugin:b")).items.map((entry) => entry.id), ["two"]);
  assert.equal((await store.snapshot("plugin:a")).revision, 2);
});

test("count, byte and source quotas reject the write and leave state untouched", async (t) => {
  const { base, open } = scratch(t);
  const store = open({ limits: { items: 3, bytes: 1500, sources: 2 } });
  for (const id of ["a", "b", "c"]) await store.commit("core", add(item(id)));
  await assert.rejects(store.commit("core", add(item("d"))), { code: "quota_exceeded" });
  await store.commit("core", add(item("a", { payload: { text: "overwrite keeps the count" } })));
  assert.equal((await store.snapshot("core")).items.length, 3);
  await assert.rejects(store.commit("core", add(item("a", { payload: "x".repeat(1600) }))), { code: "quota_exceeded" });
  assert.equal((await store.snapshot("core")).items.find((entry) => entry.id === "a").payload.text, "overwrite keeps the count");
  await store.commit("plugin:1", add(item("p")));
  await assert.rejects(store.commit("plugin:2", add(item("q"))), { code: "quota_exceeded" });
  assert.equal(readdirSync(dirOf(base)).length, 2);
  await store.commit("plugin:1", () => ({ items: [], result: 0 }));
  await store.commit("plugin:2", add(item("q")));
  assert.equal(readdirSync(dirOf(base)).length, 2);
});

test("a corrupt file fails closed, keeps its bytes and recovers once it is removed", async (t) => {
  const { base, open } = scratch(t);
  const store = open();
  await store.commit("plugin:a", add(item("one")));
  const file = join(dirOf(base), `${fileIdOf("plugin:a")}.json`);
  const cases = ["{not json", JSON.stringify({ version: 1, source: "plugin:other", revision: 1, items: [] }), JSON.stringify({ version: 2 })];
  for (const bytes of cases) {
    writeFileSync(file, bytes);
    const fresh = open();
    await assert.rejects(fresh.snapshot("plugin:a"), { code: "provider_error" });
    await assert.rejects(fresh.commit("plugin:a", add(item("two"))), { code: "provider_error" });
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal((await fresh.health("plugin:a")).state, "corrupt");
    assert.equal((await fresh.snapshot("plugin:b")).items.length, 0);
  }
  rmSync(file);
  const recovered = open();
  await recovered.commit("plugin:a", add(item("fresh")));
  assert.deepEqual((await recovered.snapshot("plugin:a")).items.map((entry) => entry.id), ["fresh"]);
});

test("a file larger than 4 MiB is corrupt without being read", async (t) => {
  const { base, open } = scratch(t);
  const store = open();
  await store.commit("core", add(item("one")));
  const file = join(dirOf(base), `${fileIdOf("core")}.json`);
  writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
  const fresh = open();
  await assert.rejects(fresh.snapshot("core"), { code: "provider_error" });
  const described = await fresh.describeFile(fileIdOf("core"));
  assert.equal(described.state, "corrupt");
});

test("a symlinked partition file is corrupt and discarding it leaves the target alone", async (t) => {
  const { base, open } = scratch(t);
  const store = open();
  await store.commit("plugin:b", add(item("keep")));
  const real = join(base, "elsewhere.json");
  writeFileSync(real, serializePartition({ source: "plugin:a", revision: 1, items: [item("x")] }));
  const link = join(dirOf(base), `${fileIdOf("plugin:a")}.json`);
  try {
    symlinkSync(real, link, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.diagnostic("file symlink fixture unavailable on this platform");
      return;
    }
    throw error;
  }
  const fresh = open();
  await assert.rejects(fresh.snapshot("plugin:a"), { code: "provider_error" });
  assert.equal((await fresh.describeFile(fileIdOf("plugin:a"))).state, "corrupt");
  const before = readFileSync(real, "utf8");
  await fresh.discardDamaged(fileIdOf("plugin:a"));
  assert.equal(existsSync(link), false);
  assert.equal(readFileSync(real, "utf8"), before);
});

test("a symlinked store directory is refused for reads and writes", async (t) => {
  const { base, open } = scratch(t);
  const target = join(base, "real");
  mkdirSync(target);
  try {
    symlinkSync(target, dirOf(base), linkType);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.diagnostic("directory symlink fixture unavailable on this platform");
      return;
    }
    throw error;
  }
  const store = open();
  await assert.rejects(store.commit("core", add(item("a"))), { code: "provider_error" });
  assert.deepEqual(readdirSync(target), []);
});

test("a failing write keeps memory and disk as they were and classifies the Node code", async (t) => {
  const { base, open } = scratch(t);
  const real = createFsIo(base);
  let failure;
  const io = { ...real, async write(fileId, text) { if (failure !== undefined) throw Object.assign(new Error("boom"), { code: failure }); return real.write(fileId, text); } };
  const store = open({ io });
  await store.commit("core", add(item("a")));
  const file = join(dirOf(base), `${fileIdOf("core")}.json`);
  const before = readFileSync(file, "utf8");
  failure = "ENOSPC";
  await assert.rejects(store.commit("core", add(item("b"))), { code: "provider_not_ready" });
  assert.equal((await store.health("core")).state, "write_failed");
  failure = "EIO";
  await assert.rejects(store.commit("core", add(item("b"))), { code: "provider_error" });
  assert.deepEqual((await store.snapshot("core")).items.map((entry) => entry.id), ["a"]);
  assert.equal(readFileSync(file, "utf8"), before);
  failure = undefined;
  await store.commit("core", add(item("b")));
  assert.equal((await store.health("core")).state, "ok");
});

test("twenty concurrent writes to one source all land and none is lost", async (t) => {
  const { open } = scratch(t);
  const store = open();
  const ids = Array.from({ length: 20 }, (_, index) => `m${index}`);
  await Promise.all(ids.map((id) => store.commit("plugin:c", add(item(id)))));
  const snapshot = await store.snapshot("plugin:c");
  assert.equal(snapshot.revision, 20);
  assert.deepEqual(snapshot.items.map((entry) => entry.id).sort(), [...ids].sort());
  const reopened = open();
  assert.equal((await reopened.snapshot("plugin:c")).items.length, 20);
});

test("expect.revision and expect.item guard the write inside the queue", async (t) => {
  const { open } = scratch(t);
  const store = open();
  await store.commit("core", add(item("a")));
  await assert.rejects(store.commit("core", () => ({ items: [], result: 0 }), { revision: 5 }), { code: "conflict" });
  await assert.rejects(store.commit("core", () => ({ items: [], result: 0 }), { item: { id: "a", rev: 2 } }), { code: "conflict" });
  await assert.rejects(store.commit("core", () => ({ items: [], result: 0 }), { item: { id: "zzz", rev: 1 } }), { code: "not_found" });
  assert.equal((await store.snapshot("core")).items.length, 1);
  await store.commit("core", () => ({ items: [], result: 0 }), { item: { id: "a", rev: 1 } });
  assert.equal((await store.snapshot("core")).items.length, 0);
});

test("a disposed store refuses every write and writes nothing", async (t) => {
  const { base, open } = scratch(t);
  const store = open();
  await store.dispose();
  await assert.rejects(store.commit("core", add(item("a"))), (error) => error instanceof StoreError && error.code === "disposed");
  assert.equal(existsSync(dirOf(base)), false);
});

test("at most 32 partition files are listed and foreign names are ignored", async (t) => {
  const { base, open } = scratch(t);
  mkdirSync(dirOf(base));
  for (let index = 0; index < 40; index += 1) writeFileSync(join(dirOf(base), `${fileIdOf(`s${index}`)}.json`), "{}");
  writeFileSync(join(dirOf(base), "note.txt"), "x");
  writeFileSync(join(dirOf(base), `${fileIdOf("s0")}.json.tmp`), "x");
  const store = open();
  assert.equal((await store.listFiles()).length, 32);
});
