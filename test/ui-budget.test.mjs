import assert from "node:assert/strict";
import test from "node:test";
import { UI_RESPONSE_BUDGET_BYTES, clipCodePoints, fitToBudget, serializedBytes } from "../out/application/ui/budget.js";
import { jsonSafe } from "../out/application/ui/jsonSafe.js";

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(random, length) {
  const pieces = [];
  for (let index = 0; index < length; index += 1) {
    const roll = random();
    if (roll < 0.55) pieces.push(String.fromCodePoint(0x4e00 + Math.floor(random() * 0x51a5)));
    else if (roll < 0.7) pieces.push(String.fromCodePoint(0x1f600 + Math.floor(random() * 0x40)));
    else if (roll < 0.85) pieces.push(String.fromCharCode(0x20 + Math.floor(random() * 0x5f)));
    else if (roll < 0.93) pieces.push(['"', "\\", "\n", "\t", "\u0007", String.fromCharCode(0x2028)][Math.floor(random() * 6)]);
    else pieces.push(String.fromCodePoint(0xff01 + Math.floor(random() * 0x5e)));
  }
  return pieces.join("");
}

const responseOf = (kept, truncated) => ({
  ok: true,
  items: kept,
  nextCursor: truncated ? "cursor" : null,
});

test("serializedBytes counts UTF-8 bytes, which is what CJK text needs and .length does not give", () => {
  const cjk = "測".repeat(1000);
  assert.equal(JSON.stringify(cjk).length, 1002);
  assert.equal(serializedBytes(cjk), 3002);
  assert.equal(serializedBytes("😀"), 6, "an astral character is 4 bytes plus the two quotes");
  assert.equal(serializedBytes(undefined), 0);
  assert.equal(UI_RESPONSE_BUDGET_BYTES, 56_000);
});

test("CJK, emoji and escaped characters: no answer ever exceeds 56,000 bytes, and truncation keeps the longest prefix that fits", () => {
  const random = prng(20260930);
  let truncatedTrials = 0;
  let fullTrials = 0;
  for (let trial = 0; trial < 300; trial += 1) {
    const count = 1 + Math.floor(random() * 40);
    const items = Array.from({ length: count }, (_, index) => ({ id: `id-${trial}-${index}`, content: randomText(random, Math.floor(random() * 2500)) }));
    const result = fitToBudget(items, (kept) => responseOf(kept, kept.length < items.length));
    if (!result.ok) {
      assert.ok(serializedBytes(responseOf([items[0]], true)) > UI_RESPONSE_BUDGET_BYTES, "refused only when the first item alone is over budget");
      continue;
    }
    const answer = responseOf(result.kept, result.truncated);
    const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8");
    assert.ok(bytes <= UI_RESPONSE_BUDGET_BYTES, `trial ${trial}: ${bytes} bytes`);
    assert.equal(bytes, result.bytes);
    assert.deepEqual(result.kept, items.slice(0, result.kept.length));
    if (result.truncated) {
      truncatedTrials += 1;
      assert.ok(result.kept.length >= 1 && result.kept.length < items.length);
      const next = responseOf(items.slice(0, result.kept.length + 1), true);
      assert.ok(serializedBytes(next) > UI_RESPONSE_BUDGET_BYTES, `trial ${trial}: one more item would not fit`);
    } else {
      fullTrials += 1;
      assert.equal(result.kept.length, items.length);
    }
  }
  assert.ok(truncatedTrials >= 30 && fullTrials >= 30, `both branches are exercised (${truncatedTrials} truncated, ${fullTrials} whole)`);
});

test("a UTF-16 length check would have let an oversized CJK answer through, the byte budget cuts it", () => {
  const items = Array.from({ length: 24 }, (_, index) => ({ id: `id-${index}`, content: "測".repeat(1500) }));
  const whole = responseOf(items, false);
  assert.ok(JSON.stringify(whole).length < 56_000, "by .length the answer looks small enough");
  assert.ok(serializedBytes(whole) > 56_000, "by bytes it is not");
  const result = fitToBudget(items, (kept) => responseOf(kept, kept.length < items.length));
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(result.bytes <= 56_000);
  assert.equal(result.kept.length, 12);
});

test("an answer that cannot fit even with no items, or whose first item alone is too big, is result_too_large instead of a cursor loop", () => {
  assert.deepEqual(fitToBudget([], () => ({ pad: "測".repeat(20_000) })), { ok: false, code: "result_too_large" });
  const huge = [{ content: "測".repeat(20_000) }, { content: "small" }];
  assert.deepEqual(fitToBudget(huge, (kept) => responseOf(kept, kept.length < huge.length)), { ok: false, code: "result_too_large" });
  assert.deepEqual(fitToBudget([], () => responseOf([], false)), { ok: true, kept: [], truncated: false, bytes: serializedBytes(responseOf([], false)) });
  const tiny = fitToBudget([1, 2, 3], (kept) => ({ kept }), 30);
  assert.equal(tiny.ok, true);
  assert.equal(tiny.kept.length, 3);
});

test("clipCodePoints never splits a surrogate pair", () => {
  const text = "😀".repeat(10);
  assert.equal(clipCodePoints(text, 4), "😀".repeat(4));
  assert.equal(clipCodePoints(text, 10), text);
  assert.equal(clipCodePoints("abc", 5), "abc");
  assert.equal(clipCodePoints("測試資料", 2), "測試");
  assert.equal(clipCodePoints(`${text}x`, 3).isWellFormed(), true);
});

function containsUndefined(value) {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(containsUndefined);
  if (typeof value === "object" && value !== null) return Object.values(value).some(containsUndefined);
  return false;
}

test("the JSON exit removes undefined and NaN, so nothing the preload would reject leaves the backend", () => {
  const dirty = { a: undefined, b: [1, undefined, { c: undefined, d: Number.NaN, e: Infinity }], f: { g: undefined }, h: "測試", when: new Date(0) };
  assert.equal(containsUndefined(dirty), true);
  const clean = jsonSafe(dirty);
  assert.equal(containsUndefined(clean), false);
  assert.deepEqual(clean, { b: [1, null, { d: null, e: null }], f: {}, h: "測試", when: "1970-01-01T00:00:00.000Z" });
  assert.equal(jsonSafe(undefined), null);
  assert.deepEqual(jsonSafe(JSON.parse(JSON.stringify(clean))), clean);
});
