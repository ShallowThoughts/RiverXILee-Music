use serde::Serialize;
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Component, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

const TARGET_VERSION: &str = "1.1.3";
const PRODUCT_NAME: &str = "RiverXILee桌面歌词";
const MAIN_BINARY_NAME: &str = "riverxilee-desktop-lyrics.exe";
const UNINSTALL_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\RiverXILee桌面歌词";
const INSTALL_LOCATION_ENV: &str = "RIVERXILEE_INSTALL_LOCATION";
const INSTALLER_BYTES: &[u8] = include_bytes!(
    "../../../src-tauri/target/release/bundle/nsis/RiverXILee桌面歌词_1.1.3_x64-setup.exe"
);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallContext {
    installed_version: Option<String>,
    install_location: String,
    target_version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    percent: u8,
    title: String,
    detail: String,
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn installed_value(name: &str) -> Option<String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(UNINSTALL_KEY, KEY_READ)
        .ok()?
        .get_value::<String, _>(name)
        .ok()
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

fn default_install_location() -> String {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(PRODUCT_NAME)
        .to_string_lossy()
        .into_owned()
}

fn validate_install_location(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("请选择有效的安装位置".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("安装位置必须是完整的 Windows 路径".to_string());
    }
    let normal_components = path
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count();
    if normal_components == 0 || path.parent().is_none() {
        return Err("不能直接安装到磁盘根目录".to_string());
    }
    Ok(path)
}

fn comparable_path(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

fn remove_previous_program_files(previous: &std::path::Path, current: &std::path::Path) {
    if comparable_path(previous) == comparable_path(current) {
        return;
    }
    let _ = fs::remove_file(previous.join(MAIN_BINARY_NAME));
    let _ = fs::remove_file(previous.join("uninstall.exe"));
    // Only remove the directory when it is empty; never touch unrelated files
    // that may share a user-selected parent folder.
    let _ = fs::remove_dir(previous);
}

fn emit_progress(app: &AppHandle, percent: u8, title: &str, detail: &str) {
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            percent,
            title: title.to_string(),
            detail: detail.to_string(),
        },
    );
}

#[tauri::command]
fn get_install_context(app: AppHandle) -> InstallContext {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("RiverXILee安装中心 · 准备就绪");
    }
    InstallContext {
        installed_version: installed_value("DisplayVersion"),
        install_location: installed_value("InstallLocation")
            .unwrap_or_else(default_install_location),
        target_version: TARGET_VERSION.to_string(),
    }
}

#[tauri::command]
async fn select_install_location(
    app: AppHandle,
    current_location: Option<String>,
) -> Result<Option<String>, String> {
    let mut picker = app
        .dialog()
        .file()
        .set_title("选择 RiverXILee桌面歌词安装位置");

    if let Some(current_location) = current_location {
        let current_path = PathBuf::from(current_location.trim().trim_matches('"'));
        if current_path.is_absolute() {
            picker = picker.set_directory(current_path);
        }
    }

    picker
        .blocking_pick_folder()
        .map(|folder| {
            folder
                .into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(error_text)
        })
        .transpose()
}

