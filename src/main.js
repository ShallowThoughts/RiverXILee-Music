import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { buildDiagnosticReport, lyricProvider, lyricTimingType } from "./diagnostics.js";
import { findActiveLine, parseLrc } from "./lyrics.js";
import { createLyricView } from "./lyric-view.js";
import { createLyricSession, legacyTrackKey, matchingLegacyKeys } from "./lyric-session.js";
import { parseSongLink, readLyricFile } from "./lyric-links.js";
import { createFontPicker, resolveInstalledFont } from "./font-picker.js";
import { playbackAnchor, playbackPosition, reconcilePlaybackAnchor } from "./playback.js";
import { updateErrorMessage, updateProgressView } from "./update-ui.js";
import { platformName, resolvePreferredSource } from "./media-sources.js";
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
  displayBackup,
  mergeDisplayProfiles,
  parseDisplayBackup,
  sanitizeDisplayProfiles,
  hexToRgb,
  lyricFontFamily,
  rgbToHex,
  sanitizeDisplaySettings,
} from "./settings.js";
import "./styles.css";
import "./liquid-glass.css";
import { initLiquidGlass } from "./liquid-glass.js";
import { createOnboarding } from "./onboarding.js";
import { pruneLyricCache, LYRIC_CACHE_LIMIT } from "./lyric-cache.js";
import { needsTranslationRefresh, translationStatus } from "./translations.js";
import { createSeekControl } from "./seek-control.js";
import "./onboarding.css";
import { displayVersion as APP_VERSION } from "../package.json";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const IS_GLASS_PREVIEW = import.meta.env.VITE_LIQUID_GLASS_PREVIEW === "1"
  || (!IS_TAURI && new URLSearchParams(location.search).get("glass") === "1");
// Stable and isolated preview share the approved material; isolation remains separate.
document.body.classList.add("glass-preview");
const DISPLAY_SETTINGS_KEY = "riverxilee-desktop-lyrics.display.v1";
const SHORTCUTS_KEY = "riverxilee-desktop-lyrics.shortcuts.v1";
const PLAYER_KEY = "riverxilee-desktop-lyrics.player.v1";
const OFFSETS_KEY = "riverxilee-desktop-lyrics.offsets.v1";
const LYRICS_CACHE_KEY = "riverxilee-desktop-lyrics.cache.v1";
const DISPLAY_PROFILES_KEY = "riverxilee-desktop-lyrics.profiles.v1";
const MELODY_KEY = "riverxilee-desktop-lyrics.melody.v1";
const ONBOARDING_KEY = "riverxilee-desktop-lyrics.onboarding.v1";
const PREVIEW_LRC = [
  "让音乐，留在看得见的地方",
  "每一句，都有自然的呼吸",
  "把此刻的旋律，轻轻唱给你",
  "下一句，沿着时间慢慢靠近",
  "Let every word follow the music",
  "지금 이 순간을 기억해",
  "透明的画面，也能装下情绪",
  "RiverXILee，陪你听见每一句",
].map((text, line) => {
  const characters = text.match(/[A-Za-z]+(?:\s+)?|[^A-Za-z]/g);
  const unit = 3500 / (characters.length + 2);
  let time = line * 4000;
  return `{${time},3600}` + characters.map((character, index) => {
    const duration = Math.floor(unit * (index === characters.length - 1 ? 3 : 1));
    const tag = `(${time},${duration},0)${character}`;
    time += duration;
    return tag;
  }).join("");
}).join("\n");
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
  displayProfiles: sanitizeDisplayProfiles(loadJson(DISPLAY_PROFILES_KEY, "displayProfiles", [])),
  discoveredMelody: loadJson(MELODY_KEY, "discoveredMelody", false) === true,
  onboardingDismissed: loadJson(ONBOARDING_KEY, "onboardingDismissed", false) === true,
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
    displayProfiles: state.displayProfiles,
    discoveredMelody: state.discoveredMelody,
    onboardingDismissed: state.onboardingDismissed,
  };
  preferenceSaveQueue = preferenceSaveQueue
    .catch(() => {})
    .then(() => invoke("save_preferences", { preferences }))
    .catch(() => {});
}

