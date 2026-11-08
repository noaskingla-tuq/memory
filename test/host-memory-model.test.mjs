import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { currentMemoryInvocation, legacyModelCallKey, operationKey, pairKey, sha256, withMemoryCaptureScope } from "../out/application/modelInvocationScope.js";

export function mockAi(overrides = {}) {
  const counters = { opened: 0, closed: 0, off: 0, interrupted: 0, sent: 0 };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } };
  let listener;
  const session = {
    sessionId: "mock-session", effective: { providerId: "codex", modelId: "gpt-6-luna" }, turn: null,
    onEvent(next) { listener = next; return () => { counters.off++; listener = undefined; }; },
    async send(input) {
      counters.sent++;
      if (overrides.send) return overrides.send({ session, emit: (event) => listener?.({ turnId: "t", ...event }), input });
      session.turn = { turnId: "t", text: '{"items":[]}', terminal: { kind: "completed" } };
      listener({ turnId: "t", kind: "textDelta", text: '{"items":[]}' });
      listener({ turnId: "t", kind: "contentSaved", sequenceNo: 1 });
      listener({ turnId: "t", kind: "completed" });
      return { turnId: "t" };
    },
    async close() { counters.closed++; },
    async interrupt() { counters.interrupted++; },
  };
  const ai = {
    async getOptions() { return overrides.options ?? options; },
    async openSession(input) { counters.opened++; overrides.open?.(input); return session; },
  };
  return { ai, counters, session, options };
}
const enabled = () => readOrganizationSettings();
const invoke = (port, signal = new AbortController().signal, input = {}) => port.invoke({ agentId: "a", policy: port.resolvePolicy("a"), operation: "extract", system: "JSON please", input, maxOutputTokens: 1024, signal });

async function invokeScoped(port, actor, operationId, operation, system, input) {
  return withMemoryCaptureScope(actor, operationId, async () => {
    const invocation = currentMemoryInvocation(operation, system, input);
    return port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), operation, system, input, maxOutputTokens: 1024, signal: new AbortController().signal, invocation });
  });
}

function durableAi({ holdSends = false } = {}) {
  const counters = { opened: 0, resumes: 0, sent: 0, closed: 0, activeSessions: 0, maxActiveSessions: 0, activeSends: 0, maxInFlight: 0 };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } };
  const sessions = new Map();
  const openInputs = [];
  const sent = [];
  const pendingSends = [];
  const finishSend = (session, listener, envelope, turnId, resolve) => {
    const reply = JSON.stringify({ items: [] });
    session.turn = { turnId, text: reply, terminal: { kind: "completed" } };
    listener?.({ turnId, kind: "textDelta", text: reply });
    listener?.({ turnId, kind: "contentSaved", sequenceNo: Number(turnId.split("-").at(-1)) });
    listener?.({ turnId, kind: "completed" });
    counters.activeSends -= 1;
    resolve({ turnId });
  };
  const createSession = (sessionId) => {
    let listener;
    let turnCount = 0;
    counters.activeSessions += 1;
    counters.maxActiveSessions = Math.max(counters.maxActiveSessions, counters.activeSessions);
    const session = {
      sessionId, closed: false, effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send({ text }) {
        counters.sent += 1;
        counters.activeSends += 1;
        counters.maxInFlight = Math.max(counters.maxInFlight, counters.activeSends);
        turnCount += 1;
        const turnId = sessionId + "-turn-" + turnCount;
        const envelope = JSON.parse(text);
        sent.push(envelope);
        if (holdSends) return await new Promise((resolve) => { pendingSends.push(() => finishSend(session, listener, envelope, turnId, resolve)); });
        return await new Promise((resolve) => finishSend(session, listener, envelope, turnId, resolve));
      },
      async close() { if (!session.closed) { session.closed = true; counters.closed += 1; counters.activeSessions -= 1; } },
      async interrupt() {},
    };
    sessions.set(sessionId, session);
    return session;
  };
  return {
    counters, openInputs, sent, options,
    releaseOne() { pendingSends.shift()?.(); },
    releaseAll() { while (pendingSends.length > 0) pendingSends.shift()?.(); },
    ai: {
      async getOptions() { return options; },
      async openSession(input) {
        openInputs.push(input);
        if ("resume" in input) {
          counters.resumes += 1;
          const session = sessions.get(input.resume);
          if (session === undefined) throw Object.assign(new Error("session not found"), { code: "session_not_found" });
          if (session.closed === true) {
            if (counters.activeSessions >= 1) throw Object.assign(new Error("session limit"), { code: "session_limit" });
            counters.activeSessions += 1;
            counters.maxActiveSessions = Math.max(counters.maxActiveSessions, counters.activeSessions);
            session.closed = false;
          }
          return session;
        }
        if (counters.activeSessions >= 1) throw Object.assign(new Error("session limit"), { code: "session_limit" });
        counters.opened += 1;
        return createSession("session-" + counters.opened);
      },
    },
  };
}

