import assert from "node:assert/strict";
import test from "node:test";
import { REPLY, T0, actorOf, callRecord, callsOf, invokeScoped, portOf, recoverAi, seed, sessionRecord, tempStore } from "./recoverHarness.mjs";

const OP = "organize:rotation";
const SOL = { providerId: "codex", modelId: "gpt-6.1-sol" };

async function rotationRig(t, { callFields = {}, sessionExtra = {} }) {
  const { store } = tempStore(t);
  const actor = actorOf("sw/a");
  const call = await callRecord(actor, OP, { hostSessionId: "host-old", turnId: "turn-old", phase: "sent", hostErrorCode: null, retryable: false, ...callFields });
  await seed(store, { sessions: [sessionRecord(actor, "host-old", "active", sessionExtra)], calls: [call] });
  const host = recoverAi({ resume: (id, make) => make(id, { turnId: "turn-old", text: "", terminal: null }) });
  const port = portOf(host.ai, store);
  t.after(() => port.cancel());
  return { store, actor, host, port };
}

const SCENARIOS = [
  ["the model was changed after the call was sent", { sessionExtra: SOL }],
  ["the call already has a sequenceNo and the model was changed", { callFields: { sequenceNo: 3 }, sessionExtra: SOL }],
  ["the policy revision changed", { sessionExtra: { policyRevision: "older-policy" } }],
  ["the session has been idle for 30 days", { sessionExtra: { lastUsedAt: T0 - 31 * 24 * 60 * 60_000 } }],
];

for (const [label, setup] of SCENARIOS) {
  test("a sent call that blocks a session rotation is closed as unrecoverable and sent again on a fresh session: " + label, async (t) => {
    const rig = await rotationRig(t, setup);
    assert.deepEqual(await invokeScoped(rig.port, rig.actor, OP), REPLY);
    const calls = await callsOf(rig.store, OP, rig.actor);
    assert.deepEqual(calls.map((call) => [call.occurrence, call.phase, call.hostErrorCode, call.retryable, call.partialDelivered]), [
      [0, "failed", "reconciled_unrecoverable", true, false],
      [1, "reply_ready", null, false, false],
    ]);
    assert.equal(rig.host.counters.sent, 1, "exactly one new send");
    assert.equal(rig.host.counters.opened, 1, "on a fresh session");
    const sessions = Object.values((await rig.store.readResumeState()).sessions);
    assert.deepEqual(sessions.map((entry) => [entry.state, entry.hostSessionId]), [["active", "fresh-1"]]);
  });
}

test("a high turnCount no longer blocks the resume: the sent call is read back from its own session and nothing is sent again", async (t) => {
  const { store } = tempStore(t);
  const actor = actorOf("sw/a");
  const call = await callRecord(actor, OP, { hostSessionId: "host-old", turnId: "turn-old", phase: "sent", hostErrorCode: null, retryable: false });
  await seed(store, { sessions: [sessionRecord(actor, "host-old", "active", { turnCount: 20 })], calls: [call] });
  const host = recoverAi({ resume: (id, make) => make(id, { turnId: "turn-old", text: JSON.stringify(REPLY), terminal: { kind: "completed" } }) });
  const port = portOf(host.ai, store, { graceMs: 50, backstopMs: 60_000 });
  t.after(() => port.cancel());
  assert.deepEqual(await invokeScoped(port, actor, OP), REPLY);
  assert.deepEqual((await callsOf(store, OP, actor)).map((entry) => [entry.occurrence, entry.phase, entry.turnId]), [[0, "reply_ready", "turn-old"]]);
  assert.equal(host.counters.resumes, 1);
  assert.equal(host.counters.opened, 0);
  assert.equal(host.counters.sent, 0);
});

test("the rotation closing does not hide another operation of the pair that still needs recovery", async (t) => {
  const rig = await rotationRig(t, { sessionExtra: SOL });
  const other = await callRecord(rig.actor, "organize:other", { phase: "prepared", turnId: null, hostSessionId: null });
  const state = await rig.store.readResumeState();
  await rig.store.writeResumeState({ ...state, operations: { ...state.operations, [other.operation.operationKey]: other.operation } });
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), (error) => error.code === "RESOURCE_BUSY" && error.localCode === "pair_blocked");
  assert.equal(rig.host.counters.sent, 0);
});

test("a prepared call without a turn is not closed by the rotation path: the unknown send still blocks", async (t) => {
  const rig = await rotationRig(t, { callFields: { phase: "prepared", turnId: null, hostSessionId: null }, sessionExtra: SOL });
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "RESOURCE_BUSY" });
  assert.equal(rig.host.counters.sent, 0);
  assert.equal((await callsOf(rig.store, OP, rig.actor))[0].phase, "prepared");
});
