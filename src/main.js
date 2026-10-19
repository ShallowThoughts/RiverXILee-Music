import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { findActiveLine, lineProgress, parseLrc, visibleLineIndices, wordProgress } from "./lyrics.js";
import { playbackAnchor, playbackPosition } from "./playback.js";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  clampLyricOffset,
  duplicateShortcut,
  sanitizeShortcuts,
  shortcutFromKeyboardEvent,
} from "./preferences.js";
import {
  DEFAULT_DISPLAY_SETTINGS,
  hexToRgb,
  rgbToHex,
  sanitizeDisplaySettings,
} from "./settings.js";
import "./styles.css";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const DISPLAY_SETTINGS_KEY = "riverxilee-desktop-lyrics.display.v1";
const SHORTCUTS_KEY = "riverxilee-desktop-lyrics.shortcuts.v1";
const PLAYER_KEY = "riverxilee-desktop-lyrics.player.v1";
const OFFSETS_KEY = "riverxilee-desktop-lyrics.offsets.v1";
const LYRICS_CACHE_KEY = "riverxilee-desktop-lyrics.cache.v1";
const PREVIEW_LRC = `[00:00.00]RiverXILee桌面歌词
[00:05.00]让音乐留在画面中央
[00:10.00]透明 · 安静 · 同步
[00:15.00]打开任意音乐平台即可自动识别`;
const nativePreferences = IS_TAURI
  ? await invoke("load_preferences").catch(() => null)
  : null;

function loadDisplaySettings() {
  try {
    const saved = nativePreferences?.display
      ?? JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) ?? "{}");
    return sanitizeDisplaySettings(saved);
  } catch {
    return sanitizeDisplaySettings();
  }
}

