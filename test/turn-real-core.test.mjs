import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { operationKey, pairKey } from "../out/application/modelInvocationScope.js";
import { buildPunchSourceMessages, punchOperationId } from "../out/application/punchContent.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { databasePathOf } from "./readerHarness.mjs";

const AGENT = "sw/rv";
const PROJECT = "rv-project";
const settings = () => readOrganizationSettings({ organizationEnabled: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (n) => `Decision number ${n}: every upgrade ${n} is tried on a synthetic copy of the old library first.`;
const punchOf = (n) => ({
  id: "rv-punch-" + n, agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock", model: "allowed", punchType: "main",
  startedAtMs: Date.now() - 500_000, endedAtMs: Date.now() - 200_000, name: "Decide " + n,
  description: JSON.stringify({ root: { children: [{ type: "text", text: text(n) }] } }),
});

// why: this is the shape of the real host: session.turn is a frozen null (the host never fills it), so the reply exists only as textDelta pieces
function frozenCore(opts) {
  const state = { sent: 0 };
  const sessions = [];
  const make = () => {
    let listener;
    const session = Object.freeze({
      sessionId: "s" + (sessions.length + 1), effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send({ text: body }) {
        const envelope = JSON.parse(body);
        state.sent += 1;
        const turnId = "t" + state.sent + "0".repeat(10);
        const n = /Decision number (\d+)/u.exec(JSON.stringify(envelope.input))?.[1];
        const reply = envelope.operation === "extract" && n ? { items: [{ content: text(Number(n)), kind: "decision", confidence: 0.9, sourceIndices: [0] }] }
          : envelope.operation === "classify" ? { items: envelope.input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [] })) } : { items: [] };
        const out = JSON.stringify(reply);
        setImmediate(async () => {
          listener?.({ turnId, kind: "started" });
          const size = Math.ceil(out.length / 5);
          for (let i = 0; i < out.length; i += size) listener?.({ turnId, kind: "textDelta", text: out.slice(i, i + size) });
          if (opts.savedBefore) listener?.({ turnId, kind: "contentSaved", sequenceNo: state.sent });
          listener?.({ turnId, kind: "completed" });
          if (opts.savedAfterMs !== undefined) {
            await pause(opts.savedAfterMs);
            listener?.({ turnId, kind: "contentSaved", sequenceNo: state.sent });
            listener?.({ turnId, kind: "contentSaved", sequenceNo: state.sent });
          }
        });
        return { turnId };
      },
      async close() {}, async interrupt() {},
    });
    sessions.push(session);
    return session;
  };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  return {
    state,
    ai: {
      async getOptions() { return options; },
      async openSession(input) {
        if ("resume" in input) {
          const found = sessions.find((session) => session.sessionId === input.resume);
          if (found === undefined) throw Object.assign(new Error("not found"), { code: "session_not_found" });
          return found;
        }
        return make();
      },
    },
  };
}

function rig(t, opts, limits) {
  const dir = mkdtempSync(join(tmpdir(), "memory-real-core-"));
  const root = join(dir, "memory-cairn-v1");
  const core = frozenCore(opts);
  const store = createLocalPunchOrganizationStore(dir);
  const port = createHostMemoryModelPort(core.ai, settings, undefined, store, undefined, limits);
  const app = new MemoryApplication(new CoreHandlePool({ layout: new CairnDataLayout(root), openCore: (path) => openCairnCore(path, { agentId: AGENT, port }) }));
  t.after(async () => { await port.cancel(); await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const db = () => {
    const database = new DatabaseSync(databasePathOf(root, AGENT), { readOnly: true });
    try { return { claims: database.prepare("SELECT event_id,state FROM admission_claims").all(), memories: database.prepare("SELECT id FROM memories WHERE origin='agent-inferred'").all() }; } finally { database.close(); }
  };
  return { core, store, db, app };
}

const ACTOR = { agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock" };
const inputOf = (n) => {
  const punch = punchOf(n);
  return { scope: "project", operationId: "organize:" + punchOperationId(punch.id), messages: buildPunchSourceMessages(punch) };
};

for (const [name, opts] of [["never", {}], ["before-completed", { savedBefore: true }], ["late-inside-grace", { savedAfterMs: 20 }], ["late-after-grace", { savedAfterMs: 400 }]]) {
  test("frozen null turn, chunked textDelta, contentSaved " + name + ": one admission, a consistent journal, no repeat on the second call", async (t) => {
    const r = rig(t, opts, { graceMs: 150, backstopMs: 60_000 });
    const first = await r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true);
    assert.equal(first.ok, true, JSON.stringify(first));
    await pause(600);
    const again = await r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true);
    assert.equal(again.value.duplicate, true);
    const found = r.db();
    assert.equal(found.claims.length, 1);
    assert.equal(found.memories.length, 1);
    const operation = (await r.store.readResumeState()).operations[operationKey(pairKey(AGENT, PROJECT), inputOf(1).operationId)];
    for (const call of Object.values(operation.calls)) assert.ok(["reply_ready", "committed", "commit_retry"].includes(call.phase), "no call is left sent or failed: " + call.phase);
    assert.ok(r.core.state.sent >= 1);
  });
}

test("frozen null turn: concurrent identical captures admit at most one memory", async (t) => {
  const r = rig(t, {}, { graceMs: 50, backstopMs: 60_000 });
  await Promise.all([1, 2, 3, 4].map(() => r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true)));
  await pause(300);
  const found = r.db();
  assert.ok(found.claims.length <= 1);
  assert.ok(found.memories.length <= 1);
});
