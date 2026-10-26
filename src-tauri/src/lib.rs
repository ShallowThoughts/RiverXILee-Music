use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::str::FromStr;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
    menu::MenuBuilder,
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_dialog::DialogExt;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackType;
mod fonts;
mod netease;

static MEDIA_MANAGER: OnceLock<GlobalSystemMediaTransportControlsSessionManager> = OnceLock::new();
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static LYRICS_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SHORTCUT_ACTIONS: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPlacement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn state_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let directory = app.path().app_config_dir().map_err(error_text)?;
    fs::create_dir_all(&directory).map_err(error_text)?;
    Ok(directory.join(name))
}

fn save_window_placement(window: &WebviewWindow) -> Result<(), String> {
    if window.is_fullscreen().map_err(error_text)? || window.is_maximized().map_err(error_text)? {
        return Ok(());
    }
    let position = window.outer_position().map_err(error_text)?;
    let size = window.outer_size().map_err(error_text)?;
    let placement = WindowPlacement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let bytes = serde_json::to_vec_pretty(&placement).map_err(error_text)?;
    fs::write(state_file(window.app_handle(), "window-placement.json")?, bytes)
        .map_err(error_text)
}

fn restore_window_placement(window: &WebviewWindow) -> Result<(), String> {
    let path = state_file(window.app_handle(), "window-placement.json")?;
    if !path.exists() {
        return Ok(());
    }
    let placement: WindowPlacement =
        serde_json::from_slice(&fs::read(path).map_err(error_text)?).map_err(error_text)?;
    let width = placement.width.max(640);
    let height = placement.height.max(280);
    let saved_right = i64::from(placement.x) + i64::from(width);
    let saved_bottom = i64::from(placement.y) + i64::from(height);
    let is_visible = window
        .available_monitors()
        .map_err(error_text)?
        .iter()
        .any(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let right = i64::from(position.x) + i64::from(size.width);
            let bottom = i64::from(position.y) + i64::from(size.height);
            let intersection_width =
                (saved_right.min(right) - i64::from(placement.x).max(i64::from(position.x))).max(0);
            let intersection_height = (saved_bottom.min(bottom)
                - i64::from(placement.y).max(i64::from(position.y)))
            .max(0);
            intersection_width >= 160 && intersection_height >= 80
        });
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(error_text)?;
    if is_visible {
        window
            .set_position(PhysicalPosition::new(placement.x, placement.y))
            .map_err(error_text)?;
    } else {
        window.center().map_err(error_text)?;
    }
    Ok(())
}