function loadJson(key, nativeKey, fallback) {
  try {
    if (nativePreferences && Object.hasOwn(nativePreferences, nativeKey)) {
      return nativePreferences[nativeKey];
    }
    return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

const state = {
  connected: false,
  source: "",
  title: "",
  artist: "",
  album: "",
  isPlaying: false,
  playbackRate: 1,
  positionMs: 0,
  durationMs: 0,
  syncedAt: performance.now(),
  lines: [],
  activeIndex: Number.NaN,
  lyricStatus: "idle",
  lyricMessage: "",
  trackKey: "",
  fetchToken: 0,
  lyricRetryAt: 0,
  lyricAttempts: 0,
  lyricMatch: null,
  alwaysOnTop: true,
  fullscreen: false,
  locked: false,
  settingsOpen: false,
  visible: true,
  preferredSource: nativePreferences?.preferredSource ?? localStorage.getItem(PLAYER_KEY) ?? "",
  availableSources: [],
  lyricOffsetMs: 0,
  offsets: loadJson(OFFSETS_KEY, "offsets", {}),
  lyricCache: loadJson(LYRICS_CACHE_KEY, "lyricCache", {}),
  shortcuts: sanitizeShortcuts(loadJson(SHORTCUTS_KEY, "shortcuts", {})),
  display: loadDisplaySettings(),
};

let preferenceSaveQueue = Promise.resolve();

function persistNativePreferences() {
  if (!IS_TAURI) return;
  const preferences = {
    display: state.display,
    shortcuts: state.shortcuts,
    preferredSource: state.preferredSource,
    offsets: state.offsets,
    lyricCache: state.lyricCache,
  };
  preferenceSaveQueue = preferenceSaveQueue
    .catch(() => {})
    .then(() => invoke("save_preferences", { preferences }))
    .catch(() => {});
}

document.querySelector("#app").innerHTML = `
  <main class="overlay-shell" id="overlay-shell">
    <section class="startup-reveal" id="startup-reveal" aria-hidden="true">
      <div class="startup-signature">
        <div class="startup-wave-wrap">
          <svg class="startup-wave" viewBox="0 0 640 96" role="presentation">
            <defs>
              <linearGradient id="startup-gradient" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#ff5ca8" />
                <stop offset="0.5" stop-color="#6cdeff" />
                <stop offset="1" stop-color="#80f6ca" />
              </linearGradient>
            </defs>
            <path class="startup-wave-guide" d="M0 48 H76 L92 31 L110 66 L132 13 L154 80 L178 39 L198 55 L218 34 L238 63 L264 21 L286 76 L308 42 L328 51 L348 25 L370 70 L394 36 L418 58 L442 18 L466 78 L490 40 L514 55 L538 30 L562 66 L584 43 L604 48 H640" />
            <path class="startup-wave-energy" d="M0 48 H76 L92 31 L110 66 L132 13 L154 80 L178 39 L198 55 L218 34 L238 63 L264 21 L286 76 L308 42 L328 51 L348 25 L370 70 L394 36 L418 58 L442 18 L466 78 L490 40 L514 55 L538 30 L562 66 L584 43 L604 48 H640" />
          </svg>
          <span class="startup-playhead"></span>
        </div>
        <strong class="startup-wordmark">RiverXILee桌面歌词</strong>
        <span class="startup-tagline">让音乐留在画面中央</span>
        <span class="startup-status">
          <span class="startup-status-item status-connect">正在连接音乐会话</span>
          <span class="startup-status-item status-timeline">正在读取播放时间轴</span>
          <span class="startup-status-item status-ready">同步完成</span>
        </span>
      </div>
      <span class="startup-exit-line"></span>
    </section>

    <header class="titlebar" data-tauri-drag-region>
      <div class="identity" data-tauri-drag-region>
        <span class="status-indicator" id="status-indicator" aria-hidden="true"></span>
        <div class="identity-copy" data-tauri-drag-region>
          <span class="app-name">RiverXILee桌面歌词</span>
          <span class="track-meta" id="track-meta">等待连接播放器</span>
        </div>
      </div>
      <div class="window-actions">
        <button class="icon-button quiet" id="minimize-button" type="button" aria-label="最小化">
          <i class="ph ph-minus" aria-hidden="true"></i>
        </button>
        <button class="icon-button quiet" id="close-button" type="button" aria-label="关闭">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <section class="lyrics-stage" id="lyrics-stage" aria-live="polite">
      <div class="lyrics-stack" id="lyrics-stack"></div>
    </section>

    <footer class="control-wrap">
      <div class="control-bar" id="control-bar">
        <div class="liquid-layer" aria-hidden="true"></div>
        <div class="transport-group">
          <button class="icon-button" data-media-action="previous" type="button" aria-label="上一首">
            <i class="ph-fill ph-skip-back" aria-hidden="true"></i>
          </button>
          <button class="icon-button play-button" id="play-button" data-media-action="toggle" type="button" aria-label="播放或暂停">
            <i class="ph-fill ph-play" aria-hidden="true"></i>
          </button>
          <button class="icon-button" data-media-action="next" type="button" aria-label="下一首">
            <i class="ph-fill ph-skip-forward" aria-hidden="true"></i>
          </button>
        </div>

        <div class="timeline-copy">
          <span id="position-text">00:00</span>
          <div class="timeline" aria-hidden="true"><span id="timeline-progress"></span></div>
          <span id="duration-text">00:00</span>
        </div>

        <div class="view-group">
          <button class="icon-button is-active" id="top-button" type="button" aria-label="切换置顶" title="置顶">
            <i class="ph-fill ph-push-pin" aria-hidden="true"></i>
          </button>
          <button class="icon-button" id="fullscreen-button" type="button" aria-label="切换全屏" title="全屏">
            <i class="ph ph-corners-out" aria-hidden="true"></i>
          </button>
          <button class="icon-button" id="settings-button" type="button" aria-label="歌词显示设置" title="歌词显示设置">
            <i class="ph ph-sliders-horizontal" aria-hidden="true"></i>
          </button>
          <button class="icon-button" id="lock-button" type="button" aria-label="锁定并开启鼠标穿透" title="锁定 · Ctrl + Shift + L 解锁">
            <i class="ph ph-lock-simple" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </footer>

    <aside class="settings-panel" id="settings-panel" aria-hidden="true" aria-label="歌词显示设置">
      <div class="settings-heading">
        <div>
          <strong>歌词显示</strong>
          <span>即时预览 · 自动保存</span>
        </div>
        <button class="icon-button quiet" id="settings-close-button" type="button" aria-label="关闭设置">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>

      <nav class="settings-tabs" aria-label="设置分类">
        <button class="settings-tab is-active" type="button" data-settings-tab="display">显示</button>
        <button class="settings-tab" type="button" data-settings-tab="sync">同步</button>
        <button class="settings-tab" type="button" data-settings-tab="shortcuts">快捷键</button>
      </nav>

      <section class="settings-section is-active" data-settings-section="display">
       <div class="settings-grid">
        <label class="setting-control">
          <span>显示行数 <output data-output="lineCount"></output></span>
          <input type="range" min="1" max="5" step="1" data-setting="lineCount" />
        </label>
        <label class="setting-control">
          <span>字号 <output data-output="fontSize"></output></span>
          <input type="range" min="24" max="96" step="1" data-setting="fontSize" />
        </label>
        <label class="setting-control">
          <span>行间距 <output data-output="lineGap"></output></span>
          <input type="range" min="4" max="56" step="1" data-setting="lineGap" />
        </label>
        <label class="setting-control">
          <span>左右位置 <output data-output="offsetX"></output></span>
          <input type="range" min="-40" max="40" step="1" data-setting="offsetX" />
        </label>
        <label class="setting-control">
          <span>上下位置 <output data-output="offsetY"></output></span>
          <input type="range" min="-35" max="35" step="1" data-setting="offsetY" />
        </label>
        <label class="setting-control">
          <span>高亮效果</span>
          <select data-setting="colorEffect">
            <option value="rgb">RGB 流光</option>
            <option value="solid">自定义纯色</option>
          </select>
        </label>
       </div>

       <div class="color-editor">
        <label class="color-picker" title="选择歌词高亮颜色">
          <span>高亮颜色</span>
          <input id="lyric-color-picker" type="color" />
        </label>
        <label>R <input type="number" min="0" max="255" step="1" data-color-channel="r" /></label>
        <label>G <input type="number" min="0" max="255" step="1" data-color-channel="g" /></label>
        <label>B <input type="number" min="0" max="255" step="1" data-color-channel="b" /></label>
       </div>
      </section>

      <section class="settings-section" data-settings-section="sync">
        <div class="sync-stack">
          <label class="setting-control">
            <span>歌词播放器 <output id="player-mode-status">自动选择</output></span>
            <select id="player-source-select"><option value="">自动选择正在播放的平台</option></select>
          </label>
          <div class="sync-row">
            <div class="sync-copy"><strong>本歌曲时间偏移</strong><span id="offset-status">0.0 秒</span></div>
            <div class="stepper" aria-label="歌词时间偏移">
              <button class="text-button" id="lyrics-earlier-button" type="button">提前 0.5 秒</button>
              <button class="text-button" id="offset-reset-button" type="button">归零</button>
              <button class="text-button" id="lyrics-later-button" type="button">延后 0.5 秒</button>
            </div>
          </div>
          <div class="sync-row">
            <div class="sync-copy"><strong>重新校准播放进度</strong><span>重新读取播放器、时间轴和当前歌词</span></div>
            <button class="text-button" id="resync-button" type="button">立即同步</button>
          </div>
          <div class="sync-row">
            <div class="sync-copy"><strong>歌词版本不正确？</strong><span>查看网易云和 QQ 音乐的候选版本</span></div>
            <button class="text-button" id="find-version-button" type="button">手动选择</button>
          </div>
          <div class="candidate-browser" id="candidate-browser" aria-live="polite"></div>
          <div class="sync-row">
            <div class="sync-copy"><strong>歌词缓存</strong><span id="cache-status">尚无缓存</span></div>
            <button class="text-button" id="cache-clear-button" type="button">清空缓存</button>
          </div>
          <label class="sync-row switch-row">
            <div class="sync-copy"><strong>开机自动启动</strong><span>登录 Windows 后自动显示桌面歌词</span></div>
            <input class="switch-input" id="autostart-switch" type="checkbox" />
          </label>
        </div>
      </section>

      <section class="settings-section" data-settings-section="shortcuts">
        <div class="shortcut-list">
          <label><span>显示或隐藏</span><input readonly data-shortcut="toggleVisibility" /></label>
          <label><span>锁定或解锁</span><input readonly data-shortcut="toggleLock" /></label>
          <label><span>歌词提前</span><input readonly data-shortcut="lyricsEarlier" /></label>
          <label><span>歌词延后</span><input readonly data-shortcut="lyricsLater" /></label>
          <label><span>重新同步</span><input readonly data-shortcut="resync" /></label>
          <label><span>切换播放器</span><input readonly data-shortcut="switchPlayer" /></label>
        </div>
        <div class="shortcut-footer">
          <span>点击输入框后直接按下组合键</span>
          <button class="text-button" id="shortcuts-reset-button" type="button">恢复默认快捷键</button>
        </div>
      </section>

      <div class="settings-footer">
          <span>优先使用真实逐字时间轴，普通歌词自动平滑推进</span>
        <div class="settings-actions">
          <button class="text-button" id="feedback-button" type="button">问题反馈</button>
          <button class="text-button" id="update-check-button" type="button">检查更新</button>
          <button class="text-button" id="settings-reset-button" type="button">恢复默认</button>
        </div>
      </div>
    </aside>

    <section class="update-banner" id="update-banner" aria-live="polite" aria-hidden="true">
      <div class="liquid-layer" aria-hidden="true"></div>
      <i class="ph ph-arrow-circle-up" aria-hidden="true"></i>
      <div class="update-copy">
        <strong id="update-title">发现新版本</strong>
        <span id="update-detail">点击下载最新版</span>
      </div>
      <button class="text-button update-download" id="update-download-button" type="button">下载更新</button>
      <button class="icon-button quiet" id="update-dismiss-button" type="button" aria-label="稍后更新" title="稍后">
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </section>

    <div class="toast" id="toast" role="status"></div>
  </main>
`;

const elements = {
  shell: document.querySelector("#overlay-shell"),
  status: document.querySelector("#status-indicator"),
  meta: document.querySelector("#track-meta"),
  stack: document.querySelector("#lyrics-stack"),
  play: document.querySelector("#play-button"),
  position: document.querySelector("#position-text"),
  duration: document.querySelector("#duration-text"),
  progress: document.querySelector("#timeline-progress"),
  top: document.querySelector("#top-button"),
  fullscreen: document.querySelector("#fullscreen-button"),
  settings: document.querySelector("#settings-button"),
  settingsPanel: document.querySelector("#settings-panel"),
  updateBanner: document.querySelector("#update-banner"),
  updateTitle: document.querySelector("#update-title"),
  updateDetail: document.querySelector("#update-detail"),
  updateDownload: document.querySelector("#update-download-button"),
  lock: document.querySelector("#lock-button"),
  toast: document.querySelector("#toast"),
  colorPicker: document.querySelector("#lyric-color-picker"),
  playerSource: document.querySelector("#player-source-select"),
  playerModeStatus: document.querySelector("#player-mode-status"),
  offsetStatus: document.querySelector("#offset-status"),
  cacheStatus: document.querySelector("#cache-status"),
  autostart: document.querySelector("#autostart-switch"),
  candidateBrowser: document.querySelector("#candidate-browser"),
};

let availableUpdate = null;
let updateCheckInFlight = false;

function setUpdateBannerVisible(visible) {
  elements.updateBanner.classList.toggle("is-visible", visible);
  elements.updateBanner.setAttribute("aria-hidden", String(!visible));
}

async function checkForUpdates({ manual = false } = {}) {
  if (!IS_TAURI || updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const update = await invoke("check_for_update");
    if (update.available) {
      availableUpdate = update;
      elements.updateTitle.textContent = `发现 v${update.latestVersion}`;
      elements.updateDetail.textContent = `当前 v${update.currentVersion} · 已有新版本`;
      setUpdateBannerVisible(true);
    } else if (manual) {
      showToast(`当前已是最新版 v${update.currentVersion}`);
    }
  } catch {
    if (manual) showToast("暂时无法检查更新，请稍后重试");
  } finally {
    updateCheckInFlight = false;
  }
}

const settingInputs = [...document.querySelectorAll("[data-setting]")];
const colorInputs = [...document.querySelectorAll("[data-color-channel]")];

function saveDisplaySettings() {
  localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(state.display));
  persistNativePreferences();
}

function updateSettingValue(path, value) {
  state.display = sanitizeDisplaySettings({ ...state.display, [path]: value });
  saveDisplaySettings();
  applyDisplaySettings();
}

function syncSettingsPanel() {
  for (const input of settingInputs) input.value = state.display[input.dataset.setting];
  for (const input of colorInputs) input.value = state.display.color[input.dataset.colorChannel];
  elements.colorPicker.value = rgbToHex(state.display.color);

  const values = {
    lineCount: `${state.display.lineCount} 行`,
    fontSize: `${state.display.fontSize}px`,
    lineGap: `${state.display.lineGap}px`,
    offsetX: `${state.display.offsetX}%`,
    offsetY: `${state.display.offsetY}%`,
  };
  for (const output of document.querySelectorAll("[data-output]")) {
    output.textContent = values[output.dataset.output];
  }
}

function applyDisplaySettings({ rerender = true } = {}) {
  const display = state.display;
  const secondarySize = Math.max(14, Math.round(display.fontSize * 0.42));
  const stackHeight = display.fontSize
    + Math.max(0, display.lineCount - 1) * secondarySize
    + Math.max(0, display.lineCount - 1) * display.lineGap
    + 24;
  const root = document.documentElement;
  root.style.setProperty("--lyric-font-size", `${display.fontSize}px`);
  root.style.setProperty("--secondary-font-size", `${secondarySize}px`);
  root.style.setProperty("--lyrics-line-gap", `${display.lineGap}px`);
  root.style.setProperty("--lyrics-offset-x", `${display.offsetX}vw`);
  root.style.setProperty("--lyrics-offset-y", `${display.offsetY}vh`);
  root.style.setProperty("--lyrics-stack-height", `${stackHeight}px`);
  root.style.setProperty(
    "--karaoke-color",
    `rgb(${display.color.r} ${display.color.g} ${display.color.b})`,
  );
  syncSettingsPanel();
  if (rerender && state.lyricStatus === "ready") renderLyricWindow(state.activeIndex);
}

function setSettingsOpen(open) {
  state.settingsOpen = open;
  elements.settingsPanel.classList.toggle("is-open", open);
  elements.settingsPanel.setAttribute("aria-hidden", String(!open));
  elements.settings.classList.toggle("is-active", open);
}

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function estimatedPosition() {
  return playbackPosition(state, performance.now());
}

function setButtonIcon(button, iconName, filled = false) {
  const icon = button.querySelector("i");
  icon.className = `${filled ? "ph-fill" : "ph"} ph-${iconName}`;
}

function showToast(message, timeout = 2_600) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("visible"), timeout);
}

