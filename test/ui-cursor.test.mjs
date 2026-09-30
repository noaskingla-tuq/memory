import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { readCairn } from "../out/adapters/ui/cairnReader.js";
import { createCursorCodec, filterHash } from "../out/application/ui/cursor.js";
import { actorOf, databasePathOf, fillNamespace, openStore, scratchDirectory } from "./readerHarness.mjs";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const FILTER = { agentId: "sw/developer", scope: "project", projectId: "p1", cli: "claude", sinceIso: "2026-09-01T00:00:00.000Z" };
const POSITION = ["2026-09-30T02:13:22.884Z", "0ac2098f-6932-40d5-bb74-0826e18dc8ab"];

function signedToken(payload, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest().toString("base64url")}`;
}

test("a cursor round-trips its keyset position exactly, including CJK identifiers", () => {
  const codec = createCursorCodec(SECRET);
  for (const position of [POSITION, ["only"], ["測試", "😀", "a", "b"], [""]]) {
    const token = codec.encode(FILTER, position);
    assert.ok(token.length <= 1024);
    assert.deepEqual(codec.decode(FILTER, token), { ok: true, position });
  }
  const other = createCursorCodec(SECRET);
  assert.deepEqual(other.decode(FILTER, codec.encode(FILTER, POSITION)), { ok: true, position: POSITION }, "the key, not the instance, decides");
});

test("the filter hash ignores key order, cursor, limit and undefined values, and reacts to every other change", () => {
  const base = filterHash(FILTER);
  assert.equal(filterHash({ ...FILTER, limit: 5, cursor: "x.y" }), base);
  assert.equal(filterHash({ ...FILTER, limit: 24 }), filterHash({ ...FILTER, limit: 3 }));
  assert.equal(filterHash({ untilIso: undefined, ...FILTER }), base);
  assert.equal(filterHash(Object.fromEntries(Object.entries(FILTER).reverse())), base);
  for (const changed of [
    { ...FILTER, agentId: "sw/reviewer" },
    { ...FILTER, cli: "codex" },
    { ...FILTER, projectId: "p2" },
    { ...FILTER, untilIso: "2026-09-30T00:00:00.000Z" },
    { ...FILTER, q: "登入" },
    { agentId: FILTER.agentId },
  ]) {
    assert.notEqual(filterHash(changed), base, JSON.stringify(changed));
  }
  assert.notEqual(filterHash({ a: [1, 2] }), filterHash({ a: [2, 1] }));
  assert.notEqual(filterHash({ a: 1 }), filterHash({ a: "1" }));
  assert.match(base, /^[0-9a-f]{32}$/);
});

test("a cursor is refused when the filter it was issued for is not the filter sent with it", () => {
  const codec = createCursorCodec(SECRET);
  const token = codec.encode(FILTER, POSITION);
  assert.deepEqual(codec.decode({ ...FILTER, limit: 5 }, token), { ok: true, position: POSITION }, "a different page size is fine");
  for (const filter of [{ ...FILTER, cli: "codex" }, { ...FILTER, q: "x" }, { agentId: FILTER.agentId }, {}]) {
    assert.deepEqual(codec.decode(filter, token), { ok: false, reason: "filter_mismatch" }, JSON.stringify(filter));
  }
});

test("changing any single character of a cursor is refused", () => {
  const codec = createCursorCodec(SECRET);
  const token = codec.encode(FILTER, POSITION);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let refused = 0;
  for (let index = 0; index < token.length; index += 1) {
    if (token[index] === ".") continue;
    const replacement = alphabet[(alphabet.indexOf(token[index]) + 1) % alphabet.length];
    const decoded = codec.decode(FILTER, `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`);
    assert.equal(decoded.ok, false, `position ${index}`);
    refused += 1;
  }
  assert.equal(refused, token.length - 1);
  assert.equal(codec.decode(FILTER, `${token}A`).ok, false, "an appended character");
  assert.equal(codec.decode(FILTER, token.slice(0, -1)).ok, false, "a dropped character");
});

test("swapped signatures, a forged position, another key, oversize and non-string input are all refused", () => {
  const codec = createCursorCodec(SECRET);
  const first = codec.encode(FILTER, POSITION);
  const second = codec.encode(FILTER, ["2026-01-01T00:00:00.000Z", "other-id"]);
  assert.equal(codec.decode(FILTER, `${first.split(".")[0]}.${second.split(".")[1]}`).ok, false);
  const forgedBody = Buffer.from(JSON.stringify({ v: 1, f: filterHash(FILTER), k: ["2099-01-01T00:00:00.000Z", "z"] }), "utf8").toString("base64url");
  assert.deepEqual(codec.decode(FILTER, `${forgedBody}.${first.split(".")[1]}`), { ok: false, reason: "tampered" });
  assert.deepEqual(createCursorCodec(Buffer.from("another key another key another!!")).decode(FILTER, first), { ok: false, reason: "tampered" }, "a cursor from another process or key");
  assert.deepEqual(createCursorCodec().decode(FILTER, first), { ok: false, reason: "tampered" }, "a random default key never matches");
  for (const bad of ["", ".", "a.b.c", "no-dot", "a b.c", `${"a".repeat(1100)}.b`, 42, null, undefined, {}]) {
    assert.deepEqual(codec.decode(FILTER, bad), { ok: false, reason: "malformed" }, String(bad).slice(0, 20));
  }
});

test("a correctly signed cursor with a wrong version or shape is still refused", () => {
  const codec = createCursorCodec(SECRET);
  const f = filterHash(FILTER);
  for (const payload of [
    { v: 2, f, k: POSITION },
    { v: 1, f: 5, k: POSITION },
    { v: 1, f, k: [] },
    { v: 1, f, k: [1, 2] },
    { v: 1, f, k: ["a", "b", "c", "d", "e"] },
    { v: 1, f, k: ["x".repeat(201)] },
    null,
    [],
  ]) {
    assert.deepEqual(codec.decode(FILTER, signedToken(payload)), { ok: false, reason: "malformed" }, JSON.stringify(payload));
  }
  assert.deepEqual(codec.decode(FILTER, signedToken({ v: 1, f, k: POSITION })), { ok: true, position: POSITION });
});

test("encode rejects a position that would not fit the cursor format", () => {
  const codec = createCursorCodec(SECRET);
  assert.throws(() => codec.encode(FILTER, []));
  assert.throws(() => codec.encode(FILTER, ["a", "b", "c", "d", "e"]));
  assert.throws(() => codec.encode(FILTER, ["x".repeat(201)]));
});

test("walking a namespace with cursors returns every row once, in list order, for any page size", async (t) => {
  const base = scratchDirectory(t, "cursor");
  const { app, root } = openStore(base, t);
  await fillNamespace(app, actorOf("sw/developer"), "personal", 27, "c");
  const path = databasePathOf(root, "sw/developer");
  const namespace = { ownerId: "sw/developer", scope: "personal", projectId: null };
  const whole = readCairn(path, (reader) => reader.list(namespace, { limit: 1000 }));
  assert.equal(whole.ok, true);
  const codec = createCursorCodec(SECRET);
  for (const limit of [1, 4, 7, 24]) {
    const filter = { agentId: "sw/developer", scope: "personal" };
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 100; guard += 1) {
      const after = cursor === undefined ? undefined : codec.decode(filter, cursor);
      assert.ok(after === undefined || after.ok);
      const page = readCairn(path, (reader) =>
        reader.list(namespace, { limit: limit + 1, ...(after === undefined ? {} : { after: { updatedAt: after.position[0], id: after.position[1] } }) }),
      );
      assert.equal(page.ok, true);
      const rows = page.value.slice(0, limit);
      seen.push(...rows);
      if (page.value.length <= limit) break;
      cursor = codec.encode({ ...filter, limit }, [rows.at(-1).updatedAt, rows.at(-1).id]);
    }
    assert.deepEqual(seen.map((row) => row.id), whole.value.map((row) => row.id), `limit ${limit}`);
  }
});
