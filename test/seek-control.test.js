import test from "node:test";
import assert from "node:assert/strict";
import { seekPosition, createSeekControl } from "../src/seek-control.js";

function harness(seek = async () => {}) {
  const handlers = {};
  const input = { value: "0", setAttribute() {}, addEventListener(name, fn) { handlers[name] = fn; } };
  const fill = { style: {} }, time = {};
  const errors = [];
  const control = createSeekControl({ input, fill, time, formatTime: String, seek, error: (e) => errors.push(e) });
  const snapshot = { key: "first", positionMs: 5000, durationMs: 100000, enabled: true };
  control.update(snapshot);
  return { input, fill, time, handlers, control, snapshot, errors };
}

test("seek target clamps to the song duration and rejects invalid numbers", () => {
  assert.equal(seekPosition(15000, 10000), 10000);
  assert.equal(seekPosition(-1, 10000), 0);
  assert.equal(seekPosition(NaN, 10000), 0);
  assert.equal(seekPosition(123, Infinity), 0);
});

test("scrubbing previews time without sending requests until committed", async () => {
  const calls = [];
  const h = harness(async (...args) => calls.push(args));
  h.handlers.pointerdown();
  h.input.value = "40000"; h.handlers.input();
  h.control.update({ ...h.snapshot, positionMs: 6000 });
  assert.equal(h.input.value, "40000");
  assert.equal(h.time.textContent, "40000");
  assert.equal(calls.length, 0);
  await h.handlers.change();
  assert.deepEqual(calls, [[40000, "first"]]);
  assert.equal(h.input.value, "6000", "confirmed playback clock remains authoritative");
});

test("switching songs during a drag cancels rather than seeking the next song", async () => {
  let calls = 0;
  const h = harness(async () => calls++);
  h.handlers.pointerdown(); h.input.value = "40000"; h.handlers.input();
  h.control.update({ ...h.snapshot, key: "next", positionMs: 0 });
  h.input.value = "70000"; h.handlers.input(); await h.handlers.change();
  assert.equal(calls, 0);
  assert.equal(h.input.value, "0");
});

test("unsupported, canceled and failed seeks restore real progress", async () => {
  const h = harness(async () => { throw new Error("not supported"); });
  h.input.value = "40000"; h.handlers.input(); await h.handlers.change();
  assert.equal(h.errors.length, 1);
  assert.equal(h.input.value, "5000");
  h.handlers.pointerdown(); h.input.value = "60000"; h.handlers.input(); h.handlers.pointercancel();
  await h.handlers.change();
  assert.equal(h.errors.length, 1);
  h.control.update({ ...h.snapshot, enabled: false });
  assert.equal(h.input.disabled, true);
});
