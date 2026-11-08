import assert from "node:assert/strict";
import test from "node:test";
import { REPLY, actorOf, callRecord, callsOf, invokeScoped, portOf, recoverAi, seed, sessionRecord, tempStore } from "./recoverHarness.mjs";

const OP = "organize:stranded";

async function stranded(t, { session, calls = {}, resume, closedSessionResume }) {
  const { store } = tempStore(t);
  const actor = actorOf("sw/a");
  const record = await callRecord(actor, OP, { hostSessionId: "host-old", turnId: "turn-old", ...calls });
  await seed(store, { sessions: session === null ? [] : [sessionRecord(actor, "host-old", session)], calls: [record] });
  const host = recoverAi({ resume, closedSessionResume });
  const port = portOf(host.ai, store);
  t.after(() => port.cancel());
  return { store, actor, host, port };
}

const resent = async (rig) => {
  assert.deepEqual(await invokeScoped(rig.port, rig.actor, OP), REPLY);
  const list = await callsOf(rig.store, OP, rig.actor);
  assert.equal(rig.host.counters.sent, 1, "exactly one new send");
  assert.deepEqual([list[0].phase, list[0].retryable, list[0].partialDelivered], ["failed", true, false]);
  assert.equal(list[1].phase, "reply_ready");
  assert.equal(list[1].occurrence, 1);
  return list;
};

for (const state of ["expired", "invalidated", "resume_unavailable"]) {
  test(`row 1: a stranded sent call whose saved session is ${state} is failed as reconciled_unrecoverable and sent again`, async (t) => {
    const rig = await stranded(t, { session: state });
    const list = await resent(rig);
    assert.equal(list[0].hostErrorCode, "reconciled_unrecoverable");
    assert.equal(rig.host.counters.resumes, 0, "a dead session is never asked to resume");
    assert.equal((await rig.store.readResumeState()).sessions[list[0].pairKey].hostSessionId.startsWith("fresh-"), true);
  });
}

test("row 1: no saved session at all is the same as a dead one", async (t) => {
  const rig = await stranded(t, { session: null });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "reconciled_unrecoverable");
});

test("row 1: an active session that the host reports as session_not_found is invalidated and the call is sent again", async (t) => {
  const rig = await stranded(t, { session: "active" });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "reconciled_unrecoverable");
  assert.equal(rig.host.counters.resumes, 1);
  assert.notEqual((await rig.store.readResumeState()).sessions[list[0].pairKey].hostSessionId, "host-old");
});

test("row 1: the dead session record is left invalidated when no new session can be opened", async (t) => {
  const rig = await stranded(t, { session: "expired" });
  await rig.port.cancel();
  const failing = recoverAi();
  failing.ai.openSession = async () => { throw Object.assign(new Error("host down"), { code: "plugin_host_unavailable" }); };
  const port = portOf(failing.ai, rig.store);
  await assert.rejects(invokeScoped(port, rig.actor, OP), { code: "RESOURCE_BUSY" });
  const state = await rig.store.readResumeState();
  assert.equal(state.sessions[Object.keys(state.sessions)[0]].state, "invalidated");
  assert.equal((await callsOf(rig.store, OP, rig.actor))[0].hostErrorCode, "reconciled_unrecoverable");
  await port.cancel();
});

test("row 2: a resumed session without a current turn is unrecoverable", async (t) => {
  const rig = await stranded(t, { session: "active", resume: (id, make) => make(id, null) });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "reconciled_unrecoverable");
  assert.equal(rig.host.counters.resumes, 1);
});

test("row 2: a resumed session whose turn id does not match is unrecoverable", async (t) => {
  const rig = await stranded(t, { session: "active", resume: (id, make) => make(id, { turnId: "someone-else", text: "", terminal: null }) });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "reconciled_unrecoverable");
});

test("row 3: a terminal failed turn becomes failed with the event fields and the call is sent again", async (t) => {
  const terminal = { kind: "failed", code: "provider_error", retryable: true, fallbackUsed: false, partialDelivered: true };
  const rig = await stranded(t, { session: "active", resume: (id, make) => make(id, { turnId: "turn-old", text: "", terminal }) });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "provider_error");
});

test("row 3: a terminal interrupted turn becomes failed interrupted and the call is sent again", async (t) => {
  const rig = await stranded(t, { session: "active", resume: (id, make) => make(id, { turnId: "turn-old", text: "", terminal: { kind: "interrupted" } }) });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "interrupted");
});

test("row 4: a completed turn with a sequence number is read back as reply_ready without another send", async (t) => {
  const rig = await stranded(t, {
    session: "active", calls: { sequenceNo: 7 },
    resume: (id, make) => make(id, { turnId: "turn-old", text: JSON.stringify(REPLY), terminal: { kind: "completed" } }),
  });
  assert.deepEqual(await invokeScoped(rig.port, rig.actor, OP), REPLY);
  const list = await callsOf(rig.store, OP, rig.actor);
  assert.equal(list.length, 1);
  assert.equal(list[0].phase, "reply_ready");
  assert.equal(rig.host.counters.sent, 0);
});

