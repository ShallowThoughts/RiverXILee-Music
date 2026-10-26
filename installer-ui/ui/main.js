(() => {
"use strict";

const tauriCore = window.__TAURI__?.core;
const tauriEvent = window.__TAURI__?.event;
const isTauri = typeof tauriCore?.invoke === "function";
const isPreview = ["127.0.0.1", "localhost"].includes(window.location.hostname);
const previewContext = {
  installedVersion: "1.1.1",
  installLocation: "C:\\Users\\RiverXILee\\AppData\\Local\\RiverXILee桌面歌词",
  targetVersion: "1.1.3",
};
const invoke = isTauri
  ? (command, args) => tauriCore.invoke(command, args)
  : isPreview
  ? async (command) => {
      if (command === "get_install_context") return previewContext;
      return undefined;
    }
  : async () => {
      throw new Error("Tauri 桥接没有完成初始化，请重新打开安装程序");
    };

const shell = document.querySelector("#installer-shell");
const currentVersion = document.querySelector("#current-version");
const readyTitle = document.querySelector("#ready-title");
const readyCopy = document.querySelector("#ready-copy");
const installLocation = document.querySelector("#install-location");
const pathPicker = document.querySelector("#path-picker");
const desktopShortcut = document.querySelector("#desktop-shortcut");
const primaryAction = document.querySelector("#primary-action");
const primaryLabel = document.querySelector("#primary-label");
const secondaryAction = document.querySelector("#secondary-action");
const progressNumber = document.querySelector("#progress-number");
const progressTitle = document.querySelector("#progress-title");
const progressDetail = document.querySelector("#progress-detail");
const progressFill = document.querySelector("#progress-fill");
const errorDetail = document.querySelector("#error-detail");

let installContext = null;
let installing = false;

function setState(state) {
  shell.dataset.state = state;
  document.querySelectorAll("[data-stage]").forEach((panel) => {
    panel.setAttribute("aria-hidden", String(panel.dataset.stage !== state));
  });
}

function setProgress(percent, title, detail) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  progressNumber.textContent = `${value}%`;
  progressFill.style.transform = `scaleX(${value / 100})`;
  if (title) progressTitle.textContent = title;
  if (detail) progressDetail.textContent = detail;
}

function showBridgeError(error) {
  setState("error");
  errorDetail.textContent = `安装中心操作失败：${String(error).replace(/^.*?: /, "")}`;
  primaryLabel.textContent = "重新检测";
  secondaryAction.textContent = "退出";
}

async function loadContext() {
  try {
    installContext = await invoke("get_install_context");
    installLocation.value = installContext.installLocation;
    if (installContext.installedVersion) {
      currentVersion.textContent = `v${installContext.installedVersion}`;
      readyTitle.textContent = "准备覆盖更新";
      readyCopy.textContent = `将当前版本升级到 v${installContext.targetVersion}，安装结束后只保留最新版。`;
      primaryLabel.textContent = "开始覆盖更新";
    } else {
      currentVersion.textContent = "首次安装";
      readyTitle.textContent = "准备进入你的音乐空间";
      readyCopy.textContent = `安装 RiverXILee桌面歌词 v${installContext.targetVersion}，随后即可自动连接音乐平台。`;
      primaryLabel.textContent = "开始安装";
    }
  } catch (error) {
    setState("error");
    errorDetail.textContent = String(error);
    primaryLabel.textContent = "重新检测";
  }
}

if (isTauri && typeof tauriEvent?.listen === "function") {
  tauriEvent.listen("install-progress", ({ payload }) => {
    setProgress(payload.percent, payload.title, payload.detail);
  }).catch(showBridgeError);
}

pathPicker.addEventListener("click", async () => {
  pathPicker.disabled = true;
  try {
    const selectedPath = await invoke("select_install_location", {
      currentLocation: installLocation.value.trim() || null,
    });
    if (selectedPath) installLocation.value = selectedPath;
  } catch (error) {
    showBridgeError(error);
  } finally {
    pathPicker.disabled = false;
  }
});

primaryAction.addEventListener("click", async () => {
  const state = shell.dataset.state;
  if (state === "complete") {
    primaryAction.disabled = true;
    primaryLabel.textContent = "正在启动…";
    await invoke("launch_installed_app").catch(() => {});
    await invoke("close_installer");
    return;
  }
  if (state === "error") {
    setState("ready");
    await loadContext();
    return;
  }
  if (installing) return;

  installing = true;
  primaryAction.disabled = true;
  secondaryAction.disabled = true;
  primaryLabel.textContent = "正在安装…";
  secondaryAction.textContent = "请稍候";
  setState("progress");
  setProgress(4, "正在准备更新", "正在检查安装位置与当前运行状态。");
  try {
    await invoke("install_product", {
      installLocation: installLocation.value.trim(),
      createDesktopShortcut: desktopShortcut.checked,
    });
    setState("complete");
    primaryLabel.textContent = "启动桌面歌词";
    secondaryAction.textContent = "稍后打开";
  } catch (error) {
    setState("error");
    errorDetail.textContent = String(error).replace(/^.*?: /, "");
    primaryLabel.textContent = "重新尝试";
    secondaryAction.textContent = "退出";
  } finally {
    installing = false;
    primaryAction.disabled = false;
    secondaryAction.disabled = false;
  }
});

secondaryAction.addEventListener("click", () => {
  invoke("close_installer").catch(showBridgeError);
});
document.querySelector("#close-button").addEventListener("click", async () => {
  if (!installing) await invoke("close_installer").catch(showBridgeError);
});
document.querySelector("#minimize-button").addEventListener("click", () => {
  invoke("minimize_installer").catch(showBridgeError);
});

const previewState = isTauri
  ? "ready"
  : new URLSearchParams(window.location.search).get("state") || "ready";

setState(previewState);
loadContext().then(() => {
  if (!isTauri && previewState === "progress") {
    setProgress(68, "正在覆盖安装", "正在替换程序文件和 Windows 安装记录。");
    primaryLabel.textContent = "正在安装…";
    secondaryAction.textContent = "请稍候";
    primaryAction.disabled = true;
    secondaryAction.disabled = true;
  }
  if (!isTauri && previewState === "complete") {
    primaryLabel.textContent = "启动桌面歌词";
    secondaryAction.textContent = "稍后打开";
  }
  if (!isTauri && previewState === "error") {
    errorDetail.textContent = "安装目录暂时无法写入，请换一个位置后重试。";
    primaryLabel.textContent = "重新尝试";
  }
});

})();
