import assert from "node:assert/strict";
import test from "node:test";
import { loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule(
  "api/settingsClient.ts",
  "state/settings.ts",
  "views/settingsView.ts",
  "router.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/settingsStrings.ts",
);

function fakeHost(initial = {}) {
  const values = { ...initial };
  const calls = [];
  const host = {
    values,
    calls,
    failSet: null,
    failGet: null,
    ignoreSet: null,
    applyThenFailSet: false,
    api: {
      async all() {
        calls.push(["all"]);
        return { ...values };
      },
      async get(key) {
        calls.push(["get", key]);
        if (host.failGet === key) {
          host.failGet = null;
          throw new Error("synthetic get failure");
        }
        return values[key];
      },
      async set(key, value) {
        calls.push(["set", key, value]);
        if (host.failSet === key && !host.applyThenFailSet) {
          host.failSet = null;
          throw new Error("synthetic write failure");
        }
        if (host.ignoreSet !== key) values[key] = value;
        if (host.failSet === key) {
          host.failSet = null;
          host.applyThenFailSet = false;
          throw new Error("synthetic write response lost after applying");
        }
        return true;
      },
    },
  };
  return host;
}

test("the settings route is explicit and keeps existing home and agent routes", () => {
  assert.deepEqual(ui.parseRoute("#/settings"), { name: "settings" });
  assert.deepEqual(ui.parseRoute("#/"), { name: "home" });
  assert.deepEqual(ui.parseRoute("#/agent/sw%2Fdeveloper"), { name: "agent", agentId: "sw/developer" });
});

test("load normalizes consumer values and ignores unknown host keys", async () => {
  const host = fakeHost({
    organizationEnabled: "false",
    organizationProvider: "  provider-x  ",
    organizationModel: "m".repeat(130),
    organizationContextBudget: 8193,
    unknownHostKey: "keep this at host",
  });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  const snapshot = state.view();
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.baseline.organizationEnabled, true, "only boolean false disables organization");
  assert.equal(snapshot.baseline.organizationProvider, "provider-x");
  assert.equal(snapshot.baseline.organizationModel, "m".repeat(128));
  assert.equal(snapshot.baseline.organizationContextBudget, 8193, "an in-range off-step host value is not rounded");
  assert.equal(snapshot.budgetIssue, "off-step");
  assert.deepEqual(snapshot.dirtyKeys, []);
  assert.equal(host.values.unknownHostKey, "keep this at host");
});

test("invalid stored budgets use the consumer default without writing on load", async () => {
  const host = fakeHost({ organizationContextBudget: 7, organizationEnabled: false });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  assert.equal(state.view().baseline.organizationContextBudget, 32768);
  assert.equal(state.view().budgetIssue, "invalid");
  assert.deepEqual(host.calls, [["all"]]);
  state.update("organizationContextBudget", 40960);
  assert.deepEqual(state.view().dirtyKeys, ["organizationContextBudget"]);
  assert.equal(state.view().budgetIssue, null);
});

test("frequency and daily time use conservative defaults for missing or invalid legacy values", async () => {
  const host = fakeHost({ organizationFrequency: "weekly", organizationDailyTime: "24:00" });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  assert.equal(state.view().baseline.organizationFrequency, "daily");
  assert.equal(state.view().baseline.organizationDailyTime, "02:00");
  assert.equal(state.view().dailyTimeIssue, null);
  assert.deepEqual(host.calls, [["all"]], "loading legacy values never rewrites host settings");

  const missing = ui.createSettingsState(ui.createSettingsClient(() => fakeHost().api));
  await missing.load();
  assert.equal(missing.view().baseline.organizationFrequency, "daily");
  assert.equal(missing.view().baseline.organizationDailyTime, "02:00");
});

test("schedule settings save in a mode-safe order and keep unrelated host values", async () => {
  const host = fakeHost({ organizationFrequency: "daily", organizationDailyTime: "02:00", untouchedHostKey: "keep" });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationDailyTime", "08:15");
  state.update("organizationFrequency", "immediate");
  state.update("organizationProvider", "provider-new");
  await state.save();
  assert.deepEqual(host.calls.filter(([method]) => method === "set").map(([, key, value]) => [key, value]), [
    ["organizationProvider", "provider-new"],
    ["organizationFrequency", "immediate"],
    ["organizationDailyTime", "08:15"],
  ]);
  assert.equal(host.values.untouchedHostKey, "keep");
  assert.equal(host.values.organizationDailyTime, "08:15", "switching to immediate retains the selected daily time");

  host.calls.length = 0;
  state.update("organizationFrequency", "daily");
  state.update("organizationDailyTime", "09:30");
  await state.save();
  assert.deepEqual(host.calls.filter(([method]) => method === "set").map(([, key, value]) => [key, value]), [
    ["organizationDailyTime", "09:30"],
    ["organizationFrequency", "daily"],
  ]);
});

