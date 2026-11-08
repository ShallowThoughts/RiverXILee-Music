use super::LyricsResult;
use serde_json::Value;
use std::{future::Future, pin::pin, time::Duration};

pub(super) async fn json(
    request: reqwest::RequestBuilder,
    provider: &str,
) -> Result<Value, String> {
    'attempts: for attempt in 0..3 {
        let copy = request
            .try_clone()
            .ok_or_else(|| "歌词请求不能安全重试".to_string())?;
        let response = copy
            .send()
            .await
            .map_err(|error| request_error(error, provider))?;
        let status = response.status().as_u16();
        if matches!(status, 429 | 502 | 503 | 504) {
            let hint = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok());
            if let Some(delay) = retry_delay(status, attempt, hint) {
                tokio::time::sleep(delay).await;
                continue;
            }
            let wait = hint
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(30)
                .clamp(30, 86400);
            return Err(format!(
                "{provider}歌词服务暂时不可用（{status}），建议等待 {wait} 秒后重试"
            ));
        }
        let response = response
            .error_for_status()
            .map_err(|error| request_error(error, provider))?;
        let value: Value = response
            .json()
            .await
            .map_err(|error| request_error(error, provider))?;
        if !value.is_object() {
            return Err(format!("{provider}歌词接口响应异常，请重试或指定歌词"));
        }
        for key in ["code", "retcode"] {
            if let Some(code) = value[key].as_i64() {
                if code != 0 && code != 200 {
                    // This is a provider JSON code, not HTTP Method Not Allowed.
                    // Retry once without changing methods, cookies or access controls.
                    if code == 405 && attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        continue 'attempts;
                    }
                    if matches!(code, 429 | 502 | 503 | 504) {
                        if let Some(delay) = retry_delay(code as u16, attempt, None) {
                            tokio::time::sleep(delay).await;
                            continue 'attempts;
                        }
                    }
                    return Err(format!(
                        "{provider}歌词接口返回错误（{code}），请稍后重试或指定歌词"
                    ));
                }
            }
        }
        return Ok(value);
    }
    unreachable!("retry loop always returns on its last attempt")
}

fn retry_delay(status: u16, attempt: u32, hint: Option<&str>) -> Option<Duration> {
    if attempt >= 2 || !matches!(status, 429 | 502 | 503 | 504) {
        return None;
    }
    match hint {
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|seconds| *seconds <= 2)
            .map(Duration::from_secs),
        None => Some(Duration::from_millis(250 * (attempt as u64 + 1))),
    }
}

fn request_error(error: reqwest::Error, provider: &str) -> String {
    if error.is_timeout() {
        format!("{provider}歌词请求超时，请检查网络后重试")
    } else if matches!(
        error.status().map(|status| status.as_u16()),
        Some(403 | 429)
    ) {
        format!("{provider}歌词接口暂时限制访问，请稍后重试或指定歌词")
    } else if error.is_connect() {
        format!("无法连接{provider}歌词接口，请检查网络后重试")
    } else if error.is_decode() {
        format!("{provider}歌词接口响应异常，请重试或指定歌词")
    } else {
        format!("{provider}歌词请求失败，请稍后重试或指定歌词")
    }
}

pub(super) async fn bounded<T>(
    provider: &str,
    lookup: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(20), lookup)
        .await
        .map_err(|_| format!("{provider}歌词查询超时，请稍后重试或指定歌词"))?
}

pub(super) async fn first_available(
    primary: impl Future<Output = Result<Option<LyricsResult>, String>>,
    secondary: impl Future<Output = Result<Option<LyricsResult>, String>>,
) -> Result<LyricsResult, String> {
    preferred_with_grace(primary, secondary, Duration::from_secs(4)).await
}

async fn preferred_with_grace(
    primary: impl Future<Output = Result<Option<LyricsResult>, String>>,
    secondary: impl Future<Output = Result<Option<LyricsResult>, String>>,
    grace: Duration,
) -> Result<LyricsResult, String> {
    let mut primary = pin!(primary);
    let mut secondary = pin!(secondary);
    // Keep the other provider alive when the first one fails or has no match.
    let (primary_finished, first) =
        futures_lite::future::or(async { (true, primary.as_mut().await) }, async {
            (false, secondary.as_mut().await)
        })
        .await;
    let first_error = match first {
        Ok(Some(result)) if primary_finished => return Ok(result),
        Ok(Some(fallback)) => {
            return match tokio::time::timeout(grace, primary.as_mut()).await {
                Ok(Ok(Some(preferred))) => Ok(preferred),
                _ => Ok(fallback),
            };
        }
        result => result.err(),
    };
    let second = if primary_finished {
        secondary.await
    } else {
        primary.await
    };
    match second {
        Ok(Some(result)) => Ok(result),
        result => Err(first_error.or_else(|| result.err()).unwrap_or_else(|| {
            "两个歌词源均未找到版本匹配的时间轴歌词，可指定歌词或导入 LRC".to_string()
        })),
    }
}