test("row 5: a completed turn without a sequence number is unrecoverable and the call is sent again", async (t) => {
  const rig = await stranded(t, {
    session: "active", calls: { sequenceNo: null },
    resume: (id, make) => make(id, { turnId: "turn-old", text: JSON.stringify(REPLY), terminal: { kind: "completed" } }),
  });
  const list = await resent(rig);
  assert.equal(list[0].hostErrorCode, "reconciled_unrecoverable");
});

test("row 6: a turn that is still running is listened to again and finishes without another send", async (t) => {
  let session;
  const rig = await stranded(t, {
    session: "active", calls: { sequenceNo: 3 },
    resume: (id, make) => { session = make(id, { turnId: "turn-old", text: "", terminal: null }); return session; },
  });
  const pending = invokeScoped(rig.port, rig.actor, OP);
  for (let i = 0; i < 50 && session === undefined; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  session.turn = { turnId: "turn-old", text: JSON.stringify(REPLY), terminal: { kind: "completed" } };
  session.emit({ turnId: "turn-old", kind: "textDelta", text: JSON.stringify(REPLY) });
  session.emit({ turnId: "turn-old", kind: "completed" });
  assert.deepEqual(await pending, REPLY);
  const list = await callsOf(rig.store, OP, rig.actor);
  assert.equal(list.length, 1);
  assert.equal(list[0].phase, "reply_ready");
  assert.equal(rig.host.counters.sent, 0);
});

test("a send_unknown call without a turn id is not touched: the unknown send still blocks", async (t) => {
  const rig = await stranded(t, { session: "expired", calls: { turnId: null, phase: "send_unknown", hostErrorCode: "send_rejected", retryable: true, partialDelivered: true } });
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "RESOURCE_BUSY", phase: "send_unknown" });
  assert.equal(rig.host.counters.sent, 0);
  assert.equal((await callsOf(rig.store, OP, rig.actor))[0].phase, "send_unknown");
});

async function liveRig(t, send, timeoutMs = 5_000, wrapStore = (store) => store) {
  const { store } = tempStore(t);
  const actor = actorOf("sw/a");
  const host = recoverAi();
  const original = host.make;
  const make = (id, turn) => Object.assign(original(id, turn), { send });
  host.ai.openSession = async () => make("live-1", null);
  const port = portOf(host.ai, wrapStore(store), timeoutMs);
  t.after(() => port.cancel());
  return { store, actor, host, port };
}
const only = async (rig) => (await callsOf(rig.store, OP, rig.actor));

test("an interrupted event closes the call as failed interrupted, never as sent", async (t) => {
  const rig = await liveRig(t, async () => ({ turnId: "turn-live" }));
  const send = rig.host.ai.openSession;
  rig.host.ai.openSession = async (input) => {
    const session = await send(input);
    session.send = async () => { setImmediate(() => session.emit({ turnId: "turn-live", kind: "interrupted" })); return { turnId: "turn-live" }; };
    return session;
  };
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "RESOURCE_BUSY", phase: "cancelled" });
  const [call] = await only(rig);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable, call.partialDelivered, call.turnId], ["failed", "interrupted", true, false, "turn-live"]);
});

test("an abort after the send closes the call as failed cancelled_local and interrupts the turn", async (t) => {
  const rig = await liveRig(t, async () => ({ turnId: "turn-live" }));
  const controller = new AbortController();
  const pending = invokeScoped(rig.port, rig.actor, OP, { value: 1 }, controller.signal);
  const rejection = assert.rejects(pending, { code: "RESOURCE_BUSY" });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejection;
  const [call] = await only(rig);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable, call.partialDelivered, call.turnId], ["failed", "cancelled_local", true, false, "turn-live"]);
  assert.equal(rig.host.counters.interrupted, 1);
});

test("the turn time limit closes the call as failed cancelled_local", async (t) => {
  const rig = await liveRig(t, async () => ({ turnId: "turn-live" }), 30);
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "MODEL_TIMEOUT" });
  const [call] = await only(rig);
  assert.deepEqual([call.phase, call.hostErrorCode], ["failed", "cancelled_local"]);
});

test("a failed session write after the send closes the call as failed cancelled_local and interrupts the turn", async (t) => {
  const failAfterSend = (store) => ({
    ...store,
    async transactResumeState(update) {
      return store.transactResumeState((state) => {
        const next = update(state);
        if (Object.values(next.sessions).some((entry) => entry.turnCount >= 1)) throw new Error("injected session write failure");
        return next;
      });
    },
  });
  const rig = await liveRig(t, async () => ({ turnId: "turn-live" }), 5_000, failAfterSend);
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "STORAGE_BUSY" });
  const [call] = await only(rig);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable, call.partialDelivered], ["failed", "cancelled_local", true, false]);
  assert.equal(rig.host.counters.interrupted, 1);
});
