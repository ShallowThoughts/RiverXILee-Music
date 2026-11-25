function playbackRate(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clampPosition(positionMs, durationMs) {
  return Math.max(0, Math.min(durationMs > 0 ? durationMs : Infinity, positionMs));
}

export async function readPlaybackSample(read, monotonic = () => performance.now(), wallClock = () => Date.now()) {
  const snapshot = await read();
  return { snapshot, receivedAt: monotonic(), receivedAtEpoch: wallClock() };
}

// SMTC Position belongs to LastUpdatedTime, not to the time we poll it.
export function playbackAnchor(snapshot, receivedAt, receivedAtEpoch) {
  // KuGou's ordinary SMTC session reports song metadata but no timeline.
  // Do not synthesize a clock from zero while enhanced compatibility is off.
  const clockAvailable = !String(snapshot.source || "").toLowerCase().includes("kugou") || snapshot.durationMs > 0;
  const rate = playbackRate(snapshot.playbackRate);
  const capturedAt = snapshot.capturedAtMs;
  const updatedAt = snapshot.timelineUpdatedAtMs;
  const timestamp = Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= capturedAt
    ? updatedAt
    : capturedAt;
  const elapsed = snapshot.isPlaying && clockAvailable && Number.isFinite(timestamp)
    ? Math.max(0, receivedAtEpoch - timestamp)
    : 0;

  return {
    positionMs: clampPosition(snapshot.positionMs + elapsed * rate, snapshot.durationMs),
    durationMs: snapshot.durationMs,
    isPlaying: snapshot.isPlaying,
    timelineAvailable: clockAvailable,
    playbackRate: rate,
    syncedAt: receivedAt,
  };
}

export function playbackPosition(anchor, now) {
  const elapsed = anchor.isPlaying && anchor.timelineAvailable !== false ? Math.max(0, now - anchor.syncedAt) : 0;
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
    || (current.timelineAvailable !== false) !== (target.timelineAvailable !== false)
    || playbackRate(current.playbackRate) !== target.playbackRate
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
