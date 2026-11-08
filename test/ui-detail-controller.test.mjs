import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { AGENT, deferred, det, fail, fakeClient, flush, getResponse, iso, keyOf, NOW, ok, refOf, scene, siblingItem, workContent } from "./detailFixtures.mjs";

const REF = refOf("m2");

const live = [];

// why: the confirmation dialog counts itself in module state, so a test that ends with one open would make every later test fail; each scene is closed for good after its test
afterEach(() => {
  for (const s of live.splice(0)) s.detail.close({ force: true });
});

function working({ get, forget, ids, reload } = {}) {
  const client = fakeClient({
    "ui.get": get ?? ((params) => ok(getResponse({ ref: refOf(params.memoryId) }))),
    "ui.forget": forget ?? (() => ok({ ok: true, forgotten: true })),
  });
  const made = { client, ...scene({ client, ids, reload }) };
  live.push(made);
  return made;
}

const bodyOf = (s) => s.drawer().children[1].innerHTML;
const footOf = (s) => s.drawer().children[2].innerHTML;
const active = (s) => s.doc.activeElement;

async function opened(options = {}) {
  const s = working(options);
  s.card("m2").focus();
  await s.detail.open(REF);
  return s;
}

// why: a real click focuses the button it lands on, which is where the dialog later returns focus
function pressForget(s) {
  s.forgetButton().focus();
  s.clickData("forget");
}

async function confirm(s) {
  pressForget(s);
  s.click(s.dialogButton("forget"));
  await flush();
}

test("opening asks ui.get for exactly that memory, under its own request key, and shows the content", async () => {
  const s = await opened();
  assert.deepEqual(s.client.calls.map((call) => [call.method, call.params, call.options]), [["ui.get", { agentId: AGENT, scope: "personal", projectId: null, memoryId: "m2" }, { key: "detail" }]]);
  assert.ok(bodyOf(s).includes("整理週報") && bodyOf(s).includes("已整理完成"));
  assert.equal(s.detail.view().phase, "ready");
  assert.equal(s.detail.view().data.revision, 1);
});

test("the drawer is a modal dialog labelled by its title, takes focus at once, and makes the page behind it inert", async () => {
  const s = working({ get: () => deferred().promise });
  s.card("m2").focus();
  const pending = s.detail.open(REF);
  const drawer = s.drawer();
  assert.equal(drawer.getAttribute("role"), "dialog");
  assert.equal(drawer.getAttribute("aria-modal"), "true");
  const title = s.doc.root.querySelectorAll("h2").find((heading) => heading.id === drawer.getAttribute("aria-labelledby"));
  assert.equal(title.textContent, "詳情");
  assert.equal(active(s), title, "focus is on the title while the memory loads");
  assert.equal(s.header.hasAttribute("inert"), true);
  assert.equal(s.main.hasAttribute("inert"), true);
  assert.ok(bodyOf(s).includes("讀取中…"), "loading is announced");
  assert.equal(footOf(s), "", "no forget button until there is something to forget");
  void pending;
});

test("a memory that cannot be read shows a plain error with a retry that asks again", async () => {
  let answer = fail("STORAGE_BUSY");
  const s = working({ get: () => (answer.ok === false ? answer : ok(getResponse({ ref: REF }))) });
  await s.detail.open(REF);
  assert.equal(s.detail.view().phase, "error");
  assert.ok(bodyOf(s).includes("記憶庫正忙著寫入。") && bodyOf(s).includes('data-dt="retry"'));
  assert.equal(footOf(s), "");
  answer = ok({});
  s.clickData("retry");
  assert.equal(s.detail.view().phase, "loading");
  await flush();
  assert.equal(s.detail.view().phase, "ready");
  assert.equal(s.client.of("ui.get").length, 2);
});

test("a response the drawer cannot understand is an error, never an empty memory", async () => {
  for (const value of [{ ok: true }, { ok: true, memory: {}, receipts: [], sameSession: [] }, null, "x"]) {
    const s = working({ get: () => ok(value) });
    await s.detail.open(REF);
    assert.equal(s.detail.view().phase, "error", JSON.stringify(value));
    assert.ok(bodyOf(s).includes('data-code="malformed_response"'));
  }
});

