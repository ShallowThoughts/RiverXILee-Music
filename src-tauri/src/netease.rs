use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{
    EnumProcessModulesEx, GetModuleBaseNameW, GetModuleInformation, LIST_MODULES_ALL, MODULEINFO,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

const CLOCK_PATTERN: [Option<u8>; 12] = [
    Some(0xf2),
    Some(0x0f),
    Some(0x11),
    Some(0x3d),
    None,
    None,
    None,
    None,
    Some(0xf2),
    Some(0x0f),
    Some(0x11),
    Some(0x35),
];
const MAX_MODULE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy)]
struct NeteaseClock {
    process_id: u32,
    address: usize,
}

static CLOCK: OnceLock<Mutex<Option<NeteaseClock>>> = OnceLock::new();
static LAST_TRACK: OnceLock<Mutex<Option<PlaybackSample>>> = OnceLock::new();

pub struct TrackSnapshot {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub is_playing: bool,
}

struct TrackMetadata {
    track_id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
}

struct PlaybackSample {
    title: String,
    artist: String,
    position_ms: i64,
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn open_process(process_id: u32) -> Option<ProcessHandle> {
    unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            process_id,
        )
        .ok()
        .map(ProcessHandle)
    }
}

fn read_memory(handle: HANDLE, address: usize, buffer: &mut [u8]) -> bool {
    let mut bytes_read = 0;
    unsafe {
        ReadProcessMemory(
            handle,
            address as *const c_void,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            Some(&mut bytes_read),
        )
        .is_ok()
            && bytes_read == buffer.len()
    }
}

fn clock_instruction_offset(module: &[u8]) -> Option<usize> {
    module.windows(CLOCK_PATTERN.len()).position(|window| {
        CLOCK_PATTERN
            .iter()
            .zip(window)
            .all(|(expected, actual)| expected.is_none_or(|value| value == *actual))
    })
}

fn clock_address(module_base: usize, module: &[u8]) -> Option<usize> {
    let instruction = clock_instruction_offset(module)?;
    let displacement =
        i32::from_le_bytes(module[instruction + 4..instruction + 8].try_into().ok()?);
    module_base
        .checked_add(instruction + 8)?
        .checked_add_signed(displacement as isize)
}

fn netease_process_ids() -> Vec<u32> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let snapshot = ProcessHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
        return Vec::new();
    }

    let mut process_ids = Vec::new();
    loop {
        let name_len = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..name_len])
            .eq_ignore_ascii_case("cloudmusic.exe")
        {
            process_ids.push(entry.th32ProcessID);
        }
        if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
            break;
        }
    }
    process_ids
}