const settingsPages = [
  ["layout", "排版与位置", "行数、字号、间距和偏移", "sliders-horizontal"],
  ["appearance", "字体、颜色与动效", "字体、高亮与流光演出", "text-aa"],
  ["profiles", "显示方案", "预设、个人方案与备份", "stack"],
  ["sync", "播放与同步", "播放器、校时与歌词来源", "waveform"],
  ["status", "播放状态", "连接信息与故障诊断", "pulse"],
  ["shortcuts", "快捷键", "查看、修改与清除全局快捷键", "keyboard"],
  ["about", "关于与帮助", "版本、更新与反馈", "info"],
];
const shortcutLabels = {
  toggleVisibility: "显示或隐藏", toggleLock: "锁定或解锁", lyricsEarlier: "歌词提前",
  lyricsLater: "歌词延后", resync: "重新同步", switchPlayer: "切换播放器",
};

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
          <span class="app-name">RiverXILee桌面歌词${IS_GLASS_PREVIEW ? " · 液态玻璃预览" : ""}</span>
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
          <div class="timeline"><span id="timeline-progress" aria-hidden="true"></span><input id="timeline-seek" type="range" min="0" max="1" step="1000" value="0" disabled aria-label="歌曲播放进度"></div>
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

    <aside class="settings-panel" id="settings-panel" aria-hidden="true" aria-labelledby="settings-page-title" inert>
      <div class="settings-heading">
        <button class="icon-button quiet" id="settings-back-button" type="button" aria-label="返回设置目录" title="返回设置目录" hidden>
          <i class="ph ph-arrow-left" aria-hidden="true"></i>
        </button>
        <div>
          <h2 id="settings-page-title" tabindex="-1">设置</h2>
          <span>${IS_GLASS_PREVIEW ? "液态玻璃独立预览" : "即时预览 · 自动保存"} · v${APP_VERSION}</span>
        </div>
        <button class="icon-button quiet" id="settings-close-button" type="button" aria-label="关闭设置">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>

      <nav class="settings-section settings-menu is-active" data-settings-section="home" aria-label="设置目录">
        ${settingsPages.map(([id, title, detail, icon]) => `
          <button class="settings-menu-item" type="button" data-settings-tab="${id}">
            <i class="ph ph-${icon} settings-menu-icon" aria-hidden="true"></i>
            <span><strong>${title}</strong><small>${detail}</small></span>
            <i class="ph ph-caret-right" aria-hidden="true"></i>
          </button>`).join("")}
      </nav>

      <section class="settings-section" data-settings-section="layout" aria-label="排版与位置">
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
       </div>
      </section>

      <section class="settings-section" data-settings-section="appearance" aria-label="字体、颜色与动效">
       <div class="settings-grid">
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
            <option value="soft">沉浸跟随</option>
            <option value="flow">流光演出</option>
            <option value="none">关闭动效</option>
          </select>
        </label>
        <div class="setting-control setting-control-wide">
          <span id="font-control-label">歌词字体 <output id="font-count">正在读取本机字体…</output></span>
          <button class="font-picker-button" id="font-family-select" type="button" aria-label="选择歌词字体" aria-haspopup="listbox" aria-expanded="false" aria-controls="font-option-list">
            <span id="font-selected-label"></span><i class="ph ph-caret-down" aria-hidden="true"></i>
          </button>
        </div>
        <label class="setting-control setting-control-wide">
          <span>翻译模式</span>
          <select data-setting="translationMode"><option value="off">仅显示原文</option><option value="bilingual">原文＋平台译文</option></select>
          <small class="setting-help" id="translation-status">仅使用当前歌词版本自带的译文，无译文时保留原文</small>
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

      <section class="settings-section" data-settings-section="profiles" aria-label="显示方案">
        <label class="setting-control">
          <span>显示预设</span>
          <span class="preset-control">
            <select id="display-preset-select"></select>
            <button class="text-button" id="apply-preset-button" type="button">应用</button>
          </span>
        </label>
        <div class="profile-heading">我的显示方案 <span id="profile-count">0 / 20</span></div>
        <div class="profile-editor">
          <label class="setting-control"><span>已保存方案</span><select id="personal-profile-select"><option value="">选择个人方案</option></select></label>
          <label class="setting-control"><span>方案名称</span><input class="setting-text" id="profile-name" maxlength="40" placeholder="例如：日常桌面、打游戏" /></label>
          <div class="profile-actions">
            <button class="text-button" id="profile-save-button" type="button">保存当前样式</button>
            <button class="text-button" id="profile-apply-button" type="button">应用</button>
            <button class="text-button" id="profile-rename-button" type="button">重命名</button>
            <button class="text-button" id="profile-delete-button" type="button">删除</button>
          </div>
          <div class="profile-backup-actions">
            <button class="text-button" id="profile-export-button" type="button"><i class="ph ph-export" aria-hidden="true"></i> 导出备份</button>
            <button class="text-button" id="profile-import-button" type="button"><i class="ph ph-import" aria-hidden="true"></i> 导入备份</button>
          </div>
          <p class="setting-help">备份包含当前样式与个人方案。导入会恢复样式并合并方案；字体需要在本机安装。</p>
          <input id="profile-file-input" type="file" accept=".json,application/json" hidden />
        </div>
        <div class="settings-footer"><button class="text-button" id="settings-reset-button" type="button">恢复默认显示</button></div>
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
            <div class="sync-copy"><strong>网易云进度增强控制</strong><span id="netease-control-status" role="status">默认关闭 · 开启前需两次确认并重启网易云</span></div>
            <button class="text-button" id="netease-control-button" type="button">临时启用</button>
          </div>
          <p class="setting-help">仅限本次运行，不修改客户端文件。开启会开放本机调试端口，存在本机访问风险；退出桌面歌词不会关闭端口，需恢复普通模式或完全退出网易云后正常重开。</p>
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
          <details class="lyric-recovery">
            <summary>指定歌曲或导入歌词</summary>
            <p class="setting-help" id="lyric-binding-target">播放歌曲后可绑定歌词</p>
            <label class="setting-control"><span>网易云 / QQ 音乐歌曲链接</span><input class="setting-text" id="song-link-input" type="text" maxlength="2048" placeholder="粘贴完整歌曲链接" /></label>
            <div class="profile-actions">
              <button class="text-button" id="song-link-button" type="button">获取并绑定</button>
              <button class="text-button" id="lyric-import-button" type="button">导入 LRC 歌词</button>
              <button class="text-button" id="lyric-auto-button" type="button">恢复自动匹配</button>
              <button class="text-button" id="lyric-instrumental-button" type="button">本首设为纯音乐</button>
            </div>
            <p class="setting-help">手动选择会绑定到当前歌曲并保存在本地。支持带时间标签的 LRC、YRC、QRC，不需要音频文件。</p>
            <input id="lyric-file-input" type="file" accept=".lrc,.yrc,.qrc,text/plain" hidden />
          </details>
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

      <section class="settings-section about-section" data-settings-section="about">
        <div class="about-identity">
          <button class="about-mark" id="about-mark" type="button" aria-label="RiverXILee 标志"><i class="ph ph-waveform" aria-hidden="true"></i></button>
          <div><strong>RiverXILee桌面歌词</strong><span>v${APP_VERSION} · 由 RiverXILee 制作</span></div>
          <button class="melody-replay icon-button" id="melody-replay" type="button" title="重温隐藏的旋律" aria-label="重温隐藏的旋律" ${state.discoveredMelody ? "" : "hidden"}><i class="ph-fill ph-star-four" aria-hidden="true"></i></button>
        </div>
        <p class="about-description">把音乐留在看得见的地方。<br />透明、安静，跟随每一句。</p>
        <p class="about-note" id="melody-discovery" role="status">${state.discoveredMelody ? "你发现了一段隐藏的旋律。" : "愿每一句喜欢的歌词，都有停留的地方。"}</p>
        <div class="settings-footer settings-actions">
          <button class="text-button" id="feedback-button" type="button">问题反馈</button>
          <button class="text-button" id="update-check-button" type="button">检查更新</button>
          <button class="text-button" id="onboarding-replay-button" type="button">新手引导</button>
        </div>
      </section>

      <section class="settings-section" data-settings-section="shortcuts">
        <div class="shortcut-list">
          ${Object.entries(shortcutLabels).map(([action, label]) => `
            <div class="shortcut-row">
              <label for="shortcut-${action}">${label}</label>
              <input id="shortcut-${action}" readonly placeholder="未设置" data-shortcut="${action}" />
              <button class="text-button" type="button" data-clear-shortcut="${action}" aria-label="清除${label}快捷键">清除</button>
            </div>`).join("")}
        </div>
        <div class="shortcut-footer">
          <span>点击输入框录入；无需快捷键时可清除</span>
          <button class="text-button" id="shortcuts-reset-button" type="button">恢复默认快捷键</button>
        </div>
      </section>

    </aside>

    <div class="font-picker-popup" id="font-picker-popup" popover="manual" hidden>
      <input class="font-search-input" id="font-search-input" type="search" autocomplete="off" maxlength="256" placeholder="搜索中文名或英文名" role="combobox" aria-label="搜索本机字体" aria-controls="font-option-list" aria-expanded="false" aria-autocomplete="list" />
      <div class="font-option-list" id="font-option-list" role="listbox" aria-label="本机已安装字体"></div>
      <p class="font-picker-status" id="font-picker-status" role="status"></p>
    </div>

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

    <div class="toast" id="toast" role="status"><span id="toast-message"></span></div>
    <dialog class="melody-dialog" id="melody-dialog" aria-labelledby="melody-title" aria-describedby="melody-message">
      <button class="icon-button melody-close" id="melody-close" type="button" aria-label="关闭隐藏旋律" autofocus><i class="ph ph-x" aria-hidden="true"></i></button>
      <div class="melody-art" aria-hidden="true">
        <svg class="melody-wave" viewBox="0 0 640 120">
          <defs><linearGradient id="melody-gradient"><stop offset="0" stop-color="#ff5ca8"/><stop offset=".5" stop-color="#6cdeff"/><stop offset="1" stop-color="#80f6ca"/></linearGradient></defs>
          <path d="M20 60 H100 L120 60 L138 39 L158 84 L184 18 L210 101 L238 44 L260 71 L288 30 L320 90 L350 39 L378 81 L406 23 L434 95 L460 46 L482 73 L508 39 L532 77 L554 54 L574 60 H620"/>
        </svg>
        <div class="melody-particles">${Array.from({ length: 18 }, (_, index) => `<span style="--particle-x:${(index - 8.5) * 28}px;--particle-y:${Math.sin(index * 2.4) * 74}px;--particle-delay:${index * 12}ms"></span>`).join("")}</div>
      </div>
      <h1 id="melody-title">RiverXILee</h1>
      <p id="melody-message">谢谢你，让每一句歌词都有停留的地方。</p>
    </dialog>
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
  fontCount: document.querySelector("#font-count"),
  personalProfile: document.querySelector("#personal-profile-select"),
  profileName: document.querySelector("#profile-name"),
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
  { family: "Microsoft YaHei UI", displayName: "微软雅黑 UI", aliases: ["Microsoft YaHei UI", "微软雅黑 UI"] },
  { family: "Microsoft JhengHei UI", displayName: "微軟正黑體 UI", aliases: ["Microsoft JhengHei UI", "微軟正黑體 UI"] },
  "Arial",
];

