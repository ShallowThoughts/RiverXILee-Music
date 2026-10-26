import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { createLyricSession, legacyTrackKey, lyricTrackKey } from "../src/lyric-session.js";

const track = (title, extra = {}) => ({ connected: true, source: "cloudmusic.exe", title, artist: "歌手", album: "专辑", durationMs: 180000, ...extra });
const result = (text) => ({ lrc: `[00:00.00]${text}\n[00:10.00]下一句`, songMid: "netease:42" });
function harness(request, options = {}) {
  const state = { trackKey: "", fetchToken: 0, lines: [], lyricCache: {}, lyricAttempts: 0 };
  let clock = 0;
  const session = createLyricSession({ state, request, notify() {}, save() {}, now: () => clock, ...options });
  return { state, session, advance() { clock = state.lyricRetryAt + 1; } };
}

test("cold cache clears the previous song immediately and fetches the new lyrics", async () => {
  let resolveNew;
  const { state, session } = harness((song) => song.title === "上一首" ? result("旧歌词") : new Promise((resolve) => { resolveNew = resolve; }));
  session.update(track("上一首")); await flush();
  assert.equal(state.lines[0].text, "旧歌词");
  session.update(track("从未播放的新歌"));
  assert.equal(state.lines.length, 0);
  assert.equal(state.lyricMatch, null);
  assert.equal(state.lyricStatus, "loading");
  await flush(); resolveNew(result("新歌词")); await flush();
  assert.equal(state.lines[0].text, "新歌词");
  assert.ok(state.lyricCache[lyricTrackKey(track("从未播放的新歌"))]);
});

test("a late ID or a changing duration does not restart a successful load", async () => {
  let calls = 0;
  const { state, session } = harness(() => { calls += 1; return result("正常歌词"); });
  session.update(track("新歌", { durationMs: 0 })); await flush();
  session.update(track("新歌", { trackId: "42", durationMs: 180001 })); await flush();
  session.update(track("新歌", { trackId: "", durationMs: 180000 })); await flush();
  assert.equal(calls, 1);
  assert.equal(state.lyricStatus, "ready");
});

test("online failure keeps retrying after the old three-attempt limit and recovers", async () => {
  let calls = 0;
  const { state, session, advance } = harness(() => {
    calls += 1;
    if (calls <= 4) throw new Error("暂时断网");
    return result("网络恢复");
  });
  session.update(track("新歌")); await flush();
  for (let index = 0; index < 4; index += 1) { advance(); session.update(track("新歌")); await flush(); }
  assert.equal(calls, 5);
  assert.equal(state.lines[0].text, "网络恢复");
});

test("late responses from previous songs or automatic requests cannot replace manual lyrics", async () => {
  const pending = [];
  const { state, session } = harness(() => new Promise((resolve) => pending.push(resolve)));
  session.update(track("第一首")); await flush();
  session.update(track("第二首")); await flush();
  await session.bind(async () => result("手动绑定"));
  pending[1](result("自动结果")); pending[0](result("上一首晚到")); await flush();
  assert.equal(state.lines[0].text, "手动绑定");
  assert.equal(state.lyricMatch.manuallySelected, true);
  assert.equal(state.lyricCache[lyricTrackKey(track("第一首"))], undefined);
});

test("hung requests time out, retry, and ignore the first response after recovery", async () => {
  let resolveOld;
  let calls = 0;
  const { state, session, advance } = harness(() => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : result("超时恢复"), { timeoutMs: 10 });
  session.update(track("新歌"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.lyricStatus, "error");
  advance(); session.update(track("新歌")); await flush();
  resolveOld(result("过期请求")); await flush();
  assert.equal(state.lines[0].text, "超时恢复");
});

test("existing v1 cache is reused and a failed manual import preserves current lyrics", async () => {
  let calls = 0;
  const { state, session } = harness(() => { calls += 1; return result("在线歌词"); });
  state.lyricCache[legacyTrackKey(track("旧缓存", { trackId: "42" }))] = result("原有缓存");
  session.update(track("旧缓存", { durationMs: 180001 })); await flush();
  assert.equal(calls, 0);
  assert.equal(state.lines[0].text, "原有缓存");
  assert.equal(await session.bind(async () => ({ lrc: "没有时间标签" })), false);
  assert.equal(state.lines[0].text, "原有缓存");
  assert.equal(state.lyricStatus, "ready");
});

test("switching songs while importing never binds the file to the next song", async () => {
  const { state, session } = harness(() => result("自动歌词"));
  session.update(track("第一首")); await flush();
  let resolveImport;
  const imported = session.bind(() => new Promise((resolve) => { resolveImport = resolve; }));
  await flush();
  session.update(track("第二首")); await flush();
  resolveImport(result("第一首的文件"));
  assert.equal(await imported, false);
  assert.equal(state.lines[0].text, "自动歌词");
  assert.equal(state.lyricCache[lyricTrackKey(track("第二首"))].manuallySelected, undefined);
});
