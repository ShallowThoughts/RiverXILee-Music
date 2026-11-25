import test from "node:test";
import assert from "node:assert/strict";
import { lyricMatchesPlayer, nativeLyricProvider } from "../src/lyric-source.js";

test("strict native source blocks foreign caches even when manually selected", () => {
  for (const [source, native, foreign] of [["Tencent.QQMusic", "qq:12345678", "netease:42"],
    ["cloudmusic.exe", "netease:42", "qq:12345678"],
    ["kugou", "kugou:0123456789abcdef0123456789abcdef", "netease:42"]]) {
    assert.ok(nativeLyricProvider(source));
    assert.equal(lyricMatchesPlayer({songMid:native}, {source}), true);
    assert.equal(lyricMatchesPlayer({songMid:foreign,manuallySelected:true}, {source}), false);
    assert.equal(lyricMatchesPlayer({songMid:"local:imported"}, {source}), true);
  }
  assert.equal(nativeLyricProvider("KuGou.exe"), "kugou");
  assert.equal(lyricMatchesPlayer({songMid:"qq:12345678"}, {source:"KuGou.exe"}), false);
});
