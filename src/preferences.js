export const DEFAULT_SHORTCUTS = Object.freeze({
  toggleVisibility: "Ctrl+Shift+H",
  toggleLock: "Ctrl+Shift+L",
  lyricsEarlier: "Ctrl+Alt+ArrowLeft",
  lyricsLater: "Ctrl+Alt+ArrowRight",
  resync: "Ctrl+Shift+R",
  switchPlayer: "Ctrl+Shift+P",
});

export const SHORTCUT_ACTIONS = Object.freeze(Object.keys(DEFAULT_SHORTCUTS));

export function normalizeShortcut(value) {
  const parts = String(value ?? "").split("+").map((part) => part.trim()).filter(Boolean);
  const modifiers = [];
  let key = "";
  for (const rawPart of parts) {
    const part = rawPart.toLowerCase();
    if (["control", "ctrl"].includes(part)) modifiers.push("Ctrl");
    else if (part === "alt") modifiers.push("Alt");
    else if (part === "shift") modifiers.push("Shift");
    else if (["meta", "super", "win", "command"].includes(part)) modifiers.push("Super");
    else key = rawPart.length === 1 ? rawPart.toUpperCase() : rawPart;
  }
  const uniqueModifiers = ["Ctrl", "Alt", "Shift", "Super"].filter((modifier) => modifiers.includes(modifier));
  return key ? [...uniqueModifiers, key].join("+") : "";
}

export function shortcutFromKeyboardEvent(event) {
  const ignored = new Set(["Control", "Alt", "Shift", "Meta"]);
  if (ignored.has(event.key)) return "";
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  const aliases = { " ": "Space", Escape: "Esc" };
  const key = aliases[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  parts.push(key);
  return normalizeShortcut(parts.join("+"));
}

export function sanitizeShortcuts(value = {}) {
  const result = {};
  for (const action of SHORTCUT_ACTIONS) {
    result[action] = normalizeShortcut(value[action]) || DEFAULT_SHORTCUTS[action];
  }
  return result;
}

export function duplicateShortcut(shortcuts, changedAction) {
  const target = shortcuts[changedAction];
  return SHORTCUT_ACTIONS.find((action) => action !== changedAction && shortcuts[action] === target) ?? null;
}

export function clampLyricOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(10_000, Math.max(-10_000, Math.round(parsed / 100) * 100));
}
