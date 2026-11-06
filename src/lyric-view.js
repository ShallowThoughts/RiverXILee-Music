import { lineProgress, wordProgress } from "./lyrics.js";

export function focusLineIndices(total, active, count) {
  const anchor = Math.max(0, Math.min(total - 1, active));
  const before = Math.floor((count - 1) / 2);
  const start = Math.max(0, anchor - before);
  const end = Math.min(total, anchor + count - before);
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
}

export function focusLineCenters(heights, anchor, gap) {
  const centers = [];
  for (const [index, height] of heights.entries()) {
    centers.push(index ? centers[index - 1] + heights[index - 1] / 2 + gap + height / 2 : height / 2);
  }
  return centers.map((center) => center - (centers[anchor] ?? 0));
}

// Driven by the song clock, not wall time: pausing and seeking also pause/seek the motion.
export function wordEmphasis(word, positionMs) {
  if (!word || word.durationMs <= 0 || positionMs <= word.timeMs) return 0;
  const elapsed = positionMs - word.timeMs;
  const attack = Math.min(180, word.durationMs * 0.4);
  if (elapsed < attack) return 1 - (1 - elapsed / attack) ** 3;
  if (elapsed <= word.durationMs) return 1;
  const release = Math.min(260, Math.max(120, word.durationMs * 0.4));
  return (1 + Math.cos(Math.PI * Math.min(1, (elapsed - word.durationMs) / release))) / 2;
}

export function wordPose(word, positionMs, fontSize, effect, reducedMotion = false, index = 0) {
  const disabled = effect === "none" || reducedMotion;
  const emphasis = disabled ? 0 : wordEmphasis(word, positionMs);
  const flowing = effect === "flow";
  const wave = disabled ? 0 : Math.sin(positionMs / 1300 + index * 0.72);
  const rotation = disabled ? 0 : Math.sin(positionMs / 2100 + index * 1.03);
  return {
    progress: wordProgress(word, positionMs),
    lift: disabled ? 0 : -Math.min(8, fontSize * (flowing ? 0.12 : 0.065)) * emphasis + wave * (flowing ? 1.8 : 0.55),
    scale: 1 + (flowing ? 0.11 : 0.045) * emphasis,
    rotate: rotation * (flowing ? 4.5 + emphasis * 3.5 : 0.7 + emphasis * 1.4),
  };
}

function animate(element, frames, duration, delay = 0) {
  const animation = element.animate(frames, {
    duration,
    delay,
    easing: "cubic-bezier(0.18, 1, 0.24, 1)",
    fill: "both",
  });
  animation.finished.then(() => animation.cancel(), () => {});
}

function createRow(document, entry, index) {
  const row = document.createElement("div");
  row.className = "lyric-line";
  row.dataset.index = String(index);
  const text = document.createElement("span");
  text.className = "lyric-text";
  text.setAttribute("aria-label", entry.text);
  if (entry.words?.length) {
    text.classList.add("has-word-timing");
    for (const [wordIndex, word] of entry.words.entries()) {
      const item = document.createElement("span");
      item.className = "karaoke-word";
      item.dataset.wordIndex = String(wordIndex);
      item.setAttribute("aria-hidden", "true");
      const base = document.createElement("span");
      base.className = "karaoke-word-base";
      base.textContent = word.text;
      const highlight = document.createElement("span");
      highlight.className = "karaoke-word-highlight";
      highlight.textContent = word.text;
      item.append(base, highlight);
      text.append(item);
    }
  } else {
    const base = document.createElement("span");
    base.className = "current-text-base";
    base.textContent = entry.text;
    const highlight = document.createElement("span");
    highlight.className = "current-text-highlight";
    highlight.textContent = entry.text;
    highlight.setAttribute("aria-hidden", "true");
    text.append(base, highlight);
  }
  row.append(text);
  return row;
}

