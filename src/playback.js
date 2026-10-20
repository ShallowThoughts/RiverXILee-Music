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

export function reconcilePlaybackAnchor(current, snapshot, receivedAt, receivedAtEpoch) {
  const target = playbackAnchor(snapshot, receivedAt, receivedAtEpoch);
  const currentPosition = playbackPosition(current, receivedAt);
  const driftMs = target.positionMs - currentPosition;
  const stateChanged = current.isPlaying !== target.isPlaying
    || Math.abs((current.durationMs ?? 0) - target.durationMs) > 1_000;
  const shouldSnap = stateChanged || Math.abs(driftMs) >= 1_500;
  const correction = shouldSnap ? driftMs : Math.max(-120, Math.min(120, driftMs));

  return {
    anchor: {
      ...target,
      positionMs: clampPosition(currentPosition + correction, target.durationMs),
      syncedAt: receivedAt,
    },
    driftMs: Math.round(driftMs),
    correction: shouldSnap ? "snap" : Math.abs(driftMs) >= 80 ? "smooth" : "steady",
  };
}
