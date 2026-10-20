import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { buildDiagnosticReport, lyricProvider, lyricTimingType } from "./diagnostics.js";
import { findActiveLine, lineProgress, parseLrc, visibleLineIndices, wordProgress } from "./lyrics.js";
import { playbackAnchor, playbackPosition, reconcilePlaybackAnchor } from "./playback.js";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  clampLyricOffset,
  duplicateShortcut,
  sanitizeShortcuts,
  shortcutFromKeyboardEvent,
} from "./preferences.js";
import {
  applyDisplayPreset,
  DEFAULT_DISPLAY_SETTINGS,
  DISPLAY_PRESETS,
  hexToRgb,
  lyricFontFamily,
  rgbToHex,
  sanitizeDisplaySettings,
} from "./settings.js";
import "./styles.css";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const APP_VERSION = "1.1.2";
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
  lyricFromCache: false,
  syncDriftMs: 0,
  syncCorrection: "steady",
  mediaPollFailures: 0,
  lastMediaError: "",
  lastMediaPollAt: 0,
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
          <strong>歌词与同步</strong>
          <span>即时预览 · 自动保存 · v${APP_VERSION}</span>
        </div>
        <button class="icon-button quiet" id="settings-close-button" type="button" aria-label="关闭设置">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>

      <nav class="settings-tabs" aria-label="设置分类">
        <button class="settings-tab is-active" type="button" data-settings-tab="display">显示</button>
        <button class="settings-tab" type="button" data-settings-tab="sync">同步</button>
        <button class="settings-tab" type="button" data-settings-tab="status">状态</button>
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
            <option value="rgb">柔和彩色流光</option>
            <option value="solid">自定义纯色</option>
          </select>
        </label>
        <label class="setting-control">
          <span>歌词动效</span>
          <select data-setting="motionEffect">
            <option value="soft">柔和跟随</option>
            <option value="flow">流体聚焦</option>
            <option value="none">关闭动效</option>
          </select>
        </label>
        <label class="setting-control setting-control-wide">
          <span>歌词字体 <output id="font-count">正在读取本机字体…</output></span>
          <input class="font-family-input" id="font-family-select" data-setting="fontFamily"
            list="system-font-options" autocomplete="off" placeholder="输入名称搜索本机字体" aria-label="搜索并选择本机字体" />
          <datalist id="system-font-options"></datalist>
        </label>
        <label class="setting-control setting-control-wide">
          <span>显示预设</span>
          <span class="preset-control">
            <select id="display-preset-select"></select>
            <button class="text-button" id="apply-preset-button" type="button">应用</button>
          </span>
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

      <section class="settings-section" data-settings-section="status">
        <div class="diagnostic-summary" id="diagnostic-summary" aria-live="polite"></div>
        <div class="diagnostic-actions">
          <button class="text-button" id="copy-diagnostics-button" type="button">复制诊断信息</button>
          <button class="text-button" id="refresh-diagnostics-button" type="button">重新检测</button>
          <button class="text-button" id="reset-window-button" type="button">窗口回到屏幕中央</button>
        </div>
        <p class="diagnostic-note">诊断信息不包含账号、聊天内容或本地文件，仅用于判断播放器、歌词和时间轴状态。</p>
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
        <span class="update-progress" id="update-progress" aria-hidden="true"><i></i></span>
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
  updateProgress: document.querySelector("#update-progress"),
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
  diagnosticSummary: document.querySelector("#diagnostic-summary"),
  displayPreset: document.querySelector("#display-preset-select"),
  fontFamily: document.querySelector("#font-family-select"),
  fontOptions: document.querySelector("#system-font-options"),
  fontCount: document.querySelector("#font-count"),
};

for (const [value, preset] of Object.entries(DISPLAY_PRESETS)) {
  elements.displayPreset.append(new Option(preset.label, value));
}

let availableUpdate = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let downloadedInstallerPath = "";

const FALLBACK_FONTS = [
  "Segoe UI Variable Display",
  "Microsoft YaHei UI",
  "Microsoft JhengHei UI",
  "Arial",
];

