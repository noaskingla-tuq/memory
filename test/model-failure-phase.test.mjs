import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { dispatchUi } from "../out/backend/uiDispatch.js";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { ui } from "./homeFixtures.mjs";

function punch(id) {
  const now = Date.now();
  return {
    id, agentId: "sw/phase-test", projectId: "phase-project", sessionId: "source-session", providerId: "mock", model: "allowed",
    punchType: "main", startedAtMs: now - 500_000, endedAtMs: now - 200_000,
    name: "Synthetic phase request", description: "Synthetic phase result.",
  };
}

function modelAi({ replyText = '{"items":[]}', waitForReply = false } = {}) {
  let listener;
  let sends = 0;
  const session = {
    sessionId: "phase-test-session", effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
    onEvent(next) { listener = next; return () => { listener = undefined; }; },
    async send() {
      sends++;
      if (waitForReply) return { turnId: "phase-test-turn" };
      session.turn = { turnId: "phase-test-turn", text: replyText, terminal: { kind: "completed" } };
      listener?.({ turnId: "phase-test-turn", kind: "textDelta", text: replyText });
      listener?.({ turnId: "phase-test-turn", kind: "contentSaved", sequenceNo: sends });
      listener?.({ turnId: "phase-test-turn", kind: "completed" });
      return { turnId: "phase-test-turn" };
    },
    async close() {},
    async interrupt() {},
  };
  return {
    get sends() { return sends; },
    api: {
      async getOptions() {
        return {
          providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }],
          defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" },
          limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 },
        };
      },
      async openSession() { return session; },
    },
  };
}

async function runOrganizationPhase(t, { name, replyText, waitForReply = false, failReplyCheckpoint = false, storageFailure = false }) {
  const dir = mkdtempSync(join(tmpdir(), "memory-phase-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const actor = { agentId: "sw/phase-test", projectId: "phase-project", sessionId: "source-session", providerId: "mock" };
  const app = storageFailure
    ? new MemoryApplication({
        async withCore(_agentId, work) {
          return work({ async capture() { return { ok: false, error: { code: "storage_error", retryable: false } }; } });
        },
        async close() {},
      })
    : new MemoryApplication(new CoreHandlePool({
        layout: new CairnDataLayout(join(dir, "memory-cairn-v1")),
        openCore: (path) => openCairnCore(path, { agentId: actor.agentId, port }),
      }));
  const baseStore = createLocalPunchOrganizationStore(dir);
  let allowReplyWrite = failReplyCheckpoint;
  const store = failReplyCheckpoint ? {
    ...baseStore,
    async transactResumeState(update) {
      return baseStore.transactResumeState((state) => {
        const next = update(state);
        const containsReply = Object.values(next.operations).some((operation) => Object.values(operation.calls).some((call) => call.phase === "reply_ready"));
        if (allowReplyWrite && containsReply) {
          allowReplyWrite = false;
          throw new Error("synthetic reply checkpoint write failure");
        }
        return next;
      });
    },
  } : baseStore;
  const model = storageFailure ? null : modelAi({ replyText, waitForReply });
  const port = storageFailure ? null : createHostMemoryModelPort(model.api, () => readOrganizationSettings({ organizationEnabled: true }), undefined, store);
  const worker = createPunchOrganizationWorker({
    store,
    enabled: () => true,
    frequency: () => "immediate",
    now: () => Date.now(),
    capture: async (job) => app.execute("memory_capture", job.input, job.actor, undefined, job.allowModelSend ?? true),
  });
  await worker.enqueue(punch(name), "synthetic-raw-memory");
  // why: the 30 second limit belongs to Cairn and is a real timer there, so the waiting case fires it on a mocked clock instead of waiting
  if (waitForReply) mock.timers.enable({ apis: ["setTimeout"] });
  try {
    worker.start();
    if (waitForReply) {
      while ((model?.sends ?? 1) < 1) await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(30_000);
    }
    await worker.idle();
  } finally { mock.timers.reset(); }
  const row = (await baseStore.readPage(null, 100)).records.find((entry) => entry.key === name)?.value;
  const organizationStatus = worker.status();
  const uiStatus = await dispatchUi("ui.status", {}, {
    storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, organizationStatus: () => organizationStatus,
  });
  const target = { innerHTML: "", dataset: {} };
  const line = ui.createStatusLine({
    client: { async call() { return { ok: true, value: uiStatus }; } }, target, now: () => Date.now(),
    scheduler: { set: () => 1, clear: () => undefined },
    visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  line.start();
  await new Promise((resolve) => setImmediate(resolve));
  line.stop();
  await worker.stop();
  await port?.cancel();
  await app.close();
  return { row, organizationStatus, uiStatus, rendered: target.innerHTML, sends: model?.sends ?? 0 };
}

test("organization status preserves distinct redacted model, schema, journal, timeout, and Cairn storage phases", { timeout: 10_000 }, async (t) => {
  const malformed = await runOrganizationPhase(t, { name: "malformed", replyText: "not JSON" });
  const schemaRejected = await runOrganizationPhase(t, { name: "schema", replyText: '{"items":[{}]}' });
  const checkpoint = await runOrganizationPhase(t, { name: "checkpoint", failReplyCheckpoint: true });
  const timeout = await runOrganizationPhase(t, { name: "timeout", waitForReply: true });
  const storage = await runOrganizationPhase(t, { name: "storage", storageFailure: true });

  for (const [entry, phase] of [
    [malformed, "reply_contract"], [schemaRejected, "cairn_schema"], [checkpoint, "state"], [timeout, "turn_timeout"], [storage, "commit"],
  ]) {
    assert.equal(entry.row.errorPhase, phase, JSON.stringify(entry.row));
    assert.equal(entry.organizationStatus.errorPhase, phase, "worker.status keeps the semantic failure phase");
    assert.equal(entry.uiStatus.organization.errorPhase, phase, "backend ui.status preserves the worker phase");
    assert.ok(entry.rendered.includes(`<dd>${phase}</dd>`), "statusLine renders the semantic phase");
  }
  assert.deepEqual([malformed, schemaRejected, checkpoint, timeout].map((entry) => entry.sends), [1, 1, 1, 1]);
  assert.equal(storage.sends, 0);
  assert.ok([malformed, schemaRejected, checkpoint, timeout, storage].every((entry) => entry.row.lastError !== null));
});