function platformName(source) {
  const value = source.toLowerCase();
  if (value.includes("cloudmusic")) return "网易云音乐";
  if (value.includes("qqmusic")) return "QQ 音乐";
  if (value.includes("kugou")) return "酷狗音乐";
  if (value.includes("kuwo")) return "酷我音乐";
  if (value.includes("qishui")) return "汽水音乐";
  if (value.includes("spotify")) return "Spotify";
  if (value.includes("applemusic") || value.includes("itunes")) return "Apple Music";
  return source || "未知播放器";
}

function syncTrackTools() {
  const offsetSeconds = state.lyricOffsetMs / 1_000;
  elements.offsetStatus.textContent = `${offsetSeconds > 0 ? "+" : ""}${offsetSeconds.toFixed(1)} 秒`;
  const cacheCount = Object.keys(state.lyricCache).length;
  elements.cacheStatus.textContent = cacheCount ? `已缓存 ${cacheCount} 首` : "尚无缓存";
  elements.playerSource.value = state.preferredSource;
  elements.playerModeStatus.textContent = state.preferredSource
    ? `已锁定 ${platformName(state.preferredSource)}`
    : "自动选择";
}

function saveOffsets() {
  localStorage.setItem(OFFSETS_KEY, JSON.stringify(state.offsets));
  persistNativePreferences();
}