test("host model consumes synchronous early terminal events and closes its session", async () => {
  const h = mockAi();
  const port = createHostMemoryModelPort(h.ai, enabled);
  assert.deepEqual(await invoke(port), { items: [] });
  assert.deepEqual(h.counters, { opened: 1, closed: 1, off: 1, interrupted: 0, sent: 1 });
  await port.cancel();
});
test("host model recovers an already-terminal turn snapshot", async () => {
  const h = mockAi({ send: async ({ session, emit }) => { session.turn = { turnId: "t", text: '{"items":[]}', terminal: { kind: "completed" } }; emit({ kind: "contentSaved", sequenceNo: 4 }); emit({ kind: "completed" }); return { turnId: "t" }; } });
  assert.deepEqual(await invoke(createHostMemoryModelPort(h.ai, enabled)), { items: [] });
  assert.equal(h.counters.closed, 1);
});
test("invalid JSON, oversized UTF-8 and rejected sends clean up listeners and sessions", async () => {
  for (const [reply, code] of [["not json", "MODEL_OUTPUT_INVALID"], [JSON.stringify("測".repeat(6000)), "MODEL_OUTPUT_INVALID"], [null, "RESOURCE_BUSY"]]) {
    const h = mockAi({ send: async ({ emit }) => { if (reply === null) throw new Error("send rejected"); emit({ kind: "textDelta", text: reply }); emit({ kind: "contentSaved", sequenceNo: 4 }); emit({ kind: "completed" }); return { turnId: "t" }; } });
    await assert.rejects(invoke(createHostMemoryModelPort(h.ai, enabled)), { code });
    assert.equal(h.counters.sent, 1, "without a journal a bad reply is final, never retried");
    assert.equal(h.counters.closed, 1);
    assert.equal(h.counters.off, 1);
  }
});
test("a completed event with its output is a reliable reply on its own: contentSaved is optional, and the reply settles after the grace", async () => {
  const h = mockAi({ send: async ({ emit }) => { emit({ kind: "textDelta", text: '{"items":[]}' }); emit({ kind: "completed" }); return { turnId: "t" }; } });
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, undefined, undefined, { graceMs: 30, backstopMs: 60_000 });
  const started = Date.now();
  assert.deepEqual(await invoke(port), { items: [] });
  assert.ok(Date.now() - started >= 25, "it waited the grace for a contentSaved that never came");
  assert.equal(h.counters.sent, 1);
  assert.equal(h.counters.closed, 1);
  assert.equal(h.counters.interrupted, 0);
  await port.cancel();
});
test("abort and disposal interrupt a stalled turn that has no journal to keep a late reply", async () => {
  for (const mode of ["abort", "dispose"]) {
    let sent;
    const started = new Promise((resolve) => { sent = resolve; });
    const h = mockAi({ send: async () => { sent(); return { turnId: "t" }; } });
    const controller = new AbortController();
    const port = createHostMemoryModelPort(h.ai, enabled);
    const call = invoke(port, controller.signal);
    const rejection = assert.rejects(call, { code: "RESOURCE_BUSY" });
    await started;
    if (mode === "abort") controller.abort();
    if (mode === "dispose") await port.cancel();
    await rejection;
    assert.equal(h.counters.interrupted, 1);
    assert.equal(h.counters.closed, 1);
    assert.equal(h.counters.off, 1);
  }
});
test("a late send result stays unknown after abort, blocks exact retry, and releases the host slot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-late-send-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi({ holdSends: true });
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  const callWithSignal = (actor, operationId, signal) => withMemoryCaptureScope(actor, operationId, async () => {
    const input = { value: operationId };
    const invocation = currentMemoryInvocation("extract", "schema", input);
    return port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), operation: "extract", system: "schema", input, maxOutputTokens: 1024, signal, invocation });
  });
  const actorA = { agentId: "sw/a", projectId: "project-a", sessionId: "task", providerId: "mock" };
  const controller = new AbortController();
  const aborted = callWithSignal(actorA, "late-send", controller.signal);
  const rejection = assert.rejects(aborted, { code: "RESOURCE_BUSY" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 1, "the provider send has started before cancellation");
  controller.abort();
  await rejection;

  const key = operationKey(pairKey(actorA.agentId, actorA.projectId), "late-send");
  const beforeLateResult = Object.values((await store.readResumeState()).operations[key].calls)[0];
  assert.equal(beforeLateResult.phase, "send_unknown");
  assert.equal(beforeLateResult.turnId, null);
  assert.equal(beforeLateResult.replyJson, null);
  h.releaseOne();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const afterLateResult = Object.values((await store.readResumeState()).operations[key].calls)[0];
  assert.equal(afterLateResult.phase, "send_unknown", "a late turn ID cannot turn an aborted call into a saved reply");
  assert.equal(afterLateResult.turnId, null);
  assert.equal(afterLateResult.replyJson, null);
  await assert.rejects(callWithSignal(actorA, "late-send", new AbortController().signal), (error) => error.code === "RESOURCE_BUSY" && error.phase === "send_unknown");
  assert.equal(h.counters.sent, 1, "exact retry remains blocked while the host outcome needs reconciliation");

  const actorB = { ...actorA, projectId: "project-b" };
  const nextPair = callWithSignal(actorB, "next-pair", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 2, "a settled late send does not leak the one host slot");
  h.releaseOne();
  assert.deepEqual(await nextPair, { items: [] });
  assert.equal(h.counters.maxActiveSessions, 1);
  await port.cancel();
  assert.equal(h.counters.activeSessions, 0);
});
test("cancellation after prepared persistence exits before send and releases the pair for a safe retry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-cancel-before-send-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baseStore = createLocalPunchOrganizationStore(dir);
  let resolvePrepared;
  const prepared = new Promise((resolve) => { resolvePrepared = resolve; });
  let releasePrepared;
  const preparedGate = new Promise((resolve) => { releasePrepared = resolve; });
  let paused = false;
  const store = {
    ...baseStore,
    async transactResumeState(update) {
      const next = await baseStore.transactResumeState(update);
      const containsPrepared = Object.values(next.operations).some((operation) => Object.values(operation.calls).some((call) => call.phase === "prepared"));
      if (!paused && containsPrepared) {
        paused = true;
        resolvePrepared();
        await preparedGate;
      }
      return next;
    },
  };
  const h = durableAi();
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  const actor = { agentId: "sw/a", projectId: "source", sessionId: "task", providerId: "mock" };
  const controller = new AbortController();
  const operationId = "cancel-before-send";
  const pending = withMemoryCaptureScope(actor, operationId, async () => {
    const invocation = currentMemoryInvocation("extract", "schema", { value: 1 });
    return port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), operation: "extract", system: "schema", input: { value: 1 }, maxOutputTokens: 1024, signal: controller.signal, invocation });
  });
  const rejection = assert.rejects(pending, { code: "RESOURCE_BUSY" });
  await prepared;
  controller.abort();
  releasePrepared();
  await rejection;
  const pair = pairKey(actor.agentId, actor.projectId);
  const key = operationKey(pair, operationId);
  const calls = Object.values((await baseStore.readResumeState()).operations[key].calls);
  assert.equal(h.counters.sent, 0);
  assert.equal(calls[0].phase, "failed");
  assert.equal(calls[0].retryable, true);
  assert.equal(calls[0].partialDelivered, false);

  assert.deepEqual(await invokeScoped(port, actor, operationId, "extract", "schema", { value: 1 }), { items: [] });
  assert.equal(h.counters.sent, 1);
  assert.equal(Object.values((await baseStore.readResumeState()).operations[key].calls).length, 2);
  await port.cancel();
});
test("cancel during discovery and late opening closes any eventual session", async () => {
  let resolveOpen;
  const h = mockAi();
  h.ai.openSession = () => new Promise((resolve) => { resolveOpen = resolve; });
  const port = createHostMemoryModelPort(h.ai, enabled);
  const pending = invoke(port);
  const rejection = assert.rejects(pending, { code: "RESOURCE_BUSY" });
  await new Promise((resolve) => setImmediate(resolve));
  await port.cancel();
  await rejection;
  resolveOpen(h.session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.closed, 1);
  const discovery = createHostMemoryModelPort({ getOptions: () => new Promise(() => {}), openSession: h.ai.openSession }, enabled);
  const stop = new AbortController();
  const hung = assert.rejects(invoke(discovery, stop.signal), { code: "RESOURCE_BUSY", phase: "cancelled" });
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  await hung;
});
test("disabled, denied, unavailable and quota settings avoid provider sends", async () => {
  for (const [values, mutate, code] of [
    [{ organizationEnabled: false }, () => {}, "MODEL_NOT_CONFIGURED"],
    [{ organizationEnabled: true, organizationModel: "gpt-astra" }, (options) => options.providers[0].models.push({ id: "gpt-astra" }), "MODEL_NOT_CONFIGURED"],
    [{ organizationEnabled: true }, (options) => { options.quota.state = "exhausted"; }, "RESOURCE_BUSY"],
    [{ organizationEnabled: true }, (options) => { options.providers[0].state = "unavailable"; }, "MODEL_NOT_CONFIGURED"],
  ]) {
    const h = mockAi(); mutate(h.options);
    const port = createHostMemoryModelPort(h.ai, () => readOrganizationSettings(values));
    await assert.rejects(invoke(port), { code });
    assert.equal(h.counters.opened, 0);
  }
});
test("actual model substitution, host character limits and UTF-8 budget are denied", async () => {
  const h = mockAi(); h.session.effective.modelId = "gpt-astra";
  await assert.rejects(invoke(createHostMemoryModelPort(h.ai, enabled)), { code: "MODEL_POLICY_DENIED" });
  assert.equal(h.counters.closed, 1);
  const budget = mockAi();
  const port = createHostMemoryModelPort(budget.ai, () => readOrganizationSettings({ organizationEnabled: true, organizationContextBudget: 8192 }));
  await assert.rejects(invoke(port, undefined, { text: "測".repeat(3000) }), { code: "MODEL_POLICY_DENIED" });
  assert.equal(budget.counters.opened, 0);
  assert.equal(port.countTokens(port.resolvePolicy("a"), "測"), 3);
});
test("host discovery permission, quota and transport rejections retain actionable model errors", async () => {
  for (const [code, expected] of [["plugin_permission_denied", "MODEL_POLICY_DENIED"], ["quota_exhausted", "RESOURCE_BUSY"], ["offline", "RESOURCE_BUSY"]]) {
    const h = mockAi();
    h.ai.getOptions = async () => { throw Object.assign(new Error("synthetic"), { code }); };
    await assert.rejects(invoke(createHostMemoryModelPort(h.ai, enabled)), { code: expected });
    assert.equal(h.counters.opened, 0);
  }
});

