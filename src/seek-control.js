export function seekPosition(position, duration) {
  const end = Number(duration);
  const value = Number(position);
  return Number.isFinite(end) && end > 0 && Number.isFinite(value)
    ? Math.round(Math.min(end, Math.max(0, value))) : 0;
}

// Preview only the thumb/time while scrubbing; lyrics wait for the real player clock.
export function createSeekControl({ input, fill, time, formatTime, seek, error }) {
  let latest = { key: "", positionMs: 0, durationMs: 0, enabled: false };
  let draft = null;
  let gestureKey = null;
  let pendingKey = null;
  function paint() {
    const position = seekPosition(draft ?? latest.positionMs, latest.durationMs);
    input.max = String(Math.max(1, latest.durationMs || 0));
    input.value = String(position);
    input.disabled = !latest.enabled || pendingKey === latest.key;
    input.title = latest.enabled ? "拖动或使用方向键调整播放进度" : "当前播放器未提供进度跳转控制";
    input.setAttribute("aria-valuetext", `${formatTime(position)} / ${formatTime(latest.durationMs)}`);
    fill.style.width = `${latest.durationMs > 0 ? position / latest.durationMs * 100 : 0}%`;
    time.textContent = formatTime(position);
  }
  input.addEventListener("pointerdown", () => { gestureKey = latest.key; });
  input.addEventListener("pointercancel", () => { draft = null; gestureKey = null; paint(); });
  input.addEventListener("input", () => {
    if (!latest.enabled || (gestureKey !== null && gestureKey !== latest.key)) return;
    draft = seekPosition(input.value, latest.durationMs);
    paint();
  });
  input.addEventListener("change", async () => {
    const key = latest.key;
    if (draft === null || !latest.enabled || (gestureKey !== null && gestureKey !== key)) {
      gestureKey = null; draft = null; paint(); return;
    }
    const target = draft;
    gestureKey = null;
    pendingKey = key;
    paint();
    try { await seek(target, key); }
    catch (reason) { if (latest.key === key) error(reason); }
    finally {
      if (pendingKey === key) pendingKey = null;
      if (latest.key === key) draft = null;
      paint();
    }
  });
  return {
    update(snapshot) {
      if (snapshot.key !== latest.key) draft = null;
      latest = snapshot;
      paint();
    },
  };
}