function adjustLyricOffset(delta, absolute = false) {
  if (!state.trackKey) {
    showToast("播放歌曲后才能调整时间");
    return;
  }
  state.lyricOffsetMs = clampLyricOffset(absolute ? delta : state.lyricOffsetMs + delta);
  if (state.lyricOffsetMs) state.offsets[state.trackKey] = state.lyricOffsetMs;
  else delete state.offsets[state.trackKey];
  saveOffsets();
  syncTrackTools();
  showToast(`本歌曲歌词${state.lyricOffsetMs > 0 ? "延后" : state.lyricOffsetMs < 0 ? "提前" : "偏移已归零"}${state.lyricOffsetMs ? ` ${Math.abs(state.lyricOffsetMs / 1_000).toFixed(1)} 秒` : ""}`);
}

function saveLyricsCache() {
  const entries = Object.entries(state.lyricCache)
    .sort(([, left], [, right]) => (right.savedAt ?? 0) - (left.savedAt ?? 0))
    .slice(0, 80);
  state.lyricCache = Object.fromEntries(entries);
  try {
    localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(state.lyricCache));
  } catch {
    state.lyricCache = Object.fromEntries(entries.slice(0, 30));
    try {
      localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(state.lyricCache));
    } catch {
      state.lyricCache = {};
    }
  }
  syncTrackTools();
  persistNativePreferences();
}

async function refreshMediaSources() {
  if (!IS_TAURI) return;
  try {
    state.availableSources = await invoke("list_media_sessions");
    const previous = elements.playerSource.value;
    elements.playerSource.replaceChildren(new Option("自动选择正在播放的平台", ""));
    for (const session of state.availableSources) {
      const suffix = session.isPlaying ? " · 正在播放" : " · 已暂停";
      elements.playerSource.append(new Option(`${platformName(session.source)}${suffix}`, session.source));
    }
    if (state.preferredSource && !state.availableSources.some((item) => item.source === state.preferredSource)) {
      elements.playerSource.append(new Option(`${platformName(state.preferredSource)} · 当前未连接`, state.preferredSource));
    }
    elements.playerSource.value = state.preferredSource || previous;
    syncTrackTools();
  } catch {
    // Media polling continues even if the optional source list is temporarily unavailable.
  }
}

