// Public KuGou catalog -> recording hash -> candidate-scoped lyric key -> LRC.
// Protocol reference: BrimDeck KugouLyrics (Apache-2.0). No login credentials.
use super::{LyricsCandidate, LyricsResult, lyric_lookup, lyric_matching};
use base64::Engine;
use serde_json::Value;

pub fn valid_hash(hash: &str) -> bool { hash.len()==32 && hash.bytes().all(|b| b.is_ascii_hexdigit()) }
fn duration(value: &Value) -> i64 { value.as_i64().or_else(|| value.as_str()?.parse().ok()).unwrap_or(0) }
fn recording_matches(title: &str, artist: &str, length: i64, found_title: &str, found_artist: &str, found_length: i64) -> bool {
    let singers: Vec<_> = found_artist.split(['、','/','&',',','，',';','；']).map(str::trim).filter(|v| !v.is_empty()).collect();
    !title.trim().is_empty() && !artist.trim().is_empty()
        && super::normalize(title)==super::normalize(found_title)
        && lyric_matching::version_tags(title)==lyric_matching::version_tags(found_title)
        && lyric_matching::artists_match(artist,&singers)
        && (length<=0 || found_length>0 && length.abs_diff(found_length)<=2500)
}
pub async fn candidates(client: &reqwest::Client, title: &str, artist: &str, length: i64) -> Result<Vec<LyricsCandidate>,String> {
    let query = format!("{title} {artist}");
    let root = lyric_lookup::json(client.get("https://mobiles.kugou.com/api/v3/search/song")
        .query(&[("format","json"),("page","1"),("pagesize","20"),("showtype","1"),("keyword",query.as_str())]),"酷狗音乐").await?;
    let mut seen = std::collections::HashSet::new();
    Ok(root["data"]["info"].as_array().into_iter().flatten().take(20).filter_map(|song| {
        let hash = song["hash"].as_str()?; if !valid_hash(hash) || !seen.insert(hash.to_ascii_lowercase()) { return None; }
        let found_title = song["songname"].as_str().unwrap_or_default(); let found_artist = song["singername"].as_str().unwrap_or_default();
        let found_length = duration(&song["duration"]).checked_mul(1000).unwrap_or(0);
        Some(LyricsCandidate { provider:"kugou".into(),id:hash.to_ascii_lowercase(),title:found_title.into(),artist:found_artist.into(),
            album:song["album_name"].as_str().unwrap_or_default().into(),duration_ms:found_length,
            score:if recording_matches(title,artist,length,found_title,found_artist,found_length) { 300 - (length.abs_diff(found_length)/250).min(100) as i64 } else { 0 } })
    }).collect())
}
fn download_body(value: &Value) -> Option<lyric_lookup::LyricBody> {
    let content = value["content"].as_str().filter(|s| s.len()<=2_800_000)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(content).ok()?;
    if bytes.len()>2_000_000 { return None; } let text = String::from_utf8(bytes).ok()?;
    if lyric_lookup::instrumental_text(&text) { Some(lyric_lookup::LyricBody::Instrumental) }
    else if lyric_lookup::has_timed_text(&text) { Some(lyric_lookup::LyricBody::Timed(text,None)) } else { None }
}
pub async fn by_hash(client: &reqwest::Client, hash: &str, title: &str, artist: &str, length: i64) -> Result<Option<lyric_lookup::LyricBody>,String> {
    if !valid_hash(hash) { return Err("酷狗录音标识无效".into()); }
    let length_text = length.max(0).to_string();
    let root = lyric_lookup::json(client.get("https://krcs.kugou.com/search")
        .query(&[("ver","1"),("man","yes"),("client","mobi"),("keyword",""),("duration",length_text.as_str()),("hash",hash)]),"酷狗音乐").await?;
    for candidate in root["candidates"].as_array().into_iter().flatten().take(6) {
        let id = candidate["id"].as_str().unwrap_or_default(); let key = candidate["accesskey"].as_str().unwrap_or_default();
        if id.is_empty() || id.len()>16 || !id.bytes().all(|b| b.is_ascii_digit()) || !(16..=64).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_hexdigit()) { continue; }
        let found_length = duration(&candidate["duration"]);
        if length>0 && (found_length<=0 || length.abs_diff(found_length)>2500) { continue; }
        // Hash identifies a recording, but reject an explicitly conflicting lyric attribution.
        let found_title = candidate["song"].as_str().unwrap_or(title); let found_artist = candidate["singer"].as_str().unwrap_or(artist);
        if !recording_matches(title,artist,length,found_title,found_artist,found_length) { continue; }
        let value = lyric_lookup::json(client.get("https://lyrics.kugou.com/download").query(&[("ver","1"),("client","pc"),("id",id),("accesskey",key),("fmt","lrc"),("charset","utf8")]),"酷狗音乐").await?;
        if let Some(body) = download_body(&value) { return Ok(Some(body)); }
    } Ok(None)
}
pub async fn fetch(client: &reqwest::Client, title: &str, artist: &str, length: i64, track_id: &str) -> Result<Option<LyricsResult>,String> {
    let exact = track_id.strip_prefix("kugou:").filter(|hash| valid_hash(hash));
    if let Some(hash) = exact {
        // An exact current recording must never silently become a different hash.
        return Ok(by_hash(client,hash,title,artist,length).await?.map(|body| lyric_lookup::make_result(body,format!("kugou:{}",hash.to_ascii_lowercase()),title.into(),artist.into())));
    }
    let mut songs = candidates(client,title,artist,length).await?; songs.sort_by_key(|c|std::cmp::Reverse(c.score));
    for song in songs.into_iter().filter(|c|c.score>0).take(3) {
        if let Some(body) = by_hash(client,&song.id,&song.title,&song.artist,length).await? {
            return Ok(Some(lyric_lookup::make_result(body,format!("kugou:{}",song.id),song.title,song.artist)));
        }
    } Ok(None)
}
#[cfg(test)] mod tests {
    use super::*; use serde_json::json;
    #[test] fn exact_title_artist_version_and_duration_prevent_cross_recording_matches() {
        assert!(recording_matches("晴天","周杰伦",269000,"晴天","周杰伦",269000));
        for (title,artist,length) in [("晴天 (Live)","周杰伦",269000),("晴天","其他歌手",269000),("晴天","周杰伦",200000)] {
            assert!(!recording_matches("晴天","周杰伦",269000,title,artist,length));
        }
        assert!(!recording_matches("晴天","",269000,"晴天","周杰伦",269000));
        assert!(!valid_hash("../invalid")); assert!(valid_hash("0123456789ABCDEF0123456789ABCDEF"));
    }
    #[test] fn malformed_or_untimed_downloads_are_not_valid_lyrics() {
        for text in ["无时间标签","<html>error</html>"] {
            assert!(download_body(&json!({"content":base64::engine::general_purpose::STANDARD.encode(text)})).is_none());
        }
        assert!(download_body(&json!({"content":"%%%%"})).is_none());
        assert!(download_body(&json!({"content":base64::engine::general_purpose::STANDARD.encode("[00:01.00]测试歌词")})).is_some());
    }
    #[test] #[ignore = "read-only live KuGou native public lyric lookup"]
    fn live_native_lyrics() {
        let result = tauri::async_runtime::block_on(fetch(super::super::lyrics_http_client(),"晴天","周杰伦",0,"")).unwrap().expect("KuGou timed lyrics");
        println!("KuGou native result: id={} title={} artist={} timed_lines={}",result.song_mid,result.matched_title,result.matched_artist,result.lrc.lines().count());
        assert!(result.song_mid.starts_with("kugou:")); assert!(lyric_lookup::has_timed_text(&result.lrc));
    }
}
