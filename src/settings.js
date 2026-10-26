export const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  lineCount: 5,
  fontSize: 48,
  lineGap: 18,
  offsetX: 0,
  offsetY: 0,
  fontFamily: "Segoe UI Variable Display",
  colorEffect: "rgb",
  motionEffect: "soft",
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
  return family.slice(0, 256) || DEFAULT_DISPLAY_SETTINGS.fontFamily;
}

export function lyricFontFamily(value) {
  const family = sanitizeFontFamily(value).replace(/["'\\]/g, "");
  return `"${family}", "Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif`;
}

export function sanitizeDisplaySettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const color = value.color ?? {};
  return {
    lineCount: clampInteger(value.lineCount, 1, 5, DEFAULT_DISPLAY_SETTINGS.lineCount),
    fontSize: clampInteger(value.fontSize, 24, 96, DEFAULT_DISPLAY_SETTINGS.fontSize),
    lineGap: clampInteger(value.lineGap, 4, 56, DEFAULT_DISPLAY_SETTINGS.lineGap),
    offsetX: clampInteger(value.offsetX, -40, 40, DEFAULT_DISPLAY_SETTINGS.offsetX),
    offsetY: clampInteger(value.offsetY, -35, 35, DEFAULT_DISPLAY_SETTINGS.offsetY),
    fontFamily: sanitizeFontFamily(value.fontFamily),
    colorEffect: value.colorEffect === "solid" ? "solid" : "rgb",
    motionEffect: ["soft", "flow", "none"].includes(value.motionEffect)
      ? value.motionEffect
      : DEFAULT_DISPLAY_SETTINGS.motionEffect,
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

export function sanitizeDisplayProfiles(value) {
  if (!Array.isArray(value)) return [];
  const names = new Set();
  const ids = new Set();
  return value.filter((profile) => {
    if (!profile || typeof profile.name !== "string" || !profile.name.trim()
      || !profile.settings || typeof profile.settings !== "object" || Array.isArray(profile.settings)) return false;
    const name = profile.name.trim().slice(0, 40).toLocaleLowerCase();
    if (names.has(name)) return false;
    names.add(name);
    return true;
  }).slice(0, 20).map((profile, index) => {
    let id = typeof profile.id === "string" && /^[\w-]{1,64}$/.test(profile.id) ? profile.id : `imported-${index}`;
    while (ids.has(id)) id += "-copy";
    ids.add(id);
    return { id, name: profile.name.trim().slice(0, 40), settings: sanitizeDisplaySettings(profile.settings) };
  });
}

export function displayBackup(display, profiles) {
  return JSON.stringify({
    format: "riverxilee-display-profiles",
    version: 1,
    display: sanitizeDisplaySettings(display),
    profiles: sanitizeDisplayProfiles(profiles),
  }, null, 2);
}

export function parseDisplayBackup(text) {
  if (text.length > 1_048_576) throw new Error("备份文件过大，请选择本软件导出的显示备份");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("备份文件不是有效的 JSON"); }
  const validSettings = (settings) => settings && typeof settings === "object" && !Array.isArray(settings)
    && ["lineCount", "fontSize", "lineGap", "offsetX", "offsetY"].every((key) => Number.isFinite(settings[key]))
    && typeof settings.fontFamily === "string" && settings.fontFamily.length <= 256
    && ["rgb", "solid"].includes(settings.colorEffect) && ["soft", "flow", "none"].includes(settings.motionEffect)
    && settings.color && ["r", "g", "b"].every((key) => Number.isFinite(settings.color[key]));
  if (value?.format !== "riverxilee-display-profiles" || value.version !== 1
    || !value.display || typeof value.display !== "object" || Array.isArray(value.display)
    || !validSettings(value.display)
    || !Array.isArray(value.profiles) || value.profiles.length > 20
    || value.profiles.some((profile) => !profile || typeof profile.name !== "string" || !profile.name.trim()
      || !validSettings(profile.settings))) {
    throw new Error("不是受支持的 RiverXILee 显示备份，原有设置未修改");
  }
  return { display: sanitizeDisplaySettings(value.display), profiles: sanitizeDisplayProfiles(value.profiles) };
}

export function mergeDisplayProfiles(existing, imported) {
  const profiles = sanitizeDisplayProfiles(existing);
  for (const profile of sanitizeDisplayProfiles(imported)) {
    if (profiles.length >= 20) break;
    if (profiles.some((item) => item.name === profile.name && JSON.stringify(item.settings) === JSON.stringify(profile.settings))) continue;
    let name = profile.name;
    let suffix = 1;
    while (profiles.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      name = `${profile.name.slice(0, 28)}（导入 ${suffix++}）`;
    }
    let id = profile.id;
    while (profiles.some((item) => item.id === id)) id += "-copy";
    profiles.push({ ...profile, id, name });
  }
  return profiles;
}