async function loadSystemFonts() {
  let fonts = FALLBACK_FONTS;
  try {
    if (IS_TAURI) fonts = await invoke("list_system_fonts");
    fonts = [...new Set([...fonts, state.display.fontFamily])]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
  } catch {
    elements.fontCount.textContent = "读取失败，显示常用字体";
  }
  elements.fontOptions.replaceChildren(...fonts.map((font) => new Option(font, font)));
  elements.fontFamily.value = state.display.fontFamily;
  elements.fontFamily.style.fontFamily = `"${state.display.fontFamily.replace(/["'\\]/g, "")}", sans-serif`;
  if (elements.fontCount.textContent !== "读取失败，显示常用字体") {
    elements.fontCount.textContent = `已识别 ${fonts.length} 款`;
  }
}

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
      downloadedInstallerPath = "";
      elements.updateTitle.textContent = `发现 v${update.latestVersion}`;
      const size = update.downloadSize > 0 ? ` · ${(update.downloadSize / 1024 / 1024).toFixed(1)} MB` : "";
      elements.updateDetail.textContent = `当前 v${update.currentVersion}${size} · 应用内安全下载`;
      elements.updateDownload.textContent = "下载并校验";
      elements.updateDownload.disabled = false;
      elements.updateProgress.style.setProperty("--update-progress", "0");
      elements.updateProgress.setAttribute("aria-hidden", "true");
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
  elements.fontFamily.style.fontFamily = `"${state.display.fontFamily.replace(/["'\\]/g, "")}", sans-serif`;
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
  const secondarySize = Math.max(18, Math.round(display.fontSize * 0.54));
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
  const fontFamily = lyricFontFamily(display.fontFamily);
  root.style.setProperty("--lyric-font-family", fontFamily);
  elements.stack.style.setProperty("font-family", fontFamily, "important");
  root.style.setProperty(
    "--karaoke-color",
    `rgb(${display.color.r} ${display.color.g} ${display.color.b})`,
  );
  elements.stack.dataset.motion = display.motionEffect;
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

function diagnosticData() {
  return {
    version: APP_VERSION,
    ...state,
    positionMs: estimatedPosition(),
    platformName,
  };
}

function renderDiagnostics() {
  if (!elements.diagnosticSummary) return;
  const source = state.source ? platformName(state.source) : "未连接";
  const sessions = state.availableSources.length
    ? state.availableSources.map((item) => `${platformName(item.source)} · ${item.isPlaying ? "播放中" : "已暂停"}`).join(" / ")
    : "未检测到受支持的播放器";
  const rows = [
    ["当前播放器", source],
    ["检测结果", sessions],
    ["歌曲", state.title ? `${state.title}${state.artist ? ` · ${state.artist}` : ""}` : "等待歌曲信息"],
    ["歌词", `${lyricProvider(state.lyricMatch)} · ${lyricTimingType(state.lines)}${state.lyricFromCache ? " · 本地缓存" : ""}`],
    ["同步", `${state.syncDriftMs > 0 ? "+" : ""}${state.syncDriftMs} ms · ${state.syncCorrection === "snap" ? "已重新锁定" : state.syncCorrection === "smooth" ? "平滑纠偏" : "稳定"}`],
    ["连接", state.mediaPollFailures ? `连续失败 ${state.mediaPollFailures} 次 · 正在重试` : "读取正常"],
  ];
  elements.diagnosticSummary.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    const name = document.createElement("span");
    name.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = value;
    row.append(name, detail);
    elements.diagnosticSummary.append(row);
  }
  if (state.lastMediaError || state.lyricStatus === "error") {
    const error = document.createElement("p");
    error.className = "diagnostic-error";
    error.textContent = `最近问题：${state.lastMediaError || state.lyricMessage}`;
    elements.diagnosticSummary.append(error);
  }
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
    renderDiagnostics();
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

  const previousActiveIndex = Number(
    elements.stack.querySelector(".current-line[data-index]")?.dataset.index ?? -1,
  );
  const previousRects = new Map(
    [...elements.stack.querySelectorAll(".lyric-line[data-index]")]
      .map((line) => [Number(line.dataset.index), line.getBoundingClientRect()]),
  );
  const fragment = document.createDocumentFragment();
  const visibleIndices = visibleLineIndices(state.lines.length, activeIndex, state.display.lineCount);

  for (const index of visibleIndices) {
    const line = document.createElement("div");
    line.className = "lyric-line";
    line.style.setProperty("font-family", "var(--lyric-font-family)", "important");
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
    fragment.append(line);
  }
  elements.stack.replaceChildren(fragment);
  animateLyricWindow(previousRects, previousActiveIndex, activeIndex);
}

function playLyricAnimation(element, keyframes, options) {
  const animation = element.animate(keyframes, options);
  animation.finished.catch(() => {}).finally(() => animation.cancel());
}

