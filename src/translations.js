import { parseLrc } from "./lyrics.js";

export function needsTranslationRefresh(match) {
  if (!match || match.manuallySelected || match.instrumental) return false;
  const id = String(match.songMid ?? "");
  const qq = id.startsWith("qq:") || /^[a-z0-9]{8,32}$/i.test(id);
  return !Object.hasOwn(match, "translationLrc") || (qq && match.translationRevision !== 1);
}

export function translationStatus({ display, lyricStatus, lyricMatch, lines }) {
  if (display.translationMode !== "bilingual") return "仅使用当前歌词版本自带的译文，无译文时保留原文";
  if (["loading", "recovering"].includes(lyricStatus)) return "正在获取当前歌词版本与平台译文…";
  if (lines.some((line) => line.translation)) return "已加载平台译文，随原文同步显示";
  if (lyricMatch?.translationLrc) return "已取得平台译文，暂未与原文时间轴对齐";
  return "本次未取得平台译文，暂时显示原文；可在播放与同步中重新获取歌词";
}

// Translations belong to the selected provider/song result, never another search hit.
export function attachTranslations(lines, translationLrc) {
  const translations = typeof translationLrc === "string" ? parseLrc(translationLrc) : [];
  if (!translations.length) return lines;
  let cursor = 0;
  return lines.map((line) => {
    while (cursor + 1 < translations.length && translations[cursor + 1].timeMs <= line.timeMs) cursor++;
    const match = [translations[cursor], translations[cursor + 1]].filter(Boolean)
      .sort((a, b) => Math.abs(a.timeMs - line.timeMs) - Math.abs(b.timeMs - line.timeMs))[0];
    if (Math.abs(match.timeMs - line.timeMs) > 750 || /^\/{2,}$/.test(match.text.trim())
      || match.text.trim() === line.text.trim()) return line;
    return { ...line, translation: match.text };
  });
}
