import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DISPLAY_SETTINGS, lyricFontFamily, sanitizeDisplaySettings } from "../src/settings.js";

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
