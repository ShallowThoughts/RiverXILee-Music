import { build } from "vite";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

await build();
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const root = new URL("../dist/", import.meta.url);
const directory = (await import("node:url")).fileURLToPath(root);
const files = {};
for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const fullPath = join(entry.parentPath ?? entry.path, entry.name);
  const key = relative(directory, fullPath).replaceAll("\\", "/");
  files[key] = createHash("sha256").update(await readFile(fullPath)).digest("hex");
}
await writeFile(new URL("asset-manifest.json", root), JSON.stringify({
  formatVersion: 1,
  appVersion: version,
  files,
}, null, 2) + "\n");
console.log(`External web resources: ${Object.keys(files).length} files, v${version}`);
