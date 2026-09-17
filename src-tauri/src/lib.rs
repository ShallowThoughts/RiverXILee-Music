use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackType;

mod netease;

static MEDIA_MANAGER: OnceLock<GlobalSystemMediaTransportControlsSessionManager> = OnceLock::new();
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaSnapshot {
    connected: bool,
    source: String,
    track_id: String,
    title: String,
    artist: String,
    album: String,
    is_playing: bool,
    playback_rate: f64,
    position_ms: i64,
    duration_ms: i64,
    timeline_updated_at_ms: Option<i64>,
    captured_at_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LyricsResult {
    lrc: String,
    song_mid: String,
    matched_title: String,
    matched_artist: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    current_version: String,
    latest_version: String,
    download_url: String,
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn timeline_timestamp_ms(winrt_ticks: i64) -> Option<i64> {
    // WinRT uses 100 ns ticks since 1601; the frontend uses Unix milliseconds.
    let unix_ms = winrt_ticks / 10_000 - 11_644_473_600_000;
    (unix_ms > 0).then_some(unix_ms)
}

fn needs_netease_clock(source: &str) -> bool {
    source.to_ascii_lowercase().contains("cloudmusic")
}

async fn media_manager() -> Result<GlobalSystemMediaTransportControlsSessionManager, String> {
    if let Some(manager) = MEDIA_MANAGER.get() {
        return Ok(manager.clone());
    }
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(error_text)?
        .await
        .map_err(error_text)?;
    let _ = MEDIA_MANAGER.set(manager.clone());
    Ok(manager)
}

fn session_is_playing(session: &GlobalSystemMediaTransportControlsSession) -> bool {
    session
        .GetPlaybackInfo()
        .and_then(|playback| playback.PlaybackStatus())
        .map(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        .unwrap_or(false)
}

fn source_is_supported_music_app(source: &str) -> bool {
    const MUSIC_APP_MARKERS: [&str; 21] = [
        "qqmusic",
        "qq音乐",
        "cloudmusic",
        "neteasemusic",
        "网易云音乐",
        "kugou",
        "酷狗音乐",
        "kuwomusic",
        "kuwo",
        "酷我音乐",
        "qishuimusic",
        "qishui",
        "汽水音乐",
        "spotify",
        "applemusic",
        "itunes",
        "amazonmusic",
        "deezer",
        "tidal",
        "zunemusic",
        "musicbee",
    ];
    let source = source.to_ascii_lowercase();
    MUSIC_APP_MARKERS
        .iter()
        .any(|marker| source.contains(marker))
}

fn session_is_music_candidate(session: &GlobalSystemMediaTransportControlsSession) -> bool {
    let source = session
        .SourceAppUserModelId()
        .map(|value| value.to_string())
        .unwrap_or_default();
    if !source_is_supported_music_app(&source) {
        return false;
    }

    let playback_type = session
        .GetPlaybackInfo()
        .ok()
        .and_then(|playback| playback.PlaybackType().ok())
        .and_then(|value| value.Value().ok());
    !matches!(
        playback_type,
        Some(MediaPlaybackType::Video | MediaPlaybackType::Image)
    )
}

async fn active_media_session() -> Result<Option<GlobalSystemMediaTransportControlsSession>, String>
{
    let manager = media_manager().await?;
    let current = manager.GetCurrentSession().ok();

    if current
        .as_ref()
        .is_some_and(|session| session_is_music_candidate(session) && session_is_playing(session))
    {
        return Ok(current);
    }

    let sessions = manager.GetSessions().map_err(error_text)?;
    for index in 0..sessions.Size().map_err(error_text)? {
        let session = sessions.GetAt(index).map_err(error_text)?;
        if session_is_music_candidate(&session) && session_is_playing(&session) {
            return Ok(Some(session));
        }
    }

    if current.as_ref().is_some_and(session_is_music_candidate) {
        return Ok(current);
    }

    for index in 0..sessions.Size().map_err(error_text)? {
        let session = sessions.GetAt(index).map_err(error_text)?;
        if session_is_music_candidate(&session) {
            return Ok(Some(session));
        }
    }

    Ok(None)
}

#[tauri::command]
async fn get_media_snapshot() -> Result<MediaSnapshot, String> {
    let Some(session) = active_media_session().await? else {
        let captured_at_ms = now_ms();
        if let Some(track) = netease::current_track() {
            return Ok(MediaSnapshot {
                connected: true,
                source: "cloudmusic.exe".to_string(),
                track_id: track.track_id,
                title: track.title,
                artist: track.artist,
                album: track.album,
                is_playing: track.is_playing,
                playback_rate: 1.0,
                position_ms: track.position_ms,
                duration_ms: track.duration_ms,
                timeline_updated_at_ms: i64::try_from(captured_at_ms).ok(),
                captured_at_ms,
            });
        }
        return Ok(MediaSnapshot {
            connected: false,
            source: String::new(),
            track_id: String::new(),
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            is_playing: false,
            playback_rate: 1.0,
            position_ms: 0,
            duration_ms: 0,
            timeline_updated_at_ms: None,
            captured_at_ms,
        });
    };

    let source = session
        .SourceAppUserModelId()
        .map_err(error_text)?
        .to_string();
    let properties = session
        .TryGetMediaPropertiesAsync()
        .map_err(error_text)?
        .await
        .map_err(error_text)?;
    let timeline = session.GetTimelineProperties().map_err(error_text)?;
    let playback = session.GetPlaybackInfo().map_err(error_text)?;
    let artist = properties.Artist().map_err(error_text)?.to_string();
    let album_artist = properties.AlbumArtist().map_err(error_text)?.to_string();

    let captured_at_ms = now_ms();
    let mut position_ms = (timeline.Position().map_err(error_text)?.Duration / 10_000).max(0);
    let duration_ms = (timeline.EndTime().map_err(error_text)?.Duration / 10_000).max(0);
    let mut timeline_updated_at_ms = timeline
        .LastUpdatedTime()
        .ok()
        .and_then(|value| timeline_timestamp_ms(value.UniversalTime));
    if needs_netease_clock(&source) {
        if let Some(netease_position_ms) = netease::current_position_ms() {
            position_ms = netease_position_ms;
            timeline_updated_at_ms = i64::try_from(captured_at_ms).ok();
        }
    }

    let title = properties.Title().map_err(error_text)?.to_string();
    let resolved_artist = if artist.is_empty() {
        album_artist
    } else {
        artist
    };
    let track_id = if source.to_ascii_lowercase().contains("cloudmusic") {
        netease::current_track_id(&title, &resolved_artist).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(MediaSnapshot {
        connected: true,
        source,
        track_id,
        title,
        artist: resolved_artist,
        album: properties.AlbumTitle().map_err(error_text)?.to_string(),
        is_playing: playback.PlaybackStatus().map_err(error_text)?
            == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
        playback_rate: playback
            .PlaybackRate()
            .ok()
            .and_then(|value| value.Value().ok())
            .filter(|rate| rate.is_finite() && *rate > 0.0)
            .unwrap_or(1.0),
        position_ms,
        duration_ms,
        timeline_updated_at_ms,
        captured_at_ms,
    })
}

#[tauri::command]
async fn control_media(action: String) -> Result<bool, String> {
    let Some(session) = active_media_session().await? else {
        return Ok(false);
    };
    let operation = match action.as_str() {
        "previous" => session.TrySkipPreviousAsync().map_err(error_text)?,
        "toggle" => session.TryTogglePlayPauseAsync().map_err(error_text)?,
        "next" => session.TrySkipNextAsync().map_err(error_text)?,
        _ => return Err("不支持的媒体操作".to_string()),
    };
    operation.await.map_err(error_text)
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn title_without_bracketed_qualifiers(value: &str) -> String {
    let mut result = String::new();
    let mut depth = 0_u32;
    for character in value.chars() {
        if matches!(character, '(' | '（' | '[' | '【' | '{') {
            depth += 1;
        } else if matches!(character, ')' | '）' | ']' | '】' | '}') {
            depth = depth.saturating_sub(1);
        } else if depth == 0 {
            result.push(character);
        }
    }
    result
        .trim()
        .trim_end_matches(['-', '–', '—', '·', '•', ' '])
        .trim()
        .to_string()
}

fn lyric_search_queries(title: &str, artist: &str) -> Vec<String> {
    let title = title.trim();
    let artist = artist.trim();
    let simplified_title = title_without_bracketed_qualifiers(title);
    let mut queries = Vec::new();
    for query in [
        format!("{title} {artist}"),
        format!("{simplified_title} {artist}"),
        title.to_string(),
        simplified_title,
    ] {
        let query = query.trim().to_string();
        if !query.is_empty() && !queries.iter().any(|existing| existing == &query) {
            queries.push(query);
        }
    }
    queries
}

fn candidate_score(
    candidate: &Value,
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: i64,
) -> i64 {
    let candidate_title = candidate["songname"].as_str().unwrap_or_default();
    let candidate_album = candidate["albumname"].as_str().unwrap_or_default();
    let candidate_artist = candidate["singer"]
        .as_array()
        .map(|singers| {
            singers
                .iter()
                .filter_map(|singer| singer["name"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let wanted_title = normalize(title);
    let found_title = normalize(candidate_title);
    let wanted_artist = normalize(artist);
    let found_artist = normalize(&candidate_artist);
    let wanted_album = normalize(album);
    let found_album = normalize(candidate_album);
    let mut score = 0;

    if wanted_title.is_empty() || found_title.is_empty() {
        return -1;
    }

    if found_title == wanted_title {
        score += 220;
    } else if found_title.contains(&wanted_title) || wanted_title.contains(&found_title) {
        score += 110;
    } else {
        return -1;
    }
    if !wanted_artist.is_empty() {
        if found_artist.is_empty()
            || !(found_artist.contains(&wanted_artist) || wanted_artist.contains(&found_artist))
        {
            return -1;
        }
        score += 90;
    }
    if !wanted_album.is_empty() && found_album == wanted_album {
        score += 35;
    }
    let found_duration = candidate["interval"].as_i64().unwrap_or_default() * 1_000;
    if duration_ms > 0 && found_duration > 0 {
        let difference = (found_duration - duration_ms).abs();
        if difference <= 2_500 {
            score += 50;
        } else if difference <= 6_000 {
            score += 20;
        } else if difference > 15_000 {
            return -1;
        } else {
            score -= 50;
        }
    }
    score
}

fn netease_artist(candidate: &Value) -> String {
    candidate["artists"]
        .as_array()
        .or_else(|| candidate["ar"].as_array())
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist["name"].as_str())
                .collect::<Vec<_>>()
                .join(" / ")
        })
        .unwrap_or_default()
}

fn netease_candidate_score(candidate: &Value, title: &str, artist: &str, duration_ms: i64) -> i64 {
    let wanted_title = normalize(title);
    let found_title = normalize(candidate["name"].as_str().unwrap_or_default());
    let wanted_artist = normalize(artist);
    let found_artist = normalize(&netease_artist(candidate));
    let mut score = 0;

    if wanted_title.is_empty() || found_title.is_empty() {
        return -1;
    }
    if found_title == wanted_title {
        score += 220;
    } else if found_title.contains(&wanted_title) || wanted_title.contains(&found_title) {
        score += 110;
    } else {
        return -1;
    }
    if !wanted_artist.is_empty() {
        if found_artist.is_empty()
            || !(found_artist.contains(&wanted_artist) || wanted_artist.contains(&found_artist))
        {
            return -1;
        }
        score += 90;
    }
    let found_duration = candidate["duration"]
        .as_i64()
        .or_else(|| candidate["dt"].as_i64())
        .unwrap_or_default();
    if duration_ms > 0 && found_duration > 0 {
        let difference = (found_duration - duration_ms).abs();
        if difference <= 2_500 {
            score += 50;
        } else if difference <= 6_000 {
            score += 20;
        } else if difference > 15_000 {
            return -1;
        } else {
            score -= 50;
        }
    }
    score
}

async fn fetch_netease_lrc(client: &reqwest::Client, track_id: &str) -> Option<String> {
    let response = client
        .get("https://music.163.com/api/song/lyric")
        .header("Referer", "https://music.163.com/")
        .query(&[
            ("id", track_id),
            ("lv", "-1"),
            ("kv", "-1"),
            ("tv", "-1"),
            ("os", "pc"),
        ])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let native = response.json::<Value>().await.ok()?;
    native["lrc"]["lyric"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

async fn fetch_netease_lyrics(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration_ms: i64,
    track_id: &str,
) -> Option<LyricsResult> {
    if !track_id.is_empty() && track_id.chars().all(|character| character.is_ascii_digit()) {
        if let Some(lrc) = fetch_netease_lrc(client, track_id).await {
            return Some(LyricsResult {
                lrc,
                song_mid: format!("netease:{track_id}"),
                matched_title: title.to_string(),
                matched_artist: artist.to_string(),
            });
        }
    }

    let mut tried_ids = HashSet::new();
    tried_ids.insert(track_id.to_string());
    for query in lyric_search_queries(title, artist) {
        let Some(search) = client
            .get("https://music.163.com/api/search/get/web")
            .header("Referer", "https://music.163.com/")
            .query(&[
                ("s", query.as_str()),
                ("type", "1"),
                ("limit", "10"),
                ("offset", "0"),
            ])
            .send()
            .await
            .ok()
            .and_then(|response| response.error_for_status().ok())
        else {
            continue;
        };
        let Ok(search) = search.json::<Value>().await else {
            continue;
        };
        let Some(candidates) = search["result"]["songs"].as_array() else {
            continue;
        };
        let mut ranked = candidates
            .iter()
            .map(|item| {
                (
                    netease_candidate_score(item, title, artist, duration_ms),
                    item,
                )
            })
            .filter(|(score, _)| *score >= 220)
            .collect::<Vec<_>>();
        ranked.sort_by_key(|(score, _)| std::cmp::Reverse(*score));

        for (_, candidate) in ranked.into_iter().take(3) {
            let Some(candidate_id) = candidate["id"].as_i64().map(|id| id.to_string()) else {
                continue;
            };
            if !tried_ids.insert(candidate_id.clone()) {
                continue;
            }
            if let Some(lrc) = fetch_netease_lrc(client, &candidate_id).await {
                return Some(LyricsResult {
                    lrc,
                    song_mid: format!("netease:{candidate_id}"),
                    matched_title: candidate["name"].as_str().unwrap_or(title).to_string(),
                    matched_artist: netease_artist(candidate),
                });
            }
        }
    }
    None
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn version_numbers(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or_default()
        })
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest = version_numbers(latest);
    let current = version_numbers(current);
    let length = latest.len().max(current.len());
    (0..length)
        .map(|index| {
            (
                *latest.get(index).unwrap_or(&0),
                *current.get(index).unwrap_or(&0),
            )
        })
        .find(|(latest, current)| latest != current)
        .is_some_and(|(latest, current)| latest > current)
}

#[tauri::command]
async fn check_for_update() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let client = HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiverXILeeDesktopLyrics/1.0.7")
            .build()
            .expect("HTTP client should initialize")
    });
    let release: Value = client
        .get("https://api.github.com/repos/ShallowThoughts/RiverXILee-Music/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(error_text)?
        .error_for_status()
        .map_err(error_text)?
        .json()
        .await
        .map_err(error_text)?;
    let latest_version = release["tag_name"]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if latest_version.is_empty() {
        return Err("GitHub 最新版本信息不完整".to_string());
    }
    let download_url = release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset["name"]
                    .as_str()
                    .is_some_and(|name| name.ends_with("_x64-setup.exe"))
            })
        })
        .and_then(|asset| asset["browser_download_url"].as_str())
        .or_else(|| release["html_url"].as_str())
        .unwrap_or("https://github.com/ShallowThoughts/RiverXILee-Music/releases/latest")
        .to_string();

    Ok(UpdateInfo {
        available: is_newer_version(&latest_version, &current_version),
        current_version,
        latest_version,
        download_url,
    })
}

#[tauri::command]
async fn fetch_lyrics(
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    source: String,
    track_id: String,
) -> Result<LyricsResult, String> {
    if title.trim().is_empty() {
        return Err("当前播放器暂未提供歌曲名称".to_string());
    }
    let client = HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiverXILeeDesktopLyrics/1.0.7")
            .build()
            .expect("HTTP client should initialize")
    });
    if source.to_ascii_lowercase().contains("cloudmusic") {
        if let Some(result) =
            fetch_netease_lyrics(client, &title, &artist, duration_ms, &track_id).await
        {
            return Ok(result);
        }
    }
    let mut tried_song_mids = HashSet::new();
    for query in lyric_search_queries(&title, &artist) {
        let Some(response) = client
            .get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp")
            .header("Referer", "https://y.qq.com/")
            .query(&[
                ("p", "1"),
                ("n", "12"),
                ("w", query.as_str()),
                ("format", "json"),
            ])
            .send()
            .await
            .ok()
            .and_then(|response| response.error_for_status().ok())
        else {
            continue;
        };
        let Ok(search) = response.json::<Value>().await else {
            continue;
        };
        let Some(candidates) = search["data"]["song"]["list"].as_array() else {
            continue;
        };
        let mut ranked = candidates
            .iter()
            .map(|item| {
                (
                    candidate_score(item, &title, &artist, &album, duration_ms),
                    item,
                )
            })
            .filter(|(score, _)| *score >= 220)
            .collect::<Vec<_>>();
        ranked.sort_by_key(|(score, _)| std::cmp::Reverse(*score));

        for (_, candidate) in ranked.into_iter().take(3) {
            let Some(song_mid) = candidate["songmid"]
                .as_str()
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if !tried_song_mids.insert(song_mid.to_string()) {
                continue;
            }
            let Some(response) = client
                .get("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg")
                .header("Referer", "https://y.qq.com/")
                .query(&[
                    ("songmid", song_mid),
                    ("format", "json"),
                    ("nobase64", "1"),
                    ("g_tk", "5381"),
                ])
                .send()
                .await
                .ok()
                .and_then(|response| response.error_for_status().ok())
            else {
                continue;
            };
            let Ok(lyric) = response.json::<Value>().await else {
                continue;
            };
            let Some(lrc) = lyric["lyric"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };
            let matched_artist = candidate["singer"]
                .as_array()
                .map(|singers| {
                    singers
                        .iter()
                        .filter_map(|singer| singer["name"].as_str())
                        .collect::<Vec<_>>()
                        .join(" / ")
                })
                .unwrap_or_default();

            return Ok(LyricsResult {
                lrc: decode_entities(lrc),
                song_mid: song_mid.to_string(),
                matched_title: candidate["songname"].as_str().unwrap_or(&title).to_string(),
                matched_artist,
            });
        }
    }
    Err("没有找到版本匹配且可用的歌词".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_wrong_artist_and_different_recording_duration() {
        let song =
            serde_json::json!({"songname":"我要的", "singer":[{"name":"歌手甲"}], "interval":240});
        assert!(super::candidate_score(&song, "我要的", "歌手乙", "", 240000) < 0);
        assert!(super::candidate_score(&song, "我要的", "歌手甲", "", 180000) < 0);
        assert!(super::candidate_score(&song, "我要的", "歌手甲", "", 241000) >= 220);
    }

    #[test]
    fn rejects_empty_metadata_and_unrelated_titles() {
        let empty = serde_json::json!({"songname":"", "singer":[]});
        assert!(super::candidate_score(&empty, "我要的", "歌手甲", "", 0) < 0);
        let other = serde_json::json!({"songname":"另一首歌", "singer":[{"name":"歌手甲"}]});
        assert!(super::candidate_score(&other, "我要的", "歌手甲", "", 0) < 0);
    }

    #[test]
    fn ranks_netease_search_results_by_recording_metadata() {
        let original = serde_json::json!({
            "id": 2700280922_i64,
            "name": "坏天气",
            "artists": [{"name": "贾格JuggShots"}],
            "duration": 153675
        });
        let accelerated = serde_json::json!({
            "id": 2700280923_i64,
            "name": "坏天气（加速版）",
            "artists": [{"name": "贾格JuggShots"}],
            "duration": 139704
        });
        assert!(
            super::netease_candidate_score(&original, "坏天气", "贾格JuggShots", 153675) >= 220
        );
        assert!(
            super::netease_candidate_score(&accelerated, "坏天气", "贾格JuggShots", 153675) < 220
        );
    }

    #[test]
    fn supports_both_netease_artist_response_shapes() {
        let web = serde_json::json!({
            "name": "add cola",
            "artists": [{"name": "三棱镜"}, {"name": "Zy"}],
            "duration": 193333
        });
        let app = serde_json::json!({
            "name": "add cola",
            "ar": [{"name": "三棱镜"}, {"name": "Zy"}],
            "dt": 193333
        });
        assert_eq!(super::netease_artist(&web), "三棱镜 / Zy");
        assert_eq!(super::netease_artist(&app), "三棱镜 / Zy");
        assert!(super::netease_candidate_score(&app, "add cola", "三棱镜/Zy", 193333) >= 220);
    }

    #[test]
    fn builds_progressively_simpler_multilingual_search_queries() {
        assert_eq!(
            super::lyric_search_queries("涉川·剧情版 (Single Version)", "蔡明希-不才"),
            vec![
                "涉川·剧情版 (Single Version) 蔡明希-不才",
                "涉川·剧情版 蔡明希-不才",
                "涉川·剧情版 (Single Version)",
                "涉川·剧情版",
            ]
        );
        assert_eq!(
            super::lyric_search_queries("Supernova", "aespa (에스파)"),
            vec!["Supernova aespa (에스파)", "Supernova"]
        );
    }

    #[test]
    fn compares_release_versions_numerically() {
        assert!(super::is_newer_version("v1.0.8", "1.0.7"));
        assert!(super::is_newer_version("1.10.0", "1.9.9"));
        assert!(!super::is_newer_version("v1.0.7", "1.0.7"));
        assert!(!super::is_newer_version("1.0.6", "1.0.7"));
    }

    #[test]
    #[ignore = "live GitHub Releases API check"]
    fn reads_the_live_github_release_feed() {
        let update = tauri::async_runtime::block_on(super::check_for_update())
            .expect("GitHub latest release should be readable");
        assert_eq!(update.current_version, "1.0.7");
        assert!(!update.latest_version.is_empty());
        assert!(update.download_url.starts_with("https://github.com/"));
    }

    #[test]
    #[ignore = "live NetEase API regression check"]
    fn resolves_reported_netease_songs_without_a_history_track_id() {
        let songs = [
            ("坏天气", "贾格JuggShots", 153675, "2700280922"),
            ("坏雨季", "鸟森/野生三十", 142656, "2709763704"),
            ("song4love.", "8bite", 208721, "2153152701"),
            ("add cola", "三棱镜/Zy", 193333, "2727822629"),
            ("KLEIN BLUE", "Nine Band", 170756, "1964744004"),
        ];
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiverXILeeDesktopLyrics/test")
            .build()
            .unwrap();

        tauri::async_runtime::block_on(async {
            for (title, artist, duration_ms, expected_id) in songs {
                assert!(
                    super::fetch_netease_lrc(&client, expected_id)
                        .await
                        .is_some(),
                    "direct lyric lookup failed for {expected_id}"
                );
                let result = super::fetch_netease_lyrics(&client, title, artist, duration_ms, "")
                    .await
                    .unwrap_or_else(|| panic!("failed to resolve {title} - {artist}"));
                assert_eq!(result.song_mid, format!("netease:{expected_id}"));
                assert!(!result.lrc.trim().is_empty());
            }
        });
    }

    #[test]
    #[ignore = "live QQ Music multilingual lyric regression check"]
    fn resolves_current_and_multilingual_qq_music_songs() {
        let songs = [
            (
                "涉川·剧情版 (Single Version)",
                "蔡明希-不才",
                "涉川",
                307506,
                "004PWior25kk4o",
            ),
            (
                "APT.",
                "ROSÉ & Bruno Mars",
                "APT.",
                169000,
                "000zR7cv2QHXks",
            ),
            ("Supernova", "aespa", "Supernova", 178000, "000JBYAP1N4s5M"),
            (
                "Magnetic",
                "ILLIT",
                "SUPER REAL ME",
                160000,
                "001pQxBw1N2qnM",
            ),
            (
                "How Sweet",
                "NewJeans",
                "How Sweet",
                219000,
                "002L8GpS1zi9mj",
            ),
        ];

        tauri::async_runtime::block_on(async {
            for (title, artist, album, duration_ms, expected_mid) in songs {
                let result = super::fetch_lyrics(
                    title.to_string(),
                    artist.to_string(),
                    album.to_string(),
                    duration_ms,
                    "QQMusic.exe".to_string(),
                    String::new(),
                )
                .await
                .unwrap_or_else(|error| panic!("failed to resolve {title} - {artist}: {error}"));
                assert_eq!(result.song_mid, expected_mid);
                assert!(!result.lrc.trim().is_empty());
            }
        });
    }

    use super::{needs_netease_clock, source_is_supported_music_app, timeline_timestamp_ms};

    #[test]
    fn converts_winrt_timeline_timestamp_to_unix_milliseconds() {
        let unix_ms = 1_780_000_000_000;
        assert_eq!(
            timeline_timestamp_ms((unix_ms + 11_644_473_600_000) * 10_000),
            Some(unix_ms)
        );
        assert_eq!(timeline_timestamp_ms(0), None);
        assert_eq!(timeline_timestamp_ms(-1), None);
    }

    #[test]
    fn accepts_supported_music_apps() {
        assert!(source_is_supported_music_app("QQMusic.exe"));
        assert!(source_is_supported_music_app("cloudmusic.exe"));
        assert!(source_is_supported_music_app("KuGou.exe"));
        assert!(source_is_supported_music_app("KuwoMusic.exe"));
        assert!(source_is_supported_music_app("Spotify.exe"));
        assert!(source_is_supported_music_app(
            "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"
        ));
        assert!(source_is_supported_music_app("汽水音乐.exe"));
    }

    #[test]
    fn rejects_video_browsers_and_unknown_media_apps() {
        assert!(!source_is_supported_music_app("Douyin.exe"));
        assert!(!source_is_supported_music_app("抖音.exe"));
        assert!(!source_is_supported_music_app("Bilibili.exe"));
        assert!(!source_is_supported_music_app("chrome.exe"));
        assert!(!source_is_supported_music_app("msedge.exe"));
        assert!(!source_is_supported_music_app("UnknownPlayer.exe"));
    }

    #[test]
    fn always_prefers_the_verified_private_netease_clock() {
        assert!(needs_netease_clock("cloudmusic.exe"));
        assert!(needs_netease_clock("CloudMusic.Desktop"));
        assert!(!needs_netease_clock("QQMusic.exe"));
    }
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(error_text)
}

#[tauri::command]
fn set_fullscreen(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_fullscreen(enabled).map_err(error_text)
}

#[tauri::command]
fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enabled).map_err(error_text)
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(error_text)
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(error_text)
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(error_text)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_ignore_cursor_events(false);
                            let _ = window.emit("overlay-unlocked", ());
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let _ = app.global_shortcut().register("Ctrl+Shift+L");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_media_snapshot,
            control_media,
            fetch_lyrics,
            check_for_update,
            set_always_on_top,
            set_fullscreen,
            set_click_through,
            minimize_window,
            close_window,
            start_dragging
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RiverXILee桌面歌词");
}
