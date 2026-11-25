// Opt-in KuGou metadata/clock reader. No account/cookie/storage APIs are read.
// SuperCall 864 and CEF profile reference: BrimDeck d321521 (Apache-2.0).
use super::{kugou_patch, netease_control};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use windows::{core::{PCWSTR, PWSTR}, Win32::{Foundation::{CloseHandle, FILETIME}, Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}, System::{Diagnostics::ToolHelp::*, RemoteDesktop::ProcessIdToSessionId, Threading::*}}};
const PORT: u16 = 12233;
const PURPOSE: &str = "酷狗增强兼容用于读取真实播放进度和当前录音标识，歌词只使用酷狗来源，不提供酷狗进度拖拽。\n\n请先从托盘完全退出酷狗，再操作启用。程序会备份并修改酷狗 libcef.dll 的 9 处已知字节；不会强制结束酷狗，也不会改动账号或歌单。完成后请自行重新打开酷狗。\n\n继续查看第二次风险提醒？";
const RISK: &str = "二次提醒：这会修改酷狗客户端内核文件，原数字签名将不再有效；酷狗下次启动会开放 127.0.0.1:12233 本机调试端口。\n\n本机的其他程序或网页可能利用端口访问酷狗内部页面，包括登录相关状态。仅在信任本机环境时使用。退出桌面歌词不会恢复文件或关闭酷狗端口；请完全退出酷狗后使用“关闭并恢复原文件”。酷狗升级后不自动重新修改。\n\n程序会校验版本与完整备份，权限不足或文件异常即停止，不会自行提权。确认风险并启用？";
const RESTORE: &str = "请先从托盘完全退出酷狗。程序将核对当前文件与备份的 SHA-256，再恢复启用前的完整 libcef.dll；不会覆盖酷狗升级或其他工具修改后的文件。\n\n恢复后请正常重新打开酷狗。是否关闭增强兼容并恢复原文件？";
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static LOCATION: Mutex<Option<PathBuf>> = Mutex::new(None);
static OPERATION: Mutex<()> = Mutex::new(());
static ACTIVE: Mutex<Option<Journal>> = Mutex::new(None);
static VALIDATED: Mutex<Option<(PathBuf, std::time::SystemTime, u64)>> = Mutex::new(None);
static RECENT: Mutex<Option<Track>> = Mutex::new(None);

#[derive(Clone, Deserialize, Serialize)]
struct Journal { library: PathBuf, original_sha: String, patched_sha: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub enabled: bool, pub needs_restore: bool, pub message: String }
#[derive(Clone)]
struct Process { pid: u32, started: u64, path: PathBuf }