pub(super) enum LyricBody {
    Timed(String, Option<String>),
    Instrumental,
}

pub(super) fn make_result(
    body: LyricBody,
    song_mid: String,
    matched_title: String,
    matched_artist: String,
) -> LyricsResult {
    let (lrc, instrumental, translation_lrc) = match body {
        LyricBody::Timed(text, translation) => (text, false, translation),
        LyricBody::Instrumental => (String::new(), true, None),
    };
    LyricsResult {
        lrc,
        song_mid,
        matched_title,
        matched_artist,
        instrumental,
        match_revision: 2,
        translation_lrc,
        translation_revision: 1,
    }
}

pub(super) fn instrumental_text(text: &str) -> bool {
    let lines = text
        .lines()
        .map(|line| if line.trim() == "[Instrumental]" { "Instrumental" }
            else { line.rsplit_once(']').map_or(line, |(_, text)| text).trim() })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    !lines.is_empty()
        && lines.iter().all(|text| {
            matches!(
                *text,
                "纯音乐，请欣赏"
                    | "纯音乐,请欣赏"
                    | "纯音乐，请欣赏。"
                    | "此歌曲为没有填词的纯音乐，请您欣赏"
                    | "[Instrumental]"
                    | "Instrumental"
            )
        })
}

pub(super) fn has_timed_text(lyrics: &str) -> bool {
    lyrics.lines().any(|line| {
        let Some((tag, text)) = line
            .trim()
            .strip_prefix('[')
            .and_then(|line| line.split_once(']'))
        else {
            return false;
        };
        if text.trim().is_empty() {
            return false;
        }
        if let Some((minutes, seconds)) = tag.split_once(':') {
            return minutes.parse::<u32>().is_ok()
                && seconds
                    .parse::<f64>()
                    .is_ok_and(|seconds| seconds.is_finite() && (0.0..60.0).contains(&seconds));
        }
        tag.split_once(',').is_some_and(|(start, duration)| {
            start.parse::<u64>().is_ok() && duration.parse::<u64>().is_ok()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn response(status: u16, body: &str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/lyrics", listener.local_addr().unwrap());
        let body = body.to_string();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        (url, handle)
    }

    #[test]
    fn http_failures_and_malformed_content_do_not_become_missing_lyrics() {
        for (status, body, expected) in [
            (403, "{}", "暂时限制访问"),
            (200, "<html>service unavailable</html>", "响应异常"),
            (200, "[]", "响应异常"),
            (200, r#"{"code":500}"#, "接口返回错误（500）"),
            (200, r#"{"retcode":-1903}"#, "接口返回错误（-1903）"),
        ] {
            let (url, server) = response(status, body);
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let error =
                tauri::async_runtime::block_on(json(client.get(url), "测试音乐源")).unwrap_err();
            assert!(error.contains(expected), "{error}");
            server.join().unwrap();
        }
    }

    fn lyrics(id: &str) -> LyricsResult {
        LyricsResult {
            lrc: "[00:01.00]line".into(),
            song_mid: id.into(),
            matched_title: "song".into(),
            matched_artist: "artist".into(),
            instrumental: false,
            match_revision: 2,
            translation_lrc: None,
            translation_revision: 1,
        }
    }

    #[test]
    fn a_failed_primary_does_not_disable_the_other_catalog() {
        let result = tauri::async_runtime::block_on(first_available(
            async { Err("QQ 音乐歌词请求超时".into()) },
            async { Ok(Some(lyrics("netease:42"))) },
        ))
        .unwrap();
        assert_eq!(result.song_mid, "netease:42");
    }

    #[test]
    fn an_unresponsive_primary_does_not_block_a_valid_fallback() {
        let result = tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                Duration::from_secs(1),
                preferred_with_grace(
                    std::future::pending(),
                    async { Ok(Some(lyrics("netease:42"))) },
                    Duration::from_millis(20),
                ),
            )
            .await
        })
        .unwrap()
        .unwrap();
        assert_eq!(result.song_mid, "netease:42");
    }

    #[test]
    fn an_empty_fast_catalog_still_waits_for_the_matching_catalog() {
        let result = tauri::async_runtime::block_on(first_available(
            async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok(Some(lyrics("qq:42")))
            },
            async { Ok(None) },
        ))
        .unwrap();
        assert_eq!(result.song_mid, "qq:42");
    }

    #[test]
    fn network_failures_remain_distinct_from_confirmed_missing_lyrics() {
        let network = tauri::async_runtime::block_on(first_available(
            async { Err("QQ 音乐歌词接口暂时限制访问".into()) },
            async { Ok(None) },
        ))
        .err()
        .unwrap();
        assert!(network.contains("限制访问"));
        let missing =
            tauri::async_runtime::block_on(first_available(async { Ok(None) }, async { Ok(None) }))
                .err()
                .unwrap();
        assert!(missing.contains("两个歌词源均未找到"));
    }

    #[test]
    fn only_timed_text_can_be_returned_as_a_successful_lyric() {
        assert!(has_timed_text("[00:01.23]a line"));
        assert!(has_timed_text("[1000,2000](1000,500,0)word"));
        assert!(!has_timed_text("<html>temporarily unavailable</html>"));
        assert!(!has_timed_text("[ar:artist]\n[ti:song]"));
        assert!(!has_timed_text("[00:01.00]"));
    }

    #[test]
    fn a_faster_fallback_does_not_steal_a_valid_native_result() {
        let result = tauri::async_runtime::block_on(preferred_with_grace(
            async {
                tokio::time::sleep(Duration::from_millis(15)).await;
                Ok(Some(lyrics("qq:preferred")))
            },
            async { Ok(Some(lyrics("netease:faster"))) },
            Duration::from_millis(50),
        ))
        .unwrap();
        assert_eq!(result.song_mid, "qq:preferred");
    }

    #[test]
    fn instrumental_markers_are_not_arbitrary_lyric_lines() {
        assert!(instrumental_text("[00:00.00]纯音乐，请欣赏"));
        assert!(instrumental_text("纯音乐，请欣赏"));
        assert!(instrumental_text("[Instrumental]"));
        assert!(!instrumental_text(
            "[00:00.00]纯音乐，请欣赏\n[00:10.00]真实的人声歌词"
        ));
        assert!(!instrumental_text(""));
        assert!(!instrumental_text("<html>503</html>"));
        let result = make_result(
            LyricBody::Instrumental,
            "netease:42".into(),
            "song".into(),
            "artist".into(),
        );
        assert!(result.instrumental && result.lrc.is_empty());
    }

    #[test]
    fn retry_policy_is_bounded_and_respects_long_retry_after() {
        assert_eq!(retry_delay(503, 0, None), Some(Duration::from_millis(250)));
        assert_eq!(retry_delay(503, 2, None), None);
        assert_eq!(retry_delay(503, 0, Some("60")), None);
        assert_eq!(retry_delay(503, 0, Some("1")), Some(Duration::from_secs(1)));
        assert_eq!(retry_delay(403, 0, None), None);
    }

    #[test]
    fn a_temporary_503_recovers_without_becoming_missing_lyrics() {
        for first in [(503, "<html>busy</html>"), (200, r#"{"code":503}"#), (200, r#"{"code":405}"#)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/lyrics", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                for (status, body) in [first, (200, r#"{"code":200,"ok":true}"#)] {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut buffer = [0; 4096];
                    let _ = stream.read(&mut buffer);
                    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let value = tauri::async_runtime::block_on(json(client.get(url), "测试源")).unwrap();
            assert_eq!(value["ok"], true);
            server.join().unwrap();
        }
    }

    #[test]
    fn provider_translation_is_preserved_without_synthesizing_missing_text() {
        let result = make_result(LyricBody::Timed("[00:01.00]Hello".into(), Some("[00:01.00]你好".into())),
            "qq:42".into(), "song".into(), "artist".into());
        assert_eq!(result.translation_lrc.as_deref(), Some("[00:01.00]你好"));
        assert!(!result.instrumental);
        let missing = make_result(LyricBody::Timed("[00:01.00]Hello".into(), None),
            "qq:42".into(), "song".into(), "artist".into());
        assert!(missing.translation_lrc.is_none());
    }
}
