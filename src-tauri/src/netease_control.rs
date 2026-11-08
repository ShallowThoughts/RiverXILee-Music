// Temporary, explicitly consented control of NetEase's own local CEF player.
// Protocol reference: BrimDeck NeteaseSource/NeteaseBridgeScript (Apache-2.0).
// No client files, shortcuts, credentials or playback memory are modified.
use serde::Serialize;
use serde_json::{Value, json};
use std::{ffi::c_void, io::Read, net::{Ipv4Addr, Ipv6Addr, TcpListener}, path::PathBuf,
    process::Command, sync::{Mutex, OnceLock}, thread::sleep, time::{Duration, Instant}};
use windows::{core::{w, PCWSTR, PWSTR}, Win32::{Foundation::{CloseHandle, FILETIME, HWND},
    NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCP6ROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER},
    Networking::WinHttp::*, System::{Diagnostics::ToolHelp::*, Threading::*, RemoteDesktop::ProcessIdToSessionId},
    UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_YESNO, MB_DEFBUTTON2, MB_ICONWARNING, MB_TOPMOST}}};

const PURPOSE: &str = "即将临时重启网易云，以支持桌面歌词进度条跳转。\n\n音乐会中断；功能默认关闭，不修改网易云文件、快捷方式或开机启动设置，也不会在下次自动开启。\n\n继续查看第二次风险提醒？";
const RISK: &str = "二次提醒：临时模式会开放仅限本机的调试端口。\n\n同一台电脑上的其他程序或网页可能通过该端口访问或控制网易云内部页面，包括登录状态相关信息。请仅在信任当前电脑环境时开启。\n\n退出桌面歌词不会关闭网易云的端口！使用设置中的“关闭并恢复普通模式”，或完全退出网易云后正常重开，才能关闭端口。\n\n确认承担风险，并立即重启网易云启用？";
const RESTORE: &str = "将重启网易云并关闭本次临时调试端口，音乐会中断。\n\n是否关闭增强控制并恢复普通模式？";
static CONTROL: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

#[derive(Clone)]
struct Process { pid: u32, started: u64, path: PathBuf }
#[derive(Clone)]
struct Session { process: Process, port: u16, ready: bool, metadata: Value, refreshed: Instant }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub enabled: bool, pub needs_restart: bool }

fn state() -> &'static Mutex<Option<Session>> { CONTROL.get_or_init(|| Mutex::new(None)) }

fn process(pid: u32) -> Option<Process> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = [0u16; 32768]; let mut size = path.len() as u32;
        let mut created = FILETIME::default(); let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default(); let mut user = FILETIME::default();
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut size).is_ok()
            && GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle);
        if !ok { return None; }
        let path = PathBuf::from(String::from_utf16_lossy(&path[..size as usize]));
        if !path.file_name()?.to_string_lossy().eq_ignore_ascii_case("cloudmusic.exe") { return None; }
        Some(Process { pid, started: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64, path })
    }
}
fn alive(p: &Process) -> bool { process(p.pid).is_some_and(|now| now.started == p.started && now.path == p.path) }

fn main_process() -> Result<Process, String> {
    unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|_| "无法读取网易云进程")?;
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut entries = Vec::new();
        if Process32FirstW(handle, &mut entry).is_ok() { loop {
            let end = entry.szExeFile.iter().position(|v| *v == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("cloudmusic.exe") {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
            if Process32NextW(handle, &mut entry).is_err() { break; }
        }}
        let _ = CloseHandle(handle);
        let mut current_session = 0;
        ProcessIdToSessionId(std::process::id(), &mut current_session).map_err(|_| "无法核验当前登录会话")?;
        let candidates: Vec<_> = entries.iter().filter(|(_, parent)| !entries.iter().any(|(pid, _)| pid == parent))
            .filter_map(|(pid, _)| {
                let mut session = u32::MAX;
                (ProcessIdToSessionId(*pid, &mut session).is_ok() && session == current_session).then(|| process(*pid)).flatten()
            }).collect();
        if candidates.len() != 1 { return Err("请先正常打开一个网易云客户端，再重试".into()); }
        Ok(candidates[0].clone())
    }
}

