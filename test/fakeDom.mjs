const TABBABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

function matchesPart(element, part) {
  const trimmed = part.trim();
  const shape = /^([a-z]*)(?:\[([a-z-]+)\])?(?::not\(\[([a-z-]+)(?:="([^"]*)")?\]\))?$/u.exec(trimmed);
  if (shape === null) throw new Error(`fake dom cannot match selector part ${trimmed}`);
  const [, tag, attribute, notAttribute, notValue] = shape;
  if (tag !== "" && element.tagName !== tag.toUpperCase()) return false;
  if (attribute !== undefined && !element.hasAttribute(attribute)) return false;
  if (notAttribute !== undefined) {
    if (notValue === undefined ? element.hasAttribute(notAttribute) : element.getAttribute(notAttribute) === notValue) return false;
  }
  return true;
}

export class FakeElement {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = [];
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.markup = "";
  }

  get innerHTML() {
    return this.markup;
  }

  // why: the fake has no HTML parser, so only anchors written as <a href="..." id="..."> are turned into children to give the dialog real body focus targets
  set innerHTML(value) {
    this.markup = value;
    this.children = [];
    for (const match of value.matchAll(/<a(?=[ >])([^>]*)>/gu)) {
      const anchor = new FakeElement(this.ownerDocument, "a");
      for (const pair of match[1].matchAll(/([a-z][a-z-]*)="([^"]*)"/gu)) anchor.setAttribute(pair[1], pair[2]);
      this.appendChild(anchor);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child);
    child.parentNode = null;
    if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  get isConnected() {
    let node = this;
    while (node.parentNode !== null) node = node.parentNode;
    return node === this.ownerDocument.root;
  }

  contains(node) {
    for (let cursor = node; cursor !== null && cursor !== undefined; cursor = cursor.parentNode) if (cursor === this) return true;
    return false;
  }

  get inert() {
    for (let cursor = this; cursor !== null; cursor = cursor.parentNode) if (cursor.hasAttribute("inert")) return true;
    return false;
  }

  focus() {
    if (!this.isConnected || this.inert) return;
    if (!TABBABLE_TAGS.has(this.tagName) && !this.hasAttribute("tabindex") && !this.hasAttribute("href")) return;
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatch(this, "focusin", { target: this });
  }

  addEventListener(type, listener, capture = false) {
    this.listeners.push({ type, listener, capture: capture === true });
  }

  removeEventListener(type, listener, capture = false) {
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.listener === listener && entry.capture === (capture === true)));
  }

  listenerCount(type) {
    return this.listeners.filter((entry) => entry.type === type).length;
  }

  querySelectorAll(selector) {
    const parts = selector.split(",");
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (parts.some((part) => matchesPart(child, part))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

export class FakeDocument {
  constructor() {
    this.root = new FakeElement(this, "#document");
    this.root.parentNode = null;
    this.body = new FakeElement(this, "body");
    this.root.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  addEventListener(type, listener, capture) {
    this.root.addEventListener(type, listener, capture);
  }

  removeEventListener(type, listener, capture) {
    this.root.removeEventListener(type, listener, capture);
  }

  listenerCount(type) {
    return this.root.listenerCount(type);
  }

  dispatch(target, type, event) {
    const path = [];
    for (let node = target; node !== null; node = node.parentNode) path.unshift(node);
    if (!path.includes(this.root)) path.unshift(this.root);
    const evt = { type, target, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...event };
    for (const node of path) for (const entry of [...node.listeners]) if (entry.type === type && entry.capture) entry.listener(evt);
    for (const node of [...path].reverse()) for (const entry of [...node.listeners]) if (entry.type === type && !entry.capture) entry.listener(evt);
    return evt;
  }

  key(key, { shift = false } = {}) {
    return this.dispatch(this.activeElement, "keydown", { key, shiftKey: shift });
  }
}