test("enabling a disabled plugin applies its target schedule before enabling work", async () => {
  const host = fakeHost({ organizationEnabled: false, organizationFrequency: "immediate", organizationDailyTime: "02:00" });
  const snapshots = [];
  const set = host.api.set;
  host.api.set = async (key, value) => {
    const result = await set(key, value);
    snapshots.push({ ...host.values });
    return result;
  };
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationEnabled", true);
  state.update("organizationDailyTime", "23:00");
  state.update("organizationFrequency", "daily");
  await state.save();
  assert.deepEqual(host.calls.filter(([method]) => method === "set").map(([, key]) => key), [
    "organizationDailyTime", "organizationFrequency", "organizationEnabled",
  ]);
  assert.ok(snapshots.slice(0, -1).every((values) => values.organizationEnabled === false));
  assert.deepEqual(snapshots.at(-1), { organizationEnabled: true, organizationFrequency: "daily", organizationDailyTime: "23:00" });
  assert.equal(state.view().lastSave, "saved");
});

test("a failed schedule write reports partial success and retries only the unconfirmed value", async () => {
  const host = fakeHost({ organizationFrequency: "immediate", organizationDailyTime: "02:00" });
  host.failSet = "organizationFrequency";
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationDailyTime", "23:00");
  state.update("organizationFrequency", "daily");
  await state.save();
  assert.equal(state.view().lastSave, "partial");
  assert.equal(state.view().savedCount, 1);
  assert.deepEqual(state.view().dirtyKeys, ["organizationFrequency"]);
  assert.equal(host.values.organizationDailyTime, "23:00");
  assert.equal(host.values.organizationFrequency, "immediate", "a failed mode switch leaves the runtime in the known prior mode");
  await state.save();
  assert.equal(state.view().lastSave, "saved");
  assert.equal(host.values.organizationFrequency, "daily");
  assert.deepEqual(host.calls.filter(([method]) => method === "set").map(([, key]) => key), [
    "organizationDailyTime", "organizationFrequency", "organizationFrequency",
  ]);
});

test("invalid daily time is announced and cannot be written until corrected", async () => {
  const host = fakeHost();
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationDailyTime", "24:00");
  const invalid = state.view();
  const markup = ui.settingsPage(invalid).value;
  assert.equal(invalid.dailyTimeIssue, "invalid");
  assert.ok(markup.includes("aria-invalid=\"true\""));
  assert.ok(markup.includes("00:00 到 23:59"));
  assert.ok(markup.includes('data-settings-action="save" disabled'));
  await state.save();
  assert.deepEqual(host.calls.filter(([method]) => method === "set"), []);

  state.update("organizationDailyTime", "23:59");
  await state.save();
  assert.equal(state.view().lastSave, "saved");
  assert.equal(host.values.organizationDailyTime, "23:59");
});

test("save writes only dirty allowlisted keys in order and confirms each value by readback", async () => {
  const host = fakeHost({ organizationProvider: "p0", organizationModel: "m0", untouchedHostKey: 42 });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationProvider", "  p1  ");
  state.update("organizationModel", "m1");
  await state.save();
  assert.deepEqual(host.calls.filter(([method]) => method === "set"), [
    ["set", "organizationProvider", "p1"],
    ["set", "organizationModel", "m1"],
  ]);
  assert.deepEqual(host.calls.filter(([method]) => method === "get"), [
    ["get", "organizationProvider"],
    ["get", "organizationModel"],
  ]);
  assert.equal(state.view().lastSave, "saved");
  assert.deepEqual(state.view().dirtyKeys, []);
  assert.equal(host.values.untouchedHostKey, 42);
  assert.equal(host.values.organizationProvider, "p1");
  const reloaded = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await reloaded.load();
  assert.equal(reloaded.view().baseline.organizationProvider, "p1");
  assert.equal(reloaded.view().baseline.organizationModel, "m1");
});

test("a middle write failure reports partial success and cancel keeps confirmed host writes", async () => {
  const host = fakeHost({ organizationProvider: "p0", organizationModel: "m0", organizationContextBudget: 32768 });
  host.failSet = "organizationModel";
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationProvider", "p1");
  state.update("organizationModel", "m1");
  state.update("organizationContextBudget", 40960);
  await state.save();
  assert.equal(state.view().lastSave, "partial");
  assert.equal(state.view().savedCount, 1);
  assert.deepEqual(state.view().dirtyKeys, ["organizationModel", "organizationContextBudget"]);
  assert.equal(state.view().outcomes.organizationProvider, "saved");
  assert.equal(state.view().outcomes.organizationModel, "failed");
  assert.deepEqual(host.calls.filter(([method]) => method === "set").map((call) => call[1]), ["organizationProvider", "organizationModel"]);
  assert.equal(state.cancel(), true);
  assert.equal(host.values.organizationProvider, "p1");
  assert.equal(state.view().baseline.organizationProvider, "p1");
  assert.equal(state.view().draft.organizationModel, "m0");
  assert.equal(state.view().draft.organizationContextBudget, 32768);
  assert.deepEqual(state.view().dirtyKeys, []);
});