test("capture scope hashes use the original agent and source project, and distinct async scopes do not leak", async () => {
  const agentA = { agentId: "sw/a", projectId: "source-1", sessionId: "host-task-context", providerId: "mock" };
  const agentB = { ...agentA, projectId: "source-2" };
  const values = await Promise.all([
    withMemoryCaptureScope(agentA, "organize:op", async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentMemoryInvocation("extract", "system-a", { input: "same" });
    }),
    withMemoryCaptureScope(agentB, "organize:op", async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentMemoryInvocation("extract", "system-a", { input: "same" });
    }),
  ]);
  assert.notEqual(pairKey(agentA.agentId, agentA.projectId), pairKey(agentB.agentId, agentB.projectId));
  assert.notEqual(operationKey(pairKey(agentA.agentId, agentA.projectId), "organize:op"), operationKey(pairKey(agentB.agentId, agentB.projectId), "organize:op"));
  assert.equal(values[0].canonicalAgentId, "sw/a");
  assert.equal(values[0].sourceProjectId, "source-1");
  assert.equal(values[1].sourceProjectId, "source-2");
  assert.equal(values[0].sameRequestOccurrence, 0);
  assert.equal(values[1].sameRequestOccurrence, 0);
  assert.equal(sha256(JSON.stringify(["sw/a", "source-1"])).length, 64);
});

