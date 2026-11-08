import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displacementMap, glassFilter, glassDimensions, GLASS_CHANNELS } from "../src/liquid-glass.js";

test("glass follows the documented RGB displacement pipeline", () => {
  assert.deepEqual(GLASS_CHANNELS, [48, 44, 40]);
  const filter = glassFilter("preview-glass");
  assert.ok(!filter.includes("feMerge"), "avoid ghosting by not mixing shifted copies into the original");
  assert.ok(filter.includes('mode="screen"'));
  assert.ok(filter.includes('stdDeviation="0.5"'));
  assert.throws(() => glassFilter('"><script>'), /Invalid/);
});

test("glass uses the requested blur, saturation, white overlay and thin inner edge", () => {
  const css = readFileSync(new URL("../src/liquid-glass.css", import.meta.url), "utf8");
  assert.match(css, /rgb\(255 255 255 \/ 10%\)/);
  assert.match(css, /blur\(18px\) var\(--glass-refraction\) saturate\(1\.65\)/);
  assert.match(css, /inset 0 0 0 1px/);
});

test("displacement geometry is deterministic and bounded for resize and hidden surfaces", () => {
  assert.deepEqual(glassDimensions(720, 58, 50), { width: 720, height: 58, radius: 29 });
  assert.deepEqual(glassDimensions(NaN, Infinity, undefined), { width: 720, height: 58, radius: 24 });
  const map = displacementMap(720, 58, 29);
  assert.equal(map, displacementMap(720, 58, 29));
  assert.ok(map.startsWith("data:image/svg+xml,"));
  assert.ok(decodeURIComponent(map).includes('fill="#808080"'));
  assert.ok(glassDimensions(-1, -1, 500).radius <= 12);
});

test("preview config is isolated while the stable identifier and version stay unchanged", () => {
  const read = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
  const stable = read("src-tauri/tauri.conf.json");
  const preview = read("src-tauri/tauri.glass-preview.conf.json");
  assert.equal(stable.identifier, "top.lxixi.riverxilee-desktop-lyrics");
  assert.notEqual(preview.identifier, stable.identifier);
  assert.equal(preview.bundle.active, false);
  assert.equal(stable.version, read("package.json").version);
});

test("preview cannot lock the window without an unlock shortcut", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(source, /async function setLocked\(locked\)[\s\S]*?if \(IS_GLASS_PREVIEW && locked\)/);
  assert.ok(source.includes("elements.lock.disabled = true"));
  assert.ok(source.includes('document.querySelector("#toast-message").textContent'));
});

test("stable builds enable glass without inheriting preview-only restrictions", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.ok(source.includes('document.body.classList.add("glass-preview")'));
  assert.match(source, /const cleanupGlass = initLiquidGlass\([\s\S]*?if \(IS_GLASS_PREVIEW\) \{\s*elements.autostart.disabled = true/);
  assert.ok(source.includes('${IS_GLASS_PREVIEW ? " · 液态玻璃预览" : ""}'));
});