function setStageMessage(title, detail = "") {
  elements.stack.replaceChildren();
  const panel = document.createElement("div");
  panel.className = "empty-state";
  const heading = document.createElement("p");
  heading.className = "empty-title";
  heading.textContent = title;
  panel.append(heading);
  if (detail) {
    const body = document.createElement("p");
    body.className = "empty-detail";
    body.textContent = detail;
    panel.append(body);
  }
  elements.stack.append(panel);
}

function renderLyricWindow(activeIndex) {
  if (state.lyricStatus === "loading") {
    setStageMessage("正在寻找歌词", `${state.title} · ${state.artist}`);
    return;
  }
  if (state.lyricStatus === "error") {
    setStageMessage("暂时没有匹配到歌词", state.lyricMessage || "切换歌曲后会自动重试");
    return;
  }
  if (!state.connected) {
    setStageMessage("打开音乐平台开始播放", "仅识别受支持的音乐客户端");
    return;
  }
  if (!state.lines.length) {
    setStageMessage("已连接播放器", "等待歌曲信息");
    return;
  }

  elements.stack.replaceChildren();
  const visibleIndices = visibleLineIndices(state.lines.length, activeIndex, state.display.lineCount);

  for (const index of visibleIndices) {
    const line = document.createElement("div");
    line.className = "lyric-line";
    line.dataset.index = String(index);
    const distance = index - activeIndex;
    line.dataset.distance = String(Math.max(-2, Math.min(2, distance)));

    if (index === activeIndex) {
      line.classList.add("current-line");
      const text = document.createElement("span");
      text.className = "current-text";
      text.dataset.effect = state.display.colorEffect;
      if (state.lines[index].words?.length) {
        text.classList.add("has-word-timing");
        text.setAttribute("aria-label", state.lines[index].text);
        for (const [wordIndex, word] of state.lines[index].words.entries()) {
          const wordElement = document.createElement("span");
          wordElement.className = "karaoke-word";
          wordElement.dataset.wordIndex = String(wordIndex);
          wordElement.setAttribute("aria-hidden", "true");
          const base = document.createElement("span");
          base.className = "karaoke-word-base";
          base.textContent = word.text;
          const highlight = document.createElement("span");
          highlight.className = "karaoke-word-highlight";
          highlight.textContent = word.text;
          wordElement.append(base, highlight);
          text.append(wordElement);
        }
      } else {
        const baseText = document.createElement("span");
        baseText.className = "current-text-base";
        baseText.textContent = state.lines[index].text;
        const highlightedText = document.createElement("span");
        highlightedText.className = "current-text-highlight";
        highlightedText.textContent = state.lines[index].text;
        highlightedText.setAttribute("aria-hidden", "true");
        text.append(baseText, highlightedText);
      }
      line.append(text);
    } else {
      line.classList.add(index < activeIndex ? "history-line" : "next-line");
      line.textContent = state.lines[index].text;
    }
    elements.stack.append(line);
  }
}

function updateConnectionUi() {
  elements.status.classList.toggle("connected", state.connected);
  elements.meta.textContent = state.connected && state.title
    ? `${state.title}${state.artist ? ` · ${state.artist}` : ""}`
    : "等待连接播放器";
  setButtonIcon(elements.play, state.isPlaying ? "pause" : "play", true);
}

async function loadLyrics(snapshot, trackKey) {
  const token = ++state.fetchToken;
  state.lyricAttempts += 1;
  state.lyricStatus = "loading";
  state.lyricMessage = "";
  state.lines = [];
  state.activeIndex = Number.NaN;
  renderLyricWindow(-1);

  const cached = state.lyricCache[trackKey];
  if (cached?.lrc) {
    const cachedLines = parseLrc(cached.lrc);
    if (cachedLines.length) {
      state.lines = cachedLines;
      state.lyricStatus = "ready";
      state.lyricMatch = cached;
      state.activeIndex = Number.NaN;
      cached.savedAt = Date.now();
      saveLyricsCache();
      return;
    }
  }

  try {
    const result = await invoke("fetch_lyrics", {
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      durationMs: snapshot.durationMs,
      source: snapshot.source,
      trackId: snapshot.trackId || "",
    });
    if (token !== state.fetchToken || trackKey !== state.trackKey) return;
    state.lines = parseLrc(result.lrc);
    if (!state.lines.length) throw new Error("歌词没有可用的时间标签");
    state.lyricStatus = "ready";
    state.lyricMatch = result;
    state.activeIndex = Number.NaN;
    state.lyricCache[trackKey] = { ...result, savedAt: Date.now() };
    saveLyricsCache();
  } catch (error) {
    if (token !== state.fetchToken || trackKey !== state.trackKey) return;
    state.lyricStatus = "error";
    state.lyricRetryAt = performance.now() + 5_000 * state.lyricAttempts;
    state.lyricMessage = String(error).replace(/^.*?: /, "");
    renderLyricWindow(-1);
  }
}

let mediaPollInFlight = false;

async function pollMedia() {
  if (!IS_TAURI || mediaPollInFlight) return;
  mediaPollInFlight = true;
  try {
    const snapshot = await invoke("get_media_snapshot", {
      preferredSource: state.preferredSource || null,
    });
    const wasConnected = state.connected;
    state.connected = snapshot.connected;
    state.source = snapshot.source;
    state.title = snapshot.title;
    state.artist = snapshot.artist;
    state.album = snapshot.album;
    Object.assign(state, playbackAnchor(snapshot, performance.now(), Date.now()));
    if (!wasConnected) state.activeIndex = Number.NaN;
    updateConnectionUi();

    const trackKey = snapshot.connected && snapshot.title
      ? `${snapshot.source}\u0000${snapshot.trackId || ""}\u0000${snapshot.title}\u0000${snapshot.artist}\u0000${snapshot.album}\u0000${snapshot.durationMs}`
      : "";
    if (trackKey !== state.trackKey) {
      state.trackKey = trackKey;
      state.lines = [];
      state.activeIndex = Number.NaN;
      state.lyricStatus = "idle";
      state.lyricMatch = null;
      state.fetchToken += 1;
      state.lyricAttempts = 0;
      state.lyricOffsetMs = state.offsets[trackKey] ?? 0;
      syncTrackTools();
      if (trackKey) loadLyrics(snapshot, trackKey);
      else renderLyricWindow(-1);
    } else if (trackKey && state.lyricStatus === "error"
      && state.lyricAttempts < 3 && performance.now() >= state.lyricRetryAt) {
      loadLyrics(snapshot, trackKey);
    }
  } catch (error) {
    state.positionMs = estimatedPosition();
    state.syncedAt = performance.now();
    state.isPlaying = false;
    state.connected = false;
    updateConnectionUi();
    setStageMessage("暂时无法读取播放器", "正在自动重连");
  } finally {
    mediaPollInFlight = false;
  }
}

