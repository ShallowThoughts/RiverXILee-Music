import assert from "node:assert/strict";
import test from "node:test";
import { musicSourceKey, platformName, resolvePreferredSource } from "../src/media-sources.js";
import { cachedLyricsFor, lyricTrackKey, matchingLegacyKeys } from "../src/lyric-session.js";
import { buildDiagnosticReport, lyricProvider } from "../src/diagnostics.js";

test("Qishui names and the SodaMusic session are one platform without accepting generic soda apps", () => {
  for (const source of ["SodaMusic.exe", "SODAMUSIC.EXE", "ByteDance.SodaMusic_123!App", "QishuiMusic.exe", "汽水音乐.exe"]) {
    assert.equal(musicSourceKey(source), "qishuimusic");
    assert.equal(platformName(source), "汽水音乐");
  }
  for (const source of ["SodaPDF.exe", "soda-video.exe", "Douyin.exe", "chrome.exe"]) {
    assert.notEqual(musicSourceKey(source), "qishuimusic");
  }
});

test("a previously locked Qishui player follows the renamed session but never a different player", () => {
  assert.equal(resolvePreferredSource("QishuiMusic.exe", [{ source: "QQMusic.exe" }, { source: "SodaMusic.exe" }]), "SodaMusic.exe");
  assert.equal(resolvePreferredSource("QishuiMusic.exe", [{ source: "QQMusic.exe" }]), "QishuiMusic.exe");
  assert.equal(resolvePreferredSource("", [{ source: "SodaMusic.exe" }]), "");
});

test("SodaMusic retains previous v2 Qishui caches and song offsets", () => {
  const track = { connected: true, source: "SodaMusic.exe", title: "song", artist: "artist", album: "album", durationMs: 180000 };
  const oldKey = ["v2", "qishuimusic.exe", "song", "artist", "album"].join("\0");
  const cached = { lrc: "[00:01.00]line", songMid: "qq:12345678", savedAt: 1 };
  assert.equal(cachedLyricsFor({ [oldKey]: cached }, track), cached);
  assert.deepEqual(matchingLegacyKeys({ [oldKey]: 500 }, track), [oldKey]);
  assert.equal(lyricTrackKey(track), lyricTrackKey({ ...track, source: "QishuiMusic.exe" }));
  assert.equal(cachedLyricsFor({ [oldKey]: cached }, { ...track, title: "another song" }), undefined);
});

test("diagnostics name SodaMusic and preserve the actionable lyric error", () => {
  const report = buildDiagnosticReport({ version: "1.1.3", source: "SodaMusic.exe", connected: true, platformName,
    title: "song", lyricStatus: "error", lyricMessage: "QQ 音乐歌词请求超时，请检查网络后重试" });
  assert.match(report, /当前播放器：汽水音乐/);
  assert.match(report, /媒体会话标识：SodaMusic\.exe/);
  assert.match(report, /最近错误：QQ 音乐歌词请求超时/);
  assert.equal(lyricProvider({ songMid: "000JBYAP1N4s5M" }), "QQ 音乐");
});
