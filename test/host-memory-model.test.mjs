import assert from "node:assert/strict";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";

export function mockAi(overrides = {}) {
  const counters = { opened: 0, closed: 0, off: 0, interrupted: 0, sent: 0 };
  const options = { providers: [{ id: "mock", state: "ready", models: [{ id: "allowed", isDefault: true }] }], defaultProviderId: "mock", quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000 } };
  let listener;
  const session = {
    effective: { providerId: "mock", modelId: "allowed" }, turn: null,
    onEvent(next) { listener = next; return () => { counters.off++; listener = undefined; }; },
    async send(input) {
      counters.sent++;
      if (overrides.send) return overrides.send({ session, emit: (event) => listener?.({ turnId: "t", ...event }), input });
      listener({ turnId: "t", kind: "textDelta", text: '{"items":[]}' });
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

test("host model consumes synchronous early terminal events and closes its session", async () => {
  const h = mockAi();
  const port = createHostMemoryModelPort(h.ai, enabled);
  assert.deepEqual(await invoke(port), { items: [] });
  assert.deepEqual(h.counters, { opened: 1, closed: 1, off: 1, interrupted: 0, sent: 1 });
  await port.cancel();
});
test("host model recovers an already-terminal turn snapshot", async () => {
  const h = mockAi({ send: async ({ session }) => { session.turn = { turnId: "t", text: '{"items":[]}', terminal: { kind: "completed" } }; return { turnId: "t" }; } });
  assert.deepEqual(await invoke(createHostMemoryModelPort(h.ai, enabled)), { items: [] });
  assert.equal(h.counters.closed, 1);
});
test("invalid JSON, oversized UTF-8 and rejected sends clean up listeners and sessions", async () => {
  for (const [reply, code] of [["not json", "MODEL_OUTPUT_INVALID"], [JSON.stringify("測".repeat(6000)), "MODEL_OUTPUT_INVALID"], [null, "MODEL_TIMEOUT"]]) {
    const h = mockAi({ send: async ({ emit }) => { if (reply === null) throw new Error("send rejected"); emit({ kind: "textDelta", text: reply }); emit({ kind: "completed" }); return { turnId: "t" }; } });
    await assert.rejects(invoke(createHostMemoryModelPort(h.ai, enabled)), { code });
    assert.equal(h.counters.closed, 1);
    assert.equal(h.counters.off, 1);
  }
});
test("abort, timeout and disposal interrupt a stalled turn", async () => {
  for (const mode of ["abort", "timeout", "dispose"]) {
    let sent;
    const started = new Promise((resolve) => { sent = resolve; });
    const h = mockAi({ send: async () => { sent(); return { turnId: "t" }; } });
    const controller = new AbortController();
    const port = createHostMemoryModelPort(h.ai, enabled, mode === "timeout" ? 20 : 10000);
    const call = invoke(port, controller.signal);
    const rejection = assert.rejects(call, { code: "MODEL_TIMEOUT" });
    await started;
    if (mode === "abort") controller.abort();
    if (mode === "dispose") await port.cancel();
    await rejection;
    assert.equal(h.counters.interrupted, 1);
    assert.equal(h.counters.closed, 1);
    assert.equal(h.counters.off, 1);
  }
});
test("cancel during discovery and late opening closes any eventual session", async () => {
  let resolveOpen;
  const h = mockAi();
  h.ai.openSession = () => new Promise((resolve) => { resolveOpen = resolve; });
  const port = createHostMemoryModelPort(h.ai, enabled);
  const pending = invoke(port);
  const rejection = assert.rejects(pending, { code: "MODEL_TIMEOUT" });
  await new Promise((resolve) => setImmediate(resolve));
  await port.cancel();
  await rejection;
  resolveOpen(h.session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counters.closed, 1);
  const discovery = createHostMemoryModelPort({ getOptions: () => new Promise(() => {}), openSession: h.ai.openSession }, enabled, 10);
  await assert.rejects(invoke(discovery), { code: "MODEL_TIMEOUT" });
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
  for (const [code, expected] of [["plugin_permission_denied", "MODEL_POLICY_DENIED"], ["quota_exhausted", "RESOURCE_BUSY"], ["offline", "MODEL_TIMEOUT"]]) {
    const h = mockAi();
    h.ai.getOptions = async () => { throw Object.assign(new Error("synthetic"), { code }); };
    await assert.rejects(invoke(createHostMemoryModelPort(h.ai, enabled)), { code: expected });
    assert.equal(h.counters.opened, 0);
  }
});
