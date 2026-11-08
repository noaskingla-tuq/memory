import assert from "node:assert/strict";
import test from "node:test";
import { loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule(
  "api/aiOptionsClient.ts",
  "api/settingsClient.ts",
  "state/settings.ts",
  "views/settingsPicker.ts",
  "views/settingsView.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/settingsStrings.ts",
);

const model = (id, isDefault = false) => ({ id, label: `Label ${id}`, efforts: [], defaultEffort: null, supportsImages: false, isDefault });
const OPTIONS = {
  providers: [
    { id: "codex", label: "Codex", state: "ready", models: [model("gpt-a", true), model("gpt-b")] },
    { id: "claude", label: "Claude", state: "not_logged_in", models: [model("cl-1")] },
    { id: "gemini", label: "Gemini", state: "not_installed", models: [] },
    { id: "ready2", label: "Second", state: "ready", models: [model("s-1")] },
    { id: "astra-x", label: "Astra", state: "ready", models: [model("astra-1")] },
  ],
  defaultProviderId: "ready2",
  limits: {},
  quota: { state: "ok", retryAfterMs: null },
};

function host(initial = {}) {
  const values = { ...initial };
  return {
    values,
    api: {
      async all() { return { ...values }; },
      async get(key) { return values[key]; },
      async set(key, value) { values[key] = value; return true; },
    },
  };
}

async function loaded(initial) {
  const h = host(initial);
  const state = ui.createSettingsState(ui.createSettingsClient(() => h.api));
  await state.load();
  return { h, state };
}

const choicesOf = async (raw = OPTIONS) => ({ status: "ready", options: await ui.createAiOptionsClient(() => ({ getOptions: async () => raw })).load() });
const selectOf = (markup, id) => new RegExp(`<select id="${id}"[^>]*>[\\s\\S]*?</select>`, "u").exec(markup)?.[0] ?? "";
const optionsOf = (select) => [...select.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/gu)].map((m) => ({ value: m[1], selected: / selected/u.test(m[2]), disabled: / disabled/u.test(m[2]), text: m[3] }));

test("provider menu lists the default entry first, every provider, and marks not-ready ones as disabled with the reason", async () => {
  const { state } = await loaded({});
  const markup = ui.settingsPage(state.view(), await choicesOf()).value;
  const provider = optionsOf(selectOf(markup, "settings-provider"));
  assert.deepEqual(provider.map((o) => o.value), ["", "codex", "claude", "gemini", "ready2"]);
  assert.equal(provider[0].text, "預設（使用目前可用的提供者）");
  assert.ok(provider[0].selected);
  assert.deepEqual(provider.map((o) => o.disabled), [false, false, true, true, false]);
  assert.equal(provider[2].text, "Claude（未登入）");
  assert.equal(provider[3].text, "Gemini（未安裝）");
  assert.equal(provider[1].text, "Codex");
  assert.ok(!/astra/iu.test(markup), "astra never appears");
  assert.ok(!markup.includes('<input id="settings-provider"'));
});

test("every non-ready state has its own reason text", async () => {
  const raw = { ...OPTIONS, providers: ["not_installed", "not_logged_in", "unsupported_version", "unavailable", "not_supported_yet"].map((state) => ({ id: state, label: state, state, models: [] })) };
  const { state } = await loaded({});
  const provider = optionsOf(selectOf(ui.settingsPage(state.view(), await choicesOf(raw)).value, "settings-provider")).slice(1);
  assert.deepEqual(provider.map((o) => o.text), ["not_installed（未安裝）", "not_logged_in（未登入）", "unsupported_version（版本不支援）", "unavailable（目前無法使用）", "not_supported_yet（尚未支援）"]);
  assert.ok(provider.every((o) => o.disabled));
});