test("an answer for another memory than the one asked for is refused", async () => {
  const s = working({ get: () => ok(getResponse({ ref: refOf("other") })) });
  await s.detail.open(REF);
  assert.equal(s.detail.view().phase, "error");
});

test("a memory that is gone offers closing and refreshing the list, which closes the drawer, reloads and returns focus to the list", async () => {
  const s = working({ get: () => fail("NOT_FOUND") });
  s.card("m2").focus();
  await s.detail.open(REF);
  assert.ok(bodyOf(s).includes("找不到這筆記憶"));
  s.clickData("closeReload");
  assert.equal(s.detail.isOpen(), false);
  await flush();
  assert.equal(s.reloads.length, 1);
  assert.equal(active(s), s.card("m2"), "the card that opened the drawer is found again by its key after the reload");
});

test("an empty memory says it has no text", async () => {
  const s = working({ get: () => ok(getResponse({ ref: REF, content: "", work: null })) });
  await s.detail.open(REF);
  assert.ok(bodyOf(s).includes("（沒有文字內容）"));
  assert.ok(footOf(s).includes('data-dt="forget"'), "an empty memory can still be forgotten");
});

test("Escape closes the drawer and puts focus back on the card that opened it, and the page is no longer inert", async () => {
  const s = await opened();
  s.doc.key("Escape");
  assert.equal(s.detail.isOpen(), false);
  assert.equal(s.drawer(), undefined);
  assert.equal(active(s), s.card("m2"));
  assert.equal(s.main.hasAttribute("inert"), false);
  assert.equal(s.header.hasAttribute("inert"), false);
  assert.equal(s.client.of("ui.forget").length, 0);
});

test("the close button and a click on the dimmed page close the drawer the same way", async () => {
  const one = await opened();
  one.click(one.closeButton());
  assert.equal(one.detail.isOpen(), false);
  assert.equal(active(one), one.card("m2"));
  const two = await opened();
  const scrim = two.doc.root.querySelectorAll("div").find((element) => element.className === "dr-scrim");
  two.click(scrim);
  assert.equal(two.detail.isOpen(), false);
  assert.equal(active(two), two.card("m2"));
});

test("if the card is gone when the drawer closes, focus goes to the list title instead", async () => {
  const s = await opened();
  s.setIds(["m1", "m3"]);
  s.doc.key("Escape");
  assert.equal(active(s), s.heading);
});

test("Tab stays inside the drawer: from the last control it wraps to the first, from the first Shift+Tab wraps to the last, and in between the browser decides", async () => {
  const s = await opened({ get: () => ok(getResponse({ ref: REF, sameSession: [siblingItem("m3")] })) });
  const [close, sibling, forget] = s.buttons(s.drawer());
  assert.deepEqual([close.getAttribute("aria-label"), sibling.getAttribute("data-dt"), forget.getAttribute("data-dt")], ["關閉詳情", "sibling", "forget"]);
  forget.focus();
  const wrap = s.doc.key("Tab");
  assert.equal(wrap.defaultPrevented, true);
  assert.equal(active(s), close);
  const back = s.doc.key("Tab", { shift: true });
  assert.equal(back.defaultPrevented, true);
  assert.equal(active(s), forget);
  sibling.focus();
  assert.equal(s.doc.key("Tab").defaultPrevented, false, "between the ends the browser moves focus itself");
  assert.equal(s.doc.key("Tab", { shift: true }).defaultPrevented, false);
  const title = s.drawer().children[0].children[0];
  title.focus();
  assert.equal(s.doc.key("Tab", { shift: true }).defaultPrevented, true, "from the title, Shift+Tab must not leave the drawer");
  assert.equal(active(s), forget);
  title.focus();
  assert.equal(s.doc.key("Tab").defaultPrevented, false, "from the title, Tab goes to the first control by itself");
});

test("focus that lands outside the drawer is pulled back to its title", async () => {
  const s = await opened();
  s.closeButton().focus();
  assert.equal(active(s), s.closeButton());
  const outside = s.doc.createElement("button");
  s.doc.body.appendChild(outside);
  s.doc.dispatch(outside, "focusin", { target: outside });
  assert.equal(active(s), s.drawer().children[0].children[0]);
});

