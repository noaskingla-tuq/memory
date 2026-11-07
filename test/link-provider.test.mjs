import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFiles } from "../out/link/fileService.js";
import { createLinkStore } from "../out/link/linkStore.js";
import { createMemoryStoreGroup } from "../out/link/memoryStoreGroup.js";
import { createProvider } from "../out/link/provider.js";

const GROUP = { id: "memory-store" };
const who = (id) => ({ source: id === undefined ? { kind: "core" } : { kind: "plugin", pluginId: id }, category: "teamuq.memory@1" });
const channel = { closed: false, emit: async () => undefined };
let linkCounter = 0;

function setup(t, options = {}) {
  const base = options.base ?? mkdtempSync(join(tmpdir(), "teamuq-link-provider-"));
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const store = createLinkStore({ dataDir: base, now, ...(options.limits === undefined ? {} : { limits: options.limits }) });
  const files = createFiles({ dataDir: base, now });
  const group = createMemoryStoreGroup({ store, ...(options.group ?? {}) });
  const provider = createProvider({ category: "teamuq.memory@1", dataClass: "local", maxSessions: options.maxSessions ?? 4, modules: [group], files, now, callRatePerSecond: options.rate ?? 1000, callBurst: options.burst ?? 1000 });
  t.after(async () => {
    provider.dispose();
    await store.dispose();
    if (options.base === undefined) rmSync(base, { recursive: true, force: true });
  });
  async function connect(pluginId) {
    linkCounter += 1;
    const linkId = `link-${linkCounter}`;
    const caller = who(pluginId);
    await provider.open({ linkId, who: caller, group: GROUP, mode: "call", channel });
    let sequence = 0;
    const call = (method, ...args) => provider.call({ id: `c${linkCounter}-${sequence += 1}`, method, args, who: caller, group: GROUP, linkId });
    call.withId = (id, method, ...args) => provider.call({ id, method, args, who: caller, group: GROUP, linkId });
    call.linkId = linkId;
    return call;
  }
  return { base, clock, store, provider, connect };
}

const refused = (code) => (error) => error.code === code;

test("teamuq.describe reports six features, the limits, dataClass local and no models", async (t) => {
  const { provider, connect } = setup(t);
  const call = await connect("a");
  const { value } = await call("teamuq.describe");
  assert.equal(value.dataClass, "local");
  const [group] = value.groups;
  assert.deepEqual(group.features, ["inspect", "diagnose", "tags", "ttl", "upsert-by-key", "text-query"]);
  assert.deepEqual(group.limits, { maxPayloadChars: 12288, maxRecallLimit: 50, maxForgetIds: 100 });
  assert.deepEqual(group.methods, ["remember", "recall", "forget", "inspect", "diagnose"]);
  assert.deepEqual(group.models, []);
  assert.equal("defaultModelId" in group, false);
  assert.deepEqual((await call("teamuq.availability")).value, { state: "ready" });
  assert.deepEqual(Object.keys(provider.categories()), ["teamuq.memory@1"]);
  await assert.rejects(call("teamuq.jobs.list"), refused("not_supported"));
  await assert.rejects(call("submit", {}), refused("not_supported"));
});

test("remember, recall by tags (AND), ids (OR) and text, ordering and upsert by key", async (t) => {
  const { clock, connect } = setup(t);
  const call = await connect("a");
  const first = await call("remember", { payload: { text: "alpha cat" }, tags: ["x", "y"] });
  assert.equal(first.value.created, true);
  clock.now += 10;
  const second = await call("remember", { payload: { text: "beta cat cat" }, tags: ["x"] });
  clock.now += 10;
  const keyed = await call("remember", { payload: "gamma", key: "fixed" });
  assert.equal(keyed.value.id, "fixed");
  clock.now += 10;
  const again = await call("remember", { payload: "gamma two", key: "fixed", tags: ["z"] });
  assert.deepEqual(again.value, { id: "fixed", created: false });

  const everything = (await call("recall", { limit: 10 })).value.items;
  assert.deepEqual(everything.map((item) => item.id), ["fixed", second.value.id, first.value.id]);
  assert.equal(everything[0].payload, "gamma two");
  assert.deepEqual(everything[0].tags, ["z"]);
  assert.deepEqual((await call("recall", { limit: 10, tags: ["x", "y"] })).value.items.map((item) => item.id), [first.value.id]);
  assert.deepEqual((await call("recall", { limit: 10, tags: ["x"] })).value.items.length, 2);
  assert.deepEqual((await call("recall", { limit: 10, ids: [first.value.id, "fixed", "none"] })).value.items.map((item) => item.id).sort(), [first.value.id, "fixed"].sort());
  const byText = (await call("recall", { limit: 10, query: "CAT" })).value.items;
  assert.deepEqual(byText.map((item) => item.id), [second.value.id, first.value.id]);
  assert.ok(byText[0].score > byText[1].score && byText[0].score <= 1);
  assert.equal((await call("recall", { limit: 10, query: "absent" })).value.items.length, 0);
});

