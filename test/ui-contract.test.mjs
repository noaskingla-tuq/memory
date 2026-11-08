import assert from "node:assert/strict";
import test from "node:test";
import {
  UI_FAILURE_CODES,
  UI_METHOD_NAMES,
  UI_METHOD_SCHEMAS,
  parseUiParams,
  parseUiResponse,
  uiFailureSchema,
} from "../out/contracts/uiContract.js";

const NOW = "2026-09-30T02:13:22.884Z";
const REF = { agentId: "sw/developer", scope: "personal", projectId: null, memoryId: "m-1" };
const ITEM = { ref: REF, kind: "context", revision: 2, updatedAt: NOW, snippet: "登入頁的表單驗證", receiptCount: 3 };
const WORK = { startIso: "2026-09-29T03:15:00.000Z", endIso: "2026-09-29T03:42:00.000Z", cli: "claude", model: "claude-opus-4-7", title: "修正登入頁" };

const SUCCESS = {
  "ui.overview": {
    ok: true,
    tiles: { totalMemories: 10, writtenToday: 2, activeAgents7d: 3, agents: 4, lastWriteAt: NOW },
    agents: [
      {
        id: "sw/developer",
        name: "開發工程師",
        team: { key: "sw", name: "軟體組" },
        counts: { personal: 4, projects: [{ projectId: "p1", count: 2 }], otherProjects: 0, total: 6 },
        lastAt: NOW,
        spark14: new Array(14).fill(1),
        latest: { snippet: "最新一筆", at: NOW },
      },
    ],
    nextCursor: null,
    profile: { generation: null, receivedAt: null },
    storage: { status: "ready", unavailableAgents: 0 },
  },
  "ui.agentStats": {
    ok: true,
    agentId: "sw/developer",
    namespaces: [{ scope: "personal", projectId: null, count: 4, firstAt: NOW, lastAt: NOW }],
    byDay30: [{ date: "2026-09-30", count: 2 }],
    byHour: new Array(24).fill(0),
    byWeekday: new Array(7).fill(0),
    tools: [{ cli: "claude", model: null, n: 2 }],
    repeatedRequests: [{ title: "修正登入頁", count: 2 }],
    representative: [ITEM],
    sampled: false,
  },
  "ui.list": { ok: true, items: [{ ...ITEM, work: WORK }], nextCursor: "abc.def" },
  "ui.search": { ok: true, items: [ITEM], nextCursor: null, scanned: { namespaces: 3, complete: true }, normalizedQuery: "登入", mode: "literal" },
  "ui.get": {
    ok: true,
    memory: { ref: REF, kind: "fact", revision: 1, createdAt: NOW, updatedAt: NOW, content: "完整內容" },
    receipts: [{ client: "claude", sessionId: "s1", eventId: "e1", role: "user", createdAt: NOW }],
    sameSession: [ITEM],
  },
  "ui.forget": { ok: true, forgotten: true },
  "ui.legacyTrial": { ok: true, action: "start", requested: 5, adopted: 5, candidates: 90, skippedAmbiguous: 0, blocked: null, trial: null },
  "ui.agentOrganization": { ok: true, action: "status", agentId: "team-a/agent-a", pending: 4, blocked: null, run: { agentId: "team-a/agent-a", state: "running", total: 4, done: 1, failed: 0, untried: 3, startedAt: 1, endedAt: null, lastError: null } },
  "ui.upgradeLegacy": { ok: true, upgraded: 1, failed: 1, results: [{ agentHash: "a".repeat(64), ok: true }, { agentHash: "b".repeat(64), ok: false, code: "STORAGE_BUSY" }], remaining: 0 },
  "ui.status": {
    ok: true,
    version: "1.0.0",
    cairnCommit: "83a10c3b7664b1f67485a19e7d84d24dcb3041a5",
    storage: { status: "ready" },
    profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: { pending: 0, lastWrittenAtMs: null } },
    lastWriteAt: null,
    uptimeSec: 12,
  },
};

const accepts = (method, params) => parseUiParams(method, params).ok;

test("every one of the ten ui.* methods has a request schema and a success schema", () => {
  assert.deepEqual(Object.keys(UI_METHOD_SCHEMAS).sort(), [...UI_METHOD_NAMES].sort());
  assert.equal(UI_METHOD_NAMES.length, 10);
  for (const method of UI_METHOD_NAMES) {
    assert.equal(typeof UI_METHOD_SCHEMAS[method].request.safeParse, "function", method);
    assert.equal(typeof UI_METHOD_SCHEMAS[method].success.safeParse, "function", method);
  }
});

test("a well formed sample of each success shape is accepted and any extra field is refused", () => {
  for (const method of UI_METHOD_NAMES) {
    assert.equal(parseUiResponse(method, SUCCESS[method]), true, method);
    assert.equal(parseUiResponse(method, { ...SUCCESS[method], leaked: 1 }), false, `${method} with an extra field`);
    assert.equal(parseUiResponse(method, { ...SUCCESS[method], ok: undefined }), false, `${method} without ok`);
  }
});

test("ui.get keeps its existing shape and refuses an uncontracted source field", () => {
  const old = SUCCESS["ui.get"];
  assert.equal(parseUiResponse("ui.get", old), true);
  assert.equal(parseUiResponse("ui.get", { ...old, source: "contains-work-record-summary" }), false);
});

