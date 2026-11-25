import { musicSourceKey } from "./media-sources.js";

export function nativeLyricProvider(source) {
  const key = musicSourceKey(source);
  if (key === "qqmusic") return "qq";
  if (key === "cloudmusic") return "netease";
  if (key === "kugou") return "kugou";
  return "";
}

export function lyricMatchesPlayer(item, track) {
  const id = String(item?.songMid || "");
  if (id.startsWith("local:") || ["manual:instrumental", "metadata:instrumental"].includes(id)) return true;
  const provider = nativeLyricProvider(track.source);
  if (provider === "qq") return id.startsWith("qq:") || /^[a-z0-9]{8,32}$/i.test(id);
  if (provider === "netease") return id.startsWith("netease:");
  if (provider === "kugou") return /^kugou:[a-f0-9]{32}$/i.test(id);
  return false;
}