test("an unknown write result blocks cancel and is read back before another write or success claim", async () => {
  const host = fakeHost({ organizationProvider: "p0" });
  host.failSet = "organizationProvider";
  host.failGet = "organizationProvider";
  host.applyThenFailSet = true;
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationProvider", "p1");
  await state.save();
  assert.equal(state.view().lastSave, "unknown");
  assert.equal(state.view().hasUnknown, true);
  assert.equal(state.cancel(), false);
  await state.save();
  assert.equal(state.view().lastSave, "saved");
  assert.equal(state.view().hasUnknown, false);
  assert.equal(state.view().dirtyKeys.length, 0);
  assert.equal(host.values.organizationProvider, "p1");
  assert.equal(host.calls.filter(([method]) => method === "set").length, 1, "readback confirmed the first write, so retry did not write twice");
  assert.deepEqual(host.calls.slice(-1), [["get", "organizationProvider"]]);
});

test("a readback that finds a different host value records a conflict instead of silently overwriting it", async () => {
  const host = fakeHost({ organizationProvider: "p0" });
  host.ignoreSet = "organizationProvider";
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  state.update("organizationProvider", "p1");
  await state.save();
  assert.equal(state.view().outcomes.organizationProvider, "failed", "host still had the confirmed pre-write value");
  assert.equal(state.view().dirtyKeys.length, 1);
  host.values.organizationProvider = "p-external";
  host.failSet = "organizationProvider";
  await state.save();
  assert.equal(state.view().outcomes.organizationProvider, "conflict");
  assert.equal(state.view().baseline.organizationProvider, "p-external");
  assert.equal(state.view().draft.organizationProvider, "p1");
  assert.deepEqual(host.calls.filter(([method]) => method === "set").map((call) => call[1]), ["organizationProvider", "organizationProvider"]);
  assert.equal(state.cancel(), true);
  assert.equal(state.view().draft.organizationProvider, "p-external");
});

test("a stale earlier route load cannot replace the latest host settings", async () => {
  let resolveFirst;
  let resolveSecond;
  let count = 0;
  const client = {
    all() {
      count += 1;
      return new Promise((resolve) => {
        if (count === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    },
    async get() { return undefined; },
    async set() { return true; },
  };
  const state = ui.createSettingsState(client);
  const first = state.load();
  const second = state.load();
  resolveSecond({ organizationProvider: "latest" });
  await second;
  resolveFirst({ organizationProvider: "stale" });
  await first;
  assert.equal(state.view().baseline.organizationProvider, "latest");
});

test("unsupported and permission failures do not present editable defaults", async () => {
  const unsupported = ui.createSettingsState(ui.createSettingsClient(() => undefined));
  await unsupported.load();
  assert.equal(unsupported.view().phase, "unsupported");
  assert.equal(ui.settingsPage(unsupported.view()).value.includes("data-setting-key"), false);
  const denied = ui.createSettingsState({ async all() { throw Object.assign(new Error("denied"), { code: "plugin_permission_denied" }); }, async get() { return undefined; }, async set() { return true; } });
  await denied.load();
  assert.equal(denied.view().phase, "permission-error");
  assert.equal(ui.settingsPage(denied.view()).value.includes("type=\"text\""), false);
});

test("rendered controls are labelled, escaped and show invalid-budget guidance", async () => {
  const host = fakeHost({ organizationProvider: `<img src=x onerror="x">`, organizationContextBudget: -1 });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  const markup = ui.settingsPage(state.view()).value;
  assert.ok(markup.includes("settings-budget-issue"));
  assert.ok(markup.includes("儲存值無效"));
  assert.ok(markup.includes("&lt;img src=x onerror=&quot;x&quot;&gt;"));
  assert.ok(!markup.includes("<img") && !markup.includes("onerror=\"x\""));
  assert.ok(markup.includes('aria-describedby="settings-provider-help settings-provider-status"'));
  assert.ok(markup.includes('type="range" min="8192" max="262144" step="8192"'));
  assert.ok(markup.includes('id="settings-frequency" data-setting-key="organizationFrequency"'));
  assert.ok(markup.includes("每天一輪") && markup.includes("即時整理"));
  assert.ok(markup.includes('id="settings-daily-time" data-setting-key="organizationDailyTime" type="time"'));
  assert.ok(markup.includes("本機時間"));
  assert.ok(markup.includes("不要填 API 金鑰"));
});

test("daily time is disabled in immediate mode while the saved value remains visible", async () => {
  const host = fakeHost({ organizationFrequency: "immediate", organizationDailyTime: "07:45" });
  const state = ui.createSettingsState(ui.createSettingsClient(() => host.api));
  await state.load();
  const markup = ui.settingsPage(state.view()).value;
  assert.equal(state.view().draft.organizationDailyTime, "07:45");
  assert.ok(markup.includes('value="07:45"') && markup.includes('id="settings-daily-time"'));
  assert.match(markup, /id="settings-daily-time"[^>]*disabled/u);
  assert.ok(markup.includes("即時整理不使用此時間"));
});