#[tauri::command]
async fn install_product(
    app: AppHandle,
    install_location: String,
    create_desktop_shortcut: bool,
) -> Result<(), String> {
    let install_location = validate_install_location(&install_location)?;
    let previous_install_location = installed_value("InstallLocation").map(PathBuf::from);
    emit_progress(&app, 10, "正在确认安装环境", "正在检查目标位置与现有版本。");

    let payload_path = std::env::temp_dir().join(format!(
        "RiverXILee-Desktop-Lyrics_{}_payload.exe",
        TARGET_VERSION
    ));
    fs::write(&payload_path, INSTALLER_BYTES).map_err(error_text)?;
    emit_progress(
        &app,
        24,
        "正在准备程序文件",
        "安装核心已经安全释放到临时目录。",
    );

    if installed_value("DisplayVersion").is_some() {
        emit_progress(
            &app,
            36,
            "正在切换到新版本",
            "正在关闭运行中的桌面歌词，用户配置保持不变。",
        );
        let _ = Command::new("taskkill")
            .args(["/IM", MAIN_BINARY_NAME, "/T", "/F"])
            .output();
        std::thread::sleep(Duration::from_millis(380));
    }

    emit_progress(
        &app,
        48,
        "正在覆盖安装",
        "正在替换程序文件和 Windows 安装记录。",
    );
    let mut installer = Command::new(&payload_path);
    installer.arg("/S");
    if !create_desktop_shortcut {
        installer.arg("/NS");
    }
    installer.env(INSTALL_LOCATION_ENV, &install_location);
    #[cfg(windows)]
    installer.raw_arg(format!("/D={}", install_location.to_string_lossy()));
    #[cfg(not(windows))]
    installer.arg(format!("/D={}", install_location.to_string_lossy()));
    let status = installer.status().map_err(error_text);
    let _ = fs::remove_file(&payload_path);
    let status = status?;
    if !status.success() {
        return Err(format!(
            "安装核心返回错误代码：{}",
            status.code().unwrap_or(-1)
        ));
    }

    emit_progress(
        &app,
        90,
        "正在验证安装结果",
        "正在确认最新版程序与唯一卸载记录。",
    );
    let recorded_location = installed_value("InstallLocation")
        .map(PathBuf::from)
        .ok_or_else(|| "安装完成后没有找到 Windows 安装位置记录".to_string())?;
    if comparable_path(&recorded_location) != comparable_path(&install_location) {
        return Err(format!(
            "安装核心没有采用所选目录：已选择 {}，实际记录为 {}",
            install_location.display(),
            recorded_location.display()
        ));
    }
    let installed_executable = recorded_location.join(MAIN_BINARY_NAME);
    if !installed_executable.exists() {
        return Err("安装完成后没有找到主程序，请检查安装目录权限".to_string());
    }

    if let Some(previous_location) = previous_install_location {
        emit_progress(
            &app,
            96,
            "正在整理旧版本",
            "正在移除原安装目录中的旧程序文件。",
        );
        remove_previous_program_files(&previous_location, &recorded_location);
    }

    emit_progress(&app, 100, "安装完成", "最新版已经就绪，原有配置完整保留。");
    Ok(())
}

#[tauri::command]
fn launch_installed_app() -> Result<(), String> {
    let install_location = installed_value("InstallLocation")
        .map(PathBuf::from)
        .ok_or_else(|| "没有找到安装位置".to_string())?;
    let executable = install_location.join(MAIN_BINARY_NAME);
    if !executable.exists() {
        return Err("没有找到已安装的主程序".to_string());
    }
    Command::new(executable).spawn().map_err(error_text)?;
    Ok(())
}

#[tauri::command]
fn minimize_installer(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "安装窗口不存在".to_string())?
        .minimize()
        .map_err(error_text)
}

#[tauri::command]
fn close_installer(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_install_context,
            select_install_location,
            install_product,
            launch_installed_app,
            minimize_installer,
            close_installer
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RiverXILee installer center");
}

#[cfg(test)]
mod tests {
    use super::{comparable_path, validate_install_location};
    use std::path::Path;

    #[test]
    fn accepts_normal_absolute_windows_path() {
        assert!(validate_install_location(r"C:\\Apps\\RiverXILee桌面歌词").is_ok());
    }

    #[test]
    fn rejects_relative_or_drive_root_path() {
        assert!(validate_install_location(r"RiverXILee桌面歌词").is_err());
        assert!(validate_install_location(r"C:\\").is_err());
    }

    #[test]
    fn compares_windows_install_paths_without_case_or_trailing_separator() {
        assert_eq!(
            comparable_path(Path::new(r"E:\Apps\RiverXILee桌面歌词\")),
            comparable_path(Path::new(r"e:\apps\riverxilee桌面歌词"))
        );
    }
}
