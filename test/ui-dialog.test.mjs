import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument } from "./fakeDom.mjs";
import { loadUiModule } from "./uiHarness.mjs";

const focus = await loadUiModule("components/dialogFocus.ts", "components/dialog.ts", "dom/html.ts");
const { openDialog, confirmDialog, html } = focus;

const FORGET = [
  { id: "cancel", label: "先不要" },
  { id: "forget", label: "永久遺忘", kind: "danger" },
];

function scene() {
  const doc = new FakeDocument();
  const app = doc.createElement("main");
  doc.body.appendChild(app);
  const opener = doc.createElement("button");
  opener.setAttribute("type", "button");
  app.appendChild(opener);
  opener.focus();
  const other = doc.createElement("button");
  app.appendChild(other);
  return { doc, app, opener, other };
}

const buttonsOf = (handle) => handle.element.querySelectorAll("button");
const label = (element) => element.textContent;

test("cycleFocus wraps in both directions and starts at either end when focus is outside", () => {
  assert.equal(focus.cycleFocus(0, 3, false), 1);
  assert.equal(focus.cycleFocus(2, 3, false), 0);
  assert.equal(focus.cycleFocus(0, 3, true), 2);
  assert.equal(focus.cycleFocus(1, 3, true), 0);
  assert.equal(focus.cycleFocus(-1, 3, false), 0);
  assert.equal(focus.cycleFocus(-1, 3, true), 2);
  assert.equal(focus.cycleFocus(9, 3, false), 0);
  assert.equal(focus.cycleFocus(0, 1, false), 0);
  assert.equal(focus.cycleFocus(0, 1, true), 0);
  assert.equal(focus.cycleFocus(0, 0, false), -1);
});

test("pickInitialFocus honours the requested id and never lands on a danger action by default", () => {
  const candidates = [{ id: "forget", danger: true }, { id: "cancel", danger: false }, { id: null, danger: false }];
  assert.deepEqual(focus.pickInitialFocus(candidates, "forget"), { kind: "candidate", index: 0 });
  assert.deepEqual(focus.pickInitialFocus(candidates, "cancel"), { kind: "candidate", index: 1 });
  assert.deepEqual(focus.pickInitialFocus(candidates), { kind: "candidate", index: 1 });
  assert.deepEqual(focus.pickInitialFocus(candidates, "missing"), { kind: "candidate", index: 1 });
  assert.deepEqual(focus.pickInitialFocus([{ id: "forget", danger: true }]), { kind: "container" });
  assert.deepEqual(focus.pickInitialFocus([]), { kind: "container" });
});

test("the dialog is a modal with a label and a description, and puts the requested action in focus", async () => {
  const { doc, app } = scene();
  const handle = confirmDialog({ document: doc, background: app, title: "要永久遺忘這筆記憶嗎？", body: html`<p>${"<b>內容</b>"}</p>`, cancel: FORGET[0], confirm: FORGET[1], initialFocus: "cancel" });
  const dialog = handle.element;
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const heading = dialog.children[0];
  assert.equal(dialog.getAttribute("aria-labelledby"), heading.id);
  assert.equal(heading.textContent, "要永久遺忘這筆記憶嗎？");
  assert.equal(dialog.getAttribute("aria-describedby"), handle.bodyElement.id);
  assert.equal(handle.bodyElement.innerHTML, "<p>&lt;b&gt;內容&lt;/b&gt;</p>");
  assert.deepEqual(buttonsOf(handle).map(label), ["先不要", "永久遺忘"]);
  assert.equal(label(doc.activeElement), "先不要");
  assert.equal(app.hasAttribute("inert"), true);
  assert.equal(doc.body.children.includes(dialog.parentNode), true);
  handle.close();
  await handle.result;
  assert.equal(app.hasAttribute("inert"), false);
});

test("without an explicit choice the first safe action is focused, and a danger-only dialog focuses itself", async () => {
  const { doc } = scene();
  const first = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: [{ id: "forget", label: "永久遺忘", kind: "danger" }, { id: "cancel", label: "先不要" }] });
  assert.equal(label(doc.activeElement), "先不要");
  first.close();
  await first.result;
  const second = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: [{ id: "forget", label: "永久遺忘", kind: "danger" }] });
  assert.equal(doc.activeElement, second.element);
  second.close();
  await second.result;
  const third = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: FORGET, initialFocus: "nope" });
  assert.equal(label(doc.activeElement), "先不要");
  third.close();
});

test("a focusable element inside the body can be the initial focus and takes part in the Tab order", async () => {
  const { doc } = scene();
  const body = html`<p>${"x"}</p><a href="#more" id="learn-more">更多</a>`;
  const handle = openDialog({ document: doc, title: "t", body, actions: FORGET, initialFocus: "learn-more" });
  const link = handle.bodyElement.children[0];
  assert.equal(doc.activeElement, link);
  const [cancel, forget] = buttonsOf(handle);
  doc.key("Tab");
  assert.equal(doc.activeElement, cancel);
  doc.key("Tab");
  assert.equal(doc.activeElement, forget);
  doc.key("Tab");
  assert.equal(doc.activeElement, link);
  handle.close();
  await handle.result;
});

