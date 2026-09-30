import assert from "node:assert/strict";
import test from "node:test";
import { loadUiModule } from "./uiViewHarness.mjs";

const { STRINGS, t } = await loadUiModule("i18n/zhTW.ts", "i18n/index.ts");

const MAINLAND_TERMS = ["程序", "信息", "軟件", "默認", "內存", "服務器", "網絡", "數據", "登錄", "用戶", "視頻", "質量", "打印", "文件夾", "保存", "設置", "頻道"];
const SIMPLIFIED_ONLY = "这个们说为时间过应该发现开关状态读写务设据错误实户录软络认证类别问题选择删显确杂无从员专项参数总结调试载页记忆";

test("the string table is Traditional Chinese with Taiwan wording: no 程序, no mainland terms, no simplified characters", () => {
  const entries = Object.entries(STRINGS);
  assert.ok(entries.length >= 60);
  for (const [key, value] of entries) {
    assert.ok(value.trim().length > 0, key);
    for (const term of MAINLAND_TERMS) assert.ok(!value.includes(term), `${key} uses ${term}`);
    for (const char of value) assert.ok(!SIMPLIFIED_ONLY.includes(char), `${key} has simplified character ${char}`);
  }
  assert.ok(!Object.values(STRINGS).join("").includes("程序"));
});

test("every string is trimmed, has no doubled spaces, and uses full-width punctuation next to Chinese text", () => {
  for (const [key, value] of Object.entries(STRINGS)) {
    assert.equal(value, value.trim(), key);
    assert.ok(!/ {2,}/u.test(value), key);
    assert.ok(!/[一-鿿][,;:?!]|[,;:?!][一-鿿]/u.test(value), `${key} uses half-width punctuation next to Chinese text`);
  }
});

test("t fills placeholders, keeps unknown ones, and coerces numbers", () => {
  assert.equal(t("status.detail", { version: "1.2.3", storage: "ready" }), "版本 1.2.3，儲存狀態 ready");
  assert.equal(t("status.detail", { version: 7 }), "版本 7，儲存狀態 {storage}");
  assert.equal(t("app.title"), "記憶");
  for (const [key, value] of Object.entries(STRINGS)) {
    const names = [...value.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((match) => match[1]);
    const params = Object.fromEntries(names.map((name) => [name, "X"]));
    assert.ok(!/\{[A-Za-z0-9_]+\}/u.test(t(key, params)), `${key} leaves a placeholder unfilled`);
  }
});

test("every error string comes as a message and an action pair", () => {
  const keys = Object.keys(STRINGS).filter((key) => key.startsWith("error."));
  assert.ok(keys.length >= 50);
  for (const key of keys) {
    const [, code, part] = key.split(".");
    assert.ok(part === "message" || part === "action", key);
    const twin = `error.${code}.${part === "message" ? "action" : "message"}`;
    assert.ok(twin in STRINGS, `${key} has its twin ${twin}`);
  }
});