test("every invoke opens its own host session, different pairs stay isolated, and each turn carries its own system and schema", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-resume-pairs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi();
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  const actor = { agentId: "sw/a", projectId: "source-1", sessionId: "management-task", providerId: "mock" };
  const input = { records: [{ id: "synthetic" }] };
  await invokeScoped(port, actor, "organize:punch-1", "extract", "extract system with schema A", input);
  await invokeScoped(port, actor, "organize:punch-1", "classify", "classify system with schema B", { selected: ["synthetic"] });
  await invokeScoped(port, { ...actor, projectId: "source-2" }, "organize:punch-1", "extract", "extract system with schema A", input);
  await invokeScoped(port, { ...actor, agentId: "sw/b" }, "organize:punch-1", "extract", "extract system with schema A", input);
  assert.equal(h.counters.opened, 4, "one fresh session per invoke");
  assert.equal(h.counters.closed, 4, "each is closed as soon as its turn settles");
  assert.equal(h.counters.maxActiveSessions, 1, "no two sessions are ever open together");
  assert.equal(h.counters.sent, 4);
  assert.equal(h.counters.resumes, 0);
  assert.ok(h.openInputs.every((open) => !("resume" in open) && open.system.includes("with schema") === false), "a session opens with the base system only");
  assert.deepEqual(h.sent.slice(0, 2).map((turn) => [turn.operation, turn.operationSystem]), [
    ["extract", "extract system with schema A"],
    ["classify", "classify system with schema B"],
  ]);
  assert.ok(h.sent.every((turn) => turn.protocol === "cairn.model-turn/v1" && typeof turn.callKey === "string"));
  const saved = await store.readResumeState();
  assert.equal(Object.keys(saved.sessions).length, 3);
  assert.equal(saved.sessions[pairKey("sw/a", "source-1")].hostSessionId, "session-2", "the pair record names the session of its latest call");
  assert.equal(saved.sessions[pairKey("sw/a", "source-1")].turnCount, 1);
  assert.equal(Object.keys(saved.operations).length, 3);
  await port.cancel();
  assert.equal(h.counters.closed, 4);
});