pub fn status() -> Status {
    let Ok(mut session) = state().try_lock() else { return Status { enabled: false, needs_restart: true }; };
    if session.as_ref().is_some_and(|s| !alive(&s.process)) { *session = None; }
    Status { enabled: session.as_ref().is_some_and(|s| s.ready), needs_restart: session.is_some() }
}
pub fn can_seek() -> bool { status().enabled }

fn confirm(parent: usize, text: &str) -> bool {
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe { MessageBoxW(Some(HWND(parent as *mut c_void)), PCWSTR(text.as_ptr()), w!("RiverXILee桌面歌词 · 网易云增强控制"),
        MB_YESNO | MB_DEFBUTTON2 | MB_ICONWARNING | MB_TOPMOST) == IDYES }
}
fn double_confirm(mut ask: impl FnMut(&str) -> bool) -> bool { ask(PURPOSE) && ask(RISK) }

fn start(path: &PathBuf, port: Option<u16>) -> Result<(), String> {
    let mut command = Command::new(path);
    if let Some(parent) = path.parent() { command.current_dir(parent); }
    if let Some(port) = port { command.arg(format!("--remote-debugging-port={port}")).arg("--remote-debugging-address=127.0.0.1"); }
    command.spawn().map_err(|_| "无法启动网易云，请手动正常打开客户端".to_string())?;
    Ok(())
}
fn exit(p: &Process) -> Result<(), String> {
    if !alive(p) { return Err("网易云进程已变更，请重试".into()); }
    Command::new(&p.path).arg("--orpheus-startup=exit-process").spawn().map_err(|_| "无法请求网易云退出")?;
    let until = Instant::now() + Duration::from_secs(15);
    while alive(p) && Instant::now() < until { sleep(Duration::from_millis(150)); }
    if alive(p) { return Err("网易云未正常退出；未强制结束，请完全退出后重试".into()); }
    Ok(())
}

// Check both families before every CDP connection, including rejected wildcard listeners.
fn verify_listener(s: &Session) -> Result<(), String> {
    if !alive(&s.process) { return Err("网易云已重启，请重新启用增强控制".into()); }
    let mut owned = false;
    for family in [2u32, 23u32] {
        let mut bytes = 0;
        unsafe { GetExtendedTcpTable(None, &mut bytes, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0); }
        if bytes == 0 || bytes > 4_194_304 { return Err("无法核验本机调试端口".into()); }
        let mut table = vec![0u8; bytes as usize];
        if unsafe { GetExtendedTcpTable(Some(table.as_mut_ptr().cast()), &mut bytes, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) } != 0 {
            return Err("无法核验本机调试端口".into());
        }
        let count = u32::from_ne_bytes(table[..4].try_into().unwrap()) as usize;
        let row_size = if family == 2 { size_of::<MIB_TCPROW_OWNER_PID>() } else { size_of::<MIB_TCP6ROW_OWNER_PID>() };
        if count > (table.len() - 4) / row_size { return Err("端口信息异常".into()); }
        for row in table[4..].chunks_exact(row_size).take(count) {
            let (port, pid, local) = unsafe { if family == 2 {
                let r = std::ptr::read_unaligned(row.as_ptr().cast::<MIB_TCPROW_OWNER_PID>());
                (r.dwLocalPort, r.dwOwningPid, Ipv4Addr::from(r.dwLocalAddr.to_ne_bytes()).is_loopback())
            } else {
                let r = std::ptr::read_unaligned(row.as_ptr().cast::<MIB_TCP6ROW_OWNER_PID>());
                (r.dwLocalPort, r.dwOwningPid, Ipv6Addr::from(r.ucLocalAddr).is_loopback())
            }};
            if u16::from_be(port as u16) != s.port { continue; }
            if !local || pid != s.process.pid { return Err("调试端口并非网易云独占的本机回环端口，已拒绝连接".into()); }
            owned = true;
        }
    }
    if !owned { return Err("网易云尚未提供本机调试端口".into()); }
    Ok(())
}

fn websocket_path(url: &str, port: u16) -> Option<String> {
    let url = reqwest::Url::parse(url).ok()?;
    (url.scheme() == "ws" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
        && url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none()
        && url.path().starts_with("/devtools/page/") && url.path().len() < 256).then(|| url.path().to_string())
}
struct HttpHandle(*mut c_void);
impl HttpHandle {
    fn checked(raw: *mut c_void) -> Result<Self, String> { if raw.is_null() { Err("无法连接网易云控制通道".into()) } else { Ok(Self(raw)) } }
}
impl Drop for HttpHandle { fn drop(&mut self) { unsafe { let _ = WinHttpCloseHandle(self.0); } } }

