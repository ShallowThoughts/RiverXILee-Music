import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("application, installer, locks and resource build use one release version", () => {
  for (const path of ["src-tauri/tauri.conf.json", "installer-ui/src-tauri/tauri.conf.json", "package-lock.json"]) {
    assert.equal(JSON.parse(read(path)).version, pkg.version, path);
  }
  for (const path of ["src-tauri/Cargo.toml", "installer-ui/src-tauri/Cargo.toml"]) {
    assert.ok(read(path).includes('version = "' + pkg.version + '"'), path);
  }
  assert.ok(read("installer-ui/src-tauri/src/lib.rs").includes('const TARGET_VERSION: &str = "' + pkg.version + '";'));
  assert.ok(read("src/main.js").includes('import { version as APP_VERSION } from "../package.json"'));
  assert.equal(pkg.license, "GPL-3.0-only");
});
