import test from "node:test";
import assert from "node:assert/strict";
import { playbackAnchor, playbackPosition } from "../src/playback.js";

const epoch = 1_780_000_000_000;
function snapshot(overrides = {}) {
  return {
    positionMs: 60_000,
    durationMs: 200_000,
    isPlaying: true,
    playbackRate: 1,
    timelineUpdatedAtMs: epoch,
    capturedAtMs: epoch + 5_000,
    ...overrides,
  };
}

test("compensates stale timeline position and IPC delay", () => {
  const anchor = playbackAnchor(snapshot(), 100, epoch + 5_050);
  assert.equal(anchor.positionMs, 65_050);
  assert.equal(playbackPosition(anchor, 600), 65_550);
});

test("polling the same cached timeline does not rewind the clock", () => {
  const first = playbackAnchor(snapshot(), 100, epoch + 5_000);
  const next = playbackAnchor(snapshot({ capturedAtMs: epoch + 5_650 }), 750, epoch + 5_650);
  assert.equal(playbackPosition(first, 750), next.positionMs);
});

test("paused snapshots do not advance despite an old timestamp", () => {
  const anchor = playbackAnchor(snapshot({ isPlaying: false }), 100, epoch + 50_000);
  assert.equal(anchor.positionMs, 60_000);
  assert.equal(playbackPosition(anchor, 10_000), 60_000);
});

test("resume uses the new timeline anchor instead of counting paused time", () => {
  const anchor = playbackAnchor(snapshot({
    timelineUpdatedAtMs: epoch + 40_000,
    capturedAtMs: epoch + 40_200,
  }), 100, epoch + 40_250);
  assert.equal(anchor.positionMs, 60_250);
});

test("honors forward and backward seeks immediately", () => {
  for (const positionMs of [120_000, 10_000]) {
    const anchor = playbackAnchor(snapshot({
      positionMs,
      timelineUpdatedAtMs: epoch + 5_000,
    }), 100, epoch + 5_030);
    assert.equal(anchor.positionMs, positionMs + 30);
  }
});

test("applies playback rate to both timestamp compensation and animation", () => {
  const anchor = playbackAnchor(snapshot({ playbackRate: 1.5 }), 100, epoch + 5_000);
  assert.equal(anchor.positionMs, 67_500);
  assert.equal(playbackPosition(anchor, 1_100), 69_000);
});

test("missing and invalid rates default to normal speed while zero stays still", () => {
  for (const playbackRate of [undefined, null, NaN, Infinity, -1]) {
    assert.equal(playbackAnchor(snapshot({ playbackRate }), 0, epoch + 5_000).positionMs, 65_000);
  }
  assert.equal(playbackAnchor(snapshot({ playbackRate: 0 }), 0, epoch + 5_000).positionMs, 60_000);
});

test("invalid or future timeline timestamps fall back to capture time", () => {
  for (const timelineUpdatedAtMs of [undefined, null, 0, -1, epoch + 6_000]) {
    const anchor = playbackAnchor(snapshot({ timelineUpdatedAtMs }), 0, epoch + 5_100);
    assert.equal(anchor.positionMs, 60_100);
  }
});

test("clamps song boundaries and supports unknown duration", () => {
  assert.equal(playbackAnchor(snapshot({ durationMs: 61_000 }), 0, epoch + 5_000).positionMs, 61_000);
  const anchor = playbackAnchor(snapshot({ durationMs: 0 }), 0, epoch + 5_000);
  assert.equal(playbackPosition(anchor, 10_000), 75_000);
  assert.equal(playbackPosition({ ...anchor, positionMs: -10, isPlaying: false }, 0), 0);
});

test("animation uses a monotonic clock and never adds negative elapsed time", () => {
  const anchor = playbackAnchor(snapshot(), 100, epoch + 5_000);
  assert.equal(playbackPosition(anchor, 50), 65_000);
});