test("same request under different operation systems has distinct durable call identities", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-resume-system-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi();
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  const actor = { agentId: "sw/a", projectId: "source-project", sessionId: "task", providerId: "mock" };
  const request = { records: [{ id: "synthetic" }] };
  await invokeScoped(port, actor, "same-operation", "extract", "schema A", request);
  await invokeScoped(port, actor, "same-operation", "extract", "schema B", request);
  assert.equal(h.counters.sent, 2);
  assert.notEqual(h.sent[0].callKey, h.sent[1].callKey);
  assert.deepEqual(h.sent.map((turn) => turn.operationSystem), ["schema A", "schema B"]);
  const journal = Object.values((await store.readResumeState()).operations)[0];
  const calls = Object.values(journal.calls);
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map((call) => call.operationSystemSha256)).size, 2);
  assert.ok(calls.every((call) => call.callKeyVersion === 2));
  await port.cancel();
});

test("an invocation fingerprint cannot be reused after changing operation, system, or request", async () => {
  const h = mockAi();
  const port = createHostMemoryModelPort(h.ai, enabled);
  const actor = { agentId: "sw/a", projectId: "source-project", sessionId: "task", providerId: "mock" };
  await withMemoryCaptureScope(actor, "fingerprint-mismatch", async () => {
    const invocation = currentMemoryInvocation("extract", "schema A", { n: 1 });
    for (const input of [
      { operation: "classify", system: "schema A", input: { n: 1 } },
      { operation: "extract", system: "schema B", input: { n: 1 } },
      { operation: "extract", system: "schema A", input: { n: 2 } },
    ]) {
      await assert.rejects(port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), ...input, maxOutputTokens: 1024, signal: new AbortController().signal, invocation }), { code: "MODEL_POLICY_DENIED" });
    }
  });
  assert.equal(h.counters.sent, 0);
  assert.equal(h.counters.opened, 0);
  await port.cancel();
});