test("the forget button asks first: a modal alert dialog, labelled, with focus on 先不要, and nothing is sent yet", async () => {
  const s = await opened();
  pressForget(s);
  const dialog = s.dialog();
  assert.equal(dialog.getAttribute("role"), "alertdialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const heading = s.doc.root.querySelectorAll("h2").find((element) => element.id === dialog.getAttribute("aria-labelledby"));
  assert.equal(heading.textContent, "要永久遺忘這筆記憶嗎？");
  assert.equal(dialog.getAttribute("aria-describedby") !== null, true);
  assert.equal(active(s).textContent, "先不要");
  assert.equal(active(s), s.dialogButton("cancel"));
  assert.deepEqual(s.buttons(dialog).map((button) => button.textContent), ["先不要", "永久遺忘這一筆"]);
  const text = dialog.children[1].innerHTML;
  for (const phrase of ["永久清除", "無法復原", "收據", "一併刪除", "相同內容之後不會再寫入"]) assert.ok(text.includes(phrase), phrase);
  assert.equal(s.client.of("ui.forget").length, 0);
  assert.equal(s.drawer().hasAttribute("inert"), true, "the drawer is inert behind the dialog");
});

test("Enter on the default button cancels, and Escape cancels: neither sends a forget, and the drawer stays open with focus back on the forget button", async () => {
  const s = await opened();
  pressForget(s);
  s.click(active(s));
  assert.equal(s.dialog(), undefined);
  assert.equal(s.client.of("ui.forget").length, 0);
  assert.equal(s.detail.isOpen(), true);
  assert.equal(active(s), s.forgetButton());
  pressForget(s);
  s.doc.key("Escape");
  await flush();
  assert.equal(s.dialog(), undefined);
  assert.equal(s.detail.isOpen(), true, "Escape closed only the dialog, not the drawer behind it");
  assert.equal(s.client.of("ui.forget").length, 0);
  assert.equal(s.reloads.length, 0);
  assert.equal(s.drawer().hasAttribute("inert"), false);
  assert.equal(active(s), s.forgetButton());
  s.doc.key("Escape");
  assert.equal(s.detail.isOpen(), false, "a second Escape closes the drawer");
});

test("a click on the dimmed page behind the dialog cancels it too", async () => {
  const s = await opened();
  pressForget(s);
  const overlay = s.dialog().parentNode;
  s.click(overlay);
  assert.equal(s.dialog(), undefined);
  assert.equal(s.client.of("ui.forget").length, 0);
});

test("confirming sends the memory's own revision once, then closes the drawer, reloads the list and lands focus on the next card", async () => {
  const order = [];
  const s = working({
    get: () => ok(getResponse({ ref: REF, revision: 7 })),
    forget: () => {
      order.push("forget");
      return ok({ ok: true, forgotten: true });
    },
    reload: ({ set, current }) => {
      order.push("reload");
      set(current().filter((id) => id !== "m2"));
    },
  });
  s.card("m2").focus();
  await s.detail.open(REF);
  await confirm(s);
  assert.deepEqual(s.client.of("ui.forget").map((call) => call.params), [{ agentId: AGENT, scope: "personal", projectId: null, memoryId: "m2", expectedRevision: 7 }]);
  assert.deepEqual(order, ["forget", "reload"]);
  assert.equal(s.detail.isOpen(), false);
  assert.equal(s.main.hasAttribute("inert"), false);
  assert.equal(s.card("m2"), undefined);
  assert.equal(active(s), s.card("m3"), "the memory that took its place has the focus");
  assert.equal(s.status().textContent, "已遺忘，相同內容不會再寫入。");
});

test("when the forgotten memory was the last one, focus goes to the previous card; when it was the only one, to the list title", async () => {
  const last = working({ ids: ["m1", "m2"], reload: ({ set, current }) => set(current().filter((id) => id !== "m2")) });
  await last.detail.open(REF);
  await confirm(last);
  assert.equal(active(last), last.card("m1"));
  const only = working({ ids: ["m2"], reload: ({ set }) => set([]) });
  await only.detail.open(REF);
  await confirm(only);
  assert.equal(active(only), only.heading);
});

test("if the list reload loses the neighbours too, focus still lands on the list title rather than nowhere", async () => {
  const s = working({ reload: ({ set }) => set(["m9"]) });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(active(s), s.heading);
});

test("a forget of a memory that was already forgotten elsewhere (forgotten:false, or NOT_FOUND) still closes, reloads and moves focus", async () => {
  for (const answer of [ok({ ok: true, forgotten: false }), fail("NOT_FOUND")]) {
    const s = working({ forget: () => answer, reload: ({ set, current }) => set(current().filter((id) => id !== "m2")) });
    await s.detail.open(REF);
    await confirm(s);
    assert.equal(s.detail.isOpen(), false);
    assert.equal(s.reloads.length, 1);
    assert.equal(active(s), s.card("m3"));
  }
});

test("a reload that fails does not undo the close or the focus move", async () => {
  const s = working({
    reload: () => {
      throw new Error("list exploded");
    },
  });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.isOpen(), false);
  assert.equal(active(s), s.card("m3"));
});

