import assert from "node:assert/strict";
import test from "node:test";
import { updateErrorMessage, updateProgressView } from "../src/update-ui.js";

test("update states distinguish connection, retry, download and verification", () => {
  assert.match(updateProgressView({ status: "connecting" }).detail, /连接.*1 \/ 3/);
  assert.deepEqual(updateProgressView({ status: "retrying", attempt: 2, percent: 75 }), {
    percent: 0, button: "正在重试…", detail: "下载中断，准备第 2 / 3 次尝试",
  });
  assert.equal(updateProgressView({ status: "verifying" }).button, "正在校验…");
  assert.deepEqual(updateProgressView({ percent: 50, downloadedBytes: 1048576, totalBytes: 2097152 }), {
    percent: 50, button: "下载中 50%", detail: "1.0 / 2.0 MB · 下载完成后自动校验",
  });
});

test("update display bounds invalid progress and handles an unknown download size", () => {
  assert.equal(updateProgressView({ percent: 300 }).percent, 100);
  assert.equal(updateProgressView({ percent: -50 }).percent, 0);
  assert.match(updateProgressView({ downloadedBytes: 1024 }).detail, /0\.0 \/ -- MB/);
});

test("update errors preserve actionable Chinese text without exposing Error prefixes", () => {
  const message = "下载更新超时，请重试或手动下载";
  assert.equal(updateErrorMessage(new Error(message)), message);
  assert.equal(updateErrorMessage(`Error: ${message}`), message);
  assert.equal(updateErrorMessage(null), "更新失败，请稍后重试或手动下载");
});
