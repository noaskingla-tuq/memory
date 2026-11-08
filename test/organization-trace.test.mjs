import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { TRACE_FILE, TRACE_MAX_BYTES, createOrganizationTrace, sanitizeTraceEntry } from "../out/adapters/storage/organizationTrace.js";
import { createBackend } from "../out/backend/service.js";
import { catchupEntry, createCatchupTrace, startupEntry } from "../out/backend/traceWiring.js";
import { REPLY, actorOf, callRecord, invokeScoped, recoverAi, seed, sessionRecord, settings, tempStore } from "./recoverHarness.mjs";

const PIN_PATH = resolve(fileURLToPath(new URL("../cairn-pin.json", import.meta.url)));
const ticks = async (count = 30) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const linesOf = (dir, name = TRACE_FILE) => readFileSync(join(dir, name), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
const SECRET_PROMPT = "SECRET-PROMPT-zebra please remember C:\\Users\\david\\private\\notes.txt";
const SECRET_REPLY = "SECRET-REPLY-giraffe";

test("an entry keeps only the metadata fields of its kind, and a free string is never written", () => {
  assert.equal(TRACE_MAX_BYTES, 1_048_576);
  const clean = sanitizeTraceEntry({
    kind: "turn", turnId: "t-1", sentAt: 12.9, resumed: false, deltas: 3, settle: "seq", settledAt: 400, endedAt: 410,
    events: [["started", 5], ["textDelta", 9]], prompt: SECRET_PROMPT, payload: "x", path: "C:\\Users\\david\\x",
  });
  assert.deepEqual(Object.keys(clean).sort(), ["deltas", "endedAt", "events", "kind", "resumed", "sentAt", "settle", "settledAt", "turnId"]);
  assert.equal(clean.sentAt, 12);
  assert.equal(sanitizeTraceEntry({ kind: "turn", turnId: SECRET_PROMPT }).turnId, "invalid", "a prompt-like value is replaced");
  assert.equal(sanitizeTraceEntry({ kind: "turn", turnId: "C:\\Users\\david\\x" }).turnId, "invalid", "a path is replaced");
  assert.equal(sanitizeTraceEntry({ kind: "turn", turnId: "/home/david/x" }).turnId, "invalid");
  assert.equal(sanitizeTraceEntry({ kind: "catchup", phase: "end", stoppedCode: "writer_unavailable", agentId: "sw/a" }).agentId, undefined);
  assert.equal(sanitizeTraceEntry({ kind: "turn", events: Array.from({ length: 500 }, () => ["textDelta", 1]) }).events.length, 64);
});

test("the log has a size cap and keeps at most two files: the current one and one rotated", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-trace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = createOrganizationTrace({ dir, maxBytes: 2_000, now: () => 1_700_000_000_000 });
  for (let i = 0; i < 200; i += 1) trace.write({ kind: "turn", turnId: "turn-" + i, sentAt: i, resumed: false, events: [["started", 1], ["textDelta", 2], ["completed", 3]], deltas: 4, settle: "seq", settledAt: 5, endedAt: 6 });
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [TRACE_FILE, TRACE_FILE + ".1"], "never a third file");
  for (const name of files) assert.ok(statSync(join(dir, name)).size <= 2_000, name + " is over the cap");
  const current = linesOf(dir);
  const rotated = linesOf(dir, TRACE_FILE + ".1");
  assert.equal(current.at(-1).turnId, "turn-199", "the newest entry is in the current file");
  assert.ok(rotated.length > 0 && current.length + rotated.length < 200, "older entries were dropped, not kept for ever");
  assert.ok(rotated.at(-1).turnId < current[0].turnId || Number(rotated.at(-1).turnId.slice(5)) < Number(current[0].turnId.slice(5)));
  assert.ok(current.every((entry) => typeof entry.t === "string"));
});