test("REVISION_CONFLICT reloads the memory, keeps the drawer open, says so, and forgets nothing until the user confirms again with the new revision", async () => {
  let revision = 1;
  const s = working({
    get: () => ok(getResponse({ ref: REF, revision, content: workContent({ body: revision === 1 ? "舊成果" : "新成果" }) })),
    forget: (params) => (params.expectedRevision === 1 ? fail("REVISION_CONFLICT") : ok({ ok: true, forgotten: true })),
    reload: ({ set, current }) => set(current().filter((id) => id !== "m2")),
  });
  await s.detail.open(REF);
  assert.ok(bodyOf(s).includes("舊成果"));
  revision = 2;
  await confirm(s);
  assert.equal(s.client.of("ui.get").length, 2, "the latest content was fetched again");
  assert.equal(s.detail.isOpen(), true);
  assert.equal(s.reloads.length, 0, "a conflict does not touch the list");
  assert.ok(bodyOf(s).includes("新成果") && !bodyOf(s).includes("舊成果"));
  assert.ok(bodyOf(s).includes('data-dt-notice="conflict"') && bodyOf(s).includes("剛才沒有遺忘任何東西"));
  assert.equal(s.detail.view().data.revision, 2);
  assert.equal(s.detail.view().forgetting, false);
  assert.equal(active(s) !== s.doc.body, true, "focus did not fall to the page");
  assert.ok(footOf(s).includes('aria-disabled="false"'), "the button works again");
  await confirm(s);
  assert.deepEqual(s.client.of("ui.forget").map((call) => call.params.expectedRevision), [1, 2]);
  assert.equal(s.detail.isOpen(), false);
  assert.equal(s.reloads.length, 1);
});

test("a conflict whose re-read fails shows that error instead of stale content", async () => {
  let gets = 0;
  const s = working({
    get: () => (++gets === 1 ? ok(getResponse({ ref: REF })) : fail("STORAGE_BUSY")),
    forget: () => fail("REVISION_CONFLICT"),
  });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.view().phase, "error");
  assert.ok(bodyOf(s).includes("記憶庫正忙著寫入。"));
  assert.equal(footOf(s), "", "no forget button over content that is out of date");
});

test("a forget that fails any other way keeps the drawer, says it did not work, and lets the user try again", async () => {
  let answer = fail("STORAGE_BUSY");
  const s = working({ forget: () => (answer.ok === false ? answer : ok({ ok: true, forgotten: true })), reload: ({ set, current }) => set(current().filter((id) => id !== "m2")) });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.isOpen(), true);
  assert.equal(s.reloads.length, 0);
  assert.ok(bodyOf(s).includes("沒有遺忘成功。") && bodyOf(s).includes("記憶庫正忙著寫入。"));
  assert.ok(footOf(s).includes('aria-disabled="false"'));
  assert.equal(s.client.of("ui.get").length, 1, "only a conflict re-reads");
  answer = ok({});
  await confirm(s);
  assert.equal(s.detail.isOpen(), false);
  assert.equal(s.client.of("ui.forget").length, 2);
});

test("a forget answer the drawer cannot understand is reported, not taken as success", async () => {
  const s = working({ forget: () => ok({ ok: true }) });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.isOpen(), true);
  assert.equal(s.reloads.length, 0);
  assert.ok(bodyOf(s).includes("malformed_response"));
});

