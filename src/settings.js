export const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  lineCount: 5,
  fontSize: 48,
  lineGap: 18,
  offsetX: 0,
  offsetY: 0,
  fontFamily: "Segoe UI Variable Display",
  colorEffect: "rgb",
  color: Object.freeze({ r: 130, g: 244, b: 212 }),
});

export const DISPLAY_PRESETS = Object.freeze({
  immersive: Object.freeze({
    label: "沉浸五行",
    settings: Object.freeze({ lineCount: 5, fontSize: 48, lineGap: 18, offsetX: 0, offsetY: 0 }),
  }),
  single: Object.freeze({
    label: "纯净单行",
    settings: Object.freeze({ lineCount: 1, fontSize: 58, lineGap: 18, offsetX: 0, offsetY: 18 }),
  }),
  double: Object.freeze({
    label: "双行字幕",
    settings: Object.freeze({ lineCount: 2, fontSize: 52, lineGap: 22, offsetX: 0, offsetY: 20 }),
  }),
  game: Object.freeze({
    label: "游戏模式",
    settings: Object.freeze({ lineCount: 2, fontSize: 42, lineGap: 14, offsetX: 0, offsetY: 28 }),
  }),
  stream: Object.freeze({
    label: "直播模式",
    settings: Object.freeze({ lineCount: 3, fontSize: 44, lineGap: 18, offsetX: 0, offsetY: 20 }),
  }),
});

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sanitizeFontFamily(value) {
  const family = String(value ?? "").trim().replace(/[\r\n;]/g, "");
  return family.slice(0, 80) || DEFAULT_DISPLAY_SETTINGS.fontFamily;
}

export function sanitizeDisplaySettings(value = {}) {
  const color = value.color ?? {};
  return {
    lineCount: clampInteger(value.lineCount, 1, 5, DEFAULT_DISPLAY_SETTINGS.lineCount),
    fontSize: clampInteger(value.fontSize, 24, 96, DEFAULT_DISPLAY_SETTINGS.fontSize),
    lineGap: clampInteger(value.lineGap, 4, 56, DEFAULT_DISPLAY_SETTINGS.lineGap),
    offsetX: clampInteger(value.offsetX, -40, 40, DEFAULT_DISPLAY_SETTINGS.offsetX),
    offsetY: clampInteger(value.offsetY, -35, 35, DEFAULT_DISPLAY_SETTINGS.offsetY),
    fontFamily: sanitizeFontFamily(value.fontFamily),
    colorEffect: value.colorEffect === "solid" ? "solid" : "rgb",
    color: {
      r: clampInteger(color.r, 0, 255, DEFAULT_DISPLAY_SETTINGS.color.r),
      g: clampInteger(color.g, 0, 255, DEFAULT_DISPLAY_SETTINGS.color.g),
      b: clampInteger(color.b, 0, 255, DEFAULT_DISPLAY_SETTINGS.color.b),
    },
  };
}

export function applyDisplayPreset(current, presetName) {
  const preset = DISPLAY_PRESETS[presetName];
  return sanitizeDisplaySettings(preset ? { ...current, ...preset.settings } : current);
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(value) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (!match) return null;
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}
