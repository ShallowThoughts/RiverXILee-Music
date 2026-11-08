export const LYRIC_CACHE_LIMIT = 1000;
export const LYRIC_MATCH_REVISION = 2;

export function pruneLyricCache(cache) {
  const entries = Object.entries(cache).sort(([, a], [, b]) => (b.savedAt || 0) - (a.savedAt || 0));
  let automatic = 0;
  return Object.fromEntries(entries.filter(([, item]) => item.manuallySelected || automatic++ < LYRIC_CACHE_LIMIT));
}

export function usableLyricCache(item, track, time = Date.now()) {
  if (!item) return false;
  if (item.manuallySelected) return true;
  if (item.matchedTitle && item.matchRevision !== LYRIC_MATCH_REVISION) return false;
  if (item.trackDurationMs > 0 && track.durationMs > 0 && Math.abs(item.trackDurationMs - track.durationMs) > 6000) return false;
  if (item.instrumental && time - (item.instrumentalCheckedAt || item.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) return false;
  return true;
}