test("a symlink at the log path is refused and its target is left alone; an unwritable directory loses the entry without throwing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-trace-link-"));
  const outside = mkdtempSync(join(tmpdir(), "memory-trace-out-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const target = join(outside, "victim.txt");
  writeFileSync(target, "keep");
  try { symlinkSync(target, join(dir, TRACE_FILE), "file"); }
  catch (error) { t.skip("this machine cannot create a symlink: " + error.code); return; }
  const trace = createOrganizationTrace({ dir });
  trace.write({ kind: "startup", state: "waiting" });
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.doesNotThrow(() => createOrganizationTrace({ dir: join(dir, "missing", "deeper") }).write({ kind: "startup", state: "waiting" }));
  const folder = mkdtempSync(join(tmpdir(), "memory-trace-dir-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, TRACE_FILE));
  assert.doesNotThrow(() => createOrganizationTrace({ dir: folder }).write({ kind: "startup", state: "waiting" }));
  assert.deepEqual(readdirSync(folder), [TRACE_FILE], "a directory at the log path is not replaced either");
});

test("no source file reads the log back: the module only appends and renames, and nothing else names the file", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  const module = join(root, "adapters", "storage", "organizationTrace.ts");
  const users = walk(root).filter((file) => file.endsWith(".ts") && file !== module && /organization-trace|TRACE_FILE|organizationTrace/u.test(readFileSync(file, "utf8")));
  for (const file of users) assert.equal(/TRACE_FILE|organization-trace.log/u.test(readFileSync(file, "utf8")), false, file + " names the log file itself");
  const own = readFileSync(module, "utf8");
  assert.equal(/readFile|createReadStream|readSync|readdir|openSync/u.test(own), false, "the module has no read path");
  assert.deepEqual(users.map((file) => file.slice(root.length + 1).replaceAll("\\", "/")).sort(), ["adapters/model/hostMemoryModelPort.ts", "adapters/model/turnTrace.ts", "adapters/model/turnTracker.ts", "backend/service.ts", "backend/traceWiring.ts"]);
});

function liveHost(t, script) {
  const { dir, store } = tempStore(t, "memory-trace-turn-");
  const host = recoverAi();
  const sessions = [];
  const state = { sent: 0 };
  host.ai.openSession = async () => {
    const session = host.make("live-" + (sessions.length + 1), null);
    session.send = async () => {
      state.sent += 1;
      const turnId = session.sessionId + "-turn-" + state.sent;
      setImmediate(() => script(session, turnId));
      return { turnId };
    };
    sessions.push(session);
    return session;
  };
  const port = createHostMemoryModelPort(host.ai, settings, undefined, store, undefined, { graceMs: 40, backstopMs: 250 }, createOrganizationTrace({ dir }));
  t.after(() => port.cancel());
  return { dir, port, state, actor: actorOf("sw/a") };
}

const reply = JSON.stringify({ items: [], note: SECRET_REPLY });
const events = (entry) => entry.events.map((row) => row[0]);

test("a turn is traced with its event kinds, delta count and how it settled, and the trace holds no prompt, reply or path", async (t) => {
  const rig = liveHost(t, (session, turnId) => {
    session.emit({ turnId, kind: "started" });
    for (const piece of [reply.slice(0, 10), reply.slice(10, 20), reply.slice(20)]) session.emit({ turnId, kind: "textDelta", text: piece });
    session.emit({ turnId, kind: "contentSaved", sequenceNo: 1 });
    session.emit({ turnId, kind: "completed" });
  });
  const value = await invokeScoped(rig.port, rig.actor, "organize:trace-a", { value: SECRET_PROMPT });
  assert.equal(value.note, SECRET_REPLY);
  await ticks();
  const [entry] = linesOf(rig.dir);
  assert.equal(entry.kind, "turn");
  assert.match(entry.turnId, /^live-1-turn-1$/u);
  assert.equal(typeof entry.sentAt, "number");
  assert.deepEqual(events(entry), ["started", "textDelta", "contentSaved", "completed"]);
  assert.equal(entry.deltas, 3);
  assert.equal(entry.settle, "seq");
  assert.ok(entry.events.every((row) => Number.isInteger(row[1]) && row[1] >= 0));
  const raw = readFileSync(join(rig.dir, TRACE_FILE), "utf8");
  for (const forbidden of ["SECRET-PROMPT", "SECRET-REPLY", "zebra", "giraffe", "private", "notes.txt", "sw/a", rig.dir, "Users"]) assert.equal(raw.includes(forbidden), false, forbidden);
});

test("settlement is traced as grace when contentSaved never comes, as backstop when the host never ends the turn, and as cancel on a hard stop", async (t) => {
  const grace = liveHost(t, (session, turnId) => {
    session.emit({ turnId, kind: "textDelta", text: reply });
    session.emit({ turnId, kind: "completed" });
  });
  await invokeScoped(grace.port, grace.actor, "organize:trace-grace", { value: 1 });
  assert.equal(linesOf(grace.dir)[0].settle, "grace");
  assert.deepEqual(events(linesOf(grace.dir)[0]), ["textDelta", "completed"]);

  const stuck = liveHost(t, (session, turnId) => session.emit({ turnId, kind: "started" }));
  await assert.rejects(invokeScoped(stuck.port, stuck.actor, "organize:trace-stuck", { value: 1 }));
  await pause(60);
  const backstop = linesOf(stuck.dir)[0];
  assert.equal(backstop.settle, "backstop");
  assert.ok(backstop.settledAt >= 200, "settled at the backstop, " + backstop.settledAt + " ms after the send");

  const hard = liveHost(t, (session, turnId) => session.emit({ turnId, kind: "started" }));
  const call = invokeScoped(hard.port, hard.actor, "organize:trace-hard", { value: 1 }).then(() => null, (error) => error);
  await ticks();
  hard.port.interrupt();
  await call;
  await pause(30);
  assert.equal(linesOf(hard.dir)[0].settle, "cancel");

  const failed = liveHost(t, (session, turnId) => session.emit({ turnId, kind: "failed", code: "provider_error", retryable: true, partialDelivered: false }));
  await assert.rejects(invokeScoped(failed.port, failed.actor, "organize:trace-failed", { value: 1 }));
  assert.equal(linesOf(failed.dir)[0].settle, "failed");
  assert.deepEqual(events(linesOf(failed.dir)[0]), ["failed"]);
});

test("a resumed turn is traced as resumed", async (t) => {
  const { dir, store } = tempStore(t, "memory-trace-resume-");
  const actor = actorOf("sw/a");
  const operation = "organize:trace-resume";
  const holder = {};
  const host = recoverAi({ resume: (id, make) => { holder.session = Object.freeze(make(id, { turnId: "turn-old", text: '{"items":', terminal: null })); return holder.session; } });
  await seed(store, { sessions: [sessionRecord(actor, "host-old")], calls: [await callRecord(actor, operation, {})] });
  const port = createHostMemoryModelPort(host.ai, settings, undefined, store, undefined, { graceMs: 30, backstopMs: 5000 }, createOrganizationTrace({ dir }));
  t.after(() => port.cancel());
  const outcome = invokeScoped(port, actor, operation);
  await pause(50);
  holder.session.emit({ turnId: "turn-old", kind: "textDelta", text: "[]}" });
  holder.session.emit({ turnId: "turn-old", kind: "completed" });
  assert.deepEqual(await outcome, REPLY);
  await ticks();
  const [entry] = linesOf(dir);
  assert.equal(entry.resumed, true);
  assert.equal(entry.turnId, "turn-old");
});

test("catch-up and start-up entries copy counts and codes only", () => {
  const end = catchupEntry({ event: "punch_catchup", examined: 12, written: 3, deduplicated: 1, pending: 0, complete: true, stoppedCode: null, agentId: "sw/a", path: "C:\\x" });
  assert.deepEqual(Object.keys(sanitizeTraceEntry(end)).sort(), ["complete", "examined", "kind", "pending", "phase", "stoppedCode", "written"]);
  assert.equal(catchupEntry({ event: "punch_subscription_unavailable" }), null);
  assert.deepEqual(catchupEntry({ event: "punch_catchup_start" }), { kind: "catchup", phase: "start" });
  assert.deepEqual(startupEntry({ state: "ready", reason: "cap", waitedMs: 5 }), { kind: "startup", state: "ready", reason: "cap", waitedMs: 5 });
});

test("through the backend: an idle first catch-up round leaves no catch-up lines, the start-up gate is traced, and nothing but metadata is in the file", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "memory-trace-backend-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, nextCursor: null, records: [] }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    ai: { async getOptions() { throw new Error("no model in this test"); } },
  };
  const backend = createBackend({ dataRoot: join(base, "memory-cairn-v1"), pinPath: PIN_PATH, host, settings: { all: () => ({ organizationEnabled: true }), onChange() { return () => {}; } } });
  t.after(() => backend.dispose());
  backend.startWorkers();
  await backend.idleWorkers();
  const rows = linesOf(base);
  const shape = rows.map((row) => row.kind + ":" + (row.phase ?? row.state) + (row.reason === undefined ? "" : ":" + row.reason));
  assert.equal(shape[0], "startup:waiting", shape.join(" "));
  assert.ok(shape.some((entry) => entry.startsWith("startup:ready")), "the gate change is traced: " + shape.join(" "));
  assert.deepEqual(rows.filter((row) => row.kind === "catchup"), [], "an idle round writes neither its start nor its end: " + shape.join(" "));
});