test("failures use a closed code list and carry retryable", () => {
  for (const code of UI_FAILURE_CODES) assert.equal(uiFailureSchema.safeParse({ ok: false, code, retryable: false }).success, true, code);
  assert.equal(uiFailureSchema.safeParse({ ok: false, code: "INTERNAL", retryable: false }).success, false);
  assert.equal(uiFailureSchema.safeParse({ ok: false, code: "NOT_FOUND" }).success, false);
  assert.equal(parseUiResponse("ui.list", { ok: false, code: "CURSOR_STALE", retryable: false }), true);
});

test("ui.overview takes an offset, an exact ISO day start and a bounded limit with the documented default", () => {
  const base = { tzOffsetMin: 480, dayStartIso: "2026-09-30T00:00:00.000Z" };
  const parsed = parseUiParams("ui.overview", base);
  assert.deepEqual(parsed, { ok: true, value: { ...base, limit: 60 } });
  assert.equal(accepts("ui.overview", { ...base, limit: 200 }), true);
  assert.equal(accepts("ui.overview", { ...base, limit: 201 }), false);
  assert.equal(accepts("ui.overview", { ...base, limit: 0 }), false);
  assert.equal(accepts("ui.overview", { ...base, tzOffsetMin: 841 }), false);
  assert.equal(accepts("ui.overview", { ...base, tzOffsetMin: 1.5 }), false);
  assert.equal(accepts("ui.overview", { ...base, dayStartIso: "2026-09-30" }), false);
  assert.equal(accepts("ui.overview", { ...base, dayStartIso: "2026-09-30T00:00:00Z" }), false, "Cairn times carry milliseconds");
  assert.equal(accepts("ui.overview", { ...base, dayStartIso: "2026-02-30T00:00:00.000Z" }), false, "a date that does not exist is refused");
  assert.equal(accepts("ui.overview", { ...base, cursor: "x".repeat(1025) }), false);
  assert.equal(accepts("ui.overview", { ...base, extra: true }), false);
  assert.equal(accepts("ui.overview", { tzOffsetMin: 480 }), false);
});

test("ui.list and ui.search bound the page size and the query, and keep scope and projectId consistent", () => {
  assert.deepEqual(parseUiParams("ui.list", {}), { ok: true, value: { limit: 12 } });
  assert.equal(accepts("ui.list", { limit: 24 }), true);
  assert.equal(accepts("ui.list", { limit: 25 }), false);
  assert.equal(accepts("ui.list", { scope: "personal", projectId: "p1" }), false);
  assert.equal(accepts("ui.list", { scope: "project", projectId: "p1", cli: "claude", sinceIso: "2026-09-01T00:00:00.000Z", untilIso: NOW }), true);
  assert.equal(accepts("ui.list", { sinceIso: "yesterday" }), false);
  assert.equal(accepts("ui.list", { q: "x" }), false);
  assert.equal(accepts("ui.search", { q: "登入" }), true);
  assert.equal(accepts("ui.search", { q: "" }), false);
  assert.equal(accepts("ui.search", { q: "x".repeat(100) }), true);
  assert.equal(accepts("ui.search", { q: "x".repeat(101) }), false);
  assert.equal(accepts("ui.search", { limit: 5 }), false, "q is required");
});

test("ui.get and ui.forget need a complete reference whose projectId matches its scope", () => {
  assert.equal(accepts("ui.get", REF), true);
  assert.equal(accepts("ui.get", { ...REF, scope: "project", projectId: "p1" }), true);
  assert.equal(accepts("ui.get", { ...REF, scope: "project", projectId: null }), false);
  assert.equal(accepts("ui.get", { ...REF, projectId: "p1" }), false);
  assert.equal(accepts("ui.get", { ...REF, memoryId: "" }), false);
  assert.equal(accepts("ui.get", { agentId: REF.agentId }), false);
  assert.equal(accepts("ui.forget", { ...REF, expectedRevision: 3 }), true);
  assert.equal(accepts("ui.forget", { ...REF, expectedRevision: 0 }), false);
  assert.equal(accepts("ui.forget", { ...REF, expectedRevision: 1.5 }), false);
  assert.equal(accepts("ui.forget", REF), false);
  assert.equal(accepts("ui.agentStats", { agentId: "a", tzOffsetMin: 0 }), true);
  assert.equal(accepts("ui.agentStats", { agentId: "a" }), false);
  assert.equal(accepts("ui.status", {}), true);
  assert.equal(accepts("ui.status", { x: 1 }), false);
});

test("response limits are enforced: snippets count code points, content stops at 4000, receipts at 12, sameSession at 8", () => {
  const emoji160 = "😀".repeat(160);
  assert.equal(parseUiResponse("ui.list", { ok: true, items: [{ ...ITEM, snippet: emoji160 }], nextCursor: null }), true, "160 code points of 2 units each are allowed");
  assert.equal(parseUiResponse("ui.list", { ok: true, items: [{ ...ITEM, snippet: `${emoji160}x` }], nextCursor: null }), false);
  const get = SUCCESS["ui.get"];
  assert.equal(parseUiResponse("ui.get", { ...get, memory: { ...get.memory, content: "測".repeat(4000) } }), true);
  assert.equal(parseUiResponse("ui.get", { ...get, memory: { ...get.memory, content: "測".repeat(4001) } }), false);
  assert.equal(parseUiResponse("ui.get", { ...get, receipts: new Array(13).fill(get.receipts[0]) }), false);
  assert.equal(parseUiResponse("ui.get", { ...get, sameSession: new Array(9).fill(ITEM) }), false);
  assert.equal(parseUiResponse("ui.overview", { ...SUCCESS["ui.overview"], agents: [{ ...SUCCESS["ui.overview"].agents[0], spark14: [1, 2, 3] }] }), false);
});