function animationFrame() {
  const position = estimatedPosition();
  elements.position.textContent = formatTime(position);
  elements.duration.textContent = formatTime(state.durationMs);
  const trackProgress = state.durationMs > 0 ? position / state.durationMs : 0;
  elements.progress.style.transform = `scaleX(${Math.min(1, Math.max(0, trackProgress))})`;

  if (state.connected && state.lyricStatus === "ready") {
    const lyricPosition = position - state.lyricOffsetMs;
    const activeIndex = findActiveLine(state.lines, lyricPosition);
    if (activeIndex !== state.activeIndex) {
      state.activeIndex = activeIndex;
      renderLyricWindow(activeIndex);
    }
    const progress = lineProgress(state.lines, activeIndex, lyricPosition, state.durationMs);
    elements.stack
      .querySelector(".current-text")
      ?.style.setProperty("--karaoke-progress", `${(progress * 100).toFixed(2)}%`);
    const activeLine = state.lines[activeIndex];
    if (activeLine?.words?.length) {
      for (const [wordIndex, word] of activeLine.words.entries()) {
        const value = wordProgress(word, lyricPosition);
        elements.stack.querySelector(`[data-word-index="${wordIndex}"]`)
          ?.style.setProperty("--word-progress", `${(value * 100).toFixed(2)}%`);
      }
    }
  }
  requestAnimationFrame(animationFrame);
}

document.querySelectorAll("[data-media-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!IS_TAURI) return;
    button.classList.add("pressed");
    try {
      await invoke("control_media", {
        action: button.dataset.mediaAction,
        preferredSource: state.preferredSource || null,
      });
      setTimeout(pollMedia, 160);
    } catch (error) {
      showToast("当前播放器暂时没有响应");
    } finally {
      setTimeout(() => button.classList.remove("pressed"), 180);
    }
  });
});

document.querySelector("#lyrics-stage").addEventListener("mousedown", (event) => {
  if (event.button === 0 && IS_TAURI && !state.locked) {
    invoke("start_dragging");
  }
});

elements.top.addEventListener("click", async () => {
  state.alwaysOnTop = !state.alwaysOnTop;
  if (IS_TAURI) await invoke("set_always_on_top", { enabled: state.alwaysOnTop });
  elements.top.classList.toggle("is-active", state.alwaysOnTop);
  showToast(state.alwaysOnTop ? "窗口已置顶" : "窗口已取消置顶");
});

elements.fullscreen.addEventListener("click", async () => {
  state.fullscreen = !state.fullscreen;
  if (IS_TAURI) await invoke("set_fullscreen", { enabled: state.fullscreen });
  document.body.classList.toggle("is-fullscreen", state.fullscreen);
  elements.fullscreen.classList.toggle("is-active", state.fullscreen);
  setButtonIcon(elements.fullscreen, state.fullscreen ? "corners-in" : "corners-out");
});

elements.settings.addEventListener("click", () => setSettingsOpen(!state.settingsOpen));
document.querySelector("#settings-close-button").addEventListener("click", () => setSettingsOpen(false));

for (const tab of document.querySelectorAll("[data-settings-tab]")) {
  tab.addEventListener("click", () => {
    for (const item of document.querySelectorAll("[data-settings-tab]")) {
      item.classList.toggle("is-active", item === tab);
    }
    for (const section of document.querySelectorAll("[data-settings-section]")) {
      section.classList.toggle("is-active", section.dataset.settingsSection === tab.dataset.settingsTab);
    }
  });
}

for (const input of settingInputs) {
  input.addEventListener("input", () => updateSettingValue(input.dataset.setting, input.value));
}

for (const input of colorInputs) {
  input.addEventListener("input", () => {
    state.display = sanitizeDisplaySettings({
      ...state.display,
      color: { ...state.display.color, [input.dataset.colorChannel]: input.value },
    });
    saveDisplaySettings();
    applyDisplaySettings();
  });
}

elements.colorPicker.addEventListener("input", () => {
  const color = hexToRgb(elements.colorPicker.value);
  if (!color) return;
  state.display = sanitizeDisplaySettings({ ...state.display, color });
  saveDisplaySettings();
  applyDisplaySettings();
});

document.querySelector("#settings-reset-button").addEventListener("click", () => {
  state.display = sanitizeDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  saveDisplaySettings();
  applyDisplaySettings();
  showToast("歌词显示已恢复默认");
});

elements.playerSource.addEventListener("change", () => {
  state.preferredSource = elements.playerSource.value;
  localStorage.setItem(PLAYER_KEY, state.preferredSource);
  persistNativePreferences();
  state.trackKey = "";
  state.fetchToken += 1;
  syncTrackTools();
  showToast(state.preferredSource ? `已锁定 ${platformName(state.preferredSource)}` : "已恢复自动选择播放器");
  pollMedia();
});