const fontPicker = createFontPicker({
  button: elements.fontFamily,
  popup: document.querySelector("#font-picker-popup"),
  search: document.querySelector("#font-search-input"),
  list: document.querySelector("#font-option-list"),
  status: document.querySelector("#font-picker-status"),
  label: document.querySelector("#font-selected-label"),
  getSelected: () => state.display.fontFamily,
  onSelect: (family) => updateSettingValue("fontFamily", family),
});

async function loadSystemFonts() {
  let fonts = FALLBACK_FONTS;
  try {
    if (IS_TAURI) fonts = await invoke("list_system_fonts");
    const catalog = fontPicker.setFonts(fonts);
    const installed = resolveInstalledFont(catalog, state.display.fontFamily);
    if (installed && installed !== state.display.fontFamily) updateSettingValue("fontFamily", installed);
    elements.fontCount.textContent = `${IS_TAURI ? "已识别" : "浏览器预览"} ${catalog.length} 款`;
  } catch {
    fontPicker.setFonts(FALLBACK_FONTS);
    elements.fontCount.textContent = "读取失败，显示常用字体";
  }
}

function setUpdateBannerVisible(visible) {
  elements.updateBanner.classList.toggle("is-visible", visible);
  elements.updateBanner.setAttribute("aria-hidden", String(!visible));
}

async function checkForUpdates({ manual = false } = {}) {
  if (!IS_TAURI || IS_GLASS_PREVIEW || updateCheckInFlight) return;
  if (updateDownloadInFlight || downloadedInstallerPath) {
    if (manual) showToast(downloadedInstallerPath ? "更新包已准备好，请点击立即安装" : "更新正在下载，请稍候");
    return;
  }
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
  } catch (error) {
    if (manual) showToast(updateErrorMessage(error, "暂时无法检查更新，请稍后重试"), 5_000);
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
  fontPicker.sync();
  for (const input of colorInputs) input.value = state.display.color[input.dataset.colorChannel];
  elements.colorPicker.value = rgbToHex(state.display.color);
  document.querySelector("#translation-status").textContent = translationStatus(state);

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
  const secondarySize = Math.max(18, Math.round(display.fontSize * 0.64));
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
  if (!open) fontPicker.close();
  state.settingsOpen = open;
  elements.settingsPanel.classList.toggle("is-open", open);
  elements.settingsPanel.setAttribute("aria-hidden", String(!open));
  elements.settings.classList.toggle("is-active", open);
  elements.settingsPanel.inert = !open;
  elements.settings.setAttribute("aria-expanded", String(open));
  if (open) showSettingsPage("home");
}

function showSettingsPage(page, returnTo) {
  fontPicker.close();
  for (const section of elements.settingsPanel.querySelectorAll("[data-settings-section]")) {
    const active = section.dataset.settingsSection === page;
    section.classList.toggle("is-active", active);
    if (active) section.scrollTop = 0;
  }
  const back = document.querySelector("#settings-back-button");
  back.hidden = page === "home";
  back.dataset.from = page;
  const title = document.querySelector("#settings-page-title");
  title.textContent = settingsPages.find(([id]) => id === page)?.[1] ?? "设置";
  if (page === "status") renderDiagnostics();
  (returnTo ?? title).focus({ preventScroll: !returnTo });
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
  document.querySelector("#toast-message").textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("visible"), timeout);
}