function animateLyricWindow(previousRects, previousActiveIndex, activeIndex) {
  const effect = state.display.motionEffect;
  if (effect === "none" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const flowing = effect === "flow";
  const direction = previousActiveIndex >= 0 && activeIndex < previousActiveIndex ? -1 : 1;
  const duration = flowing ? 620 : 420;
  const easing = flowing ? "cubic-bezier(0.2, 0.9, 0.2, 1)" : "cubic-bezier(0.16, 1, 0.3, 1)";

  for (const line of elements.stack.querySelectorAll(".lyric-line[data-index]")) {
    const index = Number(line.dataset.index);
    const previousRect = previousRects.get(index);
    if (previousRect) {
      const deltaY = previousRect.top - line.getBoundingClientRect().top;
      if (Math.abs(deltaY) > 0.5) {
        const frames = flowing
          ? [
              { translate: `0 ${deltaY}px`, filter: "blur(1.8px)" },
              { translate: "0 -2px", filter: "blur(0)" },
              { translate: "0 0", filter: "blur(0)" },
            ]
          : [
              { translate: `0 ${deltaY}px` },
              { translate: "0 0" },
            ];
        playLyricAnimation(line, frames, { duration, easing, fill: "both" });
      }
      continue;
    }

    const entryDistance = flowing ? 34 : 22;
    playLyricAnimation(line, [
      {
        opacity: 0,
        translate: `0 ${entryDistance * direction}px`,
        filter: flowing ? "blur(7px)" : "blur(2px)",
      },
      { opacity: 1, translate: "0 0", filter: "blur(0)" },
    ], { duration: flowing ? 520 : 360, easing, fill: "both" });
  }

  if (activeIndex === previousActiveIndex) return;
  const currentText = elements.stack.querySelector(".current-text");
  if (!currentText) return;
  const focusFrames = flowing
    ? [
        { opacity: 0.45, transform: "translateY(8px) scale(0.965)", filter: "blur(5px)" },
        { opacity: 1, transform: "translateY(-1px) scale(1.012)", filter: "blur(0)" },
        { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0)" },
      ]
    : [
        { opacity: 0.58, transform: "translateY(5px) scale(0.985)", filter: "blur(2px)" },
        { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0)" },
      ];
  playLyricAnimation(currentText, focusFrames, {
    duration: flowing ? 640 : 460,
    easing,
    fill: "both",
  });
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
  state.lyricFromCache = false;
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
      state.lyricFromCache = true;
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
    state.lyricFromCache = false;
    state.activeIndex = Number.NaN;
    state.lyricCache[trackKey] = { ...result, savedAt: Date.now() };
    saveLyricsCache();
  } catch (error) {
    if (token !== state.fetchToken || trackKey !== state.trackKey) return;
    state.lyricStatus = "error";
    state.lyricRetryAt = performance.now() + 5_000 * state.lyricAttempts;
    state.lyricMessage = String(error).replace(/^.*?: /, "");
    renderLyricWindow(-1);
    renderDiagnostics();
  }
}

let mediaPollInFlight = false;

