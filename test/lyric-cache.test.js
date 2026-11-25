import test from "node:test";
import assert from "node:assert/strict";
import { pruneLyricCache, usableLyricCache, LYRIC_CACHE_LIMIT, QQ_LYRIC_MATCH_REVISION } from "../src/lyric-cache.js";

test("KuGou exact recording hashes reject stale automatic versions and every foreign provider", () => {
  const hash = "0123456789abcdef0123456789abcdef";
  const track = { source: "kugou", trackId: `kugou:${hash}`, durationMs: 269000 };
  assert.equal(usableLyricCache({ songMid: `kugou:${hash}`, matchRevision: QQ_LYRIC_MATCH_REVISION },track),true);
  assert.equal(usableLyricCache({ songMid: `kugou:${"a".repeat(32)}`, matchRevision: QQ_LYRIC_MATCH_REVISION },track),false);
  for (const songMid of ["qq:12345678","netease:42"]) assert.equal(usableLyricCache({songMid, manuallySelected:true},track),false);
  assert.equal(usableLyricCache({songMid:"local:import",manuallySelected:true},track),true);
});

test("1000 automatic entries survive, oldest entries evict, and manual bindings are protected", () => {
  const cache = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`song${i}`, { savedAt: i }]));
  cache.manual = { savedAt: -1, manuallySelected: true };
  const trimmed = pruneLyricCache(cache);
  assert.equal(LYRIC_CACHE_LIMIT, 1000);
  assert.equal(Object.keys(trimmed).length, 1001);
  assert.ok(trimmed.manual && trimmed.song1099);
  assert.equal(trimmed.song99, undefined);
});

test("QQ sessions refresh old automatic matches and never reuse a cross-catalog backup ahead of QQ", () => {
  const track = { source: "QQMusic.exe", durationMs: 180_000 };
  assert.equal(usableLyricCache({ matchRevision: 2, songMid: "002sXtHN37Aqki" }, track), false);
  assert.equal(usableLyricCache({ matchRevision: QQ_LYRIC_MATCH_REVISION, songMid: "netease:42" }, track), false);
  assert.equal(usableLyricCache({ matchRevision: QQ_LYRIC_MATCH_REVISION, songMid: "002sXtHN37Aqki" }, track), true);
  assert.equal(usableLyricCache({ songMid: "netease:42", manuallySelected: true }, track), false);
  assert.equal(usableLyricCache({ songMid: "local:imported", manuallySelected: true }, track), true);
});

test("old automatic matches refresh without losing manual bindings or sliding the instrumental expiry", () => {
  const track = { durationMs: 180000 };
  assert.equal(usableLyricCache({ matchedTitle: "song" }, track), false);
  assert.equal(usableLyricCache({ matchedTitle: "song", manuallySelected: true }, track), true);
  assert.equal(usableLyricCache({ matchRevision: 2, matchedTitle: "song", trackDurationMs: 160000 }, track), false);
  assert.equal(usableLyricCache({ instrumental: true, savedAt: 1000000000, instrumentalCheckedAt: 1 }, track, 1000000001), false);
});

test("a known NetEase ID rejects cached automatic lyrics from another recording or provider", () => {
  const song = { source: "cloudmusic.exe", trackId: "42", durationMs: 180000 };
  assert.equal(usableLyricCache({ songMid: "netease:99" }, song), false);
  assert.equal(usableLyricCache({ songMid: "qq:12345678" }, song), false);
  assert.equal(usableLyricCache({ songMid: "netease:42" }, song), true);
  assert.equal(usableLyricCache({ songMid: "netease:99", manuallySelected: true }, song), true);
});
