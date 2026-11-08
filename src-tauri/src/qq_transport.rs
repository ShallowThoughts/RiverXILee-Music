// QQ's local media transport, independently implemented from the protocol
// documented by BrimDeck/Native/QqMediaConnection.cs (Apache-2.0).
// No injection, client patching, account credentials, or UI input is used.
use serde_json::{Value, json};
use std::{fs::{File, OpenOptions}, io::{Read, Write}, os::windows::io::AsRawHandle,
    path::Path, time::{Duration, Instant}};
use windows::{Win32::{Foundation::{CloseHandle, HANDLE}, System::{
    Pipes::{GetNamedPipeServerProcessId, SetNamedPipeHandleState, PIPE_NOWAIT},
    Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION}}}, core::PWSTR};

const PIPE: &str = r"\\.\pipe\y.qq.com\QQMusicTransportServer";
const MAX_MESSAGE: usize = 65_536;

pub fn is_qq(source: &str) -> bool { source.to_ascii_lowercase().contains("qqmusic") }

fn verify_owner(file: &File) -> Result<(), String> {
    unsafe {
        let mut pid = 0;
        GetNamedPipeServerProcessId(HANDLE(file.as_raw_handle()), &mut pid)
            .map_err(|_| "无法核验 QQ 音乐控制通道".to_string())?;
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|_| "无法核验 QQ 音乐进程".to_string())?;
        let mut image = [0u16; 32768];
        let mut length = image.len() as u32;
        let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut length);
        let _ = CloseHandle(process);
        result.map_err(|_| "无法读取 QQ 音乐控制通道归属".to_string())?;
        let name = String::from_utf16_lossy(&image[..length as usize]);
        if !Path::new(&name).file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("QQMusic.exe")) {
            return Err("QQ 音乐控制通道归属异常，已取消操作".into());
        }
    }
    Ok(())
}

fn receive(file: &mut File, pending: &mut Vec<u8>, deadline: Instant) -> Result<Value, String> {
    loop {
        if let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            return serde_json::from_slice(&line).map_err(|_| "QQ 音乐控制响应格式异常".into());
        }
        if Instant::now() >= deadline { return Err("QQ 音乐控制通道响应超时".into()); }
        let mut bytes = [0u8; 4096];
        match file.read(&mut bytes) {
            // PIPE_NOWAIT can complete an empty read while the server prepares a reply.
            Ok(0) => std::thread::sleep(Duration::from_millis(15)),
            Ok(count) => {
                if pending.len() + count > MAX_MESSAGE { return Err("QQ 音乐控制响应过大".into()); }
                pending.extend_from_slice(&bytes[..count]);
            }
            Err(error) if error.raw_os_error() == Some(232) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => return Err("读取 QQ 音乐控制通道失败".into()),
        }
    }
}

fn send(file: &mut File, value: Value) -> Result<(), String> {
    file.write_all(format!("{value}\n").as_bytes()).map_err(|_| "向 QQ 音乐发送进度操作失败".into())
}

fn same_song(data: &Value, title: &str, artist: &str) -> bool {
    super::normalize(data["title"].as_str().unwrap_or_default()) == super::normalize(title)
        && super::normalize(data["singer"].as_str().unwrap_or_default()) == super::normalize(artist)
}

fn target_position(position: i64, duration: i64) -> Result<i64, String> {
    if position < 0 || duration <= 0 || duration > 604_800_000 { return Err("QQ 音乐未提供有效的可跳转区间".into()); }
    Ok(position.min(duration - 1))
}

pub fn seek(position: i64, title: &str, artist: &str) -> Result<i64, String> {
    let mut file = OpenOptions::new().read(true).write(true).open(PIPE)
        .map_err(|_| "QQ 音乐本地控制通道不可用，请保持客户端运行后重试".to_string())?;
    verify_owner(&file)?;
    unsafe { SetNamedPipeHandleState(HANDLE(file.as_raw_handle()), Some(&PIPE_NOWAIT), None, None) }
        .map_err(|_| "无法设置 QQ 音乐控制通道超时保护".to_string())?;
    send(&mut file, json!({"cmd":"login", "params":{"appName":"RiverXILee", "appKey":"RiverXILee"}}))?;
    let mut pending = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(1500);
    let (mut logged_in, mut matched, mut duration) = (false, false, 0);
    while !logged_in || !matched || duration <= 0 {
        let message = receive(&mut file, &mut pending, deadline)?;
        if message["reply"] == "login" {
            if message["code"].as_i64() != Some(0) { return Err("QQ 音乐未接受本应用的媒体控制连接".into()); }
            logged_in = true;
        }
        if message["notify"] == "song" {
            if !same_song(&message["data"], title, artist) { return Err("歌曲已切换，本次进度调整已取消".into()); }
            matched = true;
        }
        if message["notify"] == "progress" { duration = message["data"]["duration"].as_i64().unwrap_or(0); }
    }
    let target = target_position(position, duration)?;
    // Drop complete pre-command messages, but retain a fragmented packet's tail.
    if let Some(end) = pending.iter().rposition(|byte| *byte == b'\n') { pending.drain(..=end); }
    send(&mut file, json!({"cmd":"seek", "params":{"value":target}}))?;
    let deadline = Instant::now() + Duration::from_millis(2000);
    loop {
        let message = receive(&mut file, &mut pending, deadline)?;
        if message["notify"] == "song" && !same_song(&message["data"], title, artist) {
            return Err("歌曲已切换，本次进度调整已取消".into());
        }
        if message["notify"] == "progress" && let Some(actual) = message["data"]["playtime"].as_i64()
            && actual >= 0 && actual <= duration && (actual - target).abs() <= 1500 { return Ok(actual); }
        if message["reply"] == "seek" && message["code"].as_i64().is_some_and(|code| code != 0) {
            return Err("QQ 音乐未接受进度跳转".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_song_and_bounds_before_dispatch() {
        assert!(same_song(&json!({"title":"Test", "singer":"A / B"}), "Test", "A&B"));
        assert!(!same_song(&json!({"title":"Other", "singer":"A"}), "Test", "A"));
        assert_eq!(target_position(2000, 1000).unwrap(), 999);
        assert!(target_position(-1, 1000).is_err());
        assert!(target_position(1000, 0).is_err());
        assert!(target_position(1000, i64::MAX).is_err());
        assert!(!is_qq("cloudmusic.exe"));
        assert!(is_qq("QQMusic.exe"));
    }
}