fn evaluate(s: &Session, path: &str, expression: &str) -> Result<Value, String> {
    verify_listener(s)?;
    unsafe {
        let agent = HttpHandle::checked(WinHttpOpen(w!("RiverXILee/1.2.0.0"), WINHTTP_ACCESS_TYPE_NO_PROXY, PCWSTR::null(), PCWSTR::null(), 0))?;
        WinHttpSetTimeouts(agent.0, 1500, 1500, 1500, 1500).map_err(|e| e.to_string())?;
        let connection = HttpHandle::checked(WinHttpConnect(agent.0, w!("127.0.0.1"), s.port, 0))?;
        let object: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let request = HttpHandle::checked(WinHttpOpenRequest(connection.0, w!("GET"), PCWSTR(object.as_ptr()), PCWSTR::null(), PCWSTR::null(), std::ptr::null(), WINHTTP_OPEN_REQUEST_FLAGS(0)))?;
        WinHttpSetOption(Some(request.0), WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, None).map_err(|e| e.to_string())?;
        WinHttpSendRequest(request.0, None, None, 0, 0, 0).map_err(|e| e.to_string())?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(|e| e.to_string())?;
        let socket = HttpHandle::checked(WinHttpWebSocketCompleteUpgrade(request.0, None))?;
        let message = json!({"id":1,"method":"Runtime.evaluate","params":{"expression":expression,"returnByValue":true}}).to_string();
        if WinHttpWebSocketSend(socket.0, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, Some(message.as_bytes())) != 0 { return Err("发送网易云进度操作失败".into()); }
        let mut data = Vec::new(); let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            let mut bytes = [0u8; 4096]; let mut count = 0; let mut kind = WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE;
            if WinHttpWebSocketReceive(socket.0, bytes.as_mut_ptr().cast(), bytes.len() as u32, &mut count, &mut kind) != 0 { return Err("网易云控制响应超时或已断开".into()); }
            if kind != WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE && kind != WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE { return Err("网易云控制响应格式异常".into()); }
            if data.len() + count as usize > 65_536 { return Err("网易云控制响应过大".into()); }
            data.extend_from_slice(&bytes[..count as usize]);
            if kind == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE {
                let value: Value = serde_json::from_slice(&data).map_err(|_| "网易云控制响应无效")?;
                if value["id"] == 1 {
                    return value.pointer("/result/result/value").cloned().ok_or("当前网易云版本暂不兼容增强控制".into());
                }
                data.clear();
            }
        }
        Err("网易云控制响应超时".into())
    }
}

// Locate only an already-loaded Redux player; never read accounts, cookies or storage.
const PLAYER: &str = r#"let load;
const key='riverLyrics'+Date.now();
if(window.webpackJsonp?.push){const m={};m[key]=(a,b,r)=>{load=r};window.webpackJsonp.push([[key],m,[[key]]]);}
else {const k=Object.keys(window).find(k=>k.startsWith('webpackChunk')&&Array.isArray(window[k]));if(k)window[k].push([[key],{},r=>{load=r}]);}
if(!load?.c)return null;
const tool=Object.values(load.c).map(m=>m?.exports?.a).find(e=>typeof e?.getStore==='function'&&typeof e?.getDispatch==='function');
const store=tool?.app?._store,p=store?.getState?.().playing;
if(!p||typeof store.dispatch!=='function')return null;
const t=p.curTrack||p.curPlaying?.track||{},id=String(p.resourceTrackId||p.curPlaying?.resourceId||'');
const info={id,title:String(p.resourceName||t.name||'').slice(0,2048),artist:(p.resourceArtists||t.artists||t.ar||[]).map(a=>a.name).join('/').slice(0,2048),duration:Number(t.duration??t.dt)||0};"#;