fn parse_history_track(kind: &str, json: &str) -> Option<TrackMetadata> {
    if kind != "track" {
        return None;
    }
    let track: Value = serde_json::from_str(json).ok()?;
    let title = track["name"].as_str()?.trim();
    let artists = track["artists"].as_array()?;
    let artist = artists
        .iter()
        .filter_map(|artist| artist["name"].as_str())
        .filter(|artist| !artist.trim().is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if title.is_empty() || artist.is_empty() {
        return None;
    }
    Some(TrackMetadata {
        track_id: track["id"]
            .as_i64()
            .map(|value| value.to_string())
            .or_else(|| track["id"].as_str().map(str::to_string))
            .unwrap_or_default(),
        title: title.to_string(),
        artist,
        album: track["album"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        duration_ms: track["duration"].as_i64().unwrap_or_default().max(0),
    })
}

fn current_database_track() -> Option<TrackMetadata> {
    let database = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("NetEase")
        .join("CloudMusic")
        .join("Library")
        .join("webdb.dat");
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    latest_history_track(&connection)
}

pub fn current_track_id(title: &str, artist: &str) -> Option<String> {
    fn normalized(value: &str) -> String {
        value
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }
    let track = current_database_track()?;
    let wanted_artist = normalized(artist);
    let found_artist = normalized(&track.artist);
    let matches = normalized(&track.title) == normalized(title)
        && (wanted_artist.is_empty()
            || found_artist.contains(&wanted_artist)
            || wanted_artist.contains(&found_artist));
    (matches
        && !track.track_id.is_empty()
        && track
            .track_id
            .chars()
            .all(|character| character.is_ascii_digit()))
    .then_some(track.track_id)
}

fn latest_history_track(connection: &Connection) -> Option<TrackMetadata> {
    let (kind, json): (String, String) = connection
        .query_row(
            "SELECT kind, jsonStr FROM (\
             SELECT 'track' AS kind, playtime, jsonStr FROM historyTracks \
             UNION ALL SELECT 'voice', playtime, jsonStr FROM historyVoices \
             UNION ALL SELECT 'audio', playtime, jsonStr FROM historyAudios\
             ) ORDER BY playtime DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    parse_history_track(&kind, &json)
}

fn playback_is_advancing(
    previous: Option<&PlaybackSample>,
    title: &str,
    artist: &str,
    position_ms: i64,
) -> bool {
    previous.is_none_or(|sample| {
        sample.title != title || sample.artist != artist || sample.position_ms != position_ms
    })
}

fn find_clock() -> Option<NeteaseClock> {
    for process_id in netease_process_ids() {
        let Some(process) = open_process(process_id) else {
            continue;
        };
        let mut modules = [HMODULE::default(); 512];
        let mut module_bytes = 0;
        if unsafe {
            EnumProcessModulesEx(
                process.0,
                modules.as_mut_ptr(),
                size_of_val(&modules) as u32,
                &mut module_bytes,
                LIST_MODULES_ALL,
            )
        }
        .is_err()
        {
            continue;
        }

        for module in modules
            .into_iter()
            .take(module_bytes as usize / size_of::<HMODULE>())
        {
            let mut name = [0u16; 260];
            let name_len =
                unsafe { GetModuleBaseNameW(process.0, Some(module), &mut name) } as usize;
            if name_len == 0
                || !String::from_utf16_lossy(&name[..name_len])
                    .eq_ignore_ascii_case("cloudmusic.dll")
            {
                continue;
            }

            let mut info = MODULEINFO::default();
            if unsafe {
                GetModuleInformation(process.0, module, &mut info, size_of::<MODULEINFO>() as u32)
            }
            .is_err()
            {
                continue;
            }
            let module_size = info.SizeOfImage as usize;
            if module_size == 0 || module_size > MAX_MODULE_BYTES {
                continue;
            }
            let module_base = info.lpBaseOfDll as usize;
            let mut image = vec![0u8; module_size];
            if !read_memory(process.0, module_base, &mut image) {
                continue;
            }
            if let Some(address) = clock_address(module_base, &image) {
                return Some(NeteaseClock {
                    process_id,
                    address,
                });
            }
        }
    }
    None
}

fn read_clock(clock: NeteaseClock) -> Option<i64> {
    let process = open_process(clock.process_id)?;
    let mut bytes = [0u8; 8];
    if !read_memory(process.0, clock.address, &mut bytes) {
        return None;
    }
    let seconds = f64::from_le_bytes(bytes);
    (seconds.is_finite() && (0.0..=604_800.0).contains(&seconds))
        .then_some((seconds * 1_000.0).round() as i64)
}

pub fn current_position_ms() -> Option<i64> {
    let mut cached = CLOCK.get_or_init(|| Mutex::new(None)).lock().ok()?;
    if let Some(position) = cached.and_then(read_clock) {
        return Some(position);
    }
    *cached = find_clock();
    cached.and_then(read_clock)
}

pub fn current_track() -> Option<TrackSnapshot> {
    let metadata = current_database_track()?;
    let position_ms = current_position_ms()?;
    let mut previous = LAST_TRACK.get_or_init(|| Mutex::new(None)).lock().ok()?;
    let is_playing = playback_is_advancing(
        previous.as_ref(),
        &metadata.title,
        &metadata.artist,
        position_ms,
    );
    *previous = Some(PlaybackSample {
        title: metadata.title.clone(),
        artist: metadata.artist.clone(),
        position_ms,
    });
    Some(TrackSnapshot {
        track_id: metadata.track_id,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        position_ms,
        duration_ms: metadata.duration_ms,
        is_playing,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{
        PlaybackSample, clock_address, clock_instruction_offset, latest_history_track,
        parse_history_track, playback_is_advancing,
    };

    #[test]
    fn locates_netease_clock_instruction_and_resolves_its_address() {
        let mut image = vec![0u8; 64];
        image[20..32].copy_from_slice(&[
            0xf2, 0x0f, 0x11, 0x3d, 0x20, 0x00, 0x00, 0x00, 0xf2, 0x0f, 0x11, 0x35,
        ]);
        assert_eq!(clock_instruction_offset(&image), Some(20));
        assert_eq!(clock_address(0x1000, &image), Some(0x103c));
    }

    #[test]
    fn rejects_images_without_the_netease_clock_instruction() {
        assert_eq!(clock_instruction_offset(&[0u8; 64]), None);
    }

    #[test]
    fn parses_only_regular_tracks_from_netease_history() {
        let json = r#"{
          "id":1842801267,
          "name":"知我",
          "duration":277321,
          "artists":[{"name":"国风堂"},{"name":"哦漏"}],
          "album":{"name":"知我"}
        }"#;
        let track = parse_history_track("track", json).expect("track should parse");
        assert_eq!(track.track_id, "1842801267");
        assert_eq!(track.title, "知我");
        assert_eq!(track.artist, "国风堂/哦漏");
        assert_eq!(track.album, "知我");
        assert_eq!(track.duration_ms, 277_321);
        assert!(parse_history_track("voice", json).is_none());
    }

    #[test]
    fn ignores_an_old_song_when_newer_netease_media_is_a_voice_program() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE historyTracks (playtime INTEGER, jsonStr TEXT);\
                 CREATE TABLE historyVoices (playtime INTEGER, jsonStr TEXT);\
                 CREATE TABLE historyAudios (playtime INTEGER, jsonStr TEXT);",
            )
            .unwrap();
        let song = r#"{"name":"知我","duration":277321,"artists":[{"name":"国风堂"}],"album":{"name":"知我"}}"#;
        connection
            .execute("INSERT INTO historyTracks VALUES (1, ?1)", [song])
            .unwrap();
        connection
            .execute("INSERT INTO historyVoices VALUES (2, '{}')", [])
            .unwrap();
        assert!(latest_history_track(&connection).is_none());

        connection
            .execute("INSERT INTO historyTracks VALUES (3, ?1)", [song])
            .unwrap();
        let current = latest_history_track(&connection).expect("newest song should be selected");
        assert_eq!(current.title, "知我");
    }

    #[test]
    fn infers_pause_from_an_unchanged_private_clock() {
        let previous = PlaybackSample {
            title: "知我".to_string(),
            artist: "国风堂/哦漏".to_string(),
            position_ms: 12_000,
        };
        assert!(!playback_is_advancing(
            Some(&previous),
            "知我",
            "国风堂/哦漏",
            12_000
        ));
        assert!(playback_is_advancing(
            Some(&previous),
            "知我",
            "国风堂/哦漏",
            12_500
        ));
        assert!(playback_is_advancing(Some(&previous), "下一首", "歌手", 0));
    }
}
