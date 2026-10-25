import assert from "node:assert/strict";
import test from "node:test";
import { AGENT, MINUTE, NOW, det, fail, getResponse, hhmm, iso, refOf, siblingItem, workContent } from "./detailFixtures.mjs";
import { tokenize } from "./timelineFixtures.mjs";

const { STRINGS, t } = det;

const TAGS = new Set(["b", "button", "details", "div", "h3", "li", "p", "pre", "span", "strong", "summary", "ul"]);
const ATTRIBUTES = new Set(["aria-disabled", "aria-hidden", "aria-label", "aria-live", "class", "data-code", "data-dt", "data-dt-key", "data-dt-notice", "role", "title", "type"]);

function assertSafe(markup, label) {
  const { tags, rest } = tokenize(markup);
  assert.ok(!/[<>]/u.test(rest), `${label}: a raw angle bracket survived outside the recognised tags: ${rest.match(/.{0,30}[<>].{0,30}/u)?.[0]}`);
  for (const tag of tags) {
    assert.ok(TAGS.has(tag.name), `${label}: unexpected tag <${tag.name}>`);
    for (const [name, value] of tag.attributes) {
      assert.ok(ATTRIBUTES.has(name), `${label}: unexpected attribute ${name} on <${tag.name}>`);
      assert.ok(value === null || !/[<>"]/u.test(value), `${label}: attribute ${name} carries a raw bracket or quote`);
    }
  }
}

const ready = (response, extra = {}) => ({ phase: "ready", ref: response.memory.ref, data: det.parseDetail(response), error: null, notice: null, forgetting: false, ...extra });
const body = (view) => det.renderDetailBody(view).value;
const foot = (view) => det.renderDetailFoot(view).value;

test("a ready drawer tells who wrote what, when it was written, when the work ran, the request, the result and the scope", () => {
  const view = ready(getResponse());
  const markup = body(view);
  assert.ok(markup.includes("<b>開發小幫手</b>"));
  assert.ok(markup.includes('<span class="badge">個人</span>'));
  const written = new Date(NOW - 60 * MINUTE);
  assert.ok(markup.includes(`寫入 ${written.getFullYear()}-09-30 ${hhmm(written.getTime())}`), "the write time carries its date");
  assert.ok(markup.includes(`工作 ${hhmm(NOW - 90 * MINUTE)}～${hhmm(NOW - 60 * MINUTE)}（耗時 30 分鐘）`), "the work span is a different thing from the write time");
  assert.ok(markup.includes("<span>claude/opus-4</span>"));
  assert.ok(markup.includes('<h3 class="dr-h">請求</h3><div class="dr-txt">整理週報</div>'));
  assert.ok(markup.includes('<h3 class="dr-h">成果</h3><div class="dr-txt">已整理完成</div>'));
  assert.ok(markup.includes("<p><span class=\"badge\">個人</span> 不屬於任何專案</p>"));
  assertSafe(markup, "ready");
});

test("the detail drawer explains automatic organization without attributing the current memory", () => {
  const markup = body(ready(getResponse()));
  assert.ok(markup.includes("外掛自動整理功能"));
  assert.ok(markup.includes("啟用時，整理流程會使用已結案工作紀錄的工作名稱與成果摘要作為輸入"));
  assert.ok(markup.includes("這是功能的一般說明，不判定目前記憶的來源"));
  assert.ok(markup.includes("其他明確寫入方式也可能建立記憶"));
  assertSafe(markup, "automatic organization explanation");
  const manual = body(ready(getResponse({ content: "一筆手動寫入的筆記", work: null })));
  assert.ok(manual.includes("這是功能的一般說明，不判定目前記憶的來源"));
});

test("the receipts list each tool, conversation, role and time; none says so, and a full page says it is capped", () => {
  const two = getResponse({
    receipts: [
      { client: "claude", sessionId: "S-100", eventId: "ev-1", role: "user", createdAt: iso(NOW - 75 * MINUTE) },
      { client: "codex", sessionId: "S-200", eventId: "ev-2", role: "assistant", createdAt: iso(NOW - 70 * MINUTE) },
    ],
  });
  const markup = body(ready(two));
  assert.ok(markup.includes("來源（收據）"));
  assert.ok(markup.includes("claude・對話 S-100・使用者的訊息・"));
  assert.ok(markup.includes("codex・對話 S-200・助理的訊息・"));
  assert.ok(markup.includes('title="ev-1"'));
  assert.ok(!markup.includes("最多列出"));
  assert.ok(body(ready(getResponse({ receipts: [] }))).includes("沒有收據紀錄。"));
  const capped = Array.from({ length: 12 }, (_, index) => ({ client: "claude", sessionId: `S-${index}`, eventId: `e${index}`, role: "user", createdAt: iso(NOW) }));
  assert.ok(body(ready(getResponse({ receipts: capped }))).includes("最多列出 12 筆收據。"));
});

test("a memory with no text says so, whether it is a work record with an empty result or plain text that is empty", () => {
  const emptyResult = getResponse({ content: workContent({ body: "" }) });
  assert.ok(body(ready(emptyResult)).includes('<div class="dr-txt">（沒有文字內容）</div>'));
  const plainEmpty = getResponse({ content: "", work: null });
  const markup = body(ready(plainEmpty));
  assert.ok(markup.includes('<div class="dr-txt">（沒有文字內容）</div>'));
  assert.ok(!markup.includes("請求"), "no request section without a request");
  assert.ok(!/undefined|null|NaN/u.test(markup));
});

test("plain text that is not a work record is shown whole under 內容, with no request and no work span", () => {
  const plain = getResponse({ content: "一筆手動寫入的筆記", work: null });
  const markup = body(ready(plain));
  assert.ok(markup.includes('<h3 class="dr-h">內容</h3><div class="dr-txt">一筆手動寫入的筆記</div>'));
  assert.ok(!markup.includes('<h3 class="dr-h">成果</h3>') && !markup.includes('<h3 class="dr-h">請求</h3>') && !markup.includes("<span>工作 "));
});

test("the original text of the memory is one click away inside a details element", () => {
  const response = getResponse();
  const markup = body(ready(response));
  assert.ok(markup.includes("<details"));
  assert.ok(markup.includes("<summary>看原始文字（記憶庫裡實際存的內容）</summary>"));
  assert.ok(markup.includes(`<pre>${response.memory.content}</pre>`));
});

test("a project memory shows the project's name and id; without a name it degrades to the short id", () => {
  const named = getResponse({ ref: refOf("p1", { scope: "project", projectId: "proj_abcdefghij" }), names: { agent: { displayName: "開發小幫手", teamKey: "sw" }, project: { displayName: "官網改版" } } });
  const markup = body(ready(named));
  assert.ok(markup.includes('<span class="badge">專案：官網改版</span>'));
  assert.ok(markup.includes('<span class="muted mono">proj_abcdefghij</span>'));
  const unnamed = { ...getResponse({ ref: refOf("p1", { scope: "project", projectId: "proj_abcdefghij" }) }), names: undefined };
  const degraded = body(ready(unnamed));
  assert.ok(degraded.includes("專案：專案 proj_abc"));
  assert.ok(degraded.includes(`<b>${AGENT}</b>`), "without a name table the agent shows by id");
});

test("the other memories of the same session are buttons that carry a key and an accessible name, and none means no section", () => {
  const response = getResponse({ sameSession: [siblingItem("m2"), siblingItem("m3", { snippet: "  ", work: { startIso: iso(NOW), endIso: iso(NOW), cli: null, model: null, title: "另一個請求" } })] });
  const markup = body(ready(response));
  assert.ok(markup.includes("同一次工作的其他記憶（2）"));
  const keys = [...markup.matchAll(/data-dt="sibling" data-dt-key="([^"]*)"/gu)].map((match) => JSON.parse(match[1].replaceAll("&quot;", '"'))[3]);
  assert.deepEqual(keys, ["m2", "m3"]);
  assert.match(markup, /<button type="button" class="sib" data-dt="sibling"[^>]*aria-label="[^"]*在這個抽屜開啟這筆記憶">/u);
  assert.ok(markup.includes("另一個請求") && markup.includes("同次工作的 m2"));
  assert.ok(!body(ready(getResponse())).includes("同一次工作的其他記憶"));
});

test("the footer offers exactly one action, forgetting this one memory, and says it only removes this one", () => {
  const markup = foot(ready(getResponse()));
  assert.ok(markup.includes("只會刪除這一筆記憶"));
  assert.match(markup, /<button type="button" class="btn btn-danger-outline" data-dt="forget" aria-disabled="false">遺忘這筆記憶…<\/button>/u);
  assert.equal([...markup.matchAll(/<button/gu)].length, 1);
  const busy = foot(ready(getResponse(), { forgetting: true }));
  assert.ok(busy.includes('aria-disabled="true"') && busy.includes("正在遺忘…"));
  assert.equal(foot({ ...ready(getResponse()), phase: "loading", data: null }), "");
  assert.equal(foot({ phase: "error", ref: refOf("m1"), data: null, error: fail("NOT_FOUND"), notice: null, forgetting: false }), "");
});

test("the drawer never offers to edit a memory or to open its conversation", () => {
  const response = getResponse({ sameSession: [siblingItem("m2")] });
  const all = body(ready(response)) + foot(ready(response));
  const actions = new Set([...all.matchAll(/data-dt="([^"]*)"/gu)].map((match) => match[1]));
  assert.deepEqual([...actions].sort(), ["forget", "sibling"]);
  assert.ok(!/開啟原對話|修改|編輯/u.test(all));
  for (const text of Object.values(STRINGS)) assert.ok(!/開啟原對話|修改記憶/u.test(text), text);
});

test("loading is a polite status with a screen-reader sentence, not an empty drawer", () => {
  const markup = body({ phase: "loading", ref: refOf("m1"), data: null, error: null, notice: null, forgetting: false });
  assert.ok(markup.includes('role="status"') && markup.includes("正在讀取這筆記憶…"));
  assert.ok(markup.includes('aria-hidden="true"'));
  assertSafe(markup, "loading");
});

test("an error says what happened in plain words and offers one action: retry when it can work, or closing and refreshing when the memory is gone", () => {
  const view = (error) => ({ phase: "error", ref: refOf("m1"), data: null, error, notice: null, forgetting: false });
  const busy = body(view(fail("STORAGE_BUSY")));
  assert.ok(busy.includes('role="alert"') && busy.includes('data-code="STORAGE_BUSY"') && busy.includes("記憶庫正忙著寫入。"));
  assert.ok(busy.includes('data-dt="retry"') && !busy.includes("closeReload"));
  assert.ok(!busy.includes("STORAGE_BUSY</"), "the raw code is only in the attribute");
  const gone = body(view(fail("NOT_FOUND")));
  assert.ok(gone.includes('data-dt="closeReload"') && gone.includes("關閉並重新整理清單") && !gone.includes('data-dt="retry"'));
  const invalid = body(view(fail("INVALID_PARAMS")));
  assert.ok(!invalid.includes("<button"), "an error that cannot be retried offers no button");
  assertSafe(busy + gone + invalid, "errors");
});

test("a conflict notice and a failed-forget notice sit above the content, each as an alert", () => {
  const conflict = body(ready(getResponse(), { notice: { kind: "conflict" } }));
  assert.ok(conflict.startsWith('<div class="notice" role="alert" data-dt-notice="conflict">'));
  assert.ok(conflict.includes("剛才沒有遺忘任何東西"));
  const failed = body(ready(getResponse(), { notice: { kind: "forgetFailed", error: fail("STORAGE_BUSY") } }));
  assert.ok(failed.includes('data-dt-notice="forgetFailed"') && failed.includes("沒有遺忘成功。") && failed.includes("記憶庫正忙著寫入。"));
  assertSafe(conflict + failed, "notices");
});

test("the confirmation says it is permanent, that receipts go with it, that the same content will not be written again, and what is untouched", () => {
  const markup = det.renderConfirmBody(det.parseDetail(getResponse())).value;
  assert.ok(markup.includes("會從「開發小幫手」的記憶庫永久清除這一筆，無法復原。"));
  assert.ok(markup.includes("這一筆的收據（寫入來源紀錄）會一併刪除。"));
  assert.ok(markup.includes("之後相同內容也不會再被寫入。"));
  assert.ok(markup.includes("不受影響：對話紀錄、打卡紀錄與其他記憶。"));
  assert.ok(markup.includes("整理週報"), "the quote names the memory being forgotten");
  assertSafe(markup, "confirm");
  assert.equal(STRINGS["dt.confirm.cancel"], "先不要");
});

test("the confirmation quote is cut at 120 characters, flattened to one line, and escaped", () => {
  const long = getResponse({ content: "長".repeat(300), work: null });
  const markup = det.renderConfirmBody(det.parseDetail(long)).value;
  assert.ok(markup.includes(`${"長".repeat(120)}…`) && !markup.includes("長".repeat(121)));
  const tricky = getResponse({ content: "第一行\n\n第二行 <b>x</b>", work: null });
  const quoted = det.renderConfirmBody(det.parseDetail(tricky)).value;
  assert.ok(quoted.includes("第一行 第二行 &lt;b&gt;x&lt;/b&gt;"));
});

test("hostile text in any field is escaped: content, request, names, tool, conversation id, project and sibling text", () => {
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  const response = getResponse({
    ref: refOf("p1", { scope: "project", projectId: evil }),
    content: workContent({ title: evil, body: evil, cli: "x", model: "y" }),
    names: { agent: { displayName: evil, teamKey: "sw" }, project: { displayName: evil } },
    receipts: [{ client: evil, sessionId: evil, eventId: evil, role: "user", createdAt: iso(NOW) }],
    sameSession: [siblingItem("m2", { snippet: evil, work: { startIso: iso(NOW), endIso: iso(NOW), cli: null, model: null, title: evil } })],
    work: { startIso: iso(NOW - 2 * MINUTE), endIso: iso(NOW), cli: evil, model: evil, title: evil },
  });
  const view = ready(response);
  for (const markup of [body(view), body({ ...view, notice: { kind: "conflict" } }), det.renderConfirmBody(view.data).value]) assertSafe(markup, "hostile");
  assert.ok(body(view).includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("the drawer's strings are Traditional Chinese and never use the word 程序", () => {
  for (const [key, text] of Object.entries(STRINGS)) if (key.startsWith("dt.")) assert.ok(!text.includes("程序"), key);
  assert.equal(t("dt.title"), "記憶詳情");
  assert.equal(t("dt.confirm.title"), "要永久遺忘這筆記憶嗎？");
});
