import test from "node:test";
import assert from "node:assert/strict";
import { findActiveLine, lineProgress, parseLrc, visibleLineIndices } from "../src/lyrics.js";
import {
  DEFAULT_DISPLAY_SETTINGS,
  hexToRgb,
  rgbToHex,
  sanitizeDisplaySettings,
} from "../src/settings.js";

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
  assert.equal(lineProgress([{ timeMs: 1_000, text: "A" }], 0, 3_500, 0), 0.5);
});

test("sanitizes persisted display settings", () => {
  assert.deepEqual(
    sanitizeDisplaySettings({
      lineCount: 9,
      fontSize: 10,
      lineGap: 200,
      offsetX: -99,
      offsetY: 99,
      colorEffect: "unknown",
      color: { r: -1, g: 128, b: 999 },
    }),
    {
      lineCount: 5,
      fontSize: 24,
      lineGap: 56,
      offsetX: -40,
      offsetY: 35,
      colorEffect: "rgb",
      color: { r: 0, g: 128, b: 255 },
    },
  );
  assert.deepEqual(sanitizeDisplaySettings(), DEFAULT_DISPLAY_SETTINGS);
});

test("converts lyric highlight colors between RGB and hex", () => {
  assert.equal(rgbToHex({ r: 130, g: 244, b: 212 }), "#82f4d4");
  assert.deepEqual(hexToRgb("#ff73d1"), { r: 255, g: 115, b: 209 });
  assert.equal(hexToRgb("invalid"), null);
});

test("keeps exactly five lyric lines around the current line", () => {
  assert.deepEqual(visibleLineIndices(30, 10), [8, 9, 10, 11, 12]);
  assert.deepEqual(visibleLineIndices(30, 0), [0, 1, 2, 3, 4]);
  assert.deepEqual(visibleLineIndices(30, 29), [25, 26, 27, 28, 29]);
  assert.deepEqual(visibleLineIndices(30, 10, 1), [10]);
  assert.deepEqual(visibleLineIndices(30, 10, 3), [9, 10, 11]);
});