document.querySelector("#lyrics-earlier-button").addEventListener("click", () => adjustLyricOffset(-500));
document.querySelector("#lyrics-later-button").addEventListener("click", () => adjustLyricOffset(500));
document.querySelector("#offset-reset-button").addEventListener("click", () => adjustLyricOffset(0, true));
document.querySelector("#resync-button").addEventListener("click", () => {
  state.syncedAt = performance.now();
  pollMedia();
  showToast("正在重新读取播放器进度");
});

function candidateDuration(milliseconds) {
  return milliseconds > 0 ? formatTime(milliseconds) : "时长未知";
}

async function chooseLyricsCandidate(candidate, button) {
  if (!state.trackKey) return;
  button.disabled = true;
  try {
    const result = await invoke("fetch_lyrics_candidate", {
      provider: candidate.provider,
      id: candidate.id,
      title: candidate.title,
      artist: candidate.artist,
    });
    const lines = parseLrc(result.lrc);
    if (!lines.length) throw new Error("这个版本没有可用的时间标签");
    state.lines = lines;
    state.activeIndex = Number.NaN;
    state.lyricStatus = "ready";
    state.lyricMatch = result;
    state.lyricCache[state.trackKey] = { ...result, savedAt: Date.now(), manuallySelected: true };
    saveLyricsCache();
    elements.candidateBrowser.replaceChildren();
    elements.candidateBrowser.classList.remove("is-visible");
    renderLyricWindow(findActiveLine(state.lines, estimatedPosition() - state.lyricOffsetMs));
    showToast(`已改用 ${candidate.title} · ${candidate.artist}`);
  } catch (error) {
    showToast(String(error).replace(/^.*?: /, ""), 4_000);
    button.disabled = false;
  }
}

document.querySelector("#find-version-button").addEventListener("click", async (event) => {
  if (!state.connected || !state.title) {
    showToast("播放歌曲后才能搜索歌词版本");
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "搜索中…";
  elements.candidateBrowser.classList.add("is-visible");
  elements.candidateBrowser.textContent = "正在查询可用歌词版本…";
  try {
    const candidates = await invoke("search_lyrics_candidates", {
      title: state.title,
      artist: state.artist,
      album: state.album,
      durationMs: state.durationMs,
    });
    elements.candidateBrowser.replaceChildren();
    if (!candidates.length) {
      elements.candidateBrowser.textContent = "没有找到其他可用版本";
      return;
    }
    for (const candidate of candidates) {
      const item = document.createElement("button");
      item.className = "candidate-item";
      item.type = "button";
      const copy = document.createElement("span");
      copy.className = "candidate-copy";
      const title = document.createElement("strong");
      title.textContent = candidate.title || "未知歌曲";
      const detail = document.createElement("span");
      detail.textContent = `${candidate.artist || "未知歌手"} · ${candidateDuration(candidate.durationMs)}`;
      const provider = document.createElement("span");
      provider.className = "candidate-provider";
      provider.textContent = candidate.provider === "netease" ? "网易云" : "QQ 音乐";
      copy.append(title, detail);
      item.append(copy, provider);
      item.addEventListener("click", () => chooseLyricsCandidate(candidate, item));
      elements.candidateBrowser.append(item);
    }
  } catch {
    elements.candidateBrowser.textContent = "搜索失败，请检查网络后重试";
  } finally {
    button.disabled = false;
    button.textContent = "手动选择";
  }
});
document.querySelector("#cache-clear-button").addEventListener("click", () => {
  state.lyricCache = {};
  saveLyricsCache();
  showToast("歌词缓存已清空");
});

elements.autostart.addEventListener("change", async () => {
  if (!IS_TAURI) return;
  elements.autostart.disabled = true;
  try {
    if (elements.autostart.checked) await enableAutostart();
    else await disableAutostart();
    showToast(elements.autostart.checked ? "已开启开机自动启动" : "已关闭开机自动启动");
  } catch {
    elements.autostart.checked = !elements.autostart.checked;
    showToast("无法修改开机启动设置");
  } finally {
    elements.autostart.disabled = false;
  }
});

const shortcutInputs = [...document.querySelectorAll("[data-shortcut]")];
let unavailableShortcutActions = new Set();

function syncShortcutInputs() {
  for (const input of shortcutInputs) {
    input.value = state.shortcuts[input.dataset.shortcut];
    const unavailable = unavailableShortcutActions.has(input.dataset.shortcut);
    input.classList.toggle("is-unavailable", unavailable);
    input.title = unavailable ? "这个组合键已被其他软件占用，请点击后重新设置" : "点击后直接按下新的组合键";
  }
  elements.lock.title = `锁定 · ${state.shortcuts.toggleLock} 解锁`;
}

async function registerShortcuts({ announce = false, changedAction = "" } = {}) {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(state.shortcuts));
  persistNativePreferences();
  syncShortcutInputs();
  if (!IS_TAURI) return true;
  try {
    const unavailable = await invoke("set_global_shortcuts", { shortcuts: state.shortcuts });
    unavailableShortcutActions = new Set(unavailable);
    syncShortcutInputs();
    if (unavailable.length > 0) {
      showToast(`${unavailable.length} 个快捷键被其他软件占用，已标红；其余快捷键仍然可用`, 5_000);
    } else if (announce) {
      showToast("快捷键已保存并立即生效");
    }
    return !changedAction || !unavailableShortcutActions.has(changedAction);
  } catch (error) {
    showToast(String(error).replace(/^.*?: /, ""), 4_500);
    return false;
  }
}