fn watch_window_placement(window: &WebviewWindow) {
    let generation = Arc::new(AtomicU64::new(0));
    let observed_window = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let generation = Arc::clone(&generation);
        let window = observed_window.clone();
        let current = generation.fetch_add(1, Ordering::Relaxed) + 1;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            if generation.load(Ordering::Relaxed) == current {
                let _ = save_window_placement(&window);
            }
        });
    });
}

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LyricsCandidate {
    provider: String,
    id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    score: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    current_version: String,
    latest_version: String,
    download_url: String,
    download_size: u64,
    release_notes: String,
    sha256: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaSessionInfo {
    source: String,
    is_playing: bool,
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

#[tauri::command]
fn list_system_fonts() -> Result<Vec<fonts::SystemFont>, String> {
    fonts::system_fonts()
}

fn timeline_timestamp_ms(winrt_ticks: i64) -> Option<i64> {
    // WinRT uses 100 ns ticks since 1601; the frontend uses Unix milliseconds.
    let unix_ms = winrt_ticks / 10_000 - 11_644_473_600_000;
    (unix_ms > 0).then_some(unix_ms)
}

fn netease_media_snapshot(track: netease::TrackSnapshot, captured_at_ms: u128) -> MediaSnapshot {
    MediaSnapshot {
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
    }
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

fn session_activity_rank(
    session: &GlobalSystemMediaTransportControlsSession,
    current_source: &str,
) -> (i64, bool) {
    let updated_at = session
        .GetTimelineProperties()
        .ok()
        .and_then(|timeline| timeline.LastUpdatedTime().ok())
        .and_then(|value| timeline_timestamp_ms(value.UniversalTime))
        .unwrap_or_default();
    let is_current = session
        .SourceAppUserModelId()
        .map(|value| value.to_string().eq_ignore_ascii_case(current_source))
        .unwrap_or(false);
    (updated_at, is_current)
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

async fn active_media_session(
    preferred_source: Option<&str>,
) -> Result<Option<GlobalSystemMediaTransportControlsSession>, String> {
    let manager = media_manager().await?;
    let current = manager.GetCurrentSession().ok();
    let wanted = preferred_source
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);

    if let Some(wanted) = wanted {
        let sessions = manager.GetSessions().map_err(error_text)?;
        for index in 0..sessions.Size().map_err(error_text)? {
            let session = sessions.GetAt(index).map_err(error_text)?;
            let source = session
                .SourceAppUserModelId()
                .map(|value| value.to_string().to_ascii_lowercase())
                .unwrap_or_default();
            if source == wanted && session_is_music_candidate(&session) {
                return Ok(Some(session));
            }
        }
        return Ok(None);
    }

    let sessions = manager.GetSessions().map_err(error_text)?;
    let current_source = current
        .as_ref()
        .and_then(|session| session.SourceAppUserModelId().ok())
        .map(|value| value.to_string())
        .unwrap_or_default();
    let mut best_playing: Option<(GlobalSystemMediaTransportControlsSession, (i64, bool))> = None;
    for index in 0..sessions.Size().map_err(error_text)? {
        let session = sessions.GetAt(index).map_err(error_text)?;
        if session_is_music_candidate(&session) && session_is_playing(&session) {
            let rank = session_activity_rank(&session, &current_source);
            if best_playing
                .as_ref()
                .is_none_or(|(_, best_rank)| rank > *best_rank)
            {
                best_playing = Some((session, rank));
            }
        }
    }
    if let Some((session, _)) = best_playing {
        return Ok(Some(session));
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
async fn list_media_sessions() -> Result<Vec<MediaSessionInfo>, String> {
    let manager = media_manager().await?;
    let sessions = manager.GetSessions().map_err(error_text)?;
    let mut result = Vec::new();
    for index in 0..sessions.Size().map_err(error_text)? {
        let session = sessions.GetAt(index).map_err(error_text)?;
        if !session_is_music_candidate(&session) {
            continue;
        }
        let source = session
            .SourceAppUserModelId()
            .map_err(error_text)?
            .to_string();
        if !result.iter().any(|item: &MediaSessionInfo| item.source == source) {
            result.push(MediaSessionInfo {
                source,
                is_playing: session_is_playing(&session),
            });
        }
    }
    Ok(result)
}

#[tauri::command]
async fn get_media_snapshot(preferred_source: Option<String>) -> Result<MediaSnapshot, String> {
    let captured_at_ms = now_ms();
    let mut netease_track = netease::current_track();
    let preferred_netease = preferred_source
        .as_deref()
        .is_some_and(|source| source.to_ascii_lowercase().contains("cloudmusic"));
    let session = match active_media_session(preferred_source.as_deref()).await {
        Ok(session) => session,
        Err(error) => {
            if (preferred_source.is_none() || preferred_netease) && let Some(track) = netease_track {
                return Ok(netease_media_snapshot(track, captured_at_ms));
            }
            return Err(error);
        }
    };
    let has_netease_session = session.as_ref().is_some_and(|session| {
        session.SourceAppUserModelId().ok().is_some_and(|source| needs_netease_clock(&source.to_string()))
    });
    if !has_netease_session && (preferred_source.is_none() || preferred_netease)
        && netease_track.as_ref().is_some_and(|track| track.is_playing)
    {
        return Ok(netease_media_snapshot(
            netease_track.take().expect("NetEase track should exist"),
            captured_at_ms,
        ));
    }

    let Some(session) = session else {
        if (preferred_source.is_none() || preferred_netease) && let Some(track) = netease_track {
            return Ok(netease_media_snapshot(track, captured_at_ms));
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

    let mut position_ms = (timeline.Position().map_err(error_text)?.Duration / 10_000).max(0);
    let duration_ms = (timeline.EndTime().map_err(error_text)?.Duration / 10_000).max(0);
    let mut timeline_updated_at_ms = timeline
        .LastUpdatedTime()
        .ok()
        .and_then(|value| timeline_timestamp_ms(value.UniversalTime));
    if needs_netease_clock(&source)
        && let Some(netease_position_ms) = netease::current_position_ms()
    {
        position_ms = netease_position_ms;
        timeline_updated_at_ms = i64::try_from(captured_at_ms).ok();
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
async fn control_media(action: String, preferred_source: Option<String>) -> Result<bool, String> {
    let Some(session) = active_media_session(preferred_source.as_deref()).await? else {
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
            ("yv", "-1"),
            ("os", "pc"),
        ])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let native = response.json::<Value>().await.ok()?;
    native["yrc"]["lyric"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| native["lrc"]["lyric"].as_str().filter(|value| !value.trim().is_empty()))
        .map(str::to_string)
}

async fn fetch_netease_lyrics(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration_ms: i64,
    track_id: &str,
) -> Option<LyricsResult> {
    if !track_id.is_empty()
        && track_id.chars().all(|character| character.is_ascii_digit())
        && let Some(lrc) = fetch_netease_lrc(client, track_id).await
    {
        return Some(LyricsResult {
            lrc,
            song_mid: format!("netease:{track_id}"),
            matched_title: title.to_string(),
            matched_artist: artist.to_string(),
        });
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

async fn fetch_qq_lrc(client: &reqwest::Client, song_mid: &str) -> Option<String> {
    let response = client
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
        .ok()?
        .error_for_status()
        .ok()?;
    let lyric = response.json::<Value>().await.ok()?;
    lyric["lyric"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(decode_entities)
}

fn lyrics_http_client() -> &'static reqwest::Client {
    LYRICS_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(7))
            .user_agent(concat!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiverXILeeDesktopLyrics/", env!("CARGO_PKG_VERSION")))
            .build().expect("lyrics HTTP client should initialize")
    })
}

#[tauri::command]
async fn search_lyrics_candidates(
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
) -> Result<Vec<LyricsCandidate>, String> {
    if title.trim().is_empty() {
        return Err("当前歌曲没有可用于搜索的标题".to_string());
    }
    let client = lyrics_http_client();
    let mut results = Vec::new();
    let mut seen = HashSet::new();

    for query in lyric_search_queries(&title, &artist).into_iter().take(2) {
        if let Some(response) = client
            .get("https://music.163.com/api/search/get/web")
            .header("Referer", "https://music.163.com/")
            .query(&[("s", query.as_str()), ("type", "1"), ("limit", "12"), ("offset", "0")])
            .send().await.ok().and_then(|response| response.error_for_status().ok())
            && let Ok(search) = response.json::<Value>().await
            && let Some(candidates) = search["result"]["songs"].as_array()
        {
            for item in candidates {
                let Some(id) = item["id"].as_i64().map(|id| id.to_string()) else { continue };
                if !seen.insert(format!("netease:{id}")) { continue; }
                results.push(LyricsCandidate {
                    provider: "netease".to_string(),
                    id,
                    title: item["name"].as_str().unwrap_or_default().to_string(),
                    artist: netease_artist(item),
                    album: item["album"]["name"].as_str().unwrap_or_default().to_string(),
                    duration_ms: item["duration"].as_i64().unwrap_or_default(),
                    score: netease_candidate_score(item, &title, &artist, duration_ms).max(0),
                });
            }
        }

        if let Some(response) = client
            .get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp")
            .header("Referer", "https://y.qq.com/")
            .query(&[("p", "1"), ("n", "12"), ("w", query.as_str()), ("format", "json")])
            .send().await.ok().and_then(|response| response.error_for_status().ok())
            && let Ok(search) = response.json::<Value>().await
            && let Some(candidates) = search["data"]["song"]["list"].as_array()
        {
            for item in candidates {
                let Some(id) = item["songmid"].as_str().filter(|id| !id.is_empty()) else { continue };
                if !seen.insert(format!("qq:{id}")) { continue; }
                let item_artist = item["singer"].as_array().map(|singers| {
                    singers.iter().filter_map(|singer| singer["name"].as_str()).collect::<Vec<_>>().join(" / ")
                }).unwrap_or_default();
                results.push(LyricsCandidate {
                    provider: "qq".to_string(),
                    id: id.to_string(),
                    title: item["songname"].as_str().unwrap_or_default().to_string(),
                    artist: item_artist,
                    album: item["albumname"].as_str().unwrap_or_default().to_string(),
                    duration_ms: item["interval"].as_i64().unwrap_or_default() * 1_000,
                    score: candidate_score(item, &title, &artist, &album, duration_ms).max(0),
                });
            }
        }
    }
    results.sort_by_key(|candidate| std::cmp::Reverse(candidate.score));
    results.truncate(20);
    Ok(results)
}

#[tauri::command]
async fn fetch_lyrics_candidate(
    provider: String,
    id: String,
    title: String,
    artist: String,
) -> Result<LyricsResult, String> {
    if !(provider == "netease" && !id.is_empty() && id.len() <= 20 && id.chars().all(|character| character.is_ascii_digit())
        || provider == "qq" && (8..=32).contains(&id.len()) && id.chars().all(|character| character.is_ascii_alphanumeric())) {
        return Err("歌曲标识无效".to_string());
    }
    let client = lyrics_http_client();
    let lrc = match provider.as_str() {
        "netease" => fetch_netease_lrc(client, &id).await,
        "qq" => fetch_qq_lrc(client, &id).await,
        _ => return Err("不支持的歌词来源".to_string()),
    }
    .ok_or_else(|| "这个版本没有可用的时间轴歌词".to_string())?;
    Ok(LyricsResult {
        lrc,
        song_mid: format!("{provider}:{id}"),
        matched_title: title,
        matched_artist: artist,
    })
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
            .user_agent(concat!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiverXILeeDesktopLyrics/", env!("CARGO_PKG_VERSION")))
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
    let asset = release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset["name"]
                    .as_str()
                    .is_some_and(|name| name.ends_with("_x64-setup.exe"))
            })
        })
        .ok_or_else(|| "最新版本没有 Windows x64 安装包".to_string())?;
    let download_url = asset["browser_download_url"]
        .as_str()
        .ok_or_else(|| "安装包下载地址不完整".to_string())?
        .to_string();
    let digest = asset["digest"]
        .as_str()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| {
            value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| "安装包缺少 SHA-256 校验信息".to_string())?
        .to_ascii_lowercase();

    Ok(UpdateInfo {
        available: is_newer_version(&latest_version, &current_version),
        current_version,
        latest_version,
        download_url,
        download_size: asset["size"].as_u64().unwrap_or_default(),
        release_notes: release["body"].as_str().unwrap_or_default().to_string(),
        sha256: digest,
    })
}

#[tauri::command]
async fn download_update(app: AppHandle, expected_version: String) -> Result<String, String> {
    let update = check_for_update().await?;
    if !update.available || update.latest_version != expected_version {
        return Err("版本信息已经变化，请重新检查更新".to_string());
    }

    let response = HTTP_CLIENT
        .get_or_init(reqwest::Client::new)
        .get(&update.download_url)
        .send()
        .await
        .map_err(error_text)?
        .error_for_status()
        .map_err(error_text)?;
    let total_bytes = response.content_length().unwrap_or(update.download_size);
    let file_name = format!(
        "RiverXILee-Desktop-Lyrics_{}_x64-setup.exe",
        update.latest_version
    );
    let installer_path = std::env::temp_dir().join(file_name);
    let mut installer = fs::File::create(&installer_path).map_err(error_text)?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded_bytes = 0_u64;

    use futures_lite::StreamExt;
    let download_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(error_text)?;
            installer.write_all(&chunk).map_err(error_text)?;
            hasher.update(&chunk);
            downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
            let percent = if total_bytes > 0 {
                ((downloaded_bytes.saturating_mul(100) / total_bytes).min(100)) as u8
            } else {
                0
            };
            let _ = app.emit(
                "update-download-progress",
                UpdateDownloadProgress {
                    downloaded_bytes,
                    total_bytes,
                    percent,
                    status: "downloading".to_string(),
                },
            );
        }
        installer.flush().map_err(error_text)
    }
    .await;
    if let Err(error) = download_result {
        drop(installer);
        let _ = fs::remove_file(&installer_path);
        return Err(error);
    }
    drop(installer);

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != update.sha256 {
        let _ = fs::remove_file(&installer_path);
        return Err("更新包校验失败，文件已安全删除".to_string());
    }
    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            downloaded_bytes,
            total_bytes,
            percent: 100,
            status: "verified".to_string(),
        },
    );
    Ok(installer_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn launch_update(app: AppHandle, installer_path: String) -> Result<(), String> {
    let installer_path = fs::canonicalize(&installer_path).map_err(error_text)?;
    let temp_directory = fs::canonicalize(std::env::temp_dir()).map_err(error_text)?;
    let file_name = installer_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !installer_path.starts_with(&temp_directory)
        || !file_name.starts_with("RiverXILee-Desktop-Lyrics_")
        || !file_name.ends_with("_x64-setup.exe")
    {
        return Err("更新安装包路径无效".to_string());
    }

    Command::new(&installer_path)
        .arg("/R")
        .spawn()
        .map_err(error_text)?;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(450));
        app.exit(0);
    });
    Ok(())
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
    tokio::time::timeout(Duration::from_secs(25), fetch_lyrics_inner(title, artist, album, duration_ms, source, track_id))
        .await.map_err(|_| "在线歌词查询超时，请稍后重试或指定歌词".to_string())?
}