async function pollMedia() {
  if (!IS_TAURI || mediaPollInFlight) return;
  mediaPollInFlight = true;
  try {
    const receivedAt = performance.now();
    const receivedAtEpoch = Date.now();
    const snapshot = await invoke("get_media_snapshot", {
      preferredSource: state.preferredSource || null,
    });
    const wasConnected = state.connected;
    const sameTrack = wasConnected
      && state.source === snapshot.source
      && state.title === snapshot.title
      && state.artist === snapshot.artist;
    state.connected = snapshot.connected;
    state.source = snapshot.source;
    state.title = snapshot.title;
    state.artist = snapshot.artist;
    state.album = snapshot.album;
    if (snapshot.connected && sameTrack) {
      const reconciled = reconcilePlaybackAnchor(state, snapshot, receivedAt, receivedAtEpoch);
      Object.assign(state, reconciled.anchor);
      state.syncDriftMs = reconciled.driftMs;
      state.syncCorrection = reconciled.correction;
    } else {
      Object.assign(state, playbackAnchor(snapshot, receivedAt, receivedAtEpoch));
      state.syncDriftMs = 0;
      state.syncCorrection = "steady";
    }
    state.mediaPollFailures = 0;
    state.lastMediaError = "";
    state.lastMediaPollAt = Date.now();
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
      state.lyricFromCache = false;
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
    renderDiagnostics();
  } catch (error) {
    state.mediaPollFailures += 1;
    state.lastMediaError = String(error).replace(/^.*?: /, "");
    state.positionMs = estimatedPosition();
    state.syncedAt = performance.now();
    if (state.mediaPollFailures >= 3) {
      state.isPlaying = false;
      state.connected = false;
      state.source = "";
      state.title = "";
      state.artist = "";
      state.album = "";
      state.trackKey = "";
      state.lines = [];
      state.activeIndex = Number.NaN;
      state.lyricStatus = "idle";
      state.lyricMatch = null;
      state.fetchToken += 1;
      updateConnectionUi();
      setStageMessage("暂时无法读取播放器", "正在自动重连，不需要重新打开软件");
    }
    renderDiagnostics();
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
        const wordElement = elements.stack.querySelector(`[data-word-index="${wordIndex}"]`);
        wordElement?.style.setProperty("--word-progress", `${(value * 100).toFixed(2)}%`);
        const emphasis = value > 0 && value < 1 ? Math.sin(Math.PI * value) : 0;
        wordElement?.style.setProperty("--word-lift", `${(-1.5 * emphasis).toFixed(2)}px`);
        wordElement?.style.setProperty("--word-scale", (1 + 0.035 * emphasis).toFixed(4));
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
    if (tab.dataset.settingsTab === "status") renderDiagnostics();
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

document.querySelector("#apply-preset-button").addEventListener("click", () => {
  const presetName = elements.displayPreset.value;
  state.display = applyDisplayPreset(state.display, presetName);
  saveDisplaySettings();
  applyDisplaySettings();
  showToast(`已应用${DISPLAY_PRESETS[presetName]?.label ?? "显示"}预设`);
});

document.querySelector("#copy-diagnostics-button").addEventListener("click", async () => {
  const report = buildDiagnosticReport(diagnosticData());
  try {
    await navigator.clipboard.writeText(report);
    showToast("诊断信息已复制，可以直接粘贴到反馈中");
  } catch {
    showToast("复制失败，请在问题反馈中自动附带诊断信息", 4_000);
  }
});

document.querySelector("#refresh-diagnostics-button").addEventListener("click", async () => {
  state.mediaPollFailures = 0;
  state.lastMediaError = "";
  await Promise.all([pollMedia(), refreshMediaSources()]);
  renderDiagnostics();
  showToast("播放器与歌词状态已重新检测");
});

document.querySelector("#reset-window-button").addEventListener("click", async () => {
  if (!IS_TAURI) return;
  try {
    await invoke("reset_window_placement");
    showToast("窗口已回到当前屏幕中央");
  } catch {
    showToast("暂时无法恢复窗口位置");
  }
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
    state.lyricFromCache = false;
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
    version: `v${APP_VERSION}`,
    platform,
    source: state.source || "unknown",
    duration: String(state.durationMs || 0),
    position: String(Math.round(estimatedPosition() || 0)),
    lyricStatus: state.lyricStatus,
    lyricMatch: state.lyricMatch?.songMid || "none",
    offset: String(state.lyricOffsetMs),
    syncDrift: String(state.syncDriftMs),
    diagnostic: buildDiagnosticReport(diagnosticData()),
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
  if (!IS_TAURI || !availableUpdate || updateDownloadInFlight) return;
  if (downloadedInstallerPath) {
    elements.updateDownload.disabled = true;
    elements.updateDownload.textContent = "正在启动…";
    elements.updateDetail.textContent = "即将关闭应用并打开 RiverXILee 更新安装界面";
    try {
      await invoke("launch_update", { installerPath: downloadedInstallerPath });
    } catch (error) {
      elements.updateDownload.disabled = false;
      elements.updateDownload.textContent = "重新安装";
      elements.updateDetail.textContent = String(error).replace(/^.*?: /, "");
    }
    return;
  }

  updateDownloadInFlight = true;
  elements.updateDownload.disabled = true;
  elements.updateDownload.textContent = "下载中 0%";
  elements.updateDetail.textContent = "正在下载更新包，请保持网络连接";
  elements.updateProgress.setAttribute("aria-hidden", "false");
  try {
    downloadedInstallerPath = await invoke("download_update", {
      expectedVersion: availableUpdate.latestVersion,
    });
    elements.updateTitle.textContent = `v${availableUpdate.latestVersion} 已准备好`;
    elements.updateDetail.textContent = "SHA-256 校验通过 · 点击后覆盖安装并保留配置";
    elements.updateDownload.textContent = "立即安装";
  } catch (error) {
    elements.updateDetail.textContent = String(error).replace(/^.*?: /, "");
    elements.updateDownload.textContent = "重新下载";
    elements.updateProgress.style.setProperty("--update-progress", "0");
  } finally {
    updateDownloadInFlight = false;
    elements.updateDownload.disabled = false;
  }
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
  listen("update-download-progress", (event) => {
    const progress = event.payload;
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    elements.updateProgress.style.setProperty("--update-progress", String(percent / 100));
    if (progress.status === "verified") {
      elements.updateDownload.textContent = "正在校验…";
      elements.updateDetail.textContent = "下载完成，正在验证安装包完整性";
    } else {
      elements.updateDownload.textContent = `下载中 ${percent}%`;
      const downloaded = (Number(progress.downloadedBytes) / 1024 / 1024).toFixed(1);
      const total = Number(progress.totalBytes) > 0
        ? (Number(progress.totalBytes) / 1024 / 1024).toFixed(1)
        : "--";
      elements.updateDetail.textContent = `${downloaded} / ${total} MB · 下载完成后自动校验`;
    }
  });
  listen("single-instance-activated", () => {
    state.visible = true;
    showToast("RiverXILee桌面歌词已经在运行", 3_500);
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

loadSystemFonts();
applyDisplaySettings({ rerender: false });
syncShortcutInputs();
syncTrackTools();
renderLyricWindow(-1);
requestAnimationFrame(animationFrame);
