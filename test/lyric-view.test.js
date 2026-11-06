import assert from "node:assert/strict";
import test from "node:test";
import { focusLineCenters, focusLineIndices, wordEmphasis, wordPose } from "../src/lyric-view.js";

const word = { timeMs: 1000, durationMs: 1000, text: "唱" };

test("word motion eases in, holds long notes and releases after the timestamp", () => {
  assert.equal(wordEmphasis(word, 999), 0);
  assert.equal(wordEmphasis(word, 1000), 0);
  assert.ok(wordEmphasis(word, 1090) > 0.8);
  assert.equal(wordEmphasis(word, 1500), 1);
  assert.equal(wordEmphasis(word, 2000), 1);
  assert.ok(Math.abs(wordEmphasis(word, 2130) - 0.5) < 0.0001);
  assert.equal(wordEmphasis(word, 2260), 0);
  assert.equal(wordEmphasis({ ...word, durationMs: 0 }, 1000), 0);
});

test("word motion is deterministic when paused, rewound or skipped", () => {
  const pose = wordPose(word, 1400, 48, "soft");
  assert.deepEqual(wordPose(word, 1400, 48, "soft"), pose);
  assert.equal(pose.progress, 0.4);
  assert.ok(pose.lift < 0 && pose.lift >= -4);
  assert.ok(Math.abs(wordPose(word, 900, 48, "soft").lift) <= 0.55);
  assert.ok(Math.abs(wordPose(word, 9000, 48, "soft").lift) <= 0.55);
  assert.notEqual(wordPose(word, 1500, 48, "flow", false, 0).rotate, wordPose(word, 1500, 48, "flow", false, 1).rotate);
});

test("none and reduced motion retain lyric colour timing without spatial animation", () => {
  for (const [effect, reduced] of [["none", false], ["soft", true], ["flow", true]]) {
    assert.deepEqual(wordPose(word, 1500, 96, effect, reduced), { progress: 0.5, lift: 0, scale: 1, rotate: 0 });
  }
  assert.ok(wordPose(word, 1500, 96, "flow").lift >= -10);
});

test("focus layouts reserve missing history and future slots instead of moving the current line", () => {
  assert.deepEqual(focusLineIndices(10, 0, 5), [0, 1, 2]);
  assert.deepEqual(focusLineIndices(10, 4, 5), [2, 3, 4, 5, 6]);
  assert.deepEqual(focusLineIndices(10, 9, 5), [7, 8, 9]);
  assert.deepEqual(focusLineIndices(10, 4, 2), [4, 5]);
  assert.deepEqual(focusLineIndices(10, 4, 1), [4]);
  const centers = focusLineCenters([30, 40, 60, 40, 30], 2, 18);
  assert.equal(centers[2], 0);
  assert.deepEqual(centers, [-121, -68, 0, 68, 121]);
});