test("two sources cannot see each other and forget all clears only the caller", async (t) => {
  const { connect } = setup(t);
  const a = await connect("a");
  const b = await connect("b");
  await a("remember", { payload: "from a", key: "k" });
  await b("remember", { payload: "from b", key: "k" });
  assert.equal((await a("recall", { limit: 5 })).value.items[0].payload, "from a");
  assert.equal((await b("recall", { limit: 5 })).value.items[0].payload, "from b");
  assert.deepEqual((await a("forget", { all: true })).value, { forgotten: 1 });
  assert.equal((await a("recall", { limit: 5 })).value.items.length, 0);
  assert.equal((await b("recall", { limit: 5 })).value.items.length, 1);
  assert.deepEqual((await b("forget", { ids: ["nothing"] })).value, { forgotten: 0 });
  const core = await connect(undefined);
  assert.equal((await core("recall", { limit: 5 })).value.items.length, 0);
});

test("forget takes exactly one selector and tags need AND semantics", async (t) => {
  const { connect } = setup(t);
  const call = await connect("a");
  await call("remember", { payload: 1, key: "one", tags: ["t", "u"] });
  await call("remember", { payload: 2, key: "two", tags: ["t"] });
  for (const bad of [{}, { ids: [] }, { tags: [] }, { all: false }, { ids: ["one"], all: true }, { ids: ["a", "a"] }, { other: 1 }]) {
    await assert.rejects(call("forget", bad), refused("capability_request_invalid"), JSON.stringify(bad));
  }
  assert.deepEqual((await call("forget", { tags: ["t", "u"] })).value, { forgotten: 1 });
  assert.deepEqual((await call("forget", { ids: ["two", "missing"] })).value, { forgotten: 1 });
});

test("identity fields and unknown fields are refused", async (t) => {
  const { connect } = setup(t);
  const call = await connect("a");
  for (const extra of [{ agentId: "x" }, { projectId: "p" }, { actor: {} }, { scope: "project" }, { source: "plugin:b" }]) {
    await assert.rejects(call("remember", { payload: 1, ...extra }), refused("capability_request_invalid"));
    await assert.rejects(call("recall", { limit: 1, ...extra }), refused("capability_request_invalid"));
    await assert.rejects(call("forget", { all: true, ...extra }), refused("capability_request_invalid"));
  }
  await assert.rejects(call("remember"), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: 1 }, { payload: 2 }), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: null }), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: 1, key: "a\u0001b" }), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: 1, tags: ["a", "a"] }), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: 1, ttlSec: 0 }), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: 1, ttlSec: 1.5 }), refused("capability_request_invalid"));
  await assert.rejects(call("remember", { payload: "x".repeat(12300) }), refused("capability_request_invalid"));
});

test("recall limit must be an integer from 1 to 50", async (t) => {
  const { connect } = setup(t);
  const call = await connect("a");
  for (const limit of [undefined, 0, 51, 1.5, "3", null, -1]) {
    await assert.rejects(call("recall", limit === undefined ? {} : { limit }), refused("capability_request_invalid"), String(limit));
  }
  assert.equal((await call("recall", { limit: 1 })).value.items.length, 0);
  assert.equal((await call("recall", { limit: 50 })).value.items.length, 0);
});

test("a non-string query and an invalid cursor are unsupported_options", async (t) => {
  const { connect } = setup(t);
  const call = await connect("a");
  await call("remember", { payload: "x" });
  for (const query of [5, { a: 1 }, ["x"], null, true]) await assert.rejects(call("recall", { limit: 5, query }), refused("unsupported_options"));
  for (const cursor of ["nonsense", "c1.0000000000000000", "c999999.0123456789abcdef"]) await assert.rejects(call("recall", { limit: 5, cursor }), refused("unsupported_options"), cursor);
  await assert.rejects(call("recall", { limit: 5, cursor: "" }), refused("capability_request_invalid"));
  await assert.rejects(call("recall", { limit: 5, cursor: "c".repeat(300) }), refused("capability_request_invalid"));
});