test("legacy call keys recover only when every stored fingerprint matches", async (t) => {
  const actor = { agentId: "sw/a", projectId: "source-project", sessionId: "task", providerId: "mock" };
  const operationId = "legacy-operation";
  const system = "synthetic schema A";
  const otherSystem = "synthetic schema B";
  const request = { n: 1 };
  const pair = pairKey(actor.agentId, actor.projectId);
  const key = operationKey(pair, operationId);
  const requestSha256 = sha256(JSON.stringify(request));
  const replyJson = '{"items":[]}';
  const legacyKey = legacyModelCallKey(key, "extract", requestSha256, 0);
  const seedLegacyReply = async (store, savedSystem, corruptDigest = false) => store.transactResumeState((state) => ({
    ...state,
    operations: {
      ...state.operations,
      [key]: {
        operationKey: key, pairKey: pair, operationId, agentId: actor.agentId, projectId: actor.projectId, updatedAt: Date.now(),
        calls: {
          [legacyKey]: {
            callKey: legacyKey, operationKey: key, pairKey: pair, modelOperation: "extract",
            operationSystemSha256: sha256(savedSystem), requestSha256, occurrence: 0,
            hostSessionId: "legacy-session", turnId: "legacy-turn", sequenceNo: 1, phase: "reply_ready",
            retryable: false, partialDelivered: false, hostErrorCode: null,
            replyJson, replySha256: corruptDigest ? "f".repeat(64) : sha256(replyJson), responseBytes: Buffer.byteLength(replyJson),
            createdAt: Date.now(), updatedAt: Date.now(),
          },
        },
      },
    },
  }));

  const matchingDir = mkdtempSync(join(tmpdir(), "memory-legacy-key-match-"));
  t.after(() => rmSync(matchingDir, { recursive: true, force: true }));
  const matchingStore = createLocalPunchOrganizationStore(matchingDir);
  await seedLegacyReply(matchingStore, system);
  let discoveryCalls = 0;
  let openCalls = 0;
  const unavailable = {
    async getOptions() { discoveryCalls++; throw new Error("host discovery must not be needed"); },
    async openSession() { openCalls++; throw new Error("session attach must not be needed"); },
  };
  const matchingPort = createHostMemoryModelPort(unavailable, enabled, undefined, matchingStore);
  assert.deepEqual(await invokeScoped(matchingPort, actor, operationId, "extract", system, request), { items: [] });
  assert.equal(discoveryCalls, 0);
  assert.equal(openCalls, 0);
  await matchingPort.cancel();

  for (const mode of ["quota", "provider", "closed-resume"]) {
    let gatedDiscoveryCalls = 0;
    let gatedOpenCalls = 0;
    const gatedOptions = {
      providers: [{ id: "codex", state: mode === "provider" ? "unavailable" : "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }],
      defaultProviderId: "codex",
      capabilities: { closedSessionResume: mode !== "closed-resume" },
      quota: { state: mode === "quota" ? "exhausted" : "ok" },
      limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 },
    };
    const gatedPort = createHostMemoryModelPort({
      async getOptions() { gatedDiscoveryCalls++; return gatedOptions; },
      async openSession() { gatedOpenCalls++; throw new Error("local recovery must not attach a session"); },
    }, enabled, undefined, matchingStore);
    assert.deepEqual(await invokeScoped(gatedPort, actor, operationId, "extract", system, request), { items: [] });
    assert.equal(gatedDiscoveryCalls, 0, `${mode} gates are irrelevant after exact local reply validation`);
    assert.equal(gatedOpenCalls, 0);
    await gatedPort.cancel();
  }

  const mismatchDir = mkdtempSync(join(tmpdir(), "memory-legacy-key-mismatch-"));
  t.after(() => rmSync(mismatchDir, { recursive: true, force: true }));
  const mismatchStore = createLocalPunchOrganizationStore(mismatchDir);
  await seedLegacyReply(mismatchStore, otherSystem);
  const mismatchPort = createHostMemoryModelPort(unavailable, enabled, undefined, mismatchStore);
  await assert.rejects(
    invokeScoped(mismatchPort, actor, operationId, "extract", system, request),
    (error) => error.code === "RESOURCE_BUSY" && error.phase === "session_resume",
  );
  assert.equal(discoveryCalls, 0, "an ambiguous legacy key must fail closed before any resend path");
  assert.equal(openCalls, 0);
  await mismatchPort.cancel();

  const corruptDir = mkdtempSync(join(tmpdir(), "memory-legacy-key-corrupt-reply-"));
  t.after(() => rmSync(corruptDir, { recursive: true, force: true }));
  const corruptStore = createLocalPunchOrganizationStore(corruptDir);
  await seedLegacyReply(corruptStore, system, true);
  const corruptPort = createHostMemoryModelPort(unavailable, enabled, undefined, corruptStore);
  await assert.rejects(
    invokeScoped(corruptPort, actor, operationId, "extract", system, request),
    (error) => error.code === "STORAGE_BUSY" && error.phase === "state",
  );
  assert.equal(discoveryCalls, 0, "a failed local integrity check must not fall through to a fresh host send");
  await corruptPort.cancel();
});

test("same-pair sends serialize and different project pairs queue behind the one host session slot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-resume-locks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi({ holdSends: true });
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  const actor = { agentId: "sw/a", projectId: "project-a", sessionId: "task", providerId: "mock" };
  const first = invokeScoped(port, actor, "op-1", "extract", "extract A", { n: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 1);
  const second = invokeScoped(port, actor, "op-1", "classify", "classify B", { n: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 1, "same-pair turn waits behind the active turn");
  h.releaseOne();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 2);
  assert.equal(h.counters.maxInFlight, 1);
  h.releaseOne();
  await second;
  await store.pruneOperation(operationKey(pairKey(actor.agentId, actor.projectId), "op-1"));

  const otherA = invokeScoped(port, { ...actor, projectId: "project-a" }, "op-3", "extract", "extract A", { n: 3 });
  const otherB = invokeScoped(port, { ...actor, projectId: "project-b" }, "op-4", "extract", "extract A", { n: 4 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 3, "different pairs queue without violating the host's one-session-per-plugin limit");
  assert.equal(h.counters.maxInFlight, 1);
  assert.equal(h.counters.activeSessions, 1);
  h.releaseOne();
  await otherA;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 4);
  assert.equal(h.counters.maxInFlight, 1);
  h.releaseOne();
  await otherB;
  assert.equal(h.counters.opened, 4, "each of the four calls opened a session of its own");
  assert.equal(h.counters.resumes, 0);
  await port.cancel();
  assert.equal(h.counters.activeSessions, 0);
  assert.equal(h.counters.maxActiveSessions, 1);
});

test("a different pair cancelled in the host-slot queue sends nothing and releases its lock", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-queued-cancel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi({ holdSends: true });
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  const actorA = { agentId: "sw/a", projectId: "project-a", sessionId: "task", providerId: "mock" };
  const actorB = { agentId: "sw/a", projectId: "project-b", sessionId: "task", providerId: "mock" };
  const callWithSignal = (actor, operationId, signal) => withMemoryCaptureScope(actor, operationId, async () => {
    const input = { operationId };
    const invocation = currentMemoryInvocation("extract", "schema", input);
    return port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), operation: "extract", system: "schema", input, maxOutputTokens: 1024, signal, invocation });
  });
  const first = callWithSignal(actorA, "first", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 1);
  const controller = new AbortController();
  const queued = callWithSignal(actorB, "cancelled-while-queued", controller.signal);
  const queuedRejection = assert.rejects(queued, { code: "RESOURCE_BUSY" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 1);
  controller.abort();
  h.releaseOne();
  await first;
  await queuedRejection;
  assert.equal(h.counters.sent, 1, "a queued cancellation must not start a host send");

  const next = callWithSignal(actorB, "after-queued-cancel", new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.sent, 2, "the cancelled pair lock and host slot must be released");
  h.releaseOne();
  await next;
  await port.cancel();
  assert.equal(h.counters.maxActiveSessions, 1);
  assert.equal(h.counters.activeSessions, 0);
});

