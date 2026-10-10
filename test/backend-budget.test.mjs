import assert from "node:assert/strict";
import test from "node:test";
import { actor, assertContractResponse, contract, startBackend } from "./backendHarness.mjs";

const BUDGET = contract.MEMORY_LIMITS.inspectBudgetBytes;
const RESULT_LIMIT = contract.MEMORY_LIMITS.resultMaxBytes;
const cjk = (length, seed) => String.fromCharCode(0x4e00 + seed) + "測".repeat(length - 1);

function decode(cursor, limit) {
  if (cursor === undefined) return 0;
  const [bound, offset] = cursor.split(":").slice(1).map(Number);
  return bound === limit ? offset : undefined;
}

// why: mirrors Cairn, whose cursor is only valid for the limit it was issued with
function fakeCore(calls, weight, total = 40) {
  const page = (limit, cursor, shape) => {
    const offset = decode(cursor, limit);
    if (offset === undefined) return { ok: false, error: { code: "invalid_cursor", retryable: false } };
    calls.push({ limit, cursor });
    const end = Math.min(total, offset + limit);
    const rows = Array.from({ length: end - offset }, (_, index) => shape(offset + index));
    return { rows, next: end < total ? `c:${limit}:${end}` : null };
  };
  const unsupported = () => {
    throw new Error("not used by the contract");
  };
  return {
    list: ({ limit, cursor }) => {
      const found = page(limit, cursor, (index) => ({ id: `m${index}`, content: cjk(weight(index), index % 20) }));
      if (found.ok === false) return found;
      return { ok: true, value: { memories: found.rows, nextCursor: found.next, exhausted: found.next === null } };
    },
    get: ({ memoryId, receiptLimit, receiptCursor }) => {
      const found = page(receiptLimit, receiptCursor, (index) => ({ id: `r${index}`, excerpt: cjk(weight(index), index % 20) }));
      if (found.ok === false) return found;
      return {
        ok: true,
        value: { memory: { id: memoryId, content: cjk(4000, 3) }, receipts: found.rows, nextReceiptCursor: found.next, exhausted: found.next === null },
      };
    },
    admit: unsupported,
    correct: unsupported,
    forget: unsupported,
    recall: unsupported,
    capture: unsupported,
    close: () => undefined,
  };
}

function start(t, weight) {
  const calls = [];
  const started = startBackend(t, { openCore: () => fakeCore(calls, weight) });
  return { ...started, calls };
}

const inspect = async (backend, input) => {
  const response = await backend.call("memory.inspect@1", { actor, input });
  return assertContractResponse("memory.inspect@1", response);
};

test("eight-thousand-character CJK items use UTF-8 bytes and repeatedly halve the limit", async (t) => {
  const { backend, calls } = start(t, () => 8000);
  const response = await inspect(backend, { scope: "personal", limit: 12 });
  assert.deepEqual(calls.map((call) => call.limit), [12, 6, 3, 1]);
  assert.equal(response.appliedLimit, 1);
  assert.equal(response.result.ok, true);
  assert.equal(response.result.value.memories.length, 1);
  assert.equal(response.nextCursor, response.result.value.nextCursor);
  assert.ok(response.nextCursor.startsWith("c:1:"));
  const size = Buffer.byteLength(JSON.stringify(response), "utf8");
  assert.ok(size <= BUDGET, `size ${size}`);
  assert.ok(size <= RESULT_LIMIT);
});

test("halving repeats until the page fits", async (t) => {
  const { backend, calls } = start(t, () => 16000);
  const response = await inspect(backend, { scope: "personal", limit: 12 });
  assert.deepEqual(calls.map((call) => call.limit), [12, 6, 3, 1]);
  assert.equal(response.appliedLimit, 1);
  assert.equal(response.result.value.memories.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= BUDGET);
});

test("continuing with nextCursor and appliedLimit reads the whole set without gaps", async (t) => {
  const { backend } = start(t, () => 8000);
  const seen = [];
  let response = await inspect(backend, { scope: "personal", limit: 12 });
  for (;;) {
    seen.push(...response.result.value.memories.map((memory) => memory.id));
    if (response.nextCursor === undefined) break;
    response = await inspect(backend, { scope: "personal", limit: response.appliedLimit, cursor: response.nextCursor });
  }
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, index) => `m${index}`));
});

test("a page that already fits keeps the requested limit", async (t) => {
  const { backend, calls } = start(t, () => 1000);
  const response = await inspect(backend, { scope: "personal", limit: 12 });
  assert.deepEqual(calls.map((call) => call.limit), [12]);
  assert.equal(response.appliedLimit, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= BUDGET);
});

test("a single item over the budget is result_too_large after the limit reaches one", async (t) => {
  const { backend, calls } = start(t, () => 70000);
  await assert.rejects(backend.call("memory.inspect@1", { actor, input: { scope: "personal", limit: 12 } }), (error) => {
    assert.equal(error.code, "result_too_large");
    return true;
  });
  assert.deepEqual(calls.map((call) => call.limit), [12, 6, 3, 1]);
});

test("a continuation page over the budget cannot be halved because its cursor is bound to the limit", async (t) => {
  const { backend, calls } = start(t, (index) => (index < 6 ? 100 : 30000));
  const first = await inspect(backend, { scope: "personal", limit: 3 });
  const second = await inspect(backend, { scope: "personal", limit: 3, cursor: first.nextCursor });
  assert.equal(second.result.value.memories.length, 3);
  await assert.rejects(backend.call("memory.inspect@1", { actor, input: { scope: "personal", limit: 3, cursor: second.nextCursor } }), {
    code: "result_too_large",
  });
  assert.deepEqual(calls.map((call) => call.limit), [3, 3, 3]);
});

test("reading one memory halves its receipt page and reports nextReceiptCursor as nextCursor", async (t) => {
  const { backend, calls } = start(t, () => 6000);
  const response = await inspect(backend, { scope: "personal", memoryId: "mem-1", limit: 12 });
  assert.equal(calls[0].limit, 12);
  assert.ok(response.appliedLimit < 12);
  assert.equal(response.result.value.receipts.length, response.appliedLimit);
  assert.equal(response.nextCursor, response.result.value.nextReceiptCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= BUDGET);
});

test("the default limit is applied explicitly so an issued cursor stays valid", async (t) => {
  const { backend, calls } = start(t, () => 100);
  const first = await inspect(backend, { scope: "personal" });
  assert.equal(first.appliedLimit, 6);
  const second = await inspect(backend, { scope: "personal", cursor: first.nextCursor });
  assert.equal(second.result.ok, true);
  assert.deepEqual(calls.map((call) => call.limit), [6, 6]);
});

test("a cursor issued for another limit stays a per-call INVALID_INPUT result", async (t) => {
  const { backend } = start(t, () => 100);
  const first = await inspect(backend, { scope: "personal", limit: 3 });
  const wrong = await inspect(backend, { scope: "personal", limit: 4, cursor: first.nextCursor });
  assert.equal(wrong.result.ok, false);
  assert.equal(wrong.result.error.code, "INVALID_INPUT");
  assert.equal(wrong.appliedLimit, undefined);
});