export function createLyricView(stack) {
  const document = stack.ownerDocument;
  const window = document.defaultView;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let rows = new Map();
  let source = null;
  let active = -1;
  let settings;
  let currentText = null;
  let currentWords = [];

  function clear() {
    for (const row of rows.values()) {
      for (const element of [row, row.firstElementChild]) {
        for (const animation of element.getAnimations()) animation.cancel();
      }
    }
    rows.clear();
    source = null;
    currentText = null;
    currentWords = [];
    delete stack.dataset.layout;
    stack.replaceChildren();
  }

  function render(lines, activeIndex, display, { motion = true } = {}) {
    const sameSong = source === lines && [...rows.values()].every((row) => row.parentNode === stack);
    const previousActive = active;
    const previous = new Map();
    if (sameSong) {
      // Snapshot all visual positions before changing layout, including interrupted animations.
      for (const [index, row] of rows) {
        const text = row.firstElementChild;
        const rect = row.getBoundingClientRect();
        const style = window.getComputedStyle(text);
        previous.set(index, {
          y: rect.top + rect.height / 2,
          x: rect.left + rect.width / 2,
          transform: style.transform,
          opacity: style.opacity,
          filter: style.filter,
        });
      }
    } else {
      clear();
    }
    for (const row of rows.values()) {
      for (const element of [row, row.firstElementChild]) {
        for (const animation of element.getAnimations()) animation.cancel();
      }
    }
    source = lines;
    active = activeIndex;
    settings = display;
    stack.dataset.motion = display.motionEffect;
    stack.dataset.layout = "focus";
    const visible = focusLineIndices(lines.length, activeIndex, display.lineCount);
    const flowing = display.motionEffect === "flow";
    const spatial = display.motionEffect !== "none" && !reducedMotion.matches;
    for (const [index, row] of rows) {
      if (!visible.includes(index)) { row.remove(); rows.delete(index); }
    }
    for (const index of visible) {
      const row = rows.get(index) ?? createRow(document, lines[index], index);
      rows.set(index, row);
      const distance = Math.min(2, Math.abs(index - Math.max(0, activeIndex)));
      const isCurrent = index === activeIndex;
      const scale = isCurrent ? 1 : Math.max(18 / display.fontSize, distance > 1 ? 0.48 : 0.64);
      row.classList.toggle("current-line", isCurrent);
      row.classList.toggle("history-line", index < activeIndex);
      row.classList.toggle("next-line", index > activeIndex);
      row.dataset.distance = String(index - activeIndex);
      row.style.setProperty("--line-scale", String(scale));
      row.style.setProperty("--line-opacity", isCurrent ? "1" : distance > 1 ? "0.32" : "0.62");
      row.style.setProperty("--line-blur", !spatial || isCurrent ? "0px" : distance > 1 ? "1.2px" : "0.25px");
      row.style.setProperty("--line-turn", flowing && spatial && !isCurrent ? `${Math.sign(index - activeIndex) * 1.4}deg` : "0deg");
      const text = row.firstElementChild;
      text.classList.toggle("current-text", isCurrent);
      text.dataset.effect = display.colorEffect;
      stack.append(row);
    }
    // Use one font size for every row, scaling its visual layer instead of reflowing its text.
    const heights = visible.map((index) => {
      const row = rows.get(index);
      return row.firstElementChild.offsetHeight * Number(row.style.getPropertyValue("--line-scale"));
    });
    const anchor = Math.max(0, visible.indexOf(Math.max(0, activeIndex)));
    const centers = focusLineCenters(heights, anchor, display.lineGap);
    visible.forEach((index, slot) => {
      const row = rows.get(index);
      const distance = index - Math.max(0, activeIndex);
      row.style.height = `${heights[slot]}px`;
      row.style.marginTop = `${-heights[slot] / 2}px`;
      row.style.transform = `translate3d(${flowing && spatial ? Math.sign(distance) * Math.min(2, Math.abs(distance)) * 10 : 0}px, ${centers[slot]}px, 0)`;
    });
    currentText = rows.get(activeIndex)?.firstElementChild ?? null;
    currentWords = currentText ? [...currentText.querySelectorAll(".karaoke-word")] : [];
    for (const row of rows.values()) {
      const text = row.firstElementChild;
      text.style.setProperty("--line-paint-width", `${text.offsetWidth}px`);
      for (const word of text.querySelectorAll(".karaoke-word")) {
        word.style.setProperty("--word-paint-x", `${-word.offsetLeft}px`);
      }
    }
    if (!motion || display.motionEffect === "none" || reducedMotion.matches) return;
    // A large seek changes context immediately; don't send several old lines flying past.
    if (sameSong && Math.abs(activeIndex - previousActive) > 1) return;
    const interval = (lines[activeIndex + 1]?.timeMs ?? lines[activeIndex]?.timeMs + 4000) - (lines[activeIndex]?.timeMs ?? 0);
    const duration = Math.min(flowing ? 680 : 540, Math.max(180, interval * 0.75));
    const direction = activeIndex < previousActive ? -1 : 1;
    const targets = visible.map((index) => {
      const row = rows.get(index);
      const rect = row.getBoundingClientRect();
      const style = window.getComputedStyle(row.firstElementChild);
      return { index, row, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, transform: style.transform, opacity: style.opacity, filter: style.filter };
    });
    for (const { index, row, x, y, transform, opacity, filter } of targets) {
      const text = row.firstElementChild;
      const old = previous.get(index);
      const targetTransform = row.style.transform;
      const delay = Math.min(48, Math.abs(index - activeIndex) * 24);
      if (old) {
        animate(row, [
          { transform: `${targetTransform} translate(${old.x - x}px, ${old.y - y}px)` },
          { transform: targetTransform },
        ], duration, delay);
        animate(text, [
          { transform: old.transform, opacity: old.opacity, filter: old.filter },
          { transform, opacity, filter },
        ], duration, delay);
      } else {
        animate(row, [
          { transform: `${targetTransform} translateY(${24 * direction}px)`, opacity: 0 },
          { transform: targetTransform, opacity: 1 },
        ], 420, delay);
      }
    }
  }

  function update(positionMs, durationMs) {
    if (!currentText || !source?.[active]) return;
    const progress = lineProgress(source, active, positionMs, durationMs);
    currentText.style.setProperty("--karaoke-progress", `${(progress * 100).toFixed(2)}%`);
    currentText.dataset.phase = progress <= 0 ? "pending" : progress >= 1 ? "done" : "active";
    const spatial = settings.motionEffect !== "none" && !reducedMotion.matches;
    const flowing = settings.motionEffect === "flow";
    const envelope = Math.min(1, progress * 8, (1 - progress) * 5);
    const breath = spatial ? Math.sin(progress * Math.PI * 1.5) * envelope : 0;
    currentText.style.setProperty("--phrase-y", `${(-breath * (flowing ? 3.5 : 1.2)).toFixed(2)}px`);
    currentText.style.setProperty("--phrase-x", `${(flowing && spatial ? Math.sin(progress * Math.PI * 2) * 2 : 0).toFixed(2)}px`);
    for (const [index, element] of currentWords.entries()) {
      const pose = wordPose(source[active].words[index], positionMs, settings.fontSize, settings.motionEffect, reducedMotion.matches, index);
      element.style.setProperty("--word-progress", `${(pose.progress * 100).toFixed(2)}%`);
      element.style.setProperty("--word-lift", `${pose.lift.toFixed(2)}px`);
      element.style.setProperty("--word-scale", pose.scale.toFixed(4));
      element.style.setProperty("--word-turn", `${pose.rotate.toFixed(2)}deg`);
      element.dataset.phase = pose.progress <= 0 ? "pending" : pose.progress >= 1 ? "done" : "active";
    }
  }

  function refresh() {
    if (source && settings) render(source, active, settings, { motion: false });
  }
  let lastWidth = stack.clientWidth;
  new window.ResizeObserver(() => {
    if (stack.clientWidth !== lastWidth) { lastWidth = stack.clientWidth; refresh(); }
  }).observe(stack);
  reducedMotion.addEventListener("change", refresh);
  document.fonts?.addEventListener("loadingdone", refresh);
  return { render, update, clear };
}
