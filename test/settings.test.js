import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DISPLAY_SETTINGS, lyricFontFamily, sanitizeDisplaySettings } from "../src/settings.js";
import { displayBackup, mergeDisplayProfiles, parseDisplayBackup } from "../src/settings.js";

test("display settings keep a supported lyric motion effect", () => {
  assert.equal(sanitizeDisplaySettings({ motionEffect: "flow" }).motionEffect, "flow");
  assert.equal(sanitizeDisplaySettings({ motionEffect: "none" }).motionEffect, "none");
});

test("display settings fall back to the default motion effect", () => {
  assert.equal(
    sanitizeDisplaySettings({ motionEffect: "bounce" }).motionEffect,
    DEFAULT_DISPLAY_SETTINGS.motionEffect,
  );
});

test("selected lyric font is emitted as the first family for every lyric layer", () => {
  assert.equal(
    lyricFontFamily("Aa海派腔调"),
    '"Aa海派腔调", "Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif',
  );
  assert.equal(lyricFontFamily('Bad"; font-size: 0'), '"Bad font-size: 0", "Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif');
});

test("display backup round-trips custom typography, colours, motion and named profiles", () => {
  const settings = sanitizeDisplaySettings({ fontFamily: "自定义字体", fontSize: 72, lineCount: 2, motionEffect: "flow", color: { r: 7, g: 80, b: 255 } });
  const profiles = [{ id: "game", name: "游戏字幕", settings }];
  assert.deepEqual(parseDisplayBackup(displayBackup(settings, profiles)), { display: settings, profiles });
});

test("import preserves existing schemes with the same name and rejects unrelated files", () => {
  const existing = [{ id: "game", name: "游戏", settings: sanitizeDisplaySettings({ fontSize: 42 }) }];
  const imported = [{ id: "game", name: "游戏", settings: sanitizeDisplaySettings({ fontSize: 64 }) }];
  const merged = mergeDisplayProfiles(existing, imported);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].settings.fontSize, 42);
  assert.equal(merged[1].settings.fontSize, 64);
  assert.notEqual(merged[0].name, merged[1].name);
  assert.notEqual(merged[0].id, merged[1].id);
  for (const invalid of ["{}", "not json", '{"format":"riverxilee-display-profiles","version":2}', '{"format":"riverxilee-display-profiles","version":1,"display":{},"profiles":[]}']) assert.throws(() => parseDisplayBackup(invalid));
});
