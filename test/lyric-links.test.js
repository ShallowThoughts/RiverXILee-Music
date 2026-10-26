import assert from "node:assert/strict";
import test from "node:test";
import { parseSongLink, readLyricFile } from "../src/lyric-links.js";

test("parses full NetEase and QQ links including shared text and hash routes", () => {
  assert.deepEqual(parseSongLink("分享歌曲 https://music.163.com/song?id=2700280922&uct2=abc"), { provider: "netease", id: "2700280922" });
  assert.equal(parseSongLink("https://music.163.com/#/song?id=42").id, "42");
  assert.equal(parseSongLink("https://y.qq.com/n/ryqq/songDetail/003lghpv0jfFXG").id, "003lghpv0jfFXG");
  assert.equal(parseSongLink("https://y.qq.com/n/yqq/song/003lghpv0jfFXG.html").id, "003lghpv0jfFXG");
  assert.equal(parseSongLink("https://i.y.qq.com/v8/playsong.html?songmid=003lghpv0jfFXG").provider, "qq");
});

test("rejects foreign URLs, lists, arbitrary schemes and unsupported short links", () => {
  for (const input of ["https://music.163.com.evil.test/song?id=42", "https://music.163.com/playlist?id=42", "file:///song?id=42", "https://163cn.tv/abc", "https://y.qq.com/n/ryqq/playlist/003lghpv0jfFXG"]) {
    assert.throws(() => parseSongLink(input));
  }
});

test("lyric files enforce size limits and decode UTF-8 and legacy Chinese", async () => {
  const utf8 = new File(["[00:00.00]你好"], "song.lrc");
  assert.equal(await readLyricFile(utf8), "[00:00.00]你好");
  const legacy = new File([new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])], "song.lrc");
  assert.equal(await readLyricFile(legacy), "你好");
  await assert.rejects(readLyricFile({ size: 3 * 1024 * 1024 }), /2 MB/);
});