test("Tab and Shift+Tab stay inside the dialog and wrap at both ends", async () => {
  const { doc, other } = scene();
  const handle = confirmDialog({ document: doc, title: "t", body: html`<p>x</p>`, cancel: FORGET[0], confirm: FORGET[1], initialFocus: "cancel" });
  const [cancel, forget] = buttonsOf(handle);
  const tab = doc.key("Tab");
  assert.equal(tab.defaultPrevented, true);
  assert.equal(doc.activeElement, forget);
  doc.key("Tab");
  assert.equal(doc.activeElement, cancel);
  doc.key("Tab", { shift: true });
  assert.equal(doc.activeElement, forget);
  doc.key("Tab", { shift: true });
  assert.equal(doc.activeElement, cancel);
  handle.element.focus();
  doc.key("Tab");
  assert.equal(doc.activeElement, cancel);
  handle.element.focus();
  doc.key("Tab", { shift: true });
  assert.equal(doc.activeElement, forget);
  other.focus();
  assert.notEqual(doc.activeElement, other);
  assert.equal(handle.element.contains(doc.activeElement), true);
  handle.close();
});

test("focus that lands outside the dialog is pulled back in when no background is made inert", async () => {
  const { doc, other } = scene();
  const handle = confirmDialog({ document: doc, title: "t", body: html`<p>x</p>`, cancel: FORGET[0], confirm: FORGET[1], initialFocus: "forget" });
  other.focus();
  assert.equal(label(doc.activeElement), "先不要");
  handle.close();
  await handle.result;
});

test("Escape closes the dialog, reports it, and returns focus to the element that opened it", async () => {
  const { doc, app, opener } = scene();
  const handle = confirmDialog({ document: doc, background: app, title: "t", body: html`<p>x</p>`, cancel: FORGET[0], confirm: FORGET[1], initialFocus: "cancel" });
  const escape = doc.key("Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  const outcome = await handle.result;
  assert.deepEqual(outcome, { action: "cancel", via: "escape" });
  assert.equal(handle.element.isConnected, false);
  assert.equal(doc.activeElement, opener);
  assert.equal(doc.listenerCount("keydown"), 0);
  assert.equal(doc.listenerCount("focusin"), 0);
  assert.equal(app.hasAttribute("inert"), false);
});

test("a dialog that cannot be dismissed ignores Escape and a click on the backdrop", async () => {
  const { doc } = scene();
  const handle = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: FORGET, dismissible: false });
  const overlay = handle.element.parentNode;
  assert.equal(doc.key("Escape").defaultPrevented, true);
  doc.dispatch(overlay, "click", { target: overlay });
  assert.equal(handle.element.isConnected, true);
  doc.dispatch(buttonsOf(handle)[0], "click", {});
  assert.deepEqual(await handle.result, { action: "cancel", via: "action" });
});

test("a click on the backdrop dismisses, while a click inside the dialog does not", async () => {
  const { doc, opener } = scene();
  const handle = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: FORGET, dismissAction: "cancel" });
  const overlay = handle.element.parentNode;
  doc.dispatch(handle.element, "click", { target: handle.element });
  assert.equal(handle.element.isConnected, true);
  doc.dispatch(overlay, "click", { target: overlay });
  assert.deepEqual(await handle.result, { action: "cancel", via: "backdrop" });
  assert.equal(doc.activeElement, opener);
});

test("choosing an action resolves once with that action and removes every listener", async () => {
  const { doc, opener } = scene();
  const handle = confirmDialog({ document: doc, title: "t", body: html`<p>x</p>`, cancel: FORGET[0], confirm: FORGET[1], initialFocus: "cancel" });
  const [, forget] = buttonsOf(handle);
  doc.dispatch(forget, "click", {});
  doc.dispatch(forget, "click", {});
  doc.key("Escape");
  handle.close();
  assert.deepEqual(await handle.result, { action: "forget", via: "action" });
  assert.equal(doc.listenerCount("keydown"), 0);
  assert.equal(doc.activeElement, opener);
});

test("focus goes to the fallback when the opener is gone, and stays put when there is neither", async () => {
  const { doc, app, opener } = scene();
  const fallback = doc.createElement("button");
  app.appendChild(fallback);
  const handle = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: FORGET, returnFocusTo: fallback });
  opener.remove();
  handle.close();
  await handle.result;
  assert.equal(doc.activeElement, fallback);

  const lone = new FakeDocument();
  const second = openDialog({ document: lone, title: "t", body: html`<p>x</p>`, actions: FORGET });
  second.close();
  await second.result;
  assert.equal(lone.activeElement, lone.body);
});

test("only one dialog can be open at a time, and a closed one makes room for the next", async () => {
  const { doc } = scene();
  const handle = openDialog({ document: doc, title: "t", body: html`<p>x</p>`, actions: FORGET });
  assert.throws(() => openDialog({ document: doc, title: "u", body: html`<p>y</p>`, actions: FORGET }), /dialog_already_open/u);
  handle.close();
  await handle.result;
  const next = openDialog({ document: doc, title: "u", body: html`<p>y</p>`, actions: FORGET });
  next.close();
  assert.deepEqual(await next.result, { action: "dismiss", via: "programmatic" });
});

test("the body must come from the html tag and titles and labels are set as text, never as markup", () => {
  const { doc } = scene();
  assert.throws(() => openDialog({ document: doc, title: "t", body: "<script>x</script>", actions: FORGET }), TypeError);
  const handle = openDialog({ document: doc, title: "<img src=x onerror=alert(1)>", body: html`<p>x</p>`, actions: [{ id: "a", label: "<b>go</b>" }] });
  assert.equal(handle.element.children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(handle.element.children[0].innerHTML, "");
  assert.equal(buttonsOf(handle)[0].textContent, "<b>go</b>");
  assert.equal(buttonsOf(handle)[0].innerHTML, "");
  handle.close();
});