test("model menu starts with the provider default and lists the selected provider models", async () => {
  const { state } = await loaded({ organizationProvider: "codex", organizationModel: "gpt-b" });
  const models = optionsOf(selectOf(ui.settingsPage(state.view(), await choicesOf()).value, "settings-model"));
  assert.deepEqual(models.map((o) => o.value), ["", "gpt-a", "gpt-b"]);
  assert.equal(models[0].text, "預設（提供者的預設模型）");
  assert.deepEqual(models.map((o) => o.selected), [false, false, true]);
  assert.equal(models[1].text, "Label gpt-a");
});

test("with the default provider the model menu uses the defaultProviderId provider, else the first ready one", async () => {
  const { state } = await loaded({});
  const withDefault = optionsOf(selectOf(ui.settingsPage(state.view(), await choicesOf()).value, "settings-model"));
  assert.deepEqual(withDefault.map((o) => o.value), ["", "s-1"]);
  const noDefault = optionsOf(selectOf(ui.settingsPage(state.view(), await choicesOf({ ...OPTIONS, defaultProviderId: null })).value, "settings-model"));
  assert.deepEqual(noDefault.map((o) => o.value), ["", "gpt-a", "gpt-b"]);
  const notReadyDefault = optionsOf(selectOf(ui.settingsPage(state.view(), await choicesOf({ ...OPTIONS, defaultProviderId: "claude" })).value, "settings-model"));
  assert.deepEqual(notReadyDefault.map((o) => o.value), ["", "gpt-a", "gpt-b"]);
});

test("choosing the default entries saves empty strings", async () => {
  const { h, state } = await loaded({ organizationProvider: "codex", organizationModel: "gpt-a" });
  const choices = await choicesOf();
  ui.changeProvider(state, choices, "");
  state.update("organizationModel", "");
  assert.deepEqual(state.view().dirtyKeys, ["organizationProvider", "organizationModel"]);
  await state.save();
  assert.equal(h.values.organizationProvider, "");
  assert.equal(h.values.organizationModel, "");
});

test("changing provider resets a model that the new list does not contain and keeps one that it does", async () => {
  const choices = await choicesOf();
  const { state } = await loaded({ organizationProvider: "codex", organizationModel: "gpt-a" });
  ui.changeProvider(state, choices, "ready2");
  assert.equal(state.view().draft.organizationProvider, "ready2");
  assert.equal(state.view().draft.organizationModel, "");
  const kept = await loaded({ organizationProvider: "ready2", organizationModel: "s-1" });
  ui.changeProvider(kept.state, choices, "");
  assert.equal(kept.state.view().draft.organizationModel, "s-1", "the default provider is ready2 so s-1 survives");
  const reset = await loaded({ organizationProvider: "codex", organizationModel: "gpt-a" });
  ui.changeProvider(reset.state, choices, "");
  assert.equal(reset.state.view().draft.organizationModel, "", "the default provider lists s-1 only");
  const empty = await loaded({ organizationProvider: "codex", organizationModel: "" });
  ui.changeProvider(empty.state, choices, "ready2");
  assert.deepEqual(empty.state.view().dirtyKeys, ["organizationProvider"]);
});

test("a saved provider or model that is not in the lists is kept and shown as unusable", async () => {
  const { state } = await loaded({ organizationProvider: "gone", organizationModel: "old-model" });
  const markup = ui.settingsPage(state.view(), await choicesOf()).value;
  const provider = optionsOf(selectOf(markup, "settings-provider"));
  const missing = provider.at(-1);
  assert.deepEqual([missing.value, missing.selected, missing.text], ["gone", true, "（目前設定：gone，現在無法使用）"]);
  const models = optionsOf(selectOf(markup, "settings-model"));
  assert.deepEqual([models.at(-1).value, models.at(-1).selected, models.at(-1).text], ["old-model", true, "（目前設定：old-model，現在無法使用）"]);
  assert.deepEqual(state.view().dirtyKeys, [], "rendering never rewrites the saved value");
  const stored = await loaded({ organizationProvider: "codex", organizationModel: "retired-model" });
  const storedModels = optionsOf(selectOf(ui.settingsPage(stored.state.view(), await choicesOf()).value, "settings-model"));
  assert.equal(storedModels.at(-1).value, "retired-model");
  assert.ok(storedModels.at(-1).selected);
});