async fn fetch_lyrics_inner(
    title: String, artist: String, album: String, duration_ms: i64, source: String, track_id: String,
) -> Result<LyricsResult, String> {
    if title.trim().is_empty() {
        return Err("当前播放器暂未提供歌曲名称".to_string());
    }
    let client = lyrics_http_client();
    if source.to_ascii_lowercase().contains("cloudmusic")
        && let Some(result) =
            fetch_netease_lyrics(client, &title, &artist, duration_ms, &track_id).await
    {
        return Ok(result);
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
            let Some(lrc) = fetch_qq_lrc(client, song_mid).await else { continue };
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
                lrc,
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
    fn enumerates_installed_windows_font_families() {
        let fonts = super::list_system_fonts().expect("Windows fonts should be readable");
        println!("detected {} installed font families", fonts.len());
        assert!(fonts.len() > 10);
        assert!(fonts.iter().all(|font| !font.family.is_empty() && !font.family.starts_with('@')));
    }

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
        assert!(super::is_newer_version("v1.1.1", "1.1.0"));
        assert!(super::is_newer_version("1.10.0", "1.9.9"));
        assert!(!super::is_newer_version("v1.1.0", "1.1.0"));
        assert!(!super::is_newer_version("1.0.9", "1.1.0"));
    }

    #[test]
    #[ignore = "live GitHub Releases API check"]
    fn reads_the_live_github_release_feed() {
        let update = tauri::async_runtime::block_on(super::check_for_update())
            .expect("GitHub latest release should be readable");
        assert_eq!(update.current_version, env!("CARGO_PKG_VERSION"));
        assert!(!update.latest_version.is_empty());
        assert!(update.download_url.starts_with("https://github.com/"));
        assert_eq!(update.sha256.len(), 64);
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

    #[test]
    #[ignore = "live manual lyric candidate regression check"]
    fn searches_and_fetches_manual_lyric_candidates() {
        tauri::async_runtime::block_on(async {
            let candidates = super::search_lyrics_candidates(
                "Supernova".to_string(),
                "aespa".to_string(),
                "Supernova".to_string(),
                178_000,
            )
            .await
            .expect("candidate search should succeed");
            let candidate = candidates
                .into_iter()
                .find(|candidate| candidate.score >= 220)
                .expect("an exact candidate should be present");
            let result = super::fetch_lyrics_candidate(
                candidate.provider,
                candidate.id,
                candidate.title,
                candidate.artist,
            )
            .await
            .expect("selected candidate should have timed lyrics");
            assert!(!result.lrc.trim().is_empty());
        });
    }

    #[test]
    #[ignore = "live dual-player selection regression check"]
    fn prefers_advancing_netease_over_an_idle_qq_music_session() {
        let snapshot = tauri::async_runtime::block_on(async {
            let _ = super::get_media_snapshot(None).await;
            std::thread::sleep(std::time::Duration::from_millis(900));
            super::get_media_snapshot(None)
                .await
                .expect("media snapshot should be available")
        });
        assert_eq!(snapshot.source, "cloudmusic.exe");
        assert!(snapshot.is_playing);
        assert!(!snapshot.title.is_empty());
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
    save_window_placement(&window)?;
    window.hide().map_err(error_text)
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(error_text)
}

#[tauri::command]
fn reset_window_placement(window: WebviewWindow) -> Result<(), String> {
    window.center().map_err(error_text)?;
    save_window_placement(&window)
}

#[tauri::command]
fn set_window_visible(window: WebviewWindow, visible: bool) -> Result<(), String> {
    if visible {
        window.show().map_err(error_text)?;
        window.set_focus().map_err(error_text)
    } else {
        save_window_placement(&window)?;
        window.hide().map_err(error_text)
    }
}

#[tauri::command]
fn load_preferences(app: AppHandle) -> Result<Option<Value>, String> {
    let path = state_file(&app, "preferences.json")?;
    if !path.exists() {
        return Ok(None);
    }
    let value = serde_json::from_slice(&fs::read(path).map_err(error_text)?)
        .map_err(error_text)?;
    Ok(Some(value))
}

#[tauri::command]
fn save_preferences(app: AppHandle, preferences: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(error_text)?;
    fs::write(state_file(&app, "preferences.json")?, bytes).map_err(error_text)
}

#[tauri::command]
async fn save_display_backup(app: AppHandle, contents: String) -> Result<bool, String> {
    if contents.len() > 1_048_576 { return Err("显示备份过大".to_string()); }
    let backup: Value = serde_json::from_str(&contents).map_err(error_text)?;
    if backup["format"] != "riverxilee-display-profiles" || backup["version"] != 1 {
        return Err("显示备份格式无效".to_string());
    }
    let Some(path) = app.dialog().file().add_filter("RiverXILee 显示备份", &["json"])
        .set_file_name("RiverXILee-display-backup.json").blocking_save_file() else { return Ok(false); };
    let path = path.into_path().map_err(error_text)?;
    fs::write(path, contents).map_err(error_text)?;
    Ok(true)
}

#[tauri::command]
fn set_global_shortcuts(
    app: AppHandle,
    shortcuts: HashMap<String, String>,
) -> Result<Vec<String>, String> {
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
    for (action, value) in shortcuts {
        let shortcut = Shortcut::from_str(value.trim())
            .map_err(|_| format!("快捷键格式无效：{value}"))?;
        if !seen.insert(shortcut.id()) {
            return Err(format!("快捷键重复：{value}"));
        }
        parsed.push((shortcut, action));
    }

    let manager = app.global_shortcut();
    manager.unregister_all().map_err(error_text)?;
    let mut unavailable = Vec::new();
    let mut registered = HashMap::new();
    for (shortcut, action) in parsed {
        if manager.register(shortcut).is_ok() {
            registered.insert(shortcut.id(), action);
        } else {
            unavailable.push(action);
        }
    }
    let actions = SHORTCUT_ACTIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut actions = actions.lock().map_err(|_| "无法保存快捷键".to_string())?;
    actions.clear();
    actions.extend(registered);
    Ok(unavailable)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("single-instance-activated", ());
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("RiverXILee桌面歌词")
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let action = SHORTCUT_ACTIONS
                            .get_or_init(|| Mutex::new(HashMap::new()))
                            .lock()
                            .ok()
                            .and_then(|actions| actions.get(&shortcut.id()).cloned());
                        if let Some(action) = action {
                            let _ = app.emit("global-shortcut", action);
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window_placement(&window)?;
                watch_window_placement(&window);
            }
            let _ = app.global_shortcut().register("Ctrl+Shift+L");
            if let Ok(shortcut) = Shortcut::from_str("Ctrl+Shift+L") {
                SHORTCUT_ACTIONS
                    .get_or_init(|| Mutex::new(HashMap::new()))
                    .lock()
                    .expect("shortcut actions should initialize")
                    .insert(shortcut.id(), "toggleLock".to_string());
            }
            let tray_menu = MenuBuilder::new(app)
                .text("toggle-visibility", "显示或隐藏歌词")
                .text("toggle-lock", "锁定或解锁")
                .text("resync", "重新同步")
                .separator()
                .text("quit", "退出 RiverXILee桌面歌词")
                .build()?;
            let mut tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("RiverXILee桌面歌词")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle-visibility" => {
                        let _ = app.emit("global-shortcut", "toggleVisibility");
                    }
                    "toggle-lock" => {
                        let _ = app.emit("global-shortcut", "toggleLock");
                    }
                    "resync" => {
                        let _ = app.emit("global-shortcut", "resync");
                    }
                    "quit" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = save_window_placement(&window);
                        }
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_media_snapshot,
            list_media_sessions,
            list_system_fonts,
            control_media,
            fetch_lyrics,
            search_lyrics_candidates,
            fetch_lyrics_candidate,
            check_for_update,
            download_update,
            launch_update,
            set_always_on_top,
            set_fullscreen,
            set_click_through,
            minimize_window,
            close_window,
            start_dragging,
            reset_window_placement,
            set_window_visible,
            load_preferences,
            save_preferences,
            save_display_backup,
            set_global_shortcuts
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RiverXILee桌面歌词");
}
