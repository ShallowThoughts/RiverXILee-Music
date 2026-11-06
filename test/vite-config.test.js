import assert from "node:assert/strict";
import test from "node:test";
import config from "../vite.config.js";

test("dependency scanning starts at the app entry instead of crawling build artifacts", () => {
  assert.deepEqual(config.optimizeDeps.entries, ["index.html"]);
});
