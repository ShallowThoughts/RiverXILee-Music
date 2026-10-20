import test from "node:test";
import assert from "node:assert/strict";
import { findActiveLine, lineProgress, parseLrc, visibleLineIndices, wordProgress } from "../src/lyrics.js";
import { buildDiagnosticReport, lyricProvider, lyricTimingType } from "../src/diagnostics.js";
import {
  DEFAULT_SHORTCUTS,
  clampLyricOffset,
  duplicateShortcut,
  normalizeShortcut,
  sanitizeShortcuts,
} from "../src/preferences.js";
import {
  applyDisplayPreset,
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

test("parses NetEase YRC and QQ enhanced word timestamps", () => {
  assert.deepEqual(parseLrc("{1000,1200,0}(1000,400,0)你(1400,800,0)好"), [{
    timeMs: 1_000,
    durationMs: 1_200,
    text: "你好",
    words: [
      { timeMs: 1_000, durationMs: 400, text: "你" },
      { timeMs: 1_400, durationMs: 800, text: "好" },
    ],
  }]);
  assert.equal(parseLrc("[1000,900]<1000,300,0>Hello <1300,600,0>world")[0].text, "Hello world");
  assert.equal(parseLrc("[0,1000](0,1000,0) 作词 : 赵雷")[0].text, "作词 : 赵雷");
  assert.equal(wordProgress({ timeMs: 1_000, durationMs: 400 }, 1_200), 0.5);
});

test("normalizes, validates and de-duplicates custom shortcuts", () => {
  assert.equal(normalizeShortcut("shift + ctrl + l"), "Ctrl+Shift+L");
  const shortcuts = sanitizeShortcuts({ toggleLock: "Alt+K" });
  assert.equal(shortcuts.toggleLock, "Alt+K");
  assert.equal(shortcuts.resync, DEFAULT_SHORTCUTS.resync);
  shortcuts.resync = "Alt+K";
  assert.equal(duplicateShortcut(shortcuts, "resync"), "toggleLock");
  assert.equal(clampLyricOffset(10_999), 10_000);
  assert.equal(clampLyricOffset(-549), -500);
});

test("display presets preserve color while changing layout and font family", () => {
  const current = sanitizeDisplaySettings({
    color: { r: 9, g: 8, b: 7 },
    fontFamily: "Microsoft YaHei UI",
  });
  const result = applyDisplayPreset(current, "game");
  assert.equal(result.lineCount, 2);
  assert.equal(result.offsetY, 28);
  assert.deepEqual(result.color, { r: 9, g: 8, b: 7 });
  assert.equal(result.fontFamily, "Microsoft YaHei UI");
});

test("diagnostic report names lyric source, timing and recovery state", () => {
  assert.equal(lyricProvider({ songMid: "netease:123" }), "网易云音乐");
  assert.equal(lyricTimingType([{ text: "Hi", words: [{ text: "Hi" }] }]), "逐字歌词");
  const report = buildDiagnosticReport({
    version: "1.1.1",
    connected: true,
    isPlaying: true,
    source: "cloudmusic.exe",
    title: "我要的",
    artist: "测试歌手",
    album: "测试专辑",
    positionMs: 65_000,
    durationMs: 185_000,
    lyricStatus: "ready",
    lyricMatch: { songMid: "netease:123" },
    lines: [{ text: "Hi", words: [{ text: "Hi" }] }],
    lyricFromCache: true,
    lyricOffsetMs: 500,
    syncDriftMs: -90,
    syncCorrection: "smooth",
    mediaPollFailures: 0,
    availableSources: [{ source: "cloudmusic.exe", isPlaying: true }],
    platformName: () => "网易云音乐",
  });
  assert.match(report, /播放进度：01:05 \/ 03:05/);
  assert.match(report, /歌词来源：网易云音乐/);
  assert.match(report, /正在使用缓存/);
  assert.match(report, /同步误差：-90 ms/);
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
      fontFamily: "Segoe UI Variable Display",
      colorEffect: "rgb",
      motionEffect: "soft",
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
