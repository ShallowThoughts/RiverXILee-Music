use super::{LyricsResult, lyric_lookup};
use std::future::Future;

pub(super) fn provider(source: &str) -> Result<&'static str, String> {
    let source = source.to_ascii_lowercase();
    if source.contains("qqmusic") { return Ok("qq"); }
    if source.contains("cloudmusic") { return Ok("netease"); }
    if source.contains("kugou") { return Ok("kugou"); }
    Err("当前播放器尚未接入自有在线歌词源，不会转用其他平台；可导入本地时间轴歌词".into())
}

pub(super) fn ensure_provider(source: &str, requested: &str) -> Result<(), String> {
    if provider(source)? == requested { return Ok(()); }
    Err("歌词来源与当前播放器不一致，请选择同平台歌曲链接或导入本地歌词".into())
}

// Closures are deliberately lazy: unselected providers must not make requests,
// even when the native catalog fails, times out or has no matching recording.
pub(super) async fn fetch<Q, N, K>(source: &str, qq: impl FnOnce() -> Q, netease: impl FnOnce() -> N, kugou: impl FnOnce() -> K) -> Result<LyricsResult, String>
where Q: Future<Output = Result<Option<LyricsResult>, String>>,
      N: Future<Output = Result<Option<LyricsResult>, String>>,
      K: Future<Output = Result<Option<LyricsResult>, String>> {
    let provider = provider(source)?;
    let (name, result) = match provider {
        "qq" => ("QQ 音乐", lyric_lookup::bounded("QQ 音乐", qq()).await),
        "kugou" => ("酷狗音乐", lyric_lookup::bounded("酷狗音乐", kugou()).await),
        _ => ("网易云音乐", lyric_lookup::bounded("网易云音乐", netease()).await),
    };
    result?.ok_or_else(|| format!("{name}未找到当前版本的时间轴歌词；未查询其他平台，可指定同平台歌曲或导入 LRC"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn strict_source_never_starts_another_provider_on_error_or_missing_lyrics() {
        for source in ["Tencent.QQMusic", "cloudmusic.exe", "kugou"] {
            for fails in [false, true] {
                let qq_calls = Cell::new(0); let netease_calls = Cell::new(0); let kugou_calls = Cell::new(0);
                let result = tauri::async_runtime::block_on(fetch(source,
                    || { qq_calls.set(qq_calls.get()+1); async { if fails { Err("QQ 原始错误".into()) } else { Ok(None) } } },
                    || { netease_calls.set(netease_calls.get()+1); async { if fails { Err("网易云原始错误".into()) } else { Ok(None) } } },
                    || { kugou_calls.set(kugou_calls.get()+1); async { if fails { Err("酷狗原始错误".into()) } else { Ok(None) } } }));
                assert!(result.is_err());
                assert_eq!(qq_calls.get(), usize::from(source.contains("QQMusic")));
                assert_eq!(netease_calls.get(), usize::from(source.contains("cloudmusic")));
                assert_eq!(kugou_calls.get(), usize::from(source.contains("kugou")));
                let error = result.err().unwrap();
                if fails { assert!(error.contains("原始错误")); }
                else { assert!(error.contains("未查询其他平台")); }
            }
        }
    }

    #[test]
    fn unsupported_native_catalog_does_not_use_qq_or_netease() {
        let result = tauri::async_runtime::block_on(fetch("Spotify.exe",
            || async { panic!("must not query QQ") }, || async { panic!("must not query NetEase") }, || async { panic!("must not query KuGou") }));
        assert!(result.err().unwrap().contains("自有在线歌词源"));
        assert!(ensure_provider("Tencent.QQMusic", "netease").is_err());
        assert!(ensure_provider("cloudmusic.exe", "qq").is_err());
        assert!(ensure_provider("QQMusic.exe", "qq").is_ok());
    }
}