fn process(pid: u32) -> Option<Process> {
    unsafe {
        let mut own_session = 0; let mut session = u32::MAX;
        ProcessIdToSessionId(std::process::id(), &mut own_session).ok()?;
        ProcessIdToSessionId(pid, &mut session).ok()?;
        if own_session != session { return None; }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 32768]; let mut size = buffer.len() as u32;
        let mut created = FILETIME::default(); let mut exit = FILETIME::default(); let mut kernel = FILETIME::default(); let mut user = FILETIME::default();
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok()
            && GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle); if !ok { return None; }
        let path = PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])).canonicalize().ok()?;
        if !path.file_name()?.eq_ignore_ascii_case("KuGou.exe") { return None; }
        Some(Process { pid, started: ((created.dwHighDateTime as u64)<<32) | created.dwLowDateTime as u64, path })
    }
}
fn processes() -> Vec<Process> {
    unsafe {
        let Ok(handle) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return Vec::new(); };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() }; let mut found = Vec::new();
        if Process32FirstW(handle, &mut entry).is_ok() { loop {
            let n = entry.szExeFile.iter().position(|v| *v==0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..n]).eq_ignore_ascii_case("KuGou.exe") {
                if let Some(p) = process(entry.th32ProcessID) { found.push(p); }
            }
            if Process32NextW(handle, &mut entry).is_err() { break; }
        }}
        let _ = CloseHandle(handle); found
    }
}
fn alive(p: &Process) -> bool { process(p.pid).is_some_and(|now| now.started == p.started && now.path == p.path) }
fn belongs_to_installation(executable: &Path, library: &Path) -> bool {
    let Some(version) = library.parent() else { return false; };
    // Some KuGou builds host CEF in KGMusic\KuGou.exe, not the child in the
    // version folder. Allow exactly these two executables of the consented install.
    let version_player = version.join("KuGou.exe");
    executable.as_os_str().eq_ignore_ascii_case(version_player.as_os_str())
        || version.parent().is_some_and(|root| executable.as_os_str().eq_ignore_ascii_case(root.join("KuGou.exe").as_os_str()))
}
fn location() -> Result<PathBuf, String> {
    let running: Vec<_> = processes().into_iter().filter_map(|p| p.path.parent().map(|d| d.join("libcef.dll"))).filter(|p| p.is_file()).collect();
    let unique: std::collections::HashSet<_> = running.into_iter().collect();
    if unique.len() > 1 { return Err("检测到多个酷狗安装位置，请只保留一个客户端再重试".into()); }
    if let Some(path) = unique.into_iter().next() { *LOCATION.lock().map_err(|_| "酷狗位置不可用")? = Some(path.clone()); return Ok(path); }
    LOCATION.lock().map_err(|_| "酷狗位置不可用")?.clone().ok_or("请先正常打开一次酷狗，再打开本设置页识别安装位置；之后从托盘完全退出酷狗再启用".into())
}
fn folder() -> Result<&'static Path, String> { DIRECTORY.get().map(PathBuf::as_path).ok_or("酷狗兼容目录尚未初始化".into()) }
fn manifest() -> Result<PathBuf, String> { Ok(folder()?.join("active.json")) }
fn backup(j: &Journal) -> Result<PathBuf, String> { Ok(folder()?.join(format!("{}.dll", j.original_sha))) }
fn valid_sha(s: &str) -> bool { s.len()==64 && s.bytes().all(|b| b.is_ascii_hexdigit()) }
fn load() -> Result<Option<Journal>, String> {
    let path = manifest()?; if !path.exists() { return Ok(None); }
    let file = File::open(path).map_err(|e| e.to_string())?; let mut bytes = Vec::new(); file.take(16385).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len()>16384 { return Err("酷狗恢复记录过大，已停止自动处理".into()); }
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| "酷狗恢复记录损坏，备份已保留，请勿手动覆盖客户端")?;
    if !valid_sha(&journal.original_sha) || !valid_sha(&journal.patched_sha) || !journal.library.is_absolute()
        || journal.library.file_name().is_none_or(|n| !n.eq_ignore_ascii_case("libcef.dll"))
        || journal.library.parent().is_none_or(|d| !d.join("KuGou.exe").is_file()) {
        return Err("酷狗恢复记录校验失败，未修改文件".into());
    }
    Ok(Some(journal))
}
pub fn init(directory: PathBuf) {
    if fs::create_dir_all(&directory).is_err() { return; } let _ = DIRECTORY.set(directory);
    if let Ok(Some(j)) = load() {
        if kugou_patch::hash(&j.library).ok().as_ref() == Some(&j.patched_sha) { if let Ok(mut active) = ACTIVE.lock() { *active = Some(j); } }
    }
}
pub fn status() -> Status {
    match load() {
        Ok(Some(j)) => {
            let enabled = ACTIVE.lock().ok().is_some_and(|a| a.as_ref().is_some_and(|a| a.patched_sha == j.patched_sha));
            Status { enabled, needs_restore: true, message: if enabled { "已启用 · 酷狗将持续开放本机调试端口，退出桌面歌词不会关闭；关闭需完全退出酷狗并恢复原文件" } else { "存在恢复记录 · 文件可能已升级或启用中断；未重新修改，请使用恢复入口检查" }.into() }
        }
        Err(e) => Status { enabled: false, needs_restore: true, message: e },
        Ok(None) => { let _ = location(); Status { enabled: false, needs_restore: false, message: "默认关闭 · 请先识别安装位置，再完全退出酷狗；启用前需两次确认".into() } }
    }
}
pub(super) fn replace(source: &Path, target: &Path) -> Result<(), String> {
    let src: Vec<u16> = source.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let dst: Vec<u16> = target.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
    unsafe { MoveFileExW(PCWSTR(src.as_ptr()), PCWSTR(dst.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }.map_err(|error| format!("无法替换酷狗文件（系统错误 {}）；请确认已完全退出且具有安装目录写入权限，未自行提权",error.code().0))
}
fn save(j: &Journal) -> Result<(), String> {
    let temp = folder()?.join("active.json.new");
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_| "无法创建恢复记录，或存在未完成的恢复记录临时文件")?;
    file.write_all(&serde_json::to_vec(j).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?; file.sync_all().map_err(|e| e.to_string())?; drop(file);
    replace(&temp, &manifest()?)
}
fn require_closed(library: &Path) -> Result<(), String> {
    let version = library.parent().ok_or("安装目录无效")?;
    let root = version.parent().ok_or("安装目录无效")?;
    if processes().iter().any(|p| p.path.starts_with(root)) { return Err("酷狗仍在后台运行，请右键酷狗托盘图标完全退出，再点击本按钮；不会强制结束播放器".into()); }
    Ok(())
}
fn change(enable: bool) -> Result<(), String> { change_at(enable,None) }
fn change_at(enable: bool, selected: Option<PathBuf>) -> Result<(), String> {
    if enable {
        if load()?.is_some() { return Err("请先恢复之前的酷狗兼容修改，再重新启用".into()); }
        let library = selected.map(Ok).unwrap_or_else(location)?.canonicalize().map_err(|e| e.to_string())?; require_closed(&library)?;
        let mut original = File::open(&library).map_err(|e| e.to_string())?;
        if kugou_patch::locate(&mut original)?.0 != kugou_patch::State::Original { return Err("酷狗内核已被其他工具修改；未接管，也未覆盖原工具的恢复数据".into()); }
        drop(original);
        let original_sha = kugou_patch::hash(&library)?;
        let backup_file = folder()?.join(format!("{original_sha}.dll"));
        if !backup_file.exists() {
            let mut output = OpenOptions::new().create_new(true).write(true).open(&backup_file).map_err(|_| "无法创建酷狗原文件备份，未修改客户端")?;
            let mut input = File::open(&library).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?; output.sync_all().map_err(|e| e.to_string())?;
        }
        if kugou_patch::hash(&backup_file)? != original_sha { return Err("原文件备份校验失败，未修改酷狗".into()); }
        let temp = library.with_file_name("libcef.dll.riverxilee-new");
        let mut copy = OpenOptions::new().read(true).write(true).create_new(true).open(&temp).map_err(|_| "无法在酷狗目录创建兼容副本；请确认目录写入权限，或先处理同名未完成副本。未自行提权")?;
        let prepared = (|| {
            std::io::copy(&mut File::open(&backup_file).map_err(|e| e.to_string())?, &mut copy).map_err(|e| e.to_string())?;
            kugou_patch::apply(&mut copy)?;
            Ok::<_,String>(Journal { library: library.clone(), original_sha, patched_sha: kugou_patch::hash(&temp)? })
        })();
        drop(copy);
        let result = prepared.and_then(|j| {
            require_closed(&library)?;
            if kugou_patch::hash(&library)? != j.original_sha { return Err("酷狗文件在准备期间发生变化，未覆盖".into()); }
            // A live mapped DLL cannot be opened for writing. Never rename a held client image.
            drop(OpenOptions::new().write(true).open(&library).map_err(|_| "酷狗文件被占用或无写入权限，未替换")?);
            save(&j)?; // durable recovery record exists before touching the installed image
            replace(&temp, &library)?;
            if kugou_patch::hash(&library)? != j.patched_sha { return Err("兼容文件校验失败，请保留备份并使用恢复入口".into()); }
            *ACTIVE.lock().map_err(|_| "酷狗兼容状态不可用")? = Some(j); Ok(())
        });
        if temp.exists() { let _ = fs::remove_file(&temp); } result
    } else {
        let Some(j) = load()? else { return Ok(()); }; require_closed(&j.library)?;
        let current = kugou_patch::hash(&j.library)?;
        if current != j.original_sha {
            if current != j.patched_sha { return Err("酷狗文件已升级或被其他工具修改，拒绝用旧备份覆盖；备份和恢复记录已保留".into()); }
            if kugou_patch::hash(&backup(&j)?)? != j.original_sha { return Err("酷狗原文件备份校验失败，未执行恢复".into()); }
            let temp = j.library.with_file_name("libcef.dll.riverxilee-restore");
            let mut copy = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_| "无法创建恢复副本，请检查目录权限或同名未完成副本")?;
            let prepared = (|| {
                std::io::copy(&mut File::open(backup(&j)?).map_err(|e| e.to_string())?, &mut copy).map_err(|e| e.to_string())?; copy.sync_all().map_err(|e| e.to_string())?;
                Ok::<_,String>(())
            })();
            drop(copy);
            let result = prepared.and_then(|_| {
                require_closed(&j.library)?;
                if kugou_patch::hash(&temp)? != j.original_sha || kugou_patch::hash(&j.library)? != j.patched_sha { return Err("恢复前文件校验发生变化，未覆盖".into()); }
                drop(OpenOptions::new().write(true).open(&j.library).map_err(|_| "酷狗文件被占用或无写入权限，未恢复")?);
                replace(&temp, &j.library)
            });
            if temp.exists() { let _ = fs::remove_file(&temp); } result?;
        }
        if kugou_patch::hash(&j.library)? != j.original_sha { return Err("恢复校验失败，恢复记录已保留".into()); }
        fs::remove_file(manifest()?).map_err(|e| e.to_string())?;
        *ACTIVE.lock().map_err(|_| "酷狗兼容状态不可用")? = None; Ok(())
    }
}
pub fn configure(enable: bool, owner: String, channel: tauri::ipc::Channel<netease_control::ConfirmationRequest>) -> Result<Status, String> {
    let _operation = OPERATION.try_lock().map_err(|_| "酷狗兼容操作正在处理中，请稍候")?;
    let ask = |stage, text| netease_control::confirm_stage(&owner, &channel, stage, text);
    if enable {
        let _ = location()?;
        if !ask("kugou-purpose", PURPOSE) || !ask("kugou-risk", RISK) { return Ok(status()); }
    } else if !ask("kugou-restore", RESTORE) { return Ok(status()); }
    change(enable)?; Ok(status())
}
pub(super) fn auto_prepare() -> Result<String,String> {
    if !super::enhancement_startup::authorized() { return Err("首次使用确认尚未完成".into()); }
    let _operation = OPERATION.try_lock().map_err(|_| "酷狗兼容操作正在处理中")?;
    if ACTIVE.lock().map_err(|_| "酷狗状态不可用")?.is_some() { return Ok("酷狗增强已准备 · 正常打开酷狗后自动读取真实进度".into()); }
    if load()?.is_some() { return Err("酷狗恢复记录需要检查；未自动覆盖升级或外部修改后的文件，请从托盘打开增强恢复工具".into()); }
    let Ok(library) = location() else { return Ok("酷狗未运行或尚未识别安装位置 · 稍后正常打开时会再次检测".into()); };
    // KuGou cannot quit gracefully through an API. Never force-kill it to
    // satisfy a default-on policy; wait for the user to exit it normally.
    if require_closed(&library).is_err() { return Ok("酷狗尚未准备：请从托盘完全退出酷狗；退出后将自动备份并准备，完成后再正常打开".into()); }
    change(true)?;
    Ok("酷狗增强已准备 · 请正常重新打开酷狗".into())
}
pub(super) fn restore_from_startup() -> Result<(),String> {
    let _operation = OPERATION.try_lock().map_err(|_| "酷狗兼容操作正在处理中")?;
    change(false)
}

const PLAY_INFO: &str = r#"new Promise(resolve=>{const name='__riverKugou'+Date.now()+Math.random().toString(36).slice(2);const timer=setTimeout(()=>{delete window[name];resolve('')},2500);window[name]=data=>{clearTimeout(timer);delete window[name];resolve(typeof data==='string'?data:JSON.stringify(data))};try{external.SuperCall(864,JSON.stringify({callback:name}))}catch(e){clearTimeout(timer);delete window[name];resolve('')}})"#;
#[derive(Clone, Debug)]
pub struct Track { pub title: String, pub artist: String, pub hash: String, pub position: i64, pub duration: i64, pub playing: bool, pub captured: u128 }
pub fn recent_track() -> Option<Track> {
    if ACTIVE.try_lock().ok()?.is_none() { return None; }
    RECENT.try_lock().ok()?.clone().filter(|t| super::now_ms().saturating_sub(t.captured)<2500)
}
fn number(value: &Value, key: &str) -> Option<f64> { value[key].as_f64().or_else(|| value[key].as_str()?.parse::<f64>().ok()).filter(|v| v.is_finite()) }
pub fn parse_track(data: &Value, captured: u128) -> Option<Track> {
    let name = data["filename"].as_str()?.trim(); if name.is_empty() || name.len()>8192 { return None; }
    let (artist, title) = name.split_once(" - ").unwrap_or(("", name));
    let duration = number(data,"duration")?; let position = number(data,"progress")? / 10_000.0;
    if duration<=0.0 || duration>604_800_000.0 || position<0.0 || position>duration { return None; }
    let playing = match data["play_status"].as_str()? { "playing"=>true, "paused"|"pasued"|"stopped"=>false, _=>return None };
    let hash = data["hash"].as_str().unwrap_or_default();
    Some(Track { title: title.trim().into(), artist: artist.trim().into(), hash: if hash.len()==32 && hash.bytes().all(|b| b.is_ascii_hexdigit()) { hash.to_ascii_lowercase() } else { String::new() }, position: position as i64, duration: duration as i64, playing, captured })
}
pub fn current_track() -> Option<Track> {
    let j = ACTIVE.try_lock().ok()?.clone()?;
    // A client update or an external change invalidates this opt-in; never automatically re-patch.
    // Metadata is checked without rehashing 150 MB at every media poll.
    if j.library.canonicalize().ok()? != j.library { return None; }
    let installed = fs::metadata(&j.library).ok()?;
    let stamp = (j.library.clone(),installed.modified().ok()?,installed.len());
    let mut validated = VALIDATED.try_lock().ok()?;
    if validated.as_ref()!=Some(&stamp) {
        if kugou_patch::hash(&j.library).ok().as_ref()!=Some(&j.patched_sha) {
            if let Ok(mut active) = ACTIVE.lock() { *active = None; } *validated = None; return None;
        }
        *validated = Some(stamp);
    }
    drop(validated);
    let owner = processes().into_iter().find(|p| belongs_to_installation(&p.path,&j.library) && netease_control::verify_loopback_listener(PORT,p.pid).is_ok())?;
    let verify = || { if !alive(&owner) { return Err("酷狗进程已变更，已停止读取".into()); } netease_control::verify_loopback_listener(PORT,owner.pid) };
    verify().ok()?;
    let client = reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(2)).build().ok()?;
    let mut bytes = Vec::new(); client.get(format!("http://127.0.0.1:{PORT}/json/list")).send().ok()?.error_for_status().ok()?.take(65537).read_to_end(&mut bytes).ok()?;
    if bytes.len()>65536 { return None; } let pages: Vec<Value> = serde_json::from_slice(&bytes).ok()?;
    for page in pages.into_iter().take(20) {
        if page["type"]!="page" { continue; }
        let Some(path) = page["webSocketDebuggerUrl"].as_str().and_then(|s| netease_control::websocket_path(s,PORT)) else { continue; };
        let Ok(value) = netease_control::evaluate_local(PORT,&path,PLAY_INFO,true,&verify) else { continue; };
        let Some(text) = value.as_str() else { continue; }; if text.len()>65536 || text.is_empty() { continue; }
        if let Ok(data) = serde_json::from_str::<Value>(text) { if let Some(track) = parse_track(&data,super::now_ms()) {
            if let Ok(mut recent) = RECENT.lock() { *recent = Some(track.clone()); } return Some(track);
        } }
    } None
}
#[cfg(test)] mod tests {
    use super::*; use serde_json::json;
    static TEST_STATE: Mutex<()> = Mutex::new(());
    #[test] fn accepts_the_consented_launcher_and_version_player_not_other_installations() {
        let library = Path::new(r"C:\Program Files\KuGou\KGMusic\20.1.61.28014\libcef.dll");
        for exe in [r"C:\Program Files\KuGou\KGMusic\KuGou.exe",r"C:\Program Files\KuGou\KGMusic\20.1.61.28014\KuGou.exe",
            r"c:\program files\kugou\kgmusic\KUGOU.EXE"] { assert!(belongs_to_installation(Path::new(exe),library),"{exe}"); }
        for exe in [r"D:\Other\KuGou.exe",r"C:\Program Files\KuGou\KGMusic\20.1.60\KuGou.exe",r"C:\Program Files\KuGou\KGMusic\Other.exe",
            r"C:\Program Files\KuGou\KGMusic\tools\KuGou.exe"] { assert!(!belongs_to_installation(Path::new(exe),library),"{exe}"); }
    }
    #[test] fn real_clock_units_and_spelling_are_validated() {
        let mut data = json!({"filename":"周杰伦 - 晴天","duration":"269000","progress":"123450000","play_status":"playing","hash":"0123456789ABCDEF0123456789ABCDEF"});
        let t = parse_track(&data,123).unwrap(); assert_eq!((t.position,t.duration,t.playing),(12345,269000,true)); assert_eq!(t.artist,"周杰伦"); assert_eq!(t.title,"晴天"); assert_eq!(t.hash,"0123456789abcdef0123456789abcdef");
        data["play_status"]=json!("pasued"); assert!(!parse_track(&data,123).unwrap().playing);
        for value in ["NaN","-1","9999999999999999999"] { data["progress"]=json!(value); assert!(parse_track(&data,123).is_none()); }
        data["duration"]=json!("0"); assert!(parse_track(&data,123).is_none());
    }
    #[test] fn no_state_means_no_connection_or_implicit_enablement() { let _guard = TEST_STATE.lock().unwrap(); assert!(ACTIVE.lock().unwrap().is_none()); assert!(current_track().is_none()); }
    #[test] #[ignore = "read-only clock probe of an already user-enabled KuGou installation; no patch, seek or playback changes"]
    fn live_enabled_clock() {
        let path = std::env::var_os("RIVER_KUGOU_DIAGNOSTIC_CONFIG").map(PathBuf::from).expect("explicit existing compatibility config folder");
        assert!(path.join("active.json").is_file(),"requires the user's existing opt-in, never enable from this test");
        init(path);
        let first = current_track().expect("consented KuGou real clock");
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let second = current_track().expect("second real clock sample");
        println!("KuGou real clock: first={first:?}; second={second:?}");
        if first.title==second.title && first.hash==second.hash && first.playing && second.playing {
            assert!(second.position>first.position+500,"clock must actually advance, not only expose song metadata");
        }
        assert!(first.duration>0 && second.duration>0);
    }
    #[test] fn backed_up_file_round_trips_and_changed_or_damaged_files_are_never_overwritten() {
        let _guard = TEST_STATE.lock().unwrap();
        let root = std::env::temp_dir().join(format!("river-kugou-recovery-test-{}-{}",std::process::id(),super::super::now_ms()));
        let version = root.join("KGMusic").join("1.0"); fs::create_dir_all(&version).unwrap();
        let library = version.join("libcef.dll"); fs::write(version.join("KuGou.exe"),b"fixture only, never executed").unwrap();
        let original = kugou_patch::tests::fixture(false); fs::write(&library,&original).unwrap();
        init(root.join("backup")); *LOCATION.lock().unwrap() = Some(library.clone());
        change_at(true,Some(library.clone())).unwrap(); let journal = load().unwrap().unwrap();
        assert_eq!(kugou_patch::hash(&journal.library).unwrap(),journal.patched_sha);
        assert_eq!(fs::read(backup(&journal).unwrap()).unwrap(),original);
        let patched = fs::read(&library).unwrap();
        fs::write(&library,b"new client version").unwrap(); assert!(change(false).unwrap_err().contains("升级"));
        assert_eq!(fs::read(&library).unwrap(),b"new client version");
        fs::write(&library,&patched).unwrap(); fs::write(backup(&journal).unwrap(),b"broken backup").unwrap();
        assert!(change(false).unwrap_err().contains("备份校验失败")); assert_eq!(fs::read(&library).unwrap(),patched);
        fs::write(backup(&journal).unwrap(),&original).unwrap(); change(false).unwrap();
        assert_eq!(fs::read(&library).unwrap(),original); assert!(load().unwrap().is_none());
        assert!(ACTIVE.lock().unwrap().is_none());
        // Only this test's exact files and empty directories are removed, never a recursive tree.
        for path in [library,version.join("KuGou.exe"),backup(&journal).unwrap()] { fs::remove_file(path).unwrap(); }
        for path in [version,root.join("KGMusic"),root.join("backup"),root] { fs::remove_dir(path).unwrap(); }
    }
}
