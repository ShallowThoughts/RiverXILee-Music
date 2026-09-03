import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { findActiveLine, lineProgress, parseLrc, visibleLineIndices } from "./lyrics.js";
import {
  DEFAULT_DISPLAY_SETTINGS,
  hexToRgb,
  rgbToHex,
  sanitizeDisplaySettings,
} from "./settings.js";
import "./styles.css";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const DISPLAY_SETTINGS_KEY = "riverxilee-desktop-lyrics.display.v1";
const PREVIEW_LRC = `[00:00.00]RiverXILee桌面歌词
[00:05.00]让音乐留在画面中央
[00:10.00]透明 · 安静 · 同步
[00:15.00]打开任意音乐平台即可自动识别`;

function loadDisplaySettings() {
  try {
    return sanitizeDisplaySettings(JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) ?? "{}"));
  } catch {
    return sanitizeDisplaySettings();
  }
}

const state = {
  connected: false,
  title: "",
  artist: "",
  album: "",
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  syncedAt: performance.now(),
  lines: [],
  activeIndex: Number.NaN,
  lyricStatus: "idle",
  lyricMessage: "",
  trackKey: "",
  fetchToken: 0,
  alwaysOnTop: true,
  fullscreen: false,
  locked: false,
  settingsOpen: false,
  display: loadDisplaySettings(),
};

document.querySelector("#app").innerHTML = `
  <main class="overlay-shell" id="overlay-shell">
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

      <div class="settings-footer">
        <span>逐字效果会根据当前歌词行的时间平滑推进</span>
        <button class="text-button" id="settings-reset-button" type="button">恢复默认</button>
      </div>
    </aside>

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
  lock: document.querySelector("#lock-button"),
  toast: document.querySelector("#toast"),
  colorPicker: document.querySelector("#lyric-color-picker"),
};

const settingInputs = [...document.querySelectorAll("[data-setting]")];
const colorInputs = [...document.querySelectorAll("[data-color-channel]")];

function saveDisplaySettings() {
  localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(state.display));
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
  const elapsed = state.isPlaying ? performance.now() - state.syncedAt : 0;
  return Math.min(state.durationMs || Number.MAX_SAFE_INTEGER, state.positionMs + elapsed);
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
      const baseText = document.createElement("span");
      baseText.className = "current-text-base";
      baseText.textContent = state.lines[index].text;
      const highlightedText = document.createElement("span");
      highlightedText.className = "current-text-highlight";
      highlightedText.textContent = state.lines[index].text;
      highlightedText.setAttribute("aria-hidden", "true");
      text.append(baseText, highlightedText);
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
  state.lyricStatus = "loading";
  state.lyricMessage = "";
  state.lines = [];
  state.activeIndex = Number.NaN;
  renderLyricWindow(-1);

  try {
    const result = await invoke("fetch_lyrics", {
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      durationMs: snapshot.durationMs,
    });
    if (token !== state.fetchToken || trackKey !== state.trackKey) return;
    state.lines = parseLrc(result.lrc);
    if (!state.lines.length) throw new Error("歌词没有可用的时间标签");
    state.lyricStatus = "ready";
    state.activeIndex = Number.NaN;
  } catch (error) {
    if (token !== state.fetchToken || trackKey !== state.trackKey) return;
    state.lyricStatus = "error";
    state.lyricMessage = String(error).replace(/^.*?: /, "");
    renderLyricWindow(-1);
  }
}

async function pollMedia() {
  if (!IS_TAURI) return;
  try {
    const snapshot = await invoke("get_media_snapshot");
    state.connected = snapshot.connected;
    state.title = snapshot.title;
    state.artist = snapshot.artist;
    state.album = snapshot.album;
    state.isPlaying = snapshot.isPlaying;
    state.positionMs = snapshot.positionMs;
    state.durationMs = snapshot.durationMs;
    state.syncedAt = performance.now();
    updateConnectionUi();

    const trackKey = snapshot.connected && snapshot.title
      ? `${snapshot.title}\u0000${snapshot.artist}\u0000${snapshot.durationMs}`
      : "";
    if (trackKey !== state.trackKey) {
      state.trackKey = trackKey;
      state.lines = [];
      state.activeIndex = Number.NaN;
      state.lyricStatus = "idle";
      if (trackKey) loadLyrics(snapshot, trackKey);
      else renderLyricWindow(-1);
    }
  } catch (error) {
    state.connected = false;
    updateConnectionUi();
    setStageMessage("暂时无法读取播放器", "正在自动重连");
  }
}

function animationFrame() {
  const position = estimatedPosition();
  elements.position.textContent = formatTime(position);
  elements.duration.textContent = formatTime(state.durationMs);
  const trackProgress = state.durationMs > 0 ? position / state.durationMs : 0;
  elements.progress.style.transform = `scaleX(${Math.min(1, Math.max(0, trackProgress))})`;

  if (state.lyricStatus === "ready") {
    const activeIndex = findActiveLine(state.lines, position);
    if (activeIndex !== state.activeIndex) {
      state.activeIndex = activeIndex;
      renderLyricWindow(activeIndex);
    }
    const progress = lineProgress(state.lines, activeIndex, position, state.durationMs);
    elements.stack
      .querySelector(".current-text")
      ?.style.setProperty("--karaoke-progress", `${(progress * 100).toFixed(2)}%`);
  }
  requestAnimationFrame(animationFrame);
}

document.querySelectorAll("[data-media-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!IS_TAURI) return;
    button.classList.add("pressed");
    try {
      await invoke("control_media", { action: button.dataset.mediaAction });
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

elements.lock.addEventListener("click", async () => {
  setSettingsOpen(false);
  state.locked = true;
  elements.shell.classList.add("is-locked");
  showToast("已锁定，按 Ctrl + Shift + L 解锁", 4_000);
  if (IS_TAURI) {
    setTimeout(() => invoke("set_click_through", { enabled: true }), 450);
  }
});

document.querySelector("#minimize-button").addEventListener("click", () => {
  if (IS_TAURI) invoke("minimize_window");
});

document.querySelector("#close-button").addEventListener("click", () => {
  if (IS_TAURI) invoke("close_window");
});

if (IS_TAURI) {
  listen("overlay-unlocked", () => {
    state.locked = false;
    elements.shell.classList.remove("is-locked");
    showToast("窗口已解锁");
  });
  pollMedia();
  setInterval(pollMedia, 650);
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
renderLyricWindow(-1);
requestAnimationFrame(animationFrame);