fn target(s: &Session) -> Result<String, String> {
    verify_listener(s)?;
    let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let response = client.get(format!("http://127.0.0.1:{}/json/list", s.port)).send().map_err(|_| "读取网易云控制页面失败")?;
    let bytes = response.take(65_537).bytes().collect::<Result<Vec<_>, _>>().map_err(|_| "读取网易云控制页面失败")?;
    if bytes.len() > 65_536 { return Err("网易云控制页面响应过大".into()); }
    let pages: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| "网易云控制页面响应异常")?;
    for page in pages.into_iter().take(20) {
        if page["type"] != "page" { continue; }
        if let Some(path) = page["webSocketDebuggerUrl"].as_str().and_then(|url| websocket_path(url, s.port)) {
            if evaluate(s, &path, &format!("(()=>{{{PLAYER}return info;}})()"))?.is_object() { return Ok(path); }
        }
    }
    Err("当前网易云版本未提供兼容的播放器控制页面".into())
}

pub fn configure(enable: bool, parent: usize) -> Result<Status, String> {
    let mut control = state().try_lock().map_err(|_| "增强控制正在处理，请稍候")?;
    if control.as_ref().is_some_and(|s| !alive(&s.process)) { *control = None; }
    if enable {
        if control.is_some() { return Err("请先关闭并恢复普通模式，再重新启用".into()); }
        let old = main_process()?;
        if !double_confirm(|text| confirm(parent, text)) { return Ok(Status { enabled: false, needs_restart: false }); }
        // OS chooses a free local port. It is revalidated against the process after launch.
        let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| "无法申请本机回环端口")?;
        let port = reservation.local_addr().map_err(|e| e.to_string())?.port();
        drop(reservation);
        exit(&old)?;
        start(&old.path, Some(port))?;
        let until = Instant::now() + Duration::from_secs(30);
        let mut last = "网易云增强控制未就绪".to_string();
        while Instant::now() < until {
            sleep(Duration::from_millis(400));
            if let Ok(p) = main_process() {
                if p.path != old.path || p.started == old.started { continue; }
                let mut session = Session { process: p, port, ready: false, metadata: Value::Null, refreshed: Instant::now() };
                *control = Some(session.clone()); // retain restore action even when handshake fails
                match target(&session) {
                    Ok(path) => {
                        session.metadata = evaluate(&session, &path, &format!("(()=>{{{PLAYER}return info;}})()"))?;
                        session.ready = true; *control = Some(session); return Ok(Status { enabled: true, needs_restart: true });
                    }
                    Err(error) => { last = error; if last.contains("已拒绝连接") { break; } }
                }
            }
        }
        // No persistent patch fallback. Leave a clear restore action if normal exit fails.
        if let Some(s) = control.as_ref() {
            if exit(&s.process).is_ok() { start(&s.process.path, None)?; *control = None; }
        }
        Err(format!("{last}。临时启动参数可能不被此版本支持；未修改客户端文件。若网易云仍未恢复，请完全退出后正常重开。"))
    } else {
        if let Some(s) = control.clone() {
            if !confirm(parent, RESTORE) { return Ok(Status { enabled: s.ready, needs_restart: true }); }
            exit(&s.process)?;
            // Check that the owned process really exited before starting ordinary mode.
            start(&s.process.path, None)?;
            *control = None;
        }
        Ok(Status { enabled: false, needs_restart: false })
    }
}

fn same_track(info: &Value, title: &str, artist: &str) -> bool {
    super::normalize(info["title"].as_str().unwrap_or_default()) == super::normalize(title)
        && super::normalize(info["artist"].as_str().unwrap_or_default()) == super::normalize(artist)
}

pub fn duration_ms(title: &str, artist: &str) -> Option<i64> {
    let mut control = state().try_lock().ok()?;
    let s = control.as_mut().filter(|s| s.ready)?;
    if !same_track(&s.metadata, title, artist) || s.refreshed.elapsed() > Duration::from_secs(2) {
        let path = target(s).ok()?;
        s.metadata = evaluate(s, &path, &format!("(()=>{{{PLAYER}return info;}})()")).ok()?;
        s.refreshed = Instant::now();
    }
    if !same_track(&s.metadata, title, artist) { return None; }
    s.metadata["duration"].as_i64().filter(|v| *v > 0 && *v <= 604_800_000)
}

