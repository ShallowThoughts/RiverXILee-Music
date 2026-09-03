const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function fractionToMilliseconds(value = "0") {
  if (value.length === 1) return Number(value) * 100;
  if (value.length === 2) return Number(value) * 10;
  return Number(value.slice(0, 3));
}

export function parseLrc(source) {
  let offset = 0;
  const offsetMatch = source.match(/\[offset:([+-]?\d+)\]/i);
  if (offsetMatch) offset = Number(offsetMatch[1]);

  const entries = [];
  for (const rawLine of source.replace(/\r/g, "").split("\n")) {
    const timestamps = [...rawLine.matchAll(TIME_TAG)];
    if (!timestamps.length) continue;

    const text = rawLine.replace(TIME_TAG, "").trim();
    if (!text) continue;

    for (const match of timestamps) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const milliseconds = fractionToMilliseconds(match[3]);
      entries.push({
        timeMs: Math.max(0, minutes * 60_000 + seconds * 1_000 + milliseconds + offset),
        text,
      });
    }
  }

  return entries
    .sort((left, right) => left.timeMs - right.timeMs)
    .filter(
      (entry, index, all) =>
        index === 0 || entry.timeMs !== all[index - 1].timeMs || entry.text !== all[index - 1].text,
    );
}

export function findActiveLine(lines, positionMs) {
  if (!lines.length || positionMs < lines[0].timeMs) return -1;

  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].timeMs <= positionMs) low = middle + 1;
    else high = middle - 1;
  }
  return high;
}

export function lineProgress(lines, activeIndex, positionMs, durationMs) {
  if (activeIndex < 0 || !lines[activeIndex]) return 0;
  const start = lines[activeIndex].timeMs;
  const fallbackEnd = durationMs > start ? durationMs : start + 5_000;
  const end = lines[activeIndex + 1]?.timeMs ?? fallbackEnd;
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (positionMs - start) / (end - start)));
}

export function visibleLineIndices(lineCount, activeIndex, visibleCount = 5) {
  if (lineCount <= 0 || visibleCount <= 0) return [];
  const count = Math.min(lineCount, visibleCount);
  const anchorIndex = Math.max(0, Math.min(lineCount - 1, activeIndex));
  const lastStart = Math.max(0, lineCount - count);
  const startIndex = Math.min(lastStart, Math.max(0, anchorIndex - Math.floor(count / 2)));
  return Array.from({ length: count }, (_, offset) => startIndex + offset);
}
