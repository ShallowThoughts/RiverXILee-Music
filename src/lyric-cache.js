import { musicSourceKey } from "./media-sources.js";

export const LYRIC_CACHE_LIMIT = 1000;
export const LYRIC_MATCH_REVISION = 4;
export const QQ_LYRIC_MATCH_REVISION = LYRIC_MATCH_REVISION;

export function pruneLyricCache(cache) {
  const entries = Object.entries(cache).sort(([, a], [, b]) => (b.savedAt || 0) - (a.savedAt || 0));
  let automatic = 0;
  return Object.fromEntries(entries.filter(([, item]) => item.manuallySelected || automatic++ < LYRIC_CACHE_LIMIT));
}

export function usableLyricCache(item, track, time = Date.now()) {
  if (!item) return false;
  if (item.manuallySelected) return true;
  if (musicSourceKey(track.source) === "cloudmusic" && /^\d+$/.test(track.trackId || "")
      && item.songMid !== `netease:${track.trackId}` && item.songMid !== "metadata:instrumental") return false;
  if (musicSourceKey(track.source) === "qqmusic") {
    // Cross-catalog backups are valid only for the current play, never ahead of QQ on a later play.
    if (item.matchRevision !== QQ_LYRIC_MATCH_REVISION || String(item.songMid).startsWith("netease:")) return false;
  } else if (item.matchedTitle && item.matchRevision !== LYRIC_MATCH_REVISION) return false;
  if (item.trackDurationMs > 0 && track.durationMs > 0 && Math.abs(item.trackDurationMs - track.durationMs) > 6000) return false;
  if (item.instrumental && time - (item.instrumentalCheckedAt || item.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) return false;
  return true;
}
