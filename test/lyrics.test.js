import test from "node:test";
import assert from "node:assert/strict";
import { findActiveLine, lineProgress, parseLrc, visibleLineIndices } from "../src/lyrics.js";

test("parses timestamps, multiple tags and offset", () => {
  const lines = parseLrc("[offset:100]\n[00:01.20][00:02.300]你好\n[00:03.00]世界");
  assert.deepEqual(lines, [
    { timeMs: 1_300, text: "你好" },
    { timeMs: 2_400, text: "你好" },
    { timeMs: 3_100, text: "世界" },
  ]);
});

test("finds the active line at boundaries", () => {
  const lines = [
    { timeMs: 1_000, text: "A" },
    { timeMs: 2_000, text: "B" },
  ];
  assert.equal(findActiveLine(lines, 999), -1);
  assert.equal(findActiveLine(lines, 1_000), 0);
  assert.equal(findActiveLine(lines, 2_500), 1);
});

test("calculates a clamped line progress", () => {
  const lines = [
    { timeMs: 1_000, text: "A" },
    { timeMs: 3_000, text: "B" },
  ];
  assert.equal(lineProgress(lines, 0, 2_000, 5_000), 0.5);
  assert.equal(lineProgress(lines, 0, 6_000, 5_000), 1);
});

test("keeps exactly five lyric lines around the current line", () => {
  assert.deepEqual(visibleLineIndices(30, 10), [8, 9, 10, 11, 12]);
  assert.deepEqual(visibleLineIndices(30, 0), [0, 1, 2, 3, 4]);
  assert.deepEqual(visibleLineIndices(30, 29), [25, 26, 27, 28, 29]);
});
