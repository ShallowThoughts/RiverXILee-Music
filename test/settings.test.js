import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DISPLAY_SETTINGS, sanitizeDisplaySettings } from "../src/settings.js";

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
