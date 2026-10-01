import assert from "node:assert/strict";
import test from "node:test";
import { NOW, makeAgent, makeOverview, memoryPreferences, pagedBackend, tokenize, ui } from "./homeFixtures.mjs";

function fakeImage() {
  const listeners = new Map();
  return {
    hidden: true,
    src: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    emit(type) {
      listeners.get(type)?.();
      listeners.delete(type);
    },
  };
}

function fakeCard(agentId) {
  const image = fakeImage();
  const initials = { hidden: false };
  return {
    dataset: { agentAvatar: agentId },
    isConnected: true,
    image,
    initials,
    querySelector(selector) {
      return selector === "[data-avatar-image]" ? image : selector === "[data-avatar-initials]" ? initials : null;
    },
  };
}

function fakeTargets() {
  let markup = "";
  const wall = {
    cards: [],
    get innerHTML() {
      return markup;
    },
    set innerHTML(value) {
      for (const card of this.cards) card.isConnected = false;
      markup = value;
      this.cards = [...markup.matchAll(/data-agent-avatar="([^"]+)"/gu)].map((match) => fakeCard(match[1]));
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-agent-avatar]");
      return this.cards;
    },
  };
  return {
    help: { innerHTML: "" },
    banner: { innerHTML: "" },
    tiles: { innerHTML: "" },
    tools: { innerHTML: "" },
    count: { textContent: "" },
    note: { textContent: "" },
    wall,
  };
}

const observers = [];

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
    this.cards = new Set();
    this.disconnected = false;
    observers.push(this);
  }

  observe(card) {
    this.cards.add(card);
  }

  unobserve(card) {
    this.cards.delete(card);
  }

  disconnect() {
    this.disconnected = true;
    this.cards.clear();
  }

  intersect(cards) {
    this.callback(cards.map((target) => ({ target, isIntersecting: true })));
  }
}

function createHome(targets, agentAvatar, agents = [makeAgent(1)]) {
  const home = ui.createTeamHome({ client: pagedBackend(agents), now: () => NOW, preferences: memoryPreferences(), agentAvatar });
  home.attach(targets);
  return home;
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("cards request canonical avatar reads only after entering view and images keep initials as decorative fallback", async () => {
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  const targets = fakeTargets();
  const agents = [makeAgent(1), makeAgent(2)];
  const reads = [];
  const home = createHome(targets, { read: async (agentId) => { reads.push(agentId); return { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }; } }, agents);
  try {
    await home.start();
    assert.equal(reads.length, 0, "offscreen cards do not request images");
    const observer = observers.at(-1);
    const [visible, offscreen] = targets.wall.cards;
    observer.intersect([visible]);
    await tick();
    assert.deepEqual(reads, [visible.dataset.agentAvatar]);
    visible.image.emit("load");
    assert.equal(visible.initials.hidden, true);
    assert.equal(visible.image.hidden, false);
    assert.match(visible.image.src, /^blob:/u);
    assert.equal(offscreen.initials.hidden, false);
    const { tags } = tokenize(targets.wall.innerHTML);
    const image = tags.find((tag) => tag.name === "img");
    assert.deepEqual(image.attributes, [["data-avatar-image", null], ["alt", ""], ["hidden", null]]);
  } finally {
    home.attach(null);
    globalThis.IntersectionObserver = previousObserver;
  }
});

test("null, rejected timeout and broken image results keep initials; object URLs are released", async () => {
  const previousObserver = globalThis.IntersectionObserver;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
  const targets = fakeTargets();
  const agents = [makeAgent(1), makeAgent(2), makeAgent(3)];
  const home = createHome(targets, { async read(agentId) {
    if (agentId === agents[0].id) return { mimeType: "image/webp", bytes: new Uint8Array([7]) };
    if (agentId === agents[1].id) return null;
    throw new Error("avatar read timed out");
  } }, agents);
  try {
    await home.start();
    const cards = targets.wall.cards;
    observers.at(-1).intersect(cards);
    await tick();
    const missingCard = cards.find((card) => card.dataset.agentAvatar === agents[1].id);
    const timeoutCard = cards.find((card) => card.dataset.agentAvatar === agents[2].id);
    const imageCard = cards.find((card) => card.dataset.agentAvatar === agents[0].id);
    assert.equal(missingCard.initials.hidden, false, "missing image leaves initials visible");
    assert.equal(timeoutCard.initials.hidden, false, "timeout/error leaves initials visible");
    imageCard.image.emit("error");
    assert.equal(imageCard.image.hidden, true);
    assert.equal(imageCard.initials.hidden, false);
    assert.equal(revoked.length, 1, "a broken image releases its object URL");
    assert.equal(created.length, 1);
    home.attach(null);
    assert.deepEqual(revoked, created, "detaching the view releases any remaining object URLs");
    assert.equal(observers.at(-1).disconnected, true);
  } finally {
    home.attach(null);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.IntersectionObserver = previousObserver;
  }
});

test("late reads cannot alter a redrawn card and visible requests stay bounded to four at a time", async () => {
  const previousObserver = globalThis.IntersectionObserver;
  const originalCreate = URL.createObjectURL;
  const created = [];
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
  const targets = fakeTargets();
  const agents = Array.from({ length: 6 }, (_, index) => makeAgent(index));
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const home = createHome(targets, { read() {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => pending.push((image) => { inFlight -= 1; resolve(image); }));
  } }, agents);
  try {
    await home.start();
    const staleCard = targets.wall.cards[0];
    observers.at(-1).intersect([staleCard]);
    assert.equal(pending.length, 1);
    home.setSort("count");
    pending[0]({ mimeType: "image/jpeg", bytes: new Uint8Array([9]) });
    await tick();
    assert.equal(staleCard.image.src, "");
    assert.equal(created.length, 0, "late data is dropped before allocating an object URL");
    observers.at(-1).intersect(targets.wall.cards);
    assert.equal(pending.length, 5, "the queue starts at most four additional reads");
    assert.equal(maxInFlight, 4);
    pending[1]({ mimeType: "image/png", bytes: new Uint8Array([1]) });
    pending[2](null);
    await tick();
    assert.equal(maxInFlight, 4);
    assert.equal(pending.length, 7, "completed slots admit queued visible cards");
    for (const release of pending.slice(3)) release(null);
    await tick();
    assert.equal(maxInFlight, 4);
    assert.equal(inFlight, 0);
  } finally {
    home.attach(null);
    URL.createObjectURL = originalCreate;
    globalThis.IntersectionObserver = previousObserver;
  }
});
