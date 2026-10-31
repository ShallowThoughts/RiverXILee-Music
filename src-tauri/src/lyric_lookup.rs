use super::LyricsResult;
use serde_json::Value;
use std::{future::Future, pin::pin, time::Duration};

pub(super) async fn json(
    request: reqwest::RequestBuilder,
    provider: &str,
) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
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
                return Err(format!(
                    "{provider}歌词接口返回错误（{code}），请稍后重试或指定歌词"
                ));
            }
        }
    }
    Ok(value)
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
    let mut primary = pin!(primary);
    let mut secondary = pin!(secondary);
    // Keep the other provider alive when the first one fails or has no match.
    let (primary_finished, first) =
        futures_lite::future::or(async { (true, primary.as_mut().await) }, async {
            (false, secondary.as_mut().await)
        })
        .await;
    let first_error = match first {
        Ok(Some(result)) => return Ok(result),
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
                first_available(std::future::pending(), async {
                    Ok(Some(lyrics("netease:42")))
                }),
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
}
