// First-run, explicit consent for default-on player enhancements. Missing,
// corrupt, stale or declined consent never authorizes an automatic operation.
use super::{kugou_control, netease_control};
use serde::{Deserialize,Serialize};
use std::{fs::{self,OpenOptions}, io::{Read,Write}, path::{Path,PathBuf}, sync::{Mutex,OnceLock,atomic::{AtomicBool,Ordering}}};
const REVISION: u32 = 1;
const NOTICE: &str = "应用将默认使用网易云增强控制和酷狗增强兼容。首次明确同意后记住选择，后续启动会自动检测已运行的播放器，设置页不再提供这两个开启按钮。未安装或未运行的播放器不会被强行启动。\n\n网易云：启用时会临时重启网易云，音乐会中断；不修改网易云文件，但会开放本机调试端口。\n\n酷狗：会完整备份并修改 libcef.dll 的 9 处已知字节，原数字签名随之失效，并在酷狗启动后持续开放 127.0.0.1:12233 调试端口。正在运行且尚未准备的酷狗不会被强杀，需要先从托盘完全退出，程序准备完成后再正常打开。升级或外部改动不会被旧备份覆盖。\n\n本机其他程序或网页可能通过调试端口访问或控制播放器内部页面，包括登录相关状态。仅在信任本机环境时同意。退出桌面歌词不会自动关闭仍运行的播放器端口或恢复酷狗文件。\n\n撤回授权或恢复原文件，请使用托盘菜单“关闭增强并恢复”。恢复前需完全退出酷狗；恢复网易云会重启其客户端。权限不足或版本不兼容时停止处理，不自行提权。\n\n点击“同意并进入”才会授权；选择“退出应用”、关闭提示或按 Esc 将退出程序，不会按同意处理。";
const RESTORE: &str = "此操作将撤回默认增强授权并退出桌面歌词。恢复网易云会重启其客户端、暂时中断播放。请先从托盘完全退出酷狗，再执行恢复；程序不会强制结束酷狗，也不会覆盖升级后的文件。\n\n如果恢复失败，会保留原文件备份和恢复记录，仍可从托盘重试。关闭桌面歌词本身不会关闭其他播放器的端口。\n\n确认关闭增强并恢复？";
static FILE: OnceLock<PathBuf> = OnceLock::new();
static APPROVED: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
static WORK: Mutex<Runtime> = Mutex::new(Runtime { netease_error: None, kugou_error: None });
struct Runtime { netease_error: Option<String>, kugou_error: Option<String> }
#[derive(Deserialize,Serialize)]
struct Consent { revision: u32, accepted: bool, accepted_at_ms: u128 }
#[derive(Serialize)]
pub struct Gate { pub approved: bool }
#[derive(Debug,Serialize)]
pub struct Status { pub netease: String, pub kugou: String }
fn valid(c: &Consent) -> bool { c.revision==REVISION && c.accepted && c.accepted_at_ms>0 }
fn read(path: &Path) -> bool {
    let Ok(file)=fs::File::open(path) else { return false; }; let mut bytes=Vec::new();
    if file.take(4097).read_to_end(&mut bytes).is_err() || bytes.len()>4096 { return false; }
    serde_json::from_slice::<Consent>(&bytes).ok().is_some_and(|c|valid(&c))
}
pub fn init(path: PathBuf) { APPROVED.store(read(&path),Ordering::SeqCst); let _=FILE.set(path); }
pub fn authorized() -> bool { APPROVED.load(Ordering::SeqCst) && !PAUSED.load(Ordering::SeqCst) }
pub fn gate() -> Gate { Gate { approved: authorized() } }
fn save() -> Result<(),String> {
    let path=FILE.get().ok_or("首次使用确认记录尚未初始化")?;
    let temp=path.with_extension("json.new");
    let mut file=OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_| "无法保存确认记录，或存在上次未完成的确认；不会进入自动增强")?;
    let bytes=serde_json::to_vec(&Consent {revision:REVISION,accepted:true,accepted_at_ms:super::now_ms()}).map_err(|e|e.to_string())?;
    file.write_all(&bytes).map_err(|e|e.to_string())?; file.sync_all().map_err(|e|e.to_string())?; drop(file);
    // Only a fresh, explicit confirmation may replace stale/corrupt consent.
    // The installed client and its independent recovery journal are not touched.
    kugou_control::replace(&temp,path).map_err(|_| "无法原子保存首次使用确认，未授权默认增强")?;
    APPROVED.store(true,Ordering::SeqCst); Ok(())
}
pub fn confirm(owner: String, channel: tauri::ipc::Channel<netease_control::ConfirmationRequest>) -> Result<Gate,String> {
    if authorized() { return Ok(gate()); }
    if netease_control::confirm_stage(&owner,&channel,"startup-enhancements",NOTICE) { save()?; }
    Ok(gate())
}
pub fn maintain() -> Result<Status,String> {
    if !authorized() { return Err("首次使用确认尚未完成，未开启任何默认增强".into()); }
    let mut runtime=WORK.try_lock().map_err(|_| "增强检测正在处理中")?;
    // Recheck after serializing against recovery. A single failure is held for
    // this run, never repeatedly restarting a client or retrying a DLL write.
    if !authorized() { return Err("默认增强授权已撤回".into()); }
    let netease=if let Some(error)=&runtime.netease_error { error.clone() }
    else if !netease_control::running() { "网易云未运行 · 打开后自动检测，不强行启动".into() }
    else { match netease_control::auto_start() {
        Ok(s) if s.enabled => "网易云增强已连接 · 本机调试端口已开启".into(),
        Ok(_) => "网易云增强暂未就绪".into(),
        Err(e) => { let message=format!("网易云增强未完成：{e}；本次不再自动重试，可从托盘恢复后重新启动应用"); runtime.netease_error=Some(message.clone()); message }
    }};
    let kugou=if let Some(error)=&runtime.kugou_error { error.clone() }
    else { match kugou_control::auto_prepare() { Ok(message)=>message, Err(e)=>{let message=format!("酷狗增强未完成：{e}；本次不再自动修改，可从托盘恢复工具检查");runtime.kugou_error=Some(message.clone());message} } };
    Ok(Status {netease,kugou})
}
pub fn recover(owner:String,channel:tauri::ipc::Channel<netease_control::ConfirmationRequest>) -> Result<bool,String> {
    if !netease_control::confirm_stage(&owner,&channel,"startup-restore",RESTORE) { return Ok(false); }
    PAUSED.store(true,Ordering::SeqCst);
    let _work=WORK.lock().map_err(|_| "增强恢复状态不可用")?;
    let path=FILE.get().ok_or("确认记录未初始化")?;
    if path.exists() { fs::remove_file(path).map_err(|_| "无法撤回默认增强授权，未继续恢复")?; }
    APPROVED.store(false,Ordering::SeqCst);
    let netease=netease_control::restore_from_startup();
    let kugou=kugou_control::restore_from_startup();
    let errors:Vec<_>=[netease.err(),kugou.err()].into_iter().flatten().collect();
    if errors.is_empty() { Ok(true) } else { Err(format!("授权已撤回；恢复尚未完成：{}。保留备份，请处理后从托盘重试",errors.join("；"))) }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn consent_is_explicit_versioned_and_fail_closed() {
        for (revision,accepted,time,expected) in [(REVISION,true,1,true),(REVISION,false,1,false),(REVISION+1,true,1,false),(REVISION,true,0,false)] {
            assert_eq!(valid(&Consent{revision,accepted,accepted_at_ms:time}),expected);
        }
        let dir=std::env::temp_dir().join(format!("river-startup-consent-{}-{}",std::process::id(),super::super::now_ms()));fs::create_dir(&dir).unwrap();
        let path=dir.join("consent.json"); assert!(!read(&path));
        for bytes in [b"broken".as_slice(),b"{}".as_slice(),b"{\"revision\":1,\"accepted\":false,\"accepted_at_ms\":1}".as_slice()] {fs::write(&path,bytes).unwrap();assert!(!read(&path));}
        fs::write(&path,serde_json::to_vec(&Consent{revision:REVISION,accepted:true,accepted_at_ms:1}).unwrap()).unwrap();assert!(read(&path));
        fs::remove_file(path).unwrap();fs::remove_dir(dir).unwrap();
    }
    #[test] fn missing_consent_cannot_trigger_default_enhancements() { assert!(!authorized());assert!(maintain().unwrap_err().contains("首次使用确认")); }
}