function syncTrackTools() {
  const offsetSeconds = state.lyricOffsetMs / 1_000;
  elements.offsetStatus.textContent = `${offsetSeconds > 0 ? "+" : ""}${offsetSeconds.toFixed(1)} 秒`;
  const cacheCount = Object.keys(state.lyricCache).length;
  elements.cacheStatus.textContent = cacheCount ? `已缓存 ${cacheCount} 首 · 自动上限 ${LYRIC_CACHE_LIMIT} 首，手动绑定保留` : `自动缓存最多 ${LYRIC_CACHE_LIMIT} 首`;
  elements.playerSource.value = state.preferredSource;
  elements.playerModeStatus.textContent = state.preferredSource
    ? `已锁定 ${platformName(state.preferredSource)}`
    : "自动选择";
  document.querySelector("#lyric-binding-target").textContent = state.trackKey
    ? `绑定到：${state.title}${state.artist ? ` · ${state.artist}` : ""}`
    : "播放歌曲后可绑定歌词";
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
    ["歌词加载", state.lyricStatus === "loading" ? `正在在线查询 · 第 ${state.lyricAttempts} 次`
      : state.lyricStatus === "error" ? `${Math.max(0, Math.ceil((state.lyricRetryAt - performance.now()) / 1000))} 秒后自动重试`
        : state.lyricStatus === "ready" ? (state.lyricMatch?.manuallySelected ? "手动绑定" : "已就绪") : "等待歌曲"],
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
  state.lyricCache = pruneLyricCache(state.lyricCache);
  try {
    localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(state.lyricCache));
  } catch {
    // WebView quota must never truncate the desktop's native preferences/cache.
  }
  syncTrackTools();
  persistNativePreferences();
}