test("a CJK-heavy recall stays under 65536 UTF-16 units and paging returns each item once", async (t) => {
  const { clock, connect } = setup(t);
  const call = await connect("a");
  const ids = [];
  for (let index = 0; index < 12; index += 1) {
    clock.now += 1;
    const payload = { text: "記".repeat(5000 + index), note: `n${index}` };
    ids.push((await call("remember", { payload, key: `k${String(index).padStart(2, "0")}` })).value.id);
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const { value } = await call("recall", { limit: 50, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(JSON.stringify(value).length <= 65536, `page ${pages} is ${JSON.stringify(value).length}`);
    assert.ok(value.items.length >= 1);
    if (value.nextCursor !== undefined) assert.ok(value.nextCursor.length <= 64);
    seen.push(...value.items.map((item) => item.id));
    cursor = value.nextCursor;
    pages += 1;
  } while (cursor !== undefined && pages < 30);
  assert.ok(pages > 1);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test("a long query keeps a valid next-page cursor", async (t) => {
  const { clock, connect } = setup(t);
  const call = await connect("a");
  const needle = "long ".repeat(80);
  for (let index = 0; index < 5; index += 1) {
    clock.now += 1;
    await call("remember", { payload: { text: `${needle}${index}` } });
  }
  const first = (await call("recall", { limit: 2, query: needle.trim() })).value;
  assert.equal(first.items.length, 2);
  assert.ok(Buffer.byteLength(first.nextCursor) <= 64);
  const second = (await call("recall", { limit: 2, query: needle.trim(), cursor: first.nextCursor })).value;
  assert.equal(second.items.length, 2);
  await assert.rejects(call("recall", { limit: 2, query: "other", cursor: first.nextCursor }), refused("unsupported_options"));
});

test("ttl hides an item after its time and a rewrite without ttl keeps it forever", async (t) => {
  const { clock, connect } = setup(t);
  const call = await connect("a");
  await call("remember", { payload: "short", key: "s", ttlSec: 10 });
  await call("remember", { payload: "kept", key: "r", ttlSec: 10 });
  clock.now += 9_999;
  assert.equal((await call("recall", { limit: 10 })).value.items.length, 2);
  await call("remember", { payload: "kept forever", key: "r" });
  clock.now += 2;
  const left = (await call("recall", { limit: 10 })).value.items;
  assert.deepEqual(left.map((item) => item.id), ["r"]);
  assert.equal((await call("inspect")).value.summary.count, 1);
});

test("a resend inside 60 seconds returns the cached outcome and later or different ones do not", async (t) => {
  const { clock, connect } = setup(t);
  const call = await connect("a");
  const args = { payload: "once" };
  const first = await call.withId("same", "remember", args);
  clock.now += 59_999;
  assert.deepEqual(await call.withId("same", "remember", args), first);
  assert.equal((await call("recall", { limit: 10 })).value.items.length, 1);
  await assert.rejects(call.withId("same", "remember", { payload: "different" }), refused("capability_request_invalid"));
  clock.now += 2;
  const third = await call.withId("same", "remember", args);
  assert.notEqual(third.value.id, first.value.id);
  assert.equal((await call("recall", { limit: 10 })).value.items.length, 2);
  await assert.rejects(call.withId("bad", "remember", { payload: "x", ttlSec: 0 }), refused("capability_request_invalid"));
  await assert.rejects(call.withId("bad", "remember", { payload: "x", ttlSec: 0 }), refused("capability_request_invalid"));
  assert.deepEqual((await call.withId("bad", "remember", { payload: "x" })).value.created, true);
});

test("closing the link drops its resend cache", async (t) => {
  const { provider, connect } = setup(t);
  const call = await connect("a");
  const args = { payload: "once" };
  const first = await call.withId("same", "remember", args);
  provider.closed(call.linkId, "closed");
  const next = await connect("a");
  const second = await next.withId("same", "remember", args);
  assert.notEqual(second.value.id, first.value.id);
});

test("inspect and diagnose describe only the caller and diagnose is well formed", async (t) => {
  const { connect } = setup(t);
  const a = await connect("a");
  const b = await connect("b");
  assert.deepEqual((await a("diagnose")).value, { ok: true, checks: [{ name: "store", ok: true, note: "尚無資料" }, { name: "quota", ok: true, note: "已用 0／2000 筆" }] });
  assert.deepEqual((await a("inspect")).value, { summary: { count: 0, sizeBytes: 0 }, details: { limits: { items: 2000, bytes: 2097152 } } });
  await a("remember", { payload: { v: 1 }, key: "k" });
  await b("remember", { payload: "bb" });
  const inspected = (await a("inspect", { limit: 5 })).value.summary;
  assert.equal(inspected.count, 1);
  assert.equal(inspected.sizeBytes, Buffer.byteLength(JSON.stringify({ v: 1 })));
  assert.equal(typeof inspected.updatedAtMs, "number");
  await assert.rejects(a("inspect", { cursor: "c" }), refused("unsupported_options"));
  await assert.rejects(a("inspect", { limit: 0 }), refused("capability_request_invalid"));
  const report = (await a("diagnose")).value;
  assert.equal(report.ok, report.checks.every((check) => check.ok));
  for (const check of report.checks) {
    assert.match(check.name, /^[a-z0-9_-]{1,48}$/u);
    assert.ok(check.note.length <= 160);
  }
  assert.equal(report.checks[0].note, "可讀寫");
  await assert.rejects(a("diagnose", {}), refused("capability_request_invalid"));
});

test("quota and storage failures surface as the standard codes without leaking content", async (t) => {
  const { connect } = setup(t, { limits: { items: 2, bytes: 100_000, sources: 1 } });
  const a = await connect("a");
  await a("remember", { payload: 1 });
  await a("remember", { payload: 2 });
  await assert.rejects(a("remember", { payload: 3 }), refused("quota_exceeded"));
  const b = await connect("b");
  await assert.rejects(b("remember", { payload: "secret-canary" }), (error) => error.code === "quota_exceeded" && !error.message.includes("secret-canary"));
  assert.equal((await a("diagnose")).value.ok, false);
});

test("a corrupt partition makes every method of that source provider_error and leaves others alone", async (t) => {
  const first = setup(t);
  const a = await first.connect("a");
  const b = await first.connect("b");
  await a("remember", { payload: 1 });
  await b("remember", { payload: 2 });
  const file = join(first.base, "memory-link-v1", `${createHash("sha256").update("plugin:a").digest("hex")}.json`);
  const bytes = "{broken";
  writeFileSync(file, bytes);
  const second = setup(t, { base: first.base });
  const again = await second.connect("a");
  for (const [method, body] of [["remember", { payload: 1 }], ["recall", { limit: 1 }], ["forget", { all: true }], ["inspect"]]) {
    await assert.rejects(again(method, ...(body === undefined ? [] : [body])), (error) => error.code === "provider_error" && !error.message.includes("broken"), method);
  }
  const report = (await again("diagnose")).value;
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks[0], { name: "store", ok: false, note: "資料檔無法讀取，已保留原檔" });
  assert.equal(readFileSync(file, "utf8"), bytes);
  const other = await second.connect("b");
  assert.equal((await other("recall", { limit: 5 })).value.items.length, 1);
});

test("hooks can shrink the advertised features and methods", async (t) => {
  const { connect } = setup(t, { group: { features: ["inspect"], methods: ["remember", "recall", "forget"], maxPayloadChars: 4096 } });
  const call = await connect("a");
  const { value } = await call("teamuq.describe");
  assert.deepEqual(value.groups[0].features, ["inspect"]);
  assert.deepEqual(value.groups[0].methods, ["remember", "recall", "forget"]);
  assert.equal(value.groups[0].limits.maxPayloadChars, 4096);
  for (const body of [{ payload: 1, tags: ["a"] }, { payload: 1, ttlSec: 5 }, { payload: 1, key: "k" }, { payload: "x".repeat(4100) }]) {
    await assert.rejects(call("remember", body), refused("unsupported_options"), JSON.stringify(body));
  }
  await assert.rejects(call("recall", { limit: 5, tags: ["a"] }), refused("unsupported_options"));
  await assert.rejects(call("recall", { limit: 5, query: "a" }), refused("unsupported_options"));
  await assert.rejects(call("forget", { tags: ["a"] }), refused("unsupported_options"));
  await assert.rejects(call("diagnose"), refused("not_supported"));
});

test("a session-mode open is unsupported and releases its slot", async (t) => {
  const { provider } = setup(t, { maxSessions: 1 });
  await assert.rejects(provider.open({ linkId: "sess", who: who("a"), group: GROUP, mode: "session", channel }), refused("unsupported_options"));
  await provider.open({ linkId: "after", who: who("a"), group: GROUP, mode: "call", channel });
});

test("connection slots, call rate and unknown groups use the standard refusals", async (t) => {
  const { provider, connect } = setup(t, { maxSessions: 1, rate: 1, burst: 2 });
  const call = await connect("a");
  await assert.rejects(provider.open({ linkId: "second", who: who("a"), group: GROUP, mode: "call", channel }), refused("capability_busy"));
  await assert.rejects(provider.open({ linkId: "other", who: who("a"), group: { id: "nope" }, mode: "call", channel }), refused("unsupported_options"));
  await call("recall", { limit: 1 });
  await call("recall", { limit: 1 });
  await assert.rejects(call("recall", { limit: 1 }), refused("rate_limited"));
  await assert.rejects(provider.call({ id: "x", method: "recall", args: [{ limit: 1 }], who: who("a"), group: null, linkId: call.linkId }), refused("capability_request_invalid"));
});

test("nothing from payload, query or tags reaches the console, stdio or files outside the store", async (t) => {
  const canary = "CANARY-7f3a91";
  const captured = [];
  const originals = {};
  for (const name of ["log", "info", "warn", "error", "debug"]) {
    originals[name] = console[name];
    console[name] = (...parts) => captured.push(parts.map(String).join(" "));
  }
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return stdout("", ...rest.filter((entry) => typeof entry === "function")); };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return stderr("", ...rest.filter((entry) => typeof entry === "function")); };
  const restore = () => {
    for (const name of Object.keys(originals)) console[name] = originals[name];
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
  const { base, connect } = setup(t);
  try {
    const call = await connect(canary);
    await call("remember", { payload: { text: canary }, key: canary, tags: [canary], ttlSec: 5 });
    await call("recall", { limit: 3, query: canary, tags: [canary], ids: [canary] });
    await call("inspect");
    await call("diagnose");
    await assert.rejects(call("recall", { limit: 3, query: 5, tags: [canary] }));
    await assert.rejects(call("remember", { payload: canary, bogus: canary }));
    await call("forget", { tags: [canary] });
  } finally {
    restore();
  }
  assert.deepEqual(captured.filter((line) => line.includes(canary)), []);
  const outside = readdirSync(base).filter((name) => name !== "memory-link-v1");
  for (const name of outside) {
    const path = join(base, name);
    if (statSync(path).isFile()) assert.equal(readFileSync(path, "utf8").includes(canary), false);
  }
});

test("calls that finish without waiting never count as in progress, so a burst larger than maxSessions is served", async (t) => {
  const { connect } = setup(t, { maxSessions: 4 });
  const call = await connect("a");
  await call("remember", { payload: "x", key: "k" });
  const answers = await Promise.all(Array.from({ length: 20 }, () => call("recall", { limit: 1 })));
  assert.ok(answers.every((answer) => answer.value.items.length === 1));
  const mixed = await Promise.all([call("inspect"), call("diagnose"), call("recall", { limit: 1 }), call("teamuq.describe"), call("inspect")]);
  assert.equal(mixed.length, 5);
});

test("a call that is still waiting does count against maxSessions", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-link-hold-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const store = createLinkStore({ dataDir: base });
  t.after(() => store.dispose());
  const held = [];
  const group = createMemoryStoreGroup({ store });
  const provider = createProvider({ category: "teamuq.memory@1", dataClass: "local", maxSessions: 1, modules: [group], probe: { beforeCall: () => new Promise((resolve) => held.push(resolve)) } });
  t.after(() => provider.dispose());
  await provider.open({ linkId: "h", who: who("a"), group: GROUP, mode: "call", channel });
  const send = (id) => provider.call({ id, method: "recall", args: [{ limit: 1 }], who: who("a"), group: GROUP, linkId: "h" });
  const first = send("1");
  await assert.rejects(send("2"), refused("capability_busy"));
  held[0]();
  assert.deepEqual((await first).value, { items: [] });
});
