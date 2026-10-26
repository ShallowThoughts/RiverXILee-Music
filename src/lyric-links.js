export function parseSongLink(input) {
  const link = String(input).match(/https?:\/\/[^\s<>"“”]+/i)?.[0];
  if (!link) throw new Error("请粘贴网易云或 QQ 音乐的歌曲链接");
  let url;
  try { url = new URL(link); } catch { throw new Error("歌曲链接格式不正确"); }
  if (url.username || url.password) throw new Error("歌曲链接格式不正确");
  const route = url.hash.startsWith("#/") ? new URL(url.hash.slice(1), url.origin) : url;
  if (["music.163.com", "m.music.163.com"].includes(url.hostname.toLowerCase())) {
    const id = route.searchParams.get("id") || route.pathname.match(/\/song\/(\d+)/)?.[1];
    if (/\/song(?:\/|$)/i.test(route.pathname) && /^\d{1,20}$/.test(id || "")) return { provider: "netease", id };
    throw new Error("请使用网易云歌曲链接，暂不支持歌单、专辑或短链接");
  }
  if (["y.qq.com", "i.y.qq.com", "c.y.qq.com"].includes(url.hostname.toLowerCase())) {
    const id = route.searchParams.get("songmid") || route.pathname.match(/\/(?:songDetail|song)\/([\da-z]+)(?:\.html)?/i)?.[1]
      || route.pathname.match(/\/song\/([\da-z]+)\.html/i)?.[1];
    if (/^[\da-z]{8,32}$/i.test(id || "") && /[a-z]/i.test(id)) return { provider: "qq", id };
    throw new Error("请使用包含 songmid 的 QQ 音乐歌曲链接，暂不支持短链接");
  }
  throw new Error("目前支持 music.163.com 和 y.qq.com 的完整歌曲链接");
}

export async function readLyricFile(file) {
  if (!file || file.size > 2 * 1024 * 1024) throw new Error("请选择不超过 2 MB 的歌词文件");
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder("gb18030").decode(bytes); }
  return text.replace(/^\uFEFF/, "");
}