test("an idle catch-up round (nothing examined, nothing written, no stop) writes neither start nor end; any other round writes both", () => {
  const rounds = (events) => {
    const written = [];
    const trace = createCatchupTrace({ write: (entry) => written.push(entry) });
    for (const event of events) trace(event);
    return written.map((entry) => entry.phase);
  };
  const start = { event: "punch_catchup_start" };
  const end = (fields) => ({ event: "punch_catchup", complete: true, stoppedCode: null, examined: 0, written: 0, pending: 0, ...fields });
  assert.deepEqual(rounds([start, end({})]), []);
  assert.deepEqual(rounds([start, end({}), start, end({})]), []);
  assert.deepEqual(rounds([start, end({ examined: 4 })]), ["start", "end"]);
  assert.deepEqual(rounds([start, end({ written: 1 })]), ["start", "end"]);
  assert.deepEqual(rounds([start, end({ stoppedCode: "writer_unavailable" })]), ["start", "end"]);
  assert.deepEqual(rounds([start, { event: "punch_catchup_failed", code: "Error" }]), ["start", "failed"]);
  assert.deepEqual(rounds([start, end({}), start, end({ examined: 2 })]), ["start", "end"]);
  assert.doesNotThrow(() => createCatchupTrace(undefined)(start));
});