pub fn seek(position_ms: i64, title: &str, artist: &str) -> Result<(), String> {
    let control = state().try_lock().map_err(|_| "网易云增强控制正在处理，请稍候")?;
    let s = control.as_ref().filter(|s| s.ready).ok_or("请先在播放与同步中临时启用网易云增强控制")?;
    let path = target(s)?;
    let info = evaluate(s, &path, &format!("(()=>{{{PLAYER}return info;}})()"))?;
    if !same_track(&info, title, artist) {
        return Err("歌曲已切换，本次进度调整已取消".into());
    }
    let duration = info["duration"].as_i64().unwrap_or(0);
    if info["id"].as_str().is_none_or(|id| id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()))
        || position_ms < 0 || duration <= 0 || duration > 604_800_000 { return Err("当前歌曲没有有效的可跳转区间".into()); }
    let position_ms = position_ms.min(duration - 1);
    let expected = serde_json::to_string(&info).map_err(|e| e.to_string())?;
    let expression = format!("(()=>{{{PLAYER}const expected={expected};if(info.id!==expected.id||info.title!==expected.title||info.artist!==expected.artist)return false;store.dispatch({{type:'playing/setPlayingPosition',payload:{{duration:{}}}}});return true;}})()", position_ms as f64 / 1000.0);
    if evaluate(s, &path, &expression)? != true { return Err("歌曲已切换，进度调整已取消".into()); }
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        sleep(Duration::from_millis(100));
        if let Some(track) = super::netease::current_track() {
            if super::normalize(&track.title) != super::normalize(title) || super::normalize(&track.artist) != super::normalize(artist) { return Err("歌曲已切换，请重试".into()); }
            if (track.position_ms - position_ms).abs() < 2500 { return Ok(()); }
        }
    }
    Err("网易云尚未确认实际播放进度，请稍后重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn starts_disabled_without_persisted_enablement() {
        let value = status();
        assert!(!value.enabled && !value.needs_restart);
    }
    #[test] fn metadata_requires_the_current_song_and_artist() {
        let info = json!({"title":"我不难过", "artist":"孙燕姿", "duration":264000});
        assert!(same_track(&info, "我不难过", "孙燕姿"));
        assert!(!same_track(&info, "我怀念的", "孙燕姿"));
        assert!(!same_track(&info, "我不难过", "其他歌手"));
    }
    #[test] fn confirmation_requires_both_prompts() {
        for answers in [[false, false], [true, false], [true, true]] {
            let mut count = 0;
            let accepted = double_confirm(|_| { let a = answers[count]; count += 1; a });
            assert_eq!(accepted, answers[0] && answers[1]);
            assert_eq!(count, if answers[0] { 2 } else { 1 });
        }
    }
    #[test] fn rejects_nonlocal_or_unrelated_debug_urls() {
        assert_eq!(websocket_path("ws://127.0.0.1:1234/devtools/page/A",1234),Some("/devtools/page/A".into()));
        for url in ["ws://localhost:1234/devtools/page/A", "ws://127.0.0.1:1235/devtools/page/A", "ws://8.8.8.8:1234/devtools/page/A", "ws://127.0.0.1:1234/devtools/browser/A", "ws://x@127.0.0.1:1234/devtools/page/A"] { assert!(websocket_path(url,1234).is_none()); }
    }
    #[test]
    #[ignore = "requires an already consented temporary NetEase port; seeks and restores the current song"]
    fn live_seek_and_restore() {
        let port = std::env::var("RIVER_TEST_NETEASE_PORT").expect("explicit consented test port").parse().unwrap();
        let session = Session { process: main_process().unwrap(), port, ready: true, metadata: Value::Null, refreshed: Instant::now() };
        verify_listener(&session).unwrap();
        let path = target(&session).unwrap();
        let info = evaluate(&session, &path, &format!("(()=>{{{PLAYER}return info;}})()")).unwrap();
        let title = info["title"].as_str().unwrap(); let artist = info["artist"].as_str().unwrap();
        let original = super::super::netease::current_position_ms().unwrap_or(0);
        let target = (original + 25_000).min(info["duration"].as_i64().unwrap() - 10_000).max(0);
        *state().lock().unwrap() = Some(session);
        let result = tauri::async_runtime::block_on(super::super::seek_media(target, "cloudmusic.exe".into(), title.into(), artist.into()));
        let observed = super::super::netease::current_position_ms();
        let restore = tauri::async_runtime::block_on(super::super::seek_media(original, "cloudmusic.exe".into(), title.into(), artist.into()));
        *state().lock().unwrap() = None;
        println!("NetEase seek: target={target} observed={observed:?} restored={}", restore.is_ok());
        result.unwrap(); restore.unwrap();
    }
}
