import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("public four-part version and internal build versions stay aligned across application and installer", () => {
  assert.equal(pkg.displayVersion, "1.2.0.0");
  assert.equal(pkg.displayVersion, pkg.version + ".0");
  for (const path of ["src-tauri/tauri.conf.json", "installer-ui/src-tauri/tauri.conf.json", "package-lock.json"]) {
    assert.equal(JSON.parse(read(path)).version, pkg.version, path);
  }
  for (const path of ["src-tauri/Cargo.toml", "installer-ui/src-tauri/Cargo.toml"]) {
    assert.ok(read(path).includes('version = "' + pkg.version + '"'), path);
  }
  assert.ok(read("installer-ui/src-tauri/src/lib.rs").includes('const TARGET_VERSION: &str = "' + pkg.displayVersion + '";'));
  assert.ok(read("src/main.js").includes('import { displayVersion as APP_VERSION } from "../package.json"'));
  assert.ok(read("scripts/package-folder.ps1").includes("$manifest.appVersion -ne $buildVersion"));
  assert.ok(read("src-tauri/src/lib.rs").includes('let current_version = "' + pkg.displayVersion + '".to_string()'));
  assert.equal(pkg.license, "GPL-3.0-only");
  assert.ok(read("scripts/build-release.ps1").includes('$env:VITE_LIQUID_GLASS_PREVIEW = "0"'));
  assert.ok(read("scripts/build-release.ps1").includes('ProductName -ne $nativeProductName'));
  assert.ok(read("scripts/build-release.ps1").includes('Get-Content -Raw -Encoding UTF8'));
});
