import assert from "node:assert/strict";
import test from "node:test";
import { createClock, nextTurn } from "../out/application/ui/timeSlice.js";

function fakeNow() {
  let value = 0;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test("a clock yields only after its slice ran out and the call budget ends the call", async () => {
  const time = fakeNow();
  const clock = createClock({ sliceMs: 25, budgetMs: 100, now: time.now });
  assert.equal(clock.sliceExpired(), false);
  time.advance(24);
  assert.equal(clock.sliceExpired(), false);
  time.advance(1);
  assert.equal(clock.sliceExpired(), true);
  await clock.yieldIfDue();
  assert.equal(clock.sliceExpired(), false, "yielding starts a new slice");
  assert.equal(clock.timeUp(), false);
  time.advance(75);
  assert.equal(clock.timeUp(), true, "100 ms after the call began");
});

test("a cancelled clock reports time up at once", () => {
  let cancelled = false;
  const clock = createClock({ cancelled: () => cancelled });
  assert.equal(clock.timeUp(), false);
  cancelled = true;
  assert.equal(clock.timeUp(), true);
});

test("concurrent calls resume in different event-loop turns, so their slices never run back to back", async () => {
  let turn = 0;
  let watching = true;
  const tick = () => {
    turn += 1;
    if (watching) setImmediate(tick);
  };
  setImmediate(tick);
  const resumedIn = [];
  const worker = async (rounds) => {
    for (let round = 0; round < rounds; round += 1) {
      await nextTurn();
      resumedIn.push(turn);
    }
  };
  await Promise.all([worker(6), worker(6), worker(6), worker(6)]);
  watching = false;
  assert.equal(resumedIn.length, 24);
  assert.equal(new Set(resumedIn).size, resumedIn.length, `two continuations shared a turn: ${resumedIn.join(",")}`);
});

test("a slice of zero milliseconds still lets every waiting call finish", async () => {
  const clocks = Array.from({ length: 5 }, () => createClock({ sliceMs: 0 }));
  let done = 0;
  await Promise.all(clocks.map(async (clock) => {
    for (let step = 0; step < 10; step += 1) await clock.yieldIfDue();
    done += 1;
  }));
  assert.equal(done, 5);
});
