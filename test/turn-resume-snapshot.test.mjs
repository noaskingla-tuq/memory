import assert from "node:assert/strict";
import test from "node:test";
import { actorOf, callRecord, callsOf, invokeScoped, portOf, recoverAi, seed, sessionRecord, tempStore } from "./recoverHarness.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resumeRig(t, frozen, freeze = true) {
  const { store } = tempStore(t);
  const actor = actorOf("sw/a");
  const operation = "organize:snap";
  const holder = {};
  const host = recoverAi({ resume: (id, make) => { const made = make(id, frozen); holder.session = freeze ? Object.freeze(made) : made; return holder.session; } });
  await seed(store, { sessions: [sessionRecord(actor, "host-old")], calls: [await callRecord(actor, operation, {})] });
  const port = portOf(host.ai, store, { graceMs: 30, backstopMs: 5000 });
  t.after(() => port.cancel());
  const outcome = invokeScoped(port, actor, operation).then((value) => ({ value }), (error) => ({ error }));
  await pause(50);
  return { holder, outcome, calls: () => callsOf(store, operation, actor) };
}

test("a resumed running turn keeps the streamed text when completed arrives, even though the attach snapshot is frozen and shorter", async (t) => {
  const rig = await resumeRig(t, { turnId: "turn-old", text: '{"items":', terminal: null });
  rig.holder.session.emit({ turnId: "turn-old", kind: "textDelta", text: "[]}" });
  rig.holder.session.emit({ turnId: "turn-old", kind: "completed" });
  const result = await Promise.race([rig.outcome, pause(1500).then(() => ({ error: new Error("timeout") }))]);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.deepEqual(result.value, { items: [] });
  const calls = await rig.calls();
  assert.deepEqual(calls.map((call) => [call.phase, call.hostErrorCode]), [["reply_ready", null]], "no failed json_parse call with retryable false");
});

test("a snapshot that is already completed still wins over the streamed text", async (t) => {
  const rig = await resumeRig(t, { turnId: "turn-old", text: '{"items":[]}', terminal: null });
  rig.holder.session.emit({ turnId: "turn-old", kind: "completed" });
  const result = await Promise.race([rig.outcome, pause(1500).then(() => ({ error: new Error("timeout") }))]);
  assert.deepEqual(result.value, { items: [] });
});

test("a snapshot that holds more than was streamed is adopted at completed", async (t) => {
  const rig = await resumeRig(t, { turnId: "turn-old", text: '{"items":', terminal: null }, false);
  rig.holder.session.turn = { turnId: "turn-old", text: '{"items":[]}', terminal: null };
  rig.holder.session.emit({ turnId: "turn-old", kind: "completed" });
  const result = await Promise.race([rig.outcome, pause(1500).then(() => ({ error: new Error("timeout") }))]);
  assert.deepEqual(result.value, { items: [] });
});
