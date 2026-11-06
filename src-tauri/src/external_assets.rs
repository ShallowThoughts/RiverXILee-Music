use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{borrow::Cow, collections::BTreeMap, fs, io, path::Path};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    app_version: String,
    files: BTreeMap<String, String>,
}

pub struct ExternalAssets {
    files: BTreeMap<String, Vec<u8>>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains(['\\', ':'])
        && key.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

impl ExternalAssets {
    pub fn load(root: &Path) -> io::Result<Self> {
        let root = root.canonicalize()?;
        let manifest_path = root.join("asset-manifest.json").canonicalize()?;
        if !manifest_path.starts_with(&root) {
            return Err(invalid(
                "Resource manifest is outside the application directory",
            ));
        }
        let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)
            .map_err(|error| invalid(error.to_string()))?;
        if manifest.format_version != 1 || manifest.app_version != env!("CARGO_PKG_VERSION") {
            return Err(invalid("Resource version does not match the application"));
        }
        if !manifest.files.contains_key("index.html") {
            return Err(invalid("Missing index.html in resource manifest"));
        }
        let mut files = BTreeMap::new();
        for (key, checksum) in manifest.files {
            if !safe_key(&key) {
                return Err(invalid("Invalid resource path"));
            }
            let path = root.join(&key).canonicalize()?;
            if !path.starts_with(&root) {
                return Err(invalid("Resource is outside the application directory"));
            }
            let bytes = fs::read(path)?;
            if format!("{:x}", Sha256::digest(&bytes)) != checksum {
                return Err(invalid(format!("Resource checksum mismatch: {key}")));
            }
            files.insert(format!("/{key}"), bytes);
        }
        Ok(Self { files })
    }
}

impl<R: tauri::Runtime> tauri::Assets<R> for ExternalAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.files
            .get(key.as_ref())
            .map(|bytes| Cow::Borrowed(bytes.as_slice()))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            self.files
                .iter()
                .map(|(key, bytes)| (Cow::Borrowed(key.as_str()), Cow::Borrowed(bytes.as_slice()))),
        )
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // The application has no inline scripts or configured CSP hashes.
        Box::new(std::iter::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "riverxilee-assets-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("index.html"), b"external page").unwrap();
            Self(path)
        }
        fn manifest(&self, key: &str, hash: &str, version: &str) {
            let value = serde_json::json!({
                "formatVersion": 1, "appVersion": version, "files": { key: hash }
            });
            fs::write(self.0.join("asset-manifest.json"), value.to_string()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.0.join("index.html"));
            let _ = fs::remove_file(self.0.join("asset-manifest.json"));
            let _ = fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn serves_external_bytes_and_not_unlisted_files() {
        let fixture = Fixture::new();
        fixture.manifest(
            "index.html",
            &format!("{:x}", Sha256::digest(b"external page")),
            env!("CARGO_PKG_VERSION"),
        );
        let assets = ExternalAssets::load(&fixture.0).unwrap();
        assert_eq!(assets.files["/index.html"], b"external page");
        assert!(!assets.files.contains_key("/asset-manifest.json"));
    }

    #[test]
    fn rejects_missing_changed_and_mixed_version_resources() {
        let fixture = Fixture::new();
        assert!(ExternalAssets::load(&fixture.0).is_err());
        fixture.manifest("index.html", "incorrect hash", env!("CARGO_PKG_VERSION"));
        assert!(ExternalAssets::load(&fixture.0).is_err());
        fixture.manifest(
            "index.html",
            &format!("{:x}", Sha256::digest(b"external page")),
            "0.0.0",
        );
        assert!(ExternalAssets::load(&fixture.0).is_err());
        fixture.manifest(
            "index.html",
            &format!("{:x}", Sha256::digest(b"external page")),
            env!("CARGO_PKG_VERSION"),
        );
        fs::remove_file(fixture.0.join("index.html")).unwrap();
        assert!(ExternalAssets::load(&fixture.0).is_err());
    }

    #[test]
    fn rejects_traversal_absolute_paths_and_windows_streams() {
        for key in [
            "../secret",
            "/index.html",
            "C:/secret",
            "assets/../secret",
            "assets//file",
            "assets\\file",
            "index.html:stream",
        ] {
            assert!(!safe_key(key), "{key}");
        }
        assert!(safe_key("assets/index-abc123.js"));
    }
}
