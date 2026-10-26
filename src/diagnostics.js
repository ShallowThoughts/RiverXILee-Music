function formatMilliseconds(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function lyricProvider(match) {
  const id = String(match?.songMid ?? "").toLowerCase();
  if (id.startsWith("netease:")) return "网易云音乐";
  if (id.startsWith("qq:")) return "QQ 音乐";
  if (id.startsWith("local:")) return "本地歌词文件";
  return match ? "在线匹配" : "尚未匹配";
}

export function lyricTimingType(lines) {
  return lines.some((line) => line.words?.length) ? "逐字歌词" : lines.length ? "普通 LRC" : "暂无歌词";
}

export function buildDiagnosticReport(data) {
  const sessions = data.availableSources?.length
    ? data.availableSources.map((item) => `${data.platformName(item.source)}（${item.isPlaying ? "播放中" : "已暂停"}）`).join("、")
    : "未检测到";
  const status = data.connected ? (data.isPlaying ? "正在播放" : "已暂停") : "未连接";
  const offset = Number(data.lyricOffsetMs || 0);
  const drift = Number(data.syncDriftMs || 0);
  return [
    `RiverXILee桌面歌词 v${data.version}`,
    `播放器状态：${status}`,
    `当前播放器：${data.source ? data.platformName(data.source) : "无"}`,
    `检测到的播放器：${sessions}`,
    `歌曲：${data.title || "未知"}`,
    `歌手：${data.artist || "未知"}`,
    `专辑：${data.album || "未知"}`,
    `播放进度：${formatMilliseconds(data.positionMs)} / ${formatMilliseconds(data.durationMs)}`,
    `歌词状态：${data.lyricStatus || "idle"}`,
    `歌词请求次数：${data.lyricAttempts || 0}`,
    `歌词来源：${lyricProvider(data.lyricMatch)}`,
    `歌词格式：${lyricTimingType(data.lines || [])}`,
    `缓存状态：${data.lyricFromCache ? "正在使用缓存" : "在线结果或尚未缓存"}`,
    `单曲偏移：${offset > 0 ? "+" : ""}${offset} ms`,
    `同步误差：${drift > 0 ? "+" : ""}${drift} ms`,
    `自动纠偏：${data.syncCorrection || "steady"}`,
    `连续读取失败：${data.mediaPollFailures || 0}`,
    `最近错误：${data.lastMediaError || data.lyricMessage || "无"}`,
  ].join("\n");
}
