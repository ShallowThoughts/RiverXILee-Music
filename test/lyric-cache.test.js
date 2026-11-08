import test from "node:test";
import assert from "node:assert/strict";
import { pruneLyricCache, usableLyricCache, LYRIC_CACHE_LIMIT } from "../src/lyric-cache.js";

test("1000 automatic entries survive, oldest entries evict, and manual bindings are protected", () => {
  const cache = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`song${i}`, { savedAt: i }]));
  cache.manual = { savedAt: -1, manuallySelected: true };
  const trimmed = pruneLyricCache(cache);
  assert.equal(LYRIC_CACHE_LIMIT, 1000);
  assert.equal(Object.keys(trimmed).length, 1001);
  assert.ok(trimmed.manual && trimmed.song1099);
  assert.equal(trimmed.song99, undefined);
});

test("old automatic matches refresh without losing manual bindings or sliding the instrumental expiry", () => {
  const track = { durationMs: 180000 };
  assert.equal(usableLyricCache({ matchedTitle: "song" }, track), false);
  assert.equal(usableLyricCache({ matchedTitle: "song", manuallySelected: true }, track), true);
  assert.equal(usableLyricCache({ matchRevision: 2, matchedTitle: "song", trackDurationMs: 160000 }, track), false);
  assert.equal(usableLyricCache({ instrumental: true, savedAt: 1000000000, instrumentalCheckedAt: 1 }, track, 1000000001), false);
});