for (const input of shortcutInputs) {
  input.addEventListener("focus", () => input.classList.add("is-recording"));
  input.addEventListener("blur", () => input.classList.remove("is-recording"));
  input.addEventListener("keydown", async (event) => {
    event.preventDefault();
    const shortcut = shortcutFromKeyboardEvent(event);
    if (!shortcut) return;
    if (!shortcut.includes("+") && !/^F(?:[1-9]|1[0-2])$/.test(shortcut)) {
      showToast("请至少搭配 Ctrl、Alt、Shift 或 Win 键");
      return;
    }
    const action = input.dataset.shortcut;
    const previous = state.shortcuts[action];
    state.shortcuts = { ...state.shortcuts, [action]: shortcut };
    const duplicate = duplicateShortcut(state.shortcuts, action);
    if (duplicate) {
      state.shortcuts[action] = previous;
      showToast("这个组合键已经用于其他功能");
      syncShortcutInputs();
      return;
    }
    if (!(await registerShortcuts({ announce: true, changedAction: action }))) {
      state.shortcuts[action] = previous;
      await registerShortcuts();
    }
    input.blur();
  });
}

document.querySelector("#shortcuts-reset-button").addEventListener("click", () => {
  state.shortcuts = { ...DEFAULT_SHORTCUTS };
  registerShortcuts({ announce: true });
});

document.querySelector("#feedback-button").addEventListener("click", async () => {
  const source = state.source.toLowerCase();
  const platform = source.includes("cloudmusic") ? "网易云音乐"
    : source.includes("qqmusic") ? "QQ 音乐"
      : source.includes("kugou") ? "酷狗音乐"
        : source.includes("kuwo") ? "酷我音乐"
          : source.includes("spotify") ? "Spotify"
            : source.includes("applemusic") || source.includes("itunes") ? "Apple Music"
              : "不确定";
  const params = new URLSearchParams({
    version: "v1.1.0",
    platform,
    source: state.source || "unknown",
    duration: String(state.durationMs || 0),
    position: String(Math.round(estimatedPosition() || 0)),
    lyricStatus: state.lyricStatus,
    lyricMatch: state.lyricMatch?.songMid || "none",
    offset: String(state.lyricOffsetMs),
  });
  if (state.title) params.set("song", `${state.title}${state.artist ? ` - ${state.artist}` : ""}`);
  const url = `https://riverxilee-feedback.riverxilee.chatgpt.site/?${params}`;
  if (IS_TAURI) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
});

document.querySelector("#update-check-button").addEventListener("click", () => {
  checkForUpdates({ manual: true });
});

elements.updateDownload.addEventListener("click", async () => {
  if (!availableUpdate?.downloadUrl) return;
  if (IS_TAURI) await openUrl(availableUpdate.downloadUrl);
  else window.open(availableUpdate.downloadUrl, "_blank", "noopener,noreferrer");
});

document.querySelector("#update-dismiss-button").addEventListener("click", () => {
  setUpdateBannerVisible(false);
});

async function setLocked(locked) {
  setSettingsOpen(false);
  state.locked = locked;
  elements.shell.classList.toggle("is-locked", locked);
  if (IS_TAURI) await invoke("set_click_through", { enabled: locked });
  showToast(locked ? `已锁定，按 ${state.shortcuts.toggleLock} 解锁` : "窗口已解锁", locked ? 4_000 : 2_600);
}

elements.lock.addEventListener("click", () => setTimeout(() => setLocked(true), 200));

async function toggleVisibility() {
  state.visible = !state.visible;
  if (IS_TAURI) await invoke("set_window_visible", { visible: state.visible });
}

function cyclePlayer() {
  const sources = ["", ...state.availableSources.map((item) => item.source)];
  const current = sources.indexOf(state.preferredSource);
  state.preferredSource = sources[(current + 1) % sources.length] ?? "";
  localStorage.setItem(PLAYER_KEY, state.preferredSource);
  persistNativePreferences();
  state.trackKey = "";
  syncTrackTools();
  pollMedia();
  showToast(state.preferredSource ? `已锁定 ${platformName(state.preferredSource)}` : "播放器已切换为自动选择");
}

async function handleShortcut(action) {
  if (!SHORTCUT_ACTIONS.includes(action)) return;
  if (action === "toggleVisibility") await toggleVisibility();
  else if (action === "toggleLock") await setLocked(!state.locked);
  else if (action === "lyricsEarlier") adjustLyricOffset(-500);
  else if (action === "lyricsLater") adjustLyricOffset(500);
  else if (action === "resync") {
    pollMedia();
    showToast("播放器进度已重新读取");
  } else if (action === "switchPlayer") cyclePlayer();
}

document.querySelector("#minimize-button").addEventListener("click", () => {
  if (IS_TAURI) invoke("minimize_window");
});

document.querySelector("#close-button").addEventListener("click", () => {
  state.visible = false;
  if (IS_TAURI) invoke("close_window");
});

if (IS_TAURI) {
  listen("global-shortcut", (event) => handleShortcut(event.payload));
  listen("single-instance-activated", () => {
    state.visible = true;
  });
  registerShortcuts();
  pollMedia();
  refreshMediaSources();
  isAutostartEnabled().then((enabled) => { elements.autostart.checked = enabled; }).catch(() => {});
  setInterval(pollMedia, 650);
  setInterval(refreshMediaSources, 4_000);
  setTimeout(checkForUpdates, 3_500);
  setInterval(checkForUpdates, 6 * 60 * 60 * 1_000);
} else {
  state.connected = true;
  state.title = "恋人";
  state.artist = "李荣浩";
  state.album = "黑马";
  state.isPlaying = true;
  state.durationMs = 20_000;
  state.lines = parseLrc(PREVIEW_LRC);
  state.lyricStatus = "ready";
  state.trackKey = "preview";
  updateConnectionUi();
}

applyDisplaySettings({ rerender: false });
syncShortcutInputs();
syncTrackTools();
renderLyricWindow(-1);
requestAnimationFrame(animationFrame);
