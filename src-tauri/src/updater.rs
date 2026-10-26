use super::{UpdateDownloadProgress, UpdateInfo};
use futures_lite::StreamExt;
use reqwest::{Client, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_ATTEMPTS: u8 = 3;
static CLIENT: OnceLock<Client> = OnceLock::new();

fn client() -> &'static Client {
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(45))
            .timeout(DOWNLOAD_TIMEOUT)
            .user_agent(concat!(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiverXILeeDesktopLyrics/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("Update HTTP client should initialize")
    })
}

#[derive(Debug)]
struct Failure {
    message: String,
    retryable: bool,
}

fn network_failure(error: reqwest::Error, operation: &str) -> Failure {
    let (message, retryable) = if error.is_timeout() {
        (format!("{operation}超时，请重试或手动下载"), true)
    } else if error.is_connect() {
        ("无法连接 GitHub，请检查网络后重试".to_string(), true)
    } else if let Some(status) = error.status() {
        match status {
            StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => (
                "GitHub 暂时限制访问，请稍后重试或手动下载".to_string(),
                false,
            ),
            StatusCode::NOT_FOUND => ("更新文件暂不可用，请重新检查更新".to_string(), false),
            _ if status.is_server_error() => ("GitHub 服务暂不可用，请稍后重试".to_string(), true),
            _ => (
                format!("{operation}失败（HTTP {}），请稍后重试", status.as_u16()),
                false,
            ),
        }
    } else {
        (
            format!("{operation}响应异常或连接中断，请重试或手动下载"),
            true,
        )
    };
    Failure { message, retryable }
}

fn disk_failure(_: std::io::Error) -> Failure {
    Failure {
        message: "无法保存更新包，请检查临时目录权限和磁盘空间".to_string(),
        retryable: false,
    }
}

async fn retry_pause(attempt: u8) {
    tokio::time::sleep(Duration::from_secs(u64::from(attempt))).await;
}

pub(super) async fn fetch_release() -> Result<Value, String> {
    fetch_release_from(
        client(),
        "https://api.github.com/repos/ShallowThoughts/RiverXILee-Music/releases/latest",
    )
    .await
}

async fn fetch_release_from(client: &Client, url: &str) -> Result<Value, String> {
    for attempt in 1..=MAX_ATTEMPTS {
        // The short metadata deadline must never become the installer deadline.
        let result = async {
            client
                .get(url)
                .timeout(CHECK_TIMEOUT)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        }
        .await;
        match result {
            Ok(release) => return Ok(release),
            Err(error) => {
                let failure = network_failure(error, "检查更新");
                if !failure.retryable || attempt == MAX_ATTEMPTS {
                    return Err(failure.message);
                }
                retry_pause(attempt).await;
            }
        }
    }
    unreachable!()
}

pub(super) async fn download_verified(
    update: &UpdateInfo,
    progress: impl Fn(UpdateDownloadProgress),
) -> Result<String, String> {
    download_to(client(), update, &std::env::temp_dir(), progress).await
}

async fn download_to(
    client: &Client,
    update: &UpdateInfo,
    directory: &Path,
    progress: impl Fn(UpdateDownloadProgress),
) -> Result<String, String> {
    if update.latest_version.is_empty()
        || !update
            .latest_version
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.')
    {
        return Err("更新版本信息异常，请重新检查更新".to_string());
    }
    let file_name = format!(
        "RiverXILee-Desktop-Lyrics_{}_x64-setup.exe",
        update.latest_version
    );
    let installer_path = directory.join(&file_name);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let part_path = directory.join(format!("{file_name}.{}.{nonce}.part", std::process::id()));
    for attempt in 1..=MAX_ATTEMPTS {
        let result = download_once(client, update, &part_path, attempt, &progress).await;
        match result {
            Ok(()) => {
                if let Err(error) = fs::rename(&part_path, &installer_path) {
                    let _ = fs::remove_file(&part_path);
                    return Err(disk_failure(error).message);
                }
                return Ok(installer_path.to_string_lossy().into_owned());
            }
            Err(failure) => {
                let _ = fs::remove_file(&part_path);
                if !failure.retryable || attempt == MAX_ATTEMPTS {
                    return Err(failure.message);
                }
                report(&progress, 0, update.download_size, "retrying", attempt + 1);
                retry_pause(attempt).await;
            }
        }
    }
    unreachable!()
}

