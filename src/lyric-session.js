import { parseLrc } from "./lyrics.js";
import { musicSourceKey as sourceKey } from "./media-sources.js";
import { usableLyricCache } from "./lyric-cache.js";
import { attachTranslations, needsTranslationRefresh } from "./translations.js";

// IDs and durations can arrive after the title, or fluctuate between media readers.
export function lyricTrackKey(track) {
  if (!track?.connected || !track.title?.trim()) return "";
  return ["v2", sourceKey(track.source), track.title.trim(), (track.artist || "").trim(), (track.album || "").trim()].join("\0");
}

export function legacyTrackKey(track) {
  return [track.source, track.trackId || "", track.title, track.artist, track.album, track.durationMs].join("\0");
}

export function matchingLegacyKeys(store, track) {
  return Object.keys(store).filter((oldKey) => {
    // Earlier v2 entries used the raw Qishui/SodaMusic identifier.
    if (oldKey.startsWith("v2\0")) {
      const [, source, title, artist, album] = oldKey.split("\0");
      return sourceKey(source) === sourceKey(track.source) && title === track.title
        && artist === track.artist && album === track.album;
    }
    const [source, id, title, artist, album, duration] = oldKey.split("\0");
    return !oldKey.startsWith("v2\0") && sourceKey(source) === sourceKey(track.source)
      && title === track.title && artist === track.artist && album === track.album
      && !(id && track.trackId && id !== track.trackId)
      && !(Number(duration) > 0 && track.durationMs > 0 && Math.abs(Number(duration) - track.durationMs) > 15_000);
  });
}

export function cachedLyricsFor(cache, track) {
  const key = lyricTrackKey(track);
  if (cache[key]) return cache[key];
  if (cache[legacyTrackKey(track)]) return cache[legacyTrackKey(track)];
  return matchingLegacyKeys(cache, track).map((oldKey) => [oldKey, cache[oldKey]])
    .sort(([, left], [, right]) => (right.savedAt || 0) - (left.savedAt || 0))[0]?.[1];
}

export function createLyricSession({ state, request, notify, save, now = () => performance.now(), timeoutMs = 28_000 }) {
  let snapshot = null;
  let controller = null;

  function invalidate() {
    state.fetchToken += 1;
    controller?.abort();
    controller = null;
  }

  async function load({ manualRequest, force = false } = {}) {
    if (!snapshot || !state.trackKey) return false;
    invalidate();
    const token = state.fetchToken;
    const key = state.trackKey;
    const track = { ...snapshot };
    const manual = Boolean(manualRequest);
    const retained = manual && (state.lines.length || state.lyricStatus === "instrumental")
      ? { lines: state.lines, match: state.lyricMatch, status: state.lyricStatus } : null;
    state.lyricAttempts += 1;
    state.lyricStatus = "loading";
    state.lyricMessage = "";
    state.lyricFromCache = false;
    if (!retained) state.lines = [];
    state.activeIndex = Number.NaN;
    notify();

    const currentController = new AbortController();
    controller = currentController;
    let timer;
    let abortHandler;
    try {
      const entry = !manual && !force ? cachedLyricsFor(state.lyricCache, track) : null;
      const cached = usableLyricCache(entry, track)
        && !(state.display?.translationMode === "bilingual" && needsTranslationRefresh(entry)) ? entry : null;
      const result = cached && (cached.instrumental || cached.lrc && parseLrc(cached.lrc).length) ? cached : await Promise.race([
        Promise.resolve().then(() => manualRequest ? manualRequest() : request(track)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("歌词请求超时，将自动重试")), timeoutMs);
          abortHandler = () => reject(new Error("歌曲已切换"));
          currentController.signal.addEventListener("abort", abortHandler, { once: true });
        }),
      ]);
      if (token !== state.fetchToken || key !== state.trackKey) return false;
      const lines = result.instrumental ? [] : attachTranslations(parseLrc(result.lrc), result.translationLrc);
      if (!result.instrumental && !lines.length) throw new Error("歌词没有可用的时间标签，可尝试其他版本或导入 LRC");
      state.lines = lines;
      state.lyricStatus = result.instrumental ? "instrumental" : "ready";
      state.lyricMatch = manual ? { ...result, manuallySelected: true } : result;
      state.lyricFromCache = result === cached;
      state.lyricRetryAt = 0;
      state.lyricCache[key] = { ...result, trackDurationMs: track.durationMs, savedAt: Date.now(),
        ...(result.instrumental ? { instrumentalCheckedAt: result.instrumentalCheckedAt || result.savedAt || Date.now() } : {}),
        ...(manual ? { manuallySelected: true } : {}) };
      save();
      notify();
      return true;
    } catch (error) {
      if (token !== state.fetchToken || key !== state.trackKey) return false;
      state.lyricMessage = String(error?.message || error).replace(/^Error: /, "");
      if (retained) {
        state.lines = retained.lines;
        state.lyricMatch = retained.match;
        state.lyricStatus = retained.status;
      } else {
        const canRecoverQuietly = !manual && state.lyricAttempts === 1
          && !/\b(?:429|502|503|504)\b|超时|限制访问|权限|没有可用的时间标签|两个歌词源均未找到/.test(state.lyricMessage);
        state.lyricStatus = canRecoverQuietly ? "recovering" : "error";
        const delays = /\b(?:429|502|503|504)\b/.test(state.lyricMessage)
          ? [30_000, 60_000, 120_000, 300_000] : /\b405\b/.test(state.lyricMessage)
            ? [10_000, 30_000, 60_000, 120_000] : [1_000, 2_500, 6_000, 15_000, 30_000, 60_000];
        const serverWait = Number(state.lyricMessage.match(/建议等待 (\d+) 秒/)?.[1] || 0) * 1000;
        state.lyricRetryAt = now() + (canRecoverQuietly ? 650 : Math.max(serverWait, delays[Math.min(state.lyricAttempts - 1, delays.length - 1)]));
      }
      notify();
      return false;
    } finally {
      clearTimeout(timer);
      if (abortHandler) currentController.signal.removeEventListener("abort", abortHandler);
      if (controller === currentController) controller = null;
    }
  }

  function update(track) {
    const key = lyricTrackKey(track);
    const enriched = track.trackId && track.trackId !== snapshot?.trackId;
    snapshot = { ...track };
    if (key !== state.trackKey) {
      invalidate();
      state.trackKey = key;
      state.lines = [];
      state.lyricMatch = null;
      state.lyricFromCache = false;
      state.lyricStatus = "idle";
      state.lyricMessage = "";
      state.lyricAttempts = 0;
      state.lyricRetryAt = 0;
      state.activeIndex = Number.NaN;
      notify();
      if (key) void load();
      return true;
    }
    if (key && ["error", "recovering"].includes(state.lyricStatus) && (enriched || now() >= state.lyricRetryAt)) void load();
    return false;
  }

  return {
    update,
    invalidate,
    retry() { state.lyricAttempts = 0; return load({ force: true }); },
    bind(manualRequest) { return load({ manualRequest, force: true }); },
  };
}
