export function updateErrorMessage(error, fallback = "更新失败，请稍后重试或手动下载") {
  const message = (error instanceof Error ? error.message : String(error ?? "")).replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

export function updateProgressView(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const attempt = Math.max(1, Math.min(3, Number(progress.attempt) || 1));
  if (progress.status === "retrying") {
    return { percent: 0, button: "正在重试…", detail: `下载中断，准备第 ${attempt} / 3 次尝试` };
  }
  if (progress.status === "connecting") {
    return { percent: 0, button: "正在连接…", detail: `正在连接下载服务器 · 第 ${attempt} / 3 次尝试` };
  }
  if (progress.status === "verifying") {
    return { percent: 100, button: "正在校验…", detail: "下载完成，正在验证安装包完整性" };
  }
  const downloaded = (Math.max(0, Number(progress.downloadedBytes) || 0) / 1024 / 1024).toFixed(1);
  const total = Number(progress.totalBytes) > 0 ? (Number(progress.totalBytes) / 1024 / 1024).toFixed(1) : "--";
  return { percent, button: `下载中 ${percent}%`, detail: `${downloaded} / ${total} MB · 下载完成后自动校验` };
}