fn report(
    progress: &impl Fn(UpdateDownloadProgress),
    downloaded: u64,
    total: u64,
    status: &str,
    attempt: u8,
) {
    progress(UpdateDownloadProgress {
        downloaded_bytes: downloaded,
        total_bytes: total,
        percent: if total > 0 {
            (downloaded.saturating_mul(100) / total).min(100) as u8
        } else {
            0
        },
        status: status.to_string(),
        attempt,
    });
}

async fn download_once(
    client: &Client,
    update: &UpdateInfo,
    part_path: &Path,
    attempt: u8,
    progress: &impl Fn(UpdateDownloadProgress),
) -> Result<(), Failure> {
    report(progress, 0, update.download_size, "connecting", attempt);
    let response = client
        .get(&update.download_url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| network_failure(error, "下载更新"))?;
    let total = response.content_length().unwrap_or(update.download_size);
    let mut installer = fs::File::create_new(part_path).map_err(disk_failure)?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| network_failure(error, "下载更新"))?;
        installer.write_all(&chunk).map_err(disk_failure)?;
        hasher.update(&chunk);
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        report(progress, downloaded, total, "downloading", attempt);
    }
    installer.flush().map_err(disk_failure)?;
    drop(installer);
    report(progress, downloaded, total, "verifying", attempt);
    if format!("{:x}", hasher.finalize()) != update.sha256 {
        return Err(Failure {
            message: "更新包 SHA-256 校验失败，已删除，请重新下载".to_string(),
            retryable: false,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, io::Read, net::TcpListener, path::PathBuf, thread};

    struct Reply {
        status: u16,
        body: Vec<u8>,
        declared_length: usize,
        pause: Duration,
    }

    fn reply(status: u16, body: &[u8]) -> Reply {
        Reply {
            status,
            body: body.to_vec(),
            declared_length: body.len(),
            pause: Duration::ZERO,
        }
    }

    fn serve(replies: Vec<Reply>) -> (String, thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let mut count = 0;
            for response in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                count += 1;
                let headers = format!(
                    "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status, response.declared_length
                );
                let _ = stream.write_all(headers.as_bytes());
                if response.pause.is_zero() {
                    let _ = stream.write_all(&response.body);
                } else {
                    let _ = stream.write_all(&response.body[..1]);
                    let _ = stream.flush();
                    thread::sleep(response.pause);
                    let _ = stream.write_all(&response.body[1..]);
                }
            }
            count
        });
        (url, server)
    }

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "RiverXILee-updater-test-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            for entry in fs::read_dir(&self.0).unwrap() {
                let _ = fs::remove_file(entry.unwrap().path());
            }
            let _ = fs::remove_dir(&self.0);
        }
    }

    fn update(url: String, body: &[u8]) -> UpdateInfo {
        UpdateInfo {
            available: true,
            current_version: "1.1.2".into(),
            latest_version: "1.1.3".into(),
            download_url: url,
            download_size: body.len() as u64,
            release_notes: String::new(),
            sha256: format!("{:x}", Sha256::digest(body)),
        }
    }

    fn test_client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }

    #[test]
    fn download_can_continue_beyond_the_old_twelve_second_deadline() {
        let body = b"verified update package";
        let mut slow = reply(200, body);
        slow.pause = Duration::from_secs(13);
        let (url, server) = serve(vec![slow]);
        let directory = TestDirectory::new();
        // Even a client's short default must be overridden for a package request.
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let path = tauri::async_runtime::block_on(download_to(
            &client,
            &update(url, body),
            &directory.0,
            |_| {},
        ))
        .unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(server.join().unwrap(), 1);
    }

    #[test]
    fn retries_server_failures_and_resets_partial_download_progress() {
        let body = b"verified update package";
        let mut interrupted = reply(200, b"incomplete");
        interrupted.declared_length = 1000;
        let (url, server) = serve(vec![
            reply(503, b"unavailable"),
            interrupted,
            reply(200, body),
        ]);
        let directory = TestDirectory::new();
        let progress = RefCell::new(Vec::new());
        let path = tauri::async_runtime::block_on(download_to(
            &test_client(),
            &update(url, body),
            &directory.0,
            |event| progress.borrow_mut().push(event),
        ))
        .unwrap();
        assert_eq!(fs::read(path).unwrap(), body);
        assert_eq!(server.join().unwrap(), 3);
        let progress = progress.borrow();
        assert!(
            progress
                .iter()
                .any(|p| p.status == "retrying" && p.attempt == 2 && p.downloaded_bytes == 0)
        );
        assert!(
            progress
                .iter()
                .any(|p| p.status == "retrying" && p.attempt == 3)
        );
        assert_eq!(progress.last().unwrap().status, "verifying");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn checksum_failure_cleans_partial_file_and_preserves_existing_installer() {
        let (url, server) = serve(vec![reply(200, b"corrupt package")]);
        let directory = TestDirectory::new();
        let existing = directory
            .0
            .join("RiverXILee-Desktop-Lyrics_1.1.3_x64-setup.exe");
        fs::write(&existing, b"previous verified installer").unwrap();
        let error = tauri::async_runtime::block_on(download_to(
            &test_client(),
            &update(url, b"expected package"),
            &directory.0,
            |_| {},
        ))
        .unwrap_err();
        assert!(error.contains("SHA-256 校验失败"));
        assert_eq!(fs::read(existing).unwrap(), b"previous verified installer");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        assert_eq!(server.join().unwrap(), 1);
    }

    #[test]
    fn stalled_download_reports_chinese_timeout_and_leaves_no_installer() {
        let replies = (0..3)
            .map(|_| {
                let mut response = reply(200, b"slow package");
                response.pause = Duration::from_millis(300);
                response
            })
            .collect();
        let (url, server) = serve(replies);
        let directory = TestDirectory::new();
        let client = Client::builder()
            .no_proxy()
            .read_timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let error = tauri::async_runtime::block_on(download_to(
            &client,
            &update(url, b"slow package"),
            &directory.0,
            |_| {},
        ))
        .unwrap_err();
        assert!(error.contains("下载更新超时"), "{error}");
        assert!(!error.contains("decoding"));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
        assert_eq!(server.join().unwrap(), 3);
    }

    #[test]
    fn temporary_metadata_failure_is_retried() {
        let (url, server) = serve(vec![
            reply(502, b"bad gateway"),
            reply(200, br#"{"tag_name":"v1.1.3"}"#),
        ]);
        let release =
            tauri::async_runtime::block_on(fetch_release_from(&test_client(), &url)).unwrap();
        assert_eq!(release["tag_name"], "v1.1.3");
        assert_eq!(server.join().unwrap(), 2);
    }

    #[test]
    fn invalid_metadata_has_actionable_chinese_error_after_bounded_retries() {
        let (url, server) = serve(
            (0..3)
                .map(|_| reply(200, b"<html>not JSON</html>"))
                .collect(),
        );
        let error =
            tauri::async_runtime::block_on(fetch_release_from(&test_client(), &url)).unwrap_err();
        assert!(error.contains("检查更新响应异常"), "{error}");
        assert!(!error.contains("decoding"));
        assert_eq!(server.join().unwrap(), 3);
    }

    #[test]
    fn rate_limit_is_not_retried_immediately() {
        let (url, server) = serve(vec![reply(403, b"rate limit")]);
        let error =
            tauri::async_runtime::block_on(fetch_release_from(&test_client(), &url)).unwrap_err();
        assert!(error.contains("GitHub 暂时限制访问"));
        assert_eq!(server.join().unwrap(), 1);
    }

    #[test]
    #[ignore = "live official update package download and SHA-256 check"]
    fn downloads_and_verifies_the_live_official_installer() {
        let update = tauri::async_runtime::block_on(crate::check_for_update()).unwrap();
        let directory = TestDirectory::new();
        let began = std::time::Instant::now();
        let path =
            tauri::async_runtime::block_on(download_to(client(), &update, &directory.0, |_| {}))
                .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), update.download_size);
        println!(
            "Official installer downloaded and SHA-256 verified: {} bytes in {:.2}s",
            update.download_size,
            began.elapsed().as_secs_f64()
        );
    }
}
