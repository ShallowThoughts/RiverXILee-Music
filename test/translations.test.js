import test from "node:test";
import assert from "node:assert/strict";
import { attachTranslations, needsTranslationRefresh, translationStatus } from "../src/translations.js";
import { sanitizeDisplaySettings, displayBackup, parseDisplayBackup } from "../src/settings.js";

test("platform translations align by timestamp without replacing original word timing", () => {
  const words = [{ text: "Hello", timeMs: 1000, durationMs: 500 }];
  const lines = [{ timeMs: 1000, text: "Hello", words }, { timeMs: 3000, text: "World" }];
  const translated = attachTranslations(lines, "[00:01.10]你好\n[00:03.00]世界");
  assert.equal(translated[0].text, "Hello");
  assert.equal(translated[0].translation, "你好");
  assert.equal(translated[0].words, words);
  assert.equal(translated[1].translation, "世界");
  assert.equal(lines[0].translation, undefined);
});

test("missing, duplicate and out-of-sync translation never invent a translated row", () => {
  const lines = [{ timeMs: 1000, text: "Hello" }];
  assert.equal(attachTranslations(lines, null), lines);
  assert.equal(attachTranslations(lines, "[00:01.00]Hello")[0].translation, undefined);
  assert.equal(attachTranslations(lines, "[00:10.00]错开的译文")[0].translation, undefined);
  assert.equal(attachTranslations(lines, "[00:01.00]//")[0].translation, undefined);
  const withTitle = attachTranslations([{ timeMs: 0, text: "Song title" }, { timeMs: 520, text: "Hello" }],
    "[00:00.00]//\n[00:00.52]你好");
  assert.equal(withTitle[0].translation, undefined);
  assert.equal(withTitle[1].translation, "你好");
});

test("legacy QQ empty translations refresh once without replacing manual bindings", () => {
  const old = { songMid: "002sXtHN37Aqki", translationLrc: null };
  assert.equal(needsTranslationRefresh(old), true);
  assert.equal(needsTranslationRefresh({ ...old, translationRevision: 1 }), false);
  assert.equal(needsTranslationRefresh({ ...old, manuallySelected: true }), false);
  assert.equal(needsTranslationRefresh({ ...old, instrumental: true }), false);
  assert.equal(needsTranslationRefresh({ songMid: "netease:42", translationLrc: null }), false);
});

test("translation help distinguishes loading, not retrieved, alignment and success", () => {
  const state = { display: { translationMode: "bilingual" }, lines: [], lyricStatus: "ready", lyricMatch: { translationLrc: null } };
  assert.match(translationStatus(state), /本次未取得/);
  assert.match(translationStatus({ ...state, lyricStatus: "loading" }), /正在获取/);
  assert.match(translationStatus({ ...state, lyricMatch: { translationLrc: "[00:10]译文" } }), /暂未.*对齐/);
  assert.match(translationStatus({ ...state, lines: [{ translation: "译文" }] }), /已加载/);
});

test("translation choice is opt-in and survives display backup", () => {
  assert.equal(sanitizeDisplaySettings().translationMode, "off");
  const settings = sanitizeDisplaySettings({ translationMode: "bilingual" });
  assert.equal(parseDisplayBackup(displayBackup(settings, [])).display.translationMode, "bilingual");
  assert.equal(sanitizeDisplaySettings({ translationMode: "unknown" }).translationMode, "off");
});
