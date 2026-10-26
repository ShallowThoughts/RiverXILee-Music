import assert from "node:assert/strict";
import test from "node:test";
import { filterFontCatalog, normalizeFontCatalog, resolveInstalledFont } from "../src/font-picker.js";
import { displayBackup, lyricFontFamily, parseDisplayBackup, sanitizeDisplaySettings } from "../src/settings.js";

const catalog = normalizeFontCatalog([
  { family: "Segoe UI Variable Display Semibold", displayName: "Segoe UI Variable Display Semibold", aliases: [] },
  { family: "Segoe UI Variable Display Semilight", displayName: "Segoe UI Variable Display Semilight", aliases: [] },
  { family: "Microsoft YaHei UI", displayName: "微软雅黑 UI", aliases: ["Microsoft YaHei UI", "微软雅黑 UI"] },
  "Arial", "arial", "@Arial", null, { family: 12 },
]);

test("font catalog keeps complete names and drops only duplicate or vertical entries", () => {
  assert.equal(catalog.length, 4);
  assert.ok(catalog.some((font) => font.family === "Segoe UI Variable Display Semibold"));
  assert.ok(catalog.every((font) => !font.family.endsWith(" Semib")));
});

test("empty search shows all families and searches recognize Chinese, English and multiple words", () => {
  assert.equal(filterFontCatalog(catalog, "").length, 4);
  assert.equal(filterFontCatalog(catalog, "微软雅黑")[0].family, "Microsoft YaHei UI");
  assert.equal(filterFontCatalog(catalog, "microsoft yahei")[0].family, "Microsoft YaHei UI");
  assert.equal(filterFontCatalog(catalog, "segoe semibold")[0].family, "Segoe UI Variable Display Semibold");
  assert.equal(filterFontCatalog(catalog, "不存在的字体").length, 0);
});

test("old truncated names are repaired only when the full family is unambiguous", () => {
  assert.equal(resolveInstalledFont(catalog, "Segoe UI Variable Display Semib"), "Segoe UI Variable Display Semibold");
  assert.equal(resolveInstalledFont(catalog, "微软雅黑 UI"), "Microsoft YaHei UI");
  assert.equal(resolveInstalledFont(catalog, "Not installed"), null);
  assert.equal(resolveInstalledFont(normalizeFontCatalog(["Segoe UI Variable Display"]), "Segoe UI Variable Display Semib"), "Segoe UI Variable Display");
  const prefix = "A".repeat(31);
  assert.equal(resolveInstalledFont(normalizeFontCatalog([`${prefix} One`, `${prefix} Two`]), prefix), null);
});

test("long font families survive settings, CSS application and backup restoration", () => {
  const family = "A complete installed font family with a very long descriptive name ".repeat(2).trim();
  assert.ok(family.length > 80);
  const settings = sanitizeDisplaySettings({ fontFamily: family });
  assert.equal(settings.fontFamily, family);
  assert.ok(lyricFontFamily(family).startsWith(`"${family}"`));
  assert.equal(parseDisplayBackup(displayBackup(settings, [])).display.fontFamily, family);
});