test("pressing forget again while the dialog is open opens no second dialog, and confirming twice sends one forget", async () => {
  const gate = deferred();
  const s = working({ forget: () => gate.promise });
  await s.detail.open(REF);
  pressForget(s);
  pressForget(s);
  pressForget(s);
  assert.equal(s.doc.root.querySelectorAll("div").filter((element) => element.getAttribute("role") === "alertdialog").length, 1);
  const confirmButton = s.dialogButton("forget");
  s.click(confirmButton);
  s.click(confirmButton);
  await flush();
  assert.equal(s.client.of("ui.forget").length, 1);
  gate.resolve(ok({ ok: true, forgotten: true }));
  await flush();
  assert.equal(s.client.of("ui.forget").length, 1);
});

test("while a forget is in flight the button is disabled and pressing it again sends and asks nothing", async () => {
  const gate = deferred();
  const s = working({ forget: () => gate.promise });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.view().forgetting, true);
  assert.ok(footOf(s).includes('aria-disabled="true"') && footOf(s).includes("正在遺忘…"));
  pressForget(s);
  pressForget(s);
  assert.equal(s.dialog(), undefined, "no second confirmation opens");
  assert.equal(s.client.of("ui.forget").length, 1);
  assert.equal(active(s) !== s.doc.body, true, "focus did not fall to the page while the footer was re-rendered");
  gate.resolve(ok({ ok: true, forgotten: true }));
  await flush();
  assert.equal(s.client.of("ui.forget").length, 1);
  assert.equal(s.detail.isOpen(), false);
});

test("the drawer cannot be closed, nor another memory opened, while a forget is in flight", async () => {
  const gate = deferred();
  const s = working({ forget: () => gate.promise });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.close(), false);
  s.doc.key("Escape");
  s.click(s.closeButton());
  assert.equal(s.detail.isOpen(), true);
  await s.detail.open(refOf("m3"));
  assert.equal(s.client.of("ui.get").length, 1, "no other memory was requested");
  gate.resolve(ok({ ok: true, forgotten: true }));
  await flush();
  assert.equal(s.detail.isOpen(), false);
});

test("a forced close during a forget (the page navigated away) still reloads the list when the forget lands, and moves no focus", async () => {
  const gate = deferred();
  const s = working({ forget: () => gate.promise });
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.detail.close({ force: true }), true);
  assert.equal(s.detail.isOpen(), false);
  const elsewhere = s.doc.createElement("button");
  s.doc.body.appendChild(elsewhere);
  elsewhere.focus();
  gate.resolve(ok({ ok: true, forgotten: true }));
  await flush();
  assert.equal(s.reloads.length, 1);
  assert.equal(active(s), elsewhere);
});

test("a forced close removes an open confirmation with the drawer, and its answer sends nothing", async () => {
  const s = await opened();
  pressForget(s);
  assert.ok(s.dialog());
  s.detail.close({ force: true });
  await flush();
  assert.equal(s.dialog(), undefined);
  assert.equal(s.drawer(), undefined);
  assert.equal(s.client.of("ui.forget").length, 0);
  assert.equal(s.main.hasAttribute("inert"), false);
});

test("a late answer for a memory the drawer has moved away from is dropped, however the two answers are ordered", async () => {
  const gates = { m2: deferred(), m3: deferred() };
  const s = working({ get: (params) => gates[params.memoryId].promise });
  const first = s.detail.open(refOf("m2"));
  const second = s.detail.open(refOf("m3"));
  gates.m3.resolve(ok(getResponse({ ref: refOf("m3"), content: workContent({ title: "第三筆", body: "第三筆的成果" }) })));
  await flush();
  assert.ok(bodyOf(s).includes("第三筆的成果"));
  gates.m2.resolve(ok(getResponse({ ref: refOf("m2"), content: workContent({ title: "第二筆", body: "第二筆的成果" }) })));
  await Promise.all([first, second]);
  await flush();
  assert.ok(bodyOf(s).includes("第三筆的成果") && !bodyOf(s).includes("第二筆的成果"));
  assert.equal(s.detail.view().ref.memoryId, "m3");
  assert.equal(s.detail.view().data.ref.memoryId, "m3");
});

test("a late answer that arrives after the drawer was closed is ignored", async () => {
  const gate = deferred();
  const s = working({ get: () => gate.promise });
  const pending = s.detail.open(REF);
  s.doc.key("Escape");
  assert.equal(s.detail.isOpen(), false);
  gate.resolve(ok(getResponse({ ref: REF })));
  await pending;
  assert.equal(s.drawer(), undefined);
  assert.equal(s.detail.view(), null);
});

