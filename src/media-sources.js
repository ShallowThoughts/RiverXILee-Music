export function musicSourceKey(source = "") {
  const value = String(source).trim().toLowerCase();
  if (value.includes("cloudmusic")) return "cloudmusic";
  if (value.includes("qqmusic")) return "qqmusic";
  if (value.includes("qishui") || value.includes("sodamusic") || value.includes("汽水音乐")) return "qishuimusic";
  return value;
}

export function platformName(source = "") {
  const value = musicSourceKey(source);
  if (value === "cloudmusic") return "网易云音乐";
  if (value === "qqmusic") return "QQ 音乐";
  if (value === "qishuimusic") return "汽水音乐";
  if (value.includes("kugou")) return "酷狗音乐";
  if (value.includes("kuwo")) return "酷我音乐";
  if (value.includes("spotify")) return "Spotify";
  if (value.includes("applemusic") || value.includes("itunes")) return "Apple Music";
  return source || "未知播放器";
}

export function resolvePreferredSource(preferred, sessions) {
  if (!preferred) return "";
  const exact = sessions.find((item) => item.source.toLowerCase() === preferred.toLowerCase());
  if (exact) return exact.source;
  if (musicSourceKey(preferred) === "qishuimusic") {
    return sessions.find((item) => musicSourceKey(item.source) === "qishuimusic")?.source || preferred;
  }
  return preferred;
}
