import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const notices = [
  "RiverXILee Desktop Lyrics - Third-party notices",
  "The application is GPL-3.0-only. The dependencies below retain their own licenses.",
  "This inventory includes Windows dependencies and build tools from both Cargo graphs.",
  "Local QQ/NetEase player compatibility protocol references: BrimDeck (MoFeng2223), Apache-2.0.",
  "Source: https://github.com/MoFeng2223/BrimDeck (Native/QqMediaConnection, NeteaseSource, NeteaseBridgeScript).",
  "RiverXILee implementations are limited to media metadata and progress control; no account APIs or persistent client patches are included.",
];
const seen = new Set();
async function collect(label, folder, metadata) {
  if (seen.has(label)) return;
  seen.add(label);
  notices.push("\n" + "=".repeat(72), label, metadata);
  const files = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(licen[sc]e|copying|notice)([._-].*)?$/i.test(entry.name))
    .map((entry) => join(folder, entry.name));
  for (const file of new Set(files)) {
    notices.push("\n--- " + file.split(/[\\/]/).at(-1) + " ---", await readFile(file, "utf8"));
  }
}
for (const manifest of ["src-tauri/Cargo.toml", "installer-ui/src-tauri/Cargo.toml"]) {
  const graph = JSON.parse(execFileSync("cargo", ["metadata", "--offline",
    "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc",
    "--manifest-path", manifest], { cwd: root, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 }));
  const ids = new Set(graph.resolve.nodes.map((node) => node.id));
  for (const pkg of graph.packages) {
    if (!ids.has(pkg.id) || pkg.name.startsWith("riverxilee-")) continue;
    await collect(pkg.name + " " + pkg.version, dirname(pkg.manifest_path),
      "License: " + (pkg.license ?? pkg.license_file ?? "See upstream") + "\nSource: " + (pkg.repository ?? pkg.source ?? ""));
    if (pkg.license_file) {
      const file = join(dirname(pkg.manifest_path), pkg.license_file);
      notices.push(await readFile(file, "utf8"));
    }
  }
}
const app = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const name of Object.keys(app.dependencies)) {
  const folder = join(root, "node_modules", name);
  const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  await collect(name + " " + pkg.version, folder, "License: " + pkg.license);
}
await writeFile(join(root, "THIRD_PARTY_NOTICES.txt"), notices.join("\n") + "\n");
console.log("Collected notices for " + seen.size + " dependency packages.");