async function refreshMediaSources() {
  if (!IS_TAURI) return;
  try {
    state.availableSources = await invoke("list_media_sessions");
    const preferred = resolvePreferredSource(state.preferredSource, state.availableSources);
    if (preferred !== state.preferredSource) {
      state.preferredSource = preferred;
      localStorage.setItem(PLAYER_KEY, preferred);
      persistNativePreferences();
    }
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

const lyricView = createLyricView(elements.stack);

function setStageMessage(title, detail = "") {
  lyricView.clear();
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
  if (state.lyricStatus === "instrumental") {
    setStageMessage("纯音乐，请欣赏", "已停止自动匹配；如判断不符，可在播放与同步中手动指定歌词");
    return;
  }
  if (["loading", "recovering"].includes(state.lyricStatus)) {
    setStageMessage(state.lyricStatus === "recovering" ? "正在重新获取歌词" : "正在寻找歌词", `${state.title} · ${state.artist}`);
    return;
  }
  if (state.lyricStatus === "error") {
    const serviceBusy = /\b(?:429|502|503|504)\b/.test(state.lyricMessage);
    const noMatch = state.lyricMessage.includes("两个歌词源均未找到");
    setStageMessage(serviceBusy ? "歌词服务暂时不可用，稍后重试" : noMatch ? "暂未找到匹配的歌词" : "歌词暂未获取，将自动重试",
      state.lyricMessage || "可尝试其他歌词版本或导入 LRC");
    const actions = document.createElement("div");
    actions.className = "empty-actions";
    const retry = document.createElement("button");
    retry.className = "text-button";
    retry.type = "button";
    retry.textContent = "立即重试";
    retry.addEventListener("click", () => lyricSession.retry());
    const recover = document.createElement("button");
    recover.className = "text-button";
    recover.type = "button";
    recover.textContent = "指定歌词";
    recover.addEventListener("click", () => {
      setSettingsOpen(true);
      document.querySelector('[data-settings-tab="sync"]').click();
      document.querySelector(".lyric-recovery").open = true;
      document.querySelector("#song-link-input").focus();
    });
    actions.append(retry, recover);
    elements.stack.querySelector(".empty-state").append(actions);
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

  lyricView.render(state.lines, activeIndex, state.display);
  lyricView.update(estimatedPosition() - state.lyricOffsetMs, state.durationMs);
}

function updateConnectionUi() {
  elements.status.classList.toggle("connected", state.connected);
  elements.meta.textContent = state.connected && state.title
    ? `${state.title}${state.artist ? ` · ${state.artist}` : ""}`
    : "等待连接播放器";
  setButtonIcon(elements.play, state.isPlaying ? "pause" : "play", true);
}

const lyricSession = createLyricSession({
  state,
  request: (snapshot) => invoke("fetch_lyrics", {
    title: snapshot.title,
    artist: snapshot.artist,
    album: snapshot.album,
    durationMs: snapshot.durationMs,
    source: snapshot.source,
    trackId: snapshot.trackId || "",
  }),
  save: saveLyricsCache,
  notify() {
    renderLyricWindow(findActiveLine(state.lines, estimatedPosition() - state.lyricOffsetMs));
    syncSettingsPanel();
    renderDiagnostics();
  },
});

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
    state.canSeek = snapshot.canSeek === true;
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

    if (lyricSession.update(snapshot)) {
      state.lyricOffsetMs = state.offsets[state.trackKey] ?? state.offsets[legacyTrackKey(snapshot)]
        ?? state.offsets[matchingLegacyKeys(state.offsets, snapshot)[0]] ?? 0;
      elements.candidateBrowser.replaceChildren();
      elements.candidateBrowser.classList.remove("is-visible");
      document.querySelector("#song-link-input").value = "";
      syncTrackTools();
    }
    renderDiagnostics();
  } catch (error) {
    state.mediaPollFailures += 1;
    state.lastMediaError = String(error).replace(/^.*?: /, "");
    state.positionMs = estimatedPosition();
    state.syncedAt = performance.now();
    if (state.mediaPollFailures >= 3) {
      lyricSession.invalidate();
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

const seekControl = createSeekControl({
  input: document.querySelector("#timeline-seek"), fill: elements.progress, time: elements.position, formatTime,
  async seek(positionMs, key) {
    if (state.trackKey !== key) return;
    if (!IS_TAURI) {
      state.positionMs = positionMs;
      state.syncedAt = performance.now();
      return;
    }
    const accepted = await invoke("seek_media", { positionMs, source: state.source, title: state.title, artist: state.artist });
    if (!accepted) throw new Error("播放器未接受进度跳转，请在音乐软件内调整");
    setTimeout(pollMedia, 160);
  },
  error(reason) { showToast(String(reason?.message || reason).replace(/^Error: /, "")); },
});

function animationFrame() {
  let position = estimatedPosition();
  if (!IS_TAURI && state.durationMs > 0 && position >= state.durationMs) {
    position %= state.durationMs;
    state.positionMs = position;
    state.syncedAt = performance.now();
  }
  elements.duration.textContent = formatTime(state.durationMs);
  seekControl.update({ key: state.trackKey, positionMs: position, durationMs: state.durationMs,
    enabled: state.connected && state.durationMs > 0 && (!IS_TAURI || state.canSeek === true) && !state.locked });

  if (state.connected && state.lyricStatus === "ready") {
    const lyricPosition = position - state.lyricOffsetMs;
    const activeIndex = findActiveLine(state.lines, lyricPosition);
    if (activeIndex !== state.activeIndex) {
      state.activeIndex = activeIndex;
      renderLyricWindow(activeIndex);
    }
    lyricView.update(lyricPosition, state.durationMs);
  }
  requestAnimationFrame(animationFrame);
}

document.querySelectorAll("[data-media-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!IS_TAURI) {
      const action = button.dataset.mediaAction;
      const position = estimatedPosition();
      state.positionMs = action === "next" ? (Math.floor(position / 4000) + 1) * 4000 % state.durationMs
        : action === "previous" ? Math.max(0, (Math.floor(position / 4000) - 1) * 4000) : position;
      if (action === "toggle") state.isPlaying = !state.isPlaying;
      state.syncedAt = performance.now();
      updateConnectionUi();
      return;
    }
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
  if (event.button === 0 && IS_TAURI && !state.locked && !event.target.closest("button, input")) {
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
document.querySelector("#settings-close-button").addEventListener("click", () => {
  setSettingsOpen(false);
  elements.settings.focus();
});

document.querySelector("#settings-back-button").addEventListener("click", (event) => {
  showSettingsPage("home", document.querySelector(`[data-settings-tab="${event.currentTarget.dataset.from}"]`));
});

for (const tab of document.querySelectorAll("[data-settings-tab]")) {
  tab.addEventListener("click", () => showSettingsPage(tab.dataset.settingsTab));
}

for (const input of settingInputs) {
  input.addEventListener("input", () => {
    updateSettingValue(input.dataset.setting, input.value);
    if (input.dataset.setting === "translationMode" && input.value === "bilingual"
      && needsTranslationRefresh(state.lyricMatch)) lyricSession.retry();
  });
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

function refreshDisplayProfiles(selected = elements.personalProfile.value) {
  elements.personalProfile.replaceChildren(new Option("选择个人方案", ""));
  for (const profile of state.displayProfiles) elements.personalProfile.append(new Option(profile.name, profile.id));
  elements.personalProfile.value = selected;
  const hasSelection = state.displayProfiles.some((profile) => profile.id === elements.personalProfile.value);
  for (const action of ["apply", "rename", "delete"]) document.querySelector(`#profile-${action}-button`).disabled = !hasSelection;
  document.querySelector("#profile-count").textContent = `${state.displayProfiles.length} / 20`;
}

function saveDisplayProfiles(selected) {
  localStorage.setItem(DISPLAY_PROFILES_KEY, JSON.stringify(state.displayProfiles));
  persistNativePreferences();
  refreshDisplayProfiles(selected);
}

elements.personalProfile.addEventListener("change", () => {
  const profile = state.displayProfiles.find((item) => item.id === elements.personalProfile.value);
  elements.profileName.value = profile?.name || "";
  refreshDisplayProfiles();
});

document.querySelector("#profile-save-button").addEventListener("click", () => {
  const name = elements.profileName.value.trim();
  if (!name) { elements.profileName.focus(); showToast("先给显示方案起个名字"); return; }
  const existing = state.displayProfiles.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!existing && state.displayProfiles.length >= 20) { showToast("最多保存 20 个方案，可以先导出备份再整理"); return; }
  const profile = { id: existing?.id || crypto.randomUUID(), name, settings: sanitizeDisplaySettings(state.display) };
  state.displayProfiles = existing ? state.displayProfiles.map((item) => item.id === existing.id ? profile : item) : [...state.displayProfiles, profile];
  saveDisplayProfiles(profile.id);
  showToast(`已${existing ? "更新" : "保存"}「${name}」`);
});

document.querySelector("#profile-apply-button").addEventListener("click", () => {
  const profile = state.displayProfiles.find((item) => item.id === elements.personalProfile.value);
  if (!profile) return;
  state.display = sanitizeDisplaySettings(profile.settings);
  saveDisplaySettings();
  applyDisplaySettings();
  showToast(`已应用「${profile.name}」`);
});

document.querySelector("#profile-rename-button").addEventListener("click", () => {
  const profile = state.displayProfiles.find((item) => item.id === elements.personalProfile.value);
  if (!profile) return;
  const name = elements.profileName.value.trim();
  if (!name) { elements.profileName.focus(); showToast("请输入新的方案名称"); return; }
  if (state.displayProfiles.some((item) => item.id !== profile.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    showToast("这个方案名称已被使用"); return;
  }
  profile.name = name;
  saveDisplayProfiles(profile.id);
  showToast("方案已重命名");
});

document.querySelector("#profile-delete-button").addEventListener("click", () => {
  const profile = state.displayProfiles.find((item) => item.id === elements.personalProfile.value);
  if (!profile) return;
  state.displayProfiles = state.displayProfiles.filter((item) => item.id !== profile.id);
  elements.profileName.value = "";
  saveDisplayProfiles("");
  showToast(`已删除「${profile.name}」，当前显示样式保留`);
});

document.querySelector("#profile-export-button").addEventListener("click", async () => {
  const contents = displayBackup(state.display, state.displayProfiles);
  try {
    if (IS_TAURI) {
      if (!(await invoke("save_display_backup", { contents }))) return;
    } else {
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "RiverXILee-display-backup.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
    showToast("显示备份已导出");
  } catch (error) { showToast(`导出失败：${error}`, 4_000); }
});

document.querySelector("#profile-import-button").addEventListener("click", () => document.querySelector("#profile-file-input").click());
document.querySelector("#profile-file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 1_048_576) throw new Error("请选择不超过 1 MB 的显示备份");
    const backup = parseDisplayBackup(await file.text());
    state.displayProfiles = mergeDisplayProfiles(state.displayProfiles, backup.profiles);
    state.display = backup.display;
    saveDisplaySettings();
    saveDisplayProfiles("");
    elements.profileName.value = "";
    applyDisplaySettings();
    showToast("已恢复显示样式并合并方案；最多保留 20 个", 3_500);
  } catch (error) { showToast(error.message, 4_000); }
});

let melodyClicks = 0;
let lastMelodyClick = 0;
let melodyTimer;
let melodyReturnFocus;
const melodyDialog = document.querySelector("#melody-dialog");

function closeMelody() {
  clearTimeout(melodyTimer);
  if (melodyDialog.open) melodyDialog.close();
}

function openMelody() {
  if (melodyDialog.open) return;
  melodyReturnFocus = document.activeElement;
  state.discoveredMelody = true;
  localStorage.setItem(MELODY_KEY, "true");
  persistNativePreferences();
  document.querySelector("#melody-replay").hidden = false;
  document.querySelector("#melody-discovery").textContent = "你发现了一段隐藏的旋律。";
  melodyDialog.showModal();
  melodyTimer = setTimeout(closeMelody, 3_200);
}

document.querySelector("#about-mark").addEventListener("click", () => {
  const now = performance.now();
  melodyClicks = now - lastMelodyClick < 2_000 ? melodyClicks + 1 : 1;
  lastMelodyClick = now;
  if (melodyClicks >= 7) { melodyClicks = 0; openMelody(); }
});
document.querySelector("#melody-replay").addEventListener("click", openMelody);
melodyDialog.addEventListener("click", closeMelody);
melodyDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeMelody(); });
melodyDialog.addEventListener("close", () => {
  clearTimeout(melodyTimer);
  if (melodyReturnFocus?.isConnected) melodyReturnFocus.focus({ preventScroll: true });
});
document.addEventListener("visibilitychange", () => { if (document.hidden) closeMelody(); });

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

const neteaseControlButton = document.querySelector("#netease-control-button");
const neteaseControlStatus = document.querySelector("#netease-control-status");
let neteaseNeedsRestart = false;
let neteaseControlBusy = false;
function paintNeteaseControl(status) {
  neteaseNeedsRestart = status.needsRestart;
  neteaseControlButton.textContent = status.needsRestart ? "关闭并恢复普通模式" : "临时启用";
  neteaseControlStatus.textContent = status.enabled
    ? "本次已启用 · 退出桌面歌词不会关闭网易云调试端口"
    : status.needsRestart ? "尚未就绪 · 请恢复普通模式后重试" : "默认关闭 · 开启前需两次确认并重启网易云";
}
async function refreshNeteaseControl() {
  if (!IS_TAURI || neteaseControlBusy) return;
  try { paintNeteaseControl(await invoke("netease_control_status")); }
  catch { neteaseControlStatus.textContent = "暂时无法读取增强控制状态，请稍后重试"; }
}
neteaseControlButton.disabled = !IS_TAURI;
neteaseControlButton.addEventListener("click", async () => {
  if (!IS_TAURI || neteaseControlBusy) return;
  neteaseControlBusy = true;
  neteaseControlButton.disabled = true;
  neteaseControlStatus.textContent = "等待确认或重启网易云，请稍候…";
  try {
    paintNeteaseControl(await invoke("configure_netease_control", { enable: !neteaseNeedsRestart }));
    await pollMedia();
  } catch (error) {
    await refreshNeteaseControlAfterError();
    neteaseControlStatus.textContent = String(error);
    showToast("网易云增强控制未完成，请查看播放与同步中的说明");
  } finally {
    neteaseControlBusy = false;
    neteaseControlButton.disabled = false;
  }
});
async function refreshNeteaseControlAfterError() {
  try { paintNeteaseControl(await invoke("netease_control_status")); } catch { /* Keep the last known restore action. */ }
}
refreshNeteaseControl();
elements.settings.addEventListener("click", refreshNeteaseControl);

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
  if (state.lyricStatus === "error") lyricSession.retry();
  showToast("正在重新读取播放器进度");
});

function candidateDuration(milliseconds) {
  return milliseconds > 0 ? formatTime(milliseconds) : "时长未知";
}

async function chooseLyricsCandidate(candidate, button, trackKey) {
  if (!state.trackKey || trackKey !== state.trackKey) return;
  button.disabled = true;
  try {
    const applied = await lyricSession.bind(() => invoke("fetch_lyrics_candidate", {
      provider: candidate.provider,
      id: candidate.id,
      title: candidate.title,
      artist: candidate.artist,
    }));
    if (!applied) {
      if (trackKey === state.trackKey) showToast(state.lyricMessage || "歌词选择未完成", 4_000);
      return;
    }
    elements.candidateBrowser.replaceChildren();
    elements.candidateBrowser.classList.remove("is-visible");
    renderLyricWindow(findActiveLine(state.lines, estimatedPosition() - state.lyricOffsetMs));
    showToast(`已改用 ${candidate.title} · ${candidate.artist}`);
  } catch (error) {
    showToast(String(error).replace(/^.*?: /, ""), 4_000);
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#find-version-button").addEventListener("click", async (event) => {
  if (!state.connected || !state.title) {
    showToast("播放歌曲后才能搜索歌词版本");
    return;
  }
  const button = event.currentTarget;
  const trackKey = state.trackKey;
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
    if (trackKey !== state.trackKey) return;
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
      item.addEventListener("click", () => chooseLyricsCandidate(candidate, item, trackKey));
      elements.candidateBrowser.append(item);
    }
  } catch {
    if (trackKey === state.trackKey) elements.candidateBrowser.textContent = "搜索失败，请检查网络后重试";
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

document.querySelector("#song-link-button").addEventListener("click", async (event) => {
  if (!state.trackKey) { showToast("播放歌曲后才能绑定歌词"); return; }
  const button = event.currentTarget;
  const key = state.trackKey;
  try {
    const candidate = parseSongLink(document.querySelector("#song-link-input").value);
    const title = state.title;
    const artist = state.artist;
    button.disabled = true;
    button.textContent = "获取中…";
    const applied = await lyricSession.bind(() => invoke("fetch_lyrics_candidate", { ...candidate, title, artist }));
    if (key === state.trackKey) showToast(applied ? "指定歌词已绑定到当前歌曲" : state.lyricMessage || "未能获取指定歌词", 4_000);
  } catch (error) { showToast(error.message, 4_000); }
  finally { button.disabled = false; button.textContent = "获取并绑定"; }
});

let lyricImportTrackKey = "";
document.querySelector("#lyric-import-button").addEventListener("click", () => {
  if (!state.trackKey) { showToast("播放歌曲后才能导入并绑定歌词"); return; }
  lyricImportTrackKey = state.trackKey;
  document.querySelector("#lyric-file-input").click();
});
document.querySelector("#lyric-file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.trackKey) return;
  if (lyricImportTrackKey !== state.trackKey) { showToast("歌曲已经切换，请为当前歌曲重新选择歌词文件"); return; }
  const key = state.trackKey;
  const title = state.title;
  const artist = state.artist;
  const applied = await lyricSession.bind(async () => ({
    lrc: await readLyricFile(file), songMid: `local:${file.name}`, matchedTitle: title, matchedArtist: artist,
  }));
  if (key === state.trackKey) showToast(applied ? "歌词文件已绑定到当前歌曲" : state.lyricMessage || "歌词导入失败", 4_000);
});
document.querySelector("#lyric-auto-button").addEventListener("click", () => {
  if (!state.trackKey) return;
  delete state.lyricCache[state.trackKey];
  for (const key of matchingLegacyKeys(state.lyricCache, {
    source: state.source, title: state.title, artist: state.artist, album: state.album, durationMs: state.durationMs,
  })) delete state.lyricCache[key];
  saveLyricsCache();
  lyricSession.retry();
  showToast("正在重新自动匹配当前歌曲");
});
document.querySelector("#lyric-instrumental-button").addEventListener("click", async () => {
  if (!state.trackKey) { showToast("播放歌曲后才能标记纯音乐"); return; }
  const title = state.title, artist = state.artist;
  const applied = await lyricSession.bind(async () => ({ lrc: "", instrumental: true,
    songMid: "manual:instrumental", matchedTitle: title, matchedArtist: artist }));
  if (applied) { syncTrackTools(); showToast("本首已标记为纯音乐；可用「恢复自动匹配」撤销"); }
});

window.addEventListener("online", () => { if (state.lyricStatus === "error") lyricSession.retry(); });

elements.autostart.addEventListener("change", async () => {
  if (!IS_TAURI || IS_GLASS_PREVIEW) return;
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
const shortcutClearButtons = [...document.querySelectorAll("[data-clear-shortcut]")];
let unavailableShortcutActions = new Set();

function syncShortcutInputs() {
  for (const input of shortcutInputs) {
    input.value = state.shortcuts[input.dataset.shortcut];
    const unavailable = Boolean(input.value) && unavailableShortcutActions.has(input.dataset.shortcut);
    input.classList.toggle("is-unavailable", unavailable);
    input.title = unavailable ? "这个组合键已被其他软件占用，请点击后重新设置" : "点击后直接按下新的组合键";
  }
  for (const button of shortcutClearButtons) button.disabled = !state.shortcuts[button.dataset.clearShortcut];
  const lockShortcut = state.shortcuts.toggleLock;
  elements.lock.title = IS_GLASS_PREVIEW ? "设计预览不启用鼠标穿透锁定" : lockShortcut && !unavailableShortcutActions.has("toggleLock") ? `锁定 · ${lockShortcut} 解锁` : "锁定 · 从系统托盘解锁";
}

async function registerShortcuts({ announce = false, changedAction = "" } = {}) {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(state.shortcuts));
  persistNativePreferences();
  syncShortcutInputs();
  if (!IS_TAURI || IS_GLASS_PREVIEW) return true;
  try {
    const shortcuts = Object.fromEntries(Object.entries(state.shortcuts).filter(([, value]) => value));
    const unavailable = await invoke("set_global_shortcuts", { shortcuts });
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

let changingShortcut = false;

async function changeShortcuts(next, changedAction = "") {
  if (changingShortcut) return;
  changingShortcut = true;
  const previous = state.shortcuts;
  state.shortcuts = next;
  try {
    if (!(await registerShortcuts({ announce: true, changedAction }))) {
      state.shortcuts = previous;
      await registerShortcuts();
    }
  } finally {
    changingShortcut = false;
  }
}

for (const button of shortcutClearButtons) {
  button.addEventListener("click", () => {
    const action = button.dataset.clearShortcut;
    document.querySelector(`#shortcut-${action}`).focus();
    changeShortcuts({ ...state.shortcuts, [action]: "" }, action);
  });
}

for (const input of shortcutInputs) {
  input.addEventListener("focus", () => input.classList.add("is-recording"));
  input.addEventListener("blur", () => input.classList.remove("is-recording"));
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Tab") return;
    if (event.key === "Escape") { input.blur(); return; }
    event.preventDefault();
    const shortcut = shortcutFromKeyboardEvent(event);
    if (!shortcut) return;
    if (!shortcut.includes("+") && !/^F(?:[1-9]|1[0-2])$/.test(shortcut)) {
      showToast("请至少搭配 Ctrl、Alt、Shift 或 Win 键");
      return;
    }
    const action = input.dataset.shortcut;
    const next = { ...state.shortcuts, [action]: shortcut };
    const duplicate = duplicateShortcut(next, action);
    if (duplicate) {
      showToast("这个组合键已经用于其他功能");
      syncShortcutInputs();
      return;
    }
    await changeShortcuts(next, action);
    input.blur();
  });
}

document.querySelector("#shortcuts-reset-button").addEventListener("click", () => {
  changeShortcuts({ ...DEFAULT_SHORTCUTS });
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
  elements.updateTitle.textContent = `下载 v${availableUpdate.latestVersion}`;
  elements.updateDownload.textContent = "正在连接…";
  elements.updateDetail.textContent = "正在确认版本并连接下载服务器";
  elements.updateProgress.setAttribute("aria-hidden", "false");
  try {
    downloadedInstallerPath = await invoke("download_update", {
      expectedVersion: availableUpdate.latestVersion,
    });
    elements.updateTitle.textContent = `v${availableUpdate.latestVersion} 已准备好`;
    elements.updateDetail.textContent = "SHA-256 校验通过 · 点击后覆盖安装并保留配置";
    elements.updateDownload.textContent = "立即安装";
  } catch (error) {
    elements.updateTitle.textContent = "更新未完成";
    elements.updateDetail.textContent = updateErrorMessage(error);
    elements.updateDetail.title = elements.updateDetail.textContent;
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
  if (onboarding.active && locked) {
    showToast("完成或跳过新手引导后，再开启鼠标穿透锁定");
    return;
  }
  if (IS_GLASS_PREVIEW && locked) {
    showToast("设计预览未注册快捷键，暂不启用鼠标穿透锁定");
    return;
  }
  setSettingsOpen(false);
  state.locked = locked;
  elements.shell.classList.toggle("is-locked", locked);
  if (IS_TAURI) await invoke("set_click_through", { enabled: locked });
  const shortcut = state.shortcuts.toggleLock;
  const unlock = shortcut && !unavailableShortcutActions.has("toggleLock") ? `按 ${shortcut} 解锁` : "从系统托盘选择「锁定或解锁」";
  showToast(locked ? `已锁定，${unlock}` : "窗口已解锁", locked ? 4_000 : 2_600);
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
    if (state.lyricStatus === "error") lyricSession.retry();
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
    if (!updateDownloadInFlight) return;
    const view = updateProgressView(event.payload);
    elements.updateProgress.style.setProperty("--update-progress", String(view.percent / 100));
    elements.updateDownload.textContent = view.button;
    elements.updateDetail.textContent = view.detail;
    elements.updateDetail.title = view.detail;
  });
  listen("single-instance-activated", () => {
    state.visible = true;
    showToast("RiverXILee桌面歌词已经在运行", 3_500);
  });
  registerShortcuts();
  pollMedia();
  refreshMediaSources();
  if (!IS_GLASS_PREVIEW) isAutostartEnabled().then((enabled) => { elements.autostart.checked = enabled; }).catch(() => {});
  setInterval(pollMedia, 650);
  setInterval(refreshMediaSources, 4_000);
  setTimeout(checkForUpdates, 3_500);
  setInterval(checkForUpdates, 6 * 60 * 60 * 1_000);
} else {
  state.connected = true;
  document.body.classList.add("browser-preview");
  const previewMotion = new URLSearchParams(location.search).get("motion");
  if (["soft", "flow", "none"].includes(previewMotion)) state.display.motionEffect = previewMotion;
  state.title = "歌词动效预览";
  state.artist = "原创演示文案 · 无音频";
  state.album = "开发预览";
  state.isPlaying = true;
  state.durationMs = 32_000;
  state.lines = parseLrc(PREVIEW_LRC);
  state.lyricStatus = "ready";
  state.trackKey = "preview";
  lyricSession.update({ ...state, source: "preview", trackId: "" });
  await lyricSession.bind(async () => ({ lrc: PREVIEW_LRC, songMid: "preview", matchedTitle: state.title, matchedArtist: state.artist }));
  updateConnectionUi();
}

loadSystemFonts();
applyDisplaySettings({ rerender: false });
syncShortcutInputs();
syncTrackTools();
refreshDisplayProfiles();
setSettingsOpen(false);
renderLyricWindow(-1);
requestAnimationFrame(animationFrame);

let tourPreviousPage = null;
const onboarding = createOnboarding({
  prepare(page) {
    if (tourPreviousPage === null) tourPreviousPage = state.settingsOpen
      ? document.querySelector("#settings-back-button").dataset.from || "home" : "closed";
    setSettingsOpen(Boolean(page));
    if (page) showSettingsPage(page);
  },
  restore() {
    setSettingsOpen(tourPreviousPage !== "closed");
    if (tourPreviousPage !== "closed") showSettingsPage(tourPreviousPage || "home");
    tourPreviousPage = null;
  },
  dismiss() {
    state.onboardingDismissed = true;
    try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch { /* Native preferences still retain this choice. */ }
    persistNativePreferences();
  },
  lockDescription() {
    if (IS_GLASS_PREVIEW) return "正式版可锁定窗口并开启鼠标穿透，让歌词留在桌面上。这份独立设计预览未注册全局快捷键，因此暂不启用锁定。";
    const shortcut = state.shortcuts.toggleLock;
    const unlock = shortcut && !unavailableShortcutActions.has("toggleLock") ? `按 ${shortcut} 解锁，也可从系统托盘解锁。` : "从系统托盘选择「锁定或解锁」返回操作。";
    return `锁定后，点击会穿过歌词窗口。${unlock}快捷键可在设置中自定义或清除。引导期间不会启用锁定。`;
  },
});
document.querySelector("#onboarding-replay-button").addEventListener("click", () => onboarding.start());
if (!state.onboardingDismissed) setTimeout(() => {
  if (!state.onboardingDismissed && state.visible && !state.locked) onboarding.start();
}, 3_000);

const cleanupGlass = initLiquidGlass([
  document.querySelector("#control-bar"), elements.settingsPanel, elements.updateBanner,
  elements.toast, document.querySelector("#font-picker-popup"), onboarding.card,
]);
window.addEventListener("pagehide", cleanupGlass, { once: true });
if (import.meta.hot) import.meta.hot.dispose(cleanupGlass);

if (IS_GLASS_PREVIEW) {
  elements.autostart.disabled = true;
  elements.lock.disabled = true;
  elements.autostart.closest("label").title = "独立设计预览不修改开机启动";
  document.querySelector("#update-check-button").disabled = true;
  document.querySelector("#update-check-button").title = "独立设计预览不接管正式更新";
  for (const input of shortcutInputs) { input.disabled = true; input.title = "设计预览不注册全局快捷键"; }
  for (const button of shortcutClearButtons) button.disabled = true;
}