test("an answer the client reports as superseded changes nothing", async () => {
  const s = working({ get: () => fail("superseded") });
  await s.detail.open(REF);
  assert.equal(s.detail.view().phase, "loading", "the newer request will answer");
});

test("a late error from the old memory does not replace the new one either", async () => {
  const gates = { m2: deferred(), m3: deferred() };
  const s = working({ get: (params) => gates[params.memoryId].promise });
  const first = s.detail.open(refOf("m2"));
  const second = s.detail.open(refOf("m3"));
  gates.m3.resolve(ok(getResponse({ ref: refOf("m3") })));
  await flush();
  gates.m2.resolve(fail("NOT_FOUND"));
  await Promise.all([first, second]);
  assert.equal(s.detail.view().phase, "ready");
  assert.equal(s.detail.view().ref.memoryId, "m3");
});

test("opening another memory while the drawer is open reuses the drawer and keeps the first card as the place to return to", async () => {
  const s = await opened();
  const drawer = s.drawer();
  await s.detail.open(refOf("m3"));
  assert.equal(s.drawer(), drawer, "one drawer, not two");
  assert.equal(s.doc.root.querySelectorAll("aside").length, 1);
  s.doc.key("Escape");
  assert.equal(active(s), s.card("m2"));
});

test("a same-session button loads that memory inside the drawer and keeps focus in the drawer", async () => {
  const s = working({ get: (params) => ok(getResponse({ ref: refOf(params.memoryId), sameSession: params.memoryId === "m2" ? [siblingItem("m3")] : [siblingItem("m2")] })) });
  s.card("m2").focus();
  await s.detail.open(REF);
  s.clickData("sibling", keyOf(refOf("m3")));
  assert.equal(s.detail.view().phase, "loading");
  assert.equal(active(s), s.drawer().children[0].children[0], "the clicked button is gone, so focus is on the title");
  await flush();
  assert.equal(s.detail.view().ref.memoryId, "m3");
  assert.deepEqual(s.client.of("ui.get").map((call) => call.params.memoryId), ["m2", "m3"]);
  s.clickData("sibling", '["nobody","personal",null,"zz"]');
  assert.equal(s.client.of("ui.get").length, 2, "a key that is not in the list does nothing");
  s.doc.key("Escape");
  assert.equal(active(s), s.card("m2"), "closing returns to the card that opened the first memory");
});

test("forgetting a same-session memory that is not on the list reloads and returns to the card that opened the drawer", async () => {
  const s = working({
    get: (params) => ok(getResponse({ ref: refOf(params.memoryId), sameSession: params.memoryId === "m2" ? [siblingItem("zz")] : [] })),
    reload: ({ set, current }) => set([...current()]),
  });
  s.card("m2").focus();
  await s.detail.open(REF);
  s.clickData("sibling", keyOf(refOf("zz")));
  await flush();
  await confirm(s);
  assert.deepEqual(s.client.of("ui.forget").map((call) => call.params.memoryId), ["zz"]);
  assert.equal(s.detail.isOpen(), false);
  assert.equal(active(s), s.card("m2"));
});

test("the announcement is a polite status region that exists before the message, clears itself, and restarts its timer on the next message", async () => {
  const s = working({ reload: ({ set, current }) => set(current().filter((id) => id !== "m2")) });
  const region = s.status();
  assert.equal(region.getAttribute("aria-live"), "polite");
  assert.equal(region.textContent, "");
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(region.textContent, "已遺忘，相同內容不會再寫入。");
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, 6000);
  s.timers[0].callback();
  assert.equal(region.textContent, "");
  s.setIds(["m1", "m2", "m3"]);
  await s.detail.open(REF);
  await confirm(s);
  assert.equal(s.timers.length, 2);
});

test("every request the drawer makes is a method the page may call, and only ui.get and ui.forget", async () => {
  const s = await opened({ get: () => ok(getResponse({ ref: REF })) });
  await confirm(s);
  assert.deepEqual([...new Set(s.client.calls.map((call) => call.method))].sort(), ["ui.forget", "ui.get"]);
  assert.equal(det.GET_KEY, "detail");
  assert.notEqual(det.FORGET_KEY, det.GET_KEY);
  assert.equal(NOW > 0 && iso(NOW).length > 0, true);
});