test("a saved astra id is kept as unusable and never offered", async () => {
  const { state } = await loaded({ organizationProvider: "astra-x" });
  const provider = optionsOf(selectOf(ui.settingsPage(state.view(), await choicesOf()).value, "settings-provider"));
  assert.deepEqual(provider.map((o) => o.value), ["", "codex", "claude", "gemini", "ready2", "astra-x"]);
  assert.equal(provider.at(-1).text, "（目前設定：astra-x，現在無法使用）");
});

test("stored values and labels are escaped inside the menus", async () => {
  const { state } = await loaded({ organizationProvider: `"><img src=x>` });
  const raw = { ...OPTIONS, providers: [{ id: "p", label: `<b>x</b>`, state: "ready", models: [] }] };
  const markup = ui.settingsPage(state.view(), await choicesOf(raw)).value;
  assert.ok(!markup.includes("<img") && !markup.includes("<b>x"));
  assert.ok(markup.includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("without a usable getOptions the page falls back to the two text boxes", async () => {
  const { state } = await loaded({ organizationProvider: "typed", organizationModel: "m" });
  const failures = [
    () => undefined,
    () => ({}),
    () => ({ getOptions: async () => { throw Object.assign(new Error("denied"), { code: "plugin_permission_denied" }); } }),
    () => ({ getOptions: () => { throw new Error("sync"); } }),
    () => ({ getOptions: async () => ({ providers: "nope" }) }),
    () => { throw new Error("no bridge"); },
  ];
  for (const source of failures) {
    assert.equal(await ui.createAiOptionsClient(source).load(), null);
  }
  const markup = ui.settingsPage(state.view(), { status: "unavailable" }).value;
  assert.ok(markup.includes('<input id="settings-provider" data-setting-key="organizationProvider" type="text" value="typed"'));
  assert.ok(markup.includes('<input id="settings-model" data-setting-key="organizationModel" type="text" value="m"'));
  assert.ok(!markup.includes('<select id="settings-provider"'));
  assert.equal(ui.settingsPage(state.view()).value, markup, "the default rendering is the text boxes");
});

test("a getOptions that never answers times out and falls back", async () => {
  const started = Date.now();
  const options = await ui.createAiOptionsClient(() => ({ getOptions: () => new Promise(() => {}) }), 30).load();
  assert.equal(options, null);
  assert.ok(Date.now() - started < 2000);
});

test("while the options are loading the boxes are shown disabled, never as an empty menu", async () => {
  const { state } = await loaded({});
  const markup = ui.settingsPage(state.view(), { status: "pending" }).value;
  assert.match(markup, /<input id="settings-provider"[^>]*disabled/u);
  assert.match(markup, /<input id="settings-model"[^>]*disabled/u);
});

test("menus keep the label, help and status wiring of the text boxes", async () => {
  const { state } = await loaded({});
  const markup = ui.settingsPage(state.view(), await choicesOf()).value;
  assert.ok(markup.includes('<label for="settings-provider">'));
  assert.ok(markup.includes('<select id="settings-provider" data-setting-key="organizationProvider" aria-describedby="settings-provider-help settings-provider-effect settings-provider-status">'));
  assert.ok(markup.includes('<select id="settings-model" data-setting-key="organizationModel" aria-describedby="settings-model-help settings-model-effect settings-model-status">'));
});

test("the parser drops malformed providers and models instead of failing", async () => {
  const parsed = ui.parseAiOptions({ providers: [null, { id: "" }, { id: "a", label: "", state: "weird", models: [null, { id: "m" }, { id: "m" }, { id: "astra-model" }] }, { id: "a" }], defaultProviderId: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { providers: [{ id: "a", label: "a", state: "unavailable", models: [{ id: "m", label: "m" }] }], defaultProviderId: null });
  assert.equal(ui.parseAiOptions(null), null);
});