test("backend restart resumes a sent turn and recovers its saved result without another send", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-resume-reply-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi();
  let failReplyCheckpoint = true;
  const injectedStore = {
    ...store,
    async transactResumeState(update) {
      return store.transactResumeState((state) => {
        const next = update(state);
        const replyReady = Object.values(next.operations).some((operation) => Object.values(operation.calls).some((call) => call.phase === "reply_ready"));
        if (replyReady && failReplyCheckpoint) {
          failReplyCheckpoint = false;
          throw new Error("injected reply checkpoint failure");
        }
        return next;
      });
    },
  };
  const actor = { agentId: "sw/a", projectId: "project-a", sessionId: "task", providerId: "mock" };
  const firstPort = createHostMemoryModelPort(h.ai, enabled, undefined, injectedStore);
  await assert.rejects(invokeScoped(firstPort, actor, "op-recover", "extract", "extract schema", { n: 7 }), (error) => error.code === "STORAGE_BUSY" && error.phase === "state");
  const pair = pairKey(actor.agentId, actor.projectId);
  const key = operationKey(pair, "op-recover");
  const firstJournal = (await store.readResumeState()).operations[key];
  const firstCall = Object.values(firstJournal.calls)[0];
  assert.equal(firstCall.phase, "sent");
  assert.equal(firstCall.sequenceNo, 1);
  assert.equal(firstCall.replyJson, null);
  await firstPort.cancel();

  const resumedPort = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  assert.deepEqual(await invokeScoped(resumedPort, actor, "op-recover", "extract", "extract schema", { n: 7 }), { items: [] });
  assert.deepEqual(await invokeScoped(resumedPort, actor, "op-recover", "extract", "extract schema", { n: 7 }), { items: [] });
  assert.equal(h.counters.sent, 1, "reattachment and cached commit recovery add zero sends");
  assert.equal(h.counters.resumes, 1);
  const recovered = (await store.readResumeState()).operations[key];
  const recoveredCall = Object.values(recovered.calls)[0];
  assert.equal(recoveredCall.phase, "reply_ready");
  assert.equal(recoveredCall.replyJson, '{"items":[]}');
  assert.equal(recoveredCall.hostSessionId, firstCall.hostSessionId);
  assert.equal(recoveredCall.turnId, firstCall.turnId);
  await resumedPort.cancel();
});

