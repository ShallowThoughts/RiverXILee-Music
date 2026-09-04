function playbackRate(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clampPosition(positionMs, durationMs) {
  return Math.max(0, Math.min(durationMs > 0 ? durationMs : Infinity, positionMs));
}

// SMTC Position belongs to LastUpdatedTime, not to the time we poll it.
export function playbackAnchor(snapshot, receivedAt, receivedAtEpoch) {
  const rate = playbackRate(snapshot.playbackRate);
  const capturedAt = snapshot.capturedAtMs;
  const updatedAt = snapshot.timelineUpdatedAtMs;
  const timestamp = Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= capturedAt
    ? updatedAt
    : capturedAt;
  const elapsed = snapshot.isPlaying && Number.isFinite(timestamp)
    ? Math.max(0, receivedAtEpoch - timestamp)
    : 0;

  return {
    positionMs: clampPosition(snapshot.positionMs + elapsed * rate, snapshot.durationMs),
    durationMs: snapshot.durationMs,
    isPlaying: snapshot.isPlaying,
    playbackRate: rate,
    syncedAt: receivedAt,
  };
}

export function playbackPosition(anchor, now) {
  const elapsed = anchor.isPlaying ? Math.max(0, now - anchor.syncedAt) : 0;
  return clampPosition(
    anchor.positionMs + elapsed * playbackRate(anchor.playbackRate),
    anchor.durationMs,
  );
}
