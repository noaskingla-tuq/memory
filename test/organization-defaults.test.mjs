import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { ORGANIZATION_DEFAULT_MODEL, ORGANIZATION_DEFAULT_PROVIDER } from "../out/contracts/organizationDefaults.js";
import { REPLY, actorOf, invokeScoped, recoverAi, tempStore } from "./recoverHarness.mjs";

test("the plugin default is codex with gpt-6-luna", () => {
  assert.equal(ORGANIZATION_DEFAULT_PROVIDER, "codex");
  assert.equal(ORGANIZATION_DEFAULT_MODEL, "gpt-6-luna");
});

test("empty, blank and missing provider and model values resolve to codex and gpt-6-luna", () => {
  for (const values of [{}, { organizationProvider: "", organizationModel: "" }, { organizationProvider: "   ", organizationModel: "\t" }, { organizationProvider: 5, organizationModel: null }]) {
    const settings = readOrganizationSettings(values);
    assert.deepEqual([settings.providerId, settings.modelId], ["codex", "gpt-6-luna"], JSON.stringify(values));
  }
  assert.equal(readOrganizationSettings().providerId, "codex");
});

test("a named model is kept, and codex with an empty model still means luna", () => {
  assert.equal(readOrganizationSettings({ organizationModel: "gpt-6.1-sol" }).modelId, "gpt-6.1-sol");
  assert.equal(readOrganizationSettings({ organizationProvider: "codex" }).modelId, "gpt-6-luna");
});

test("another provider with an empty model leaves the model empty", () => {
  for (const organizationProvider of ["claude", "scripted", " other "]) {
    const settings = readOrganizationSettings({ organizationProvider });
    assert.equal(settings.providerId, organizationProvider.trim());
    assert.equal(settings.modelId, "");
  }
  assert.equal(readOrganizationSettings({ organizationProvider: "claude", organizationModel: "m-1" }).modelId, "m-1");
});

test("the manifest keeps empty defaults, so the plugin alone decides what empty means", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plugin/manifest.template.json", import.meta.url), "utf8").replace("@VERSION@", "0.0.0"));
  const byKey = Object.fromEntries(manifest.settingsSchema.fields.map((field) => [field.key, field]));
  assert.equal(byKey.organizationProvider.default, "");
  assert.equal(byKey.organizationModel.default, "");
});

function portFor(t, { models, values = {}, state = "ready", provider = "codex" }) {
  const { store } = tempStore(t, "memory-defaults-");
  const host = recoverAi();
  const opened = [];
  host.ai.getOptions = async () => ({ providers: [{ id: provider, state, models }], defaultProviderId: provider, capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } });
  const open = host.ai.openSession;
  host.ai.openSession = async (input) => { opened.push(input); const session = await open(input); session.effective = { providerId: input.providerId, modelId: input.modelId, effort: null }; return session; };
  const port = createHostMemoryModelPort(host.ai, () => readOrganizationSettings(values), undefined, store);
  t.after(() => port.cancel());
  return { port, host, opened };
}

test("an unset setting opens the session on codex with gpt-6-luna even when it is not the host default model", async (t) => {
  const rig = portFor(t, { models: [{ id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-6-luna", isDefault: false }] });
  assert.deepEqual(await invokeScoped(rig.port, actorOf("sw/a"), "organize:default"), REPLY);
  assert.deepEqual(rig.opened.map((entry) => [entry.providerId, entry.modelId]), [["codex", "gpt-6-luna"]]);
});

test("when luna is not in the list the call fails with MODEL_NOT_CONFIGURED and no other model is used", async (t) => {
  const rig = portFor(t, { models: [{ id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-6.2-terra", isDefault: false }] });
  await assert.rejects(invokeScoped(rig.port, actorOf("sw/a"), "organize:no-luna"), { code: "MODEL_NOT_CONFIGURED", phase: "policy" });
  assert.deepEqual(rig.opened, [], "no session was opened");
  assert.equal(rig.host.counters.sent, 0, "nothing was sent");
});

test("when codex is not ready the call fails with MODEL_NOT_CONFIGURED instead of using another provider", async (t) => {
  const rig = portFor(t, { models: [{ id: "gpt-6-luna", isDefault: true }], state: "not_logged_in" });
  await assert.rejects(invokeScoped(rig.port, actorOf("sw/a"), "organize:not-ready"), { code: "MODEL_NOT_CONFIGURED" });
  assert.equal(rig.host.counters.sent, 0);
});

test("a host that lists only another provider does not get a silent substitute", async (t) => {
  const rig = portFor(t, { models: [{ id: "scripted-text", isDefault: true }], provider: "scripted" });
  await assert.rejects(invokeScoped(rig.port, actorOf("sw/a"), "organize:other"), { code: "MODEL_NOT_CONFIGURED" });
  assert.deepEqual(rig.opened, []);
});

test("choosing another provider with an empty model uses that provider's own default model", async (t) => {
  const rig = portFor(t, { models: [{ id: "scripted-text", isDefault: true }], provider: "scripted", values: { organizationProvider: "scripted" } });
  assert.deepEqual(await invokeScoped(rig.port, actorOf("sw/a"), "organize:chosen"), REPLY);
  assert.deepEqual(rig.opened.map((entry) => [entry.providerId, entry.modelId]), [["scripted", "scripted-text"]]);
});