test("a host without closedSessionResume fails closed for an unresolved turn instead of opening a replacement session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-resume-unavailable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = durableAi();
  let failReplyCheckpoint = true;
  const injectedStore = {
    ...store,
    async transactResumeState(update) {
      return store.transactResumeState((state) => {
        const next = update(state);
        if (failReplyCheckpoint && Object.values(next.operations).some((operation) => Object.values(operation.calls).some((call) => call.phase === "reply_ready"))) {
          failReplyCheckpoint = false;
          throw new Error("injected reply checkpoint failure");
        }
        return next;
      });
    },
  };
  const actor = { agentId: "sw/a", projectId: "source", sessionId: "task", providerId: "mock" };
  const first = createHostMemoryModelPort(h.ai, enabled, undefined, injectedStore);
  await assert.rejects(invokeScoped(first, actor, "pending-op", "extract", "schema", { value: 1 }), (error) => error.code === "STORAGE_BUSY" && error.phase === "state");
  await first.cancel();
  h.ai.getOptions = async () => ({ ...h.options, capabilities: { closedSessionResume: false } });
  const retry = createHostMemoryModelPort(h.ai, enabled, undefined, store);
  await assert.rejects(invokeScoped(retry, actor, "pending-op", "extract", "schema", { value: 1 }), { code: "MODEL_POLICY_DENIED" });
  assert.equal(h.counters.sent, 1);
  assert.equal(h.counters.opened, 1, "resume unavailable does not silently create a replacement session");
  assert.equal((await store.readResumeState()).sessions[pairKey(actor.agentId, actor.projectId)].state, "resume_unavailable");
  await retry.cancel();
});

test("unknown send delivery is journaled and a retry does not issue a second send", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-send-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const counters = { sent: 0, closed: 0 };
  let listener;
  const session = {
    sessionId: "unknown-send-session",
    effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null },
    turn: null,
    onEvent(next) { listener = next; return () => { listener = undefined; }; },
    async send() { counters.sent += 1; throw Object.assign(new Error("transport disconnected"), { code: "plugin_host_unavailable" }); },
    async close() { counters.closed += 1; },
    async interrupt() {},
  };
  const ai = {
    async getOptions() { return { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } }; },
    async openSession() { return session; },
  };
  const actor = { agentId: "sw/a", projectId: "source", sessionId: "task", providerId: "mock" };
  const first = createHostMemoryModelPort(ai, enabled, undefined, store);
  await assert.rejects(invokeScoped(first, actor, "unknown-op", "extract", "schema", { value: 1 }), { code: "RESOURCE_BUSY" });
  await first.cancel();
  const state = await store.readResumeState();
  const key = operationKey(pairKey(actor.agentId, actor.projectId), "unknown-op");
  const call = Object.values(state.operations[key].calls)[0];
  assert.equal(call.phase, "send_unknown");
  assert.equal(call.hostErrorCode, "plugin_host_unavailable");
  const retry = createHostMemoryModelPort(ai, enabled, undefined, store);
  await assert.rejects(invokeScoped(retry, actor, "unknown-op", "extract", "schema", { value: 1 }), { code: "RESOURCE_BUSY" });
  assert.equal(counters.sent, 1);
  await retry.cancel();
});

test("provider partial delivery stays correlated and cannot be retried automatically", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-partial-turn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const counters = { sent: 0 };
  const session = {
    sessionId: "partial-session",
    effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null },
    turn: null,
    onEvent(listener) { this.listener = listener; return () => { this.listener = undefined; }; },
    async send() {
      counters.sent += 1;
      this.listener({ turnId: "partial-turn", kind: "failed", code: "provider_error", retryable: true, fallbackUsed: false, partialDelivered: true });
      return { turnId: "partial-turn" };
    },
    async close() {},
    async interrupt() {},
  };
  const ai = {
    async getOptions() { return { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } }; },
    async openSession() { return session; },
  };
  const actor = { agentId: "sw/a", projectId: "source", sessionId: "task", providerId: "mock" };
  const port = createHostMemoryModelPort(ai, enabled, undefined, store);
  await assert.rejects(invokeScoped(port, actor, "partial-op", "extract", "schema", { value: 1 }), { code: "RESOURCE_BUSY" });
  await assert.rejects(invokeScoped(port, actor, "partial-op", "extract", "schema", { value: 1 }), { code: "RESOURCE_BUSY" });
  const key = operationKey(pairKey(actor.agentId, actor.projectId), "partial-op");
  const call = Object.values((await store.readResumeState()).operations[key].calls)[0];
  assert.equal(call.phase, "failed");
  assert.equal(call.hostErrorCode, "provider_error");
  assert.equal(call.retryable, true);
  assert.equal(call.partialDelivered, true);
  assert.equal(counters.sent, 1);
  await port.cancel();
});
