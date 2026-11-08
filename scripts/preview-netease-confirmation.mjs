// Export a self-contained, non-controlling visual preview; no localhost service required.
import { build } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const output = resolve("artifacts/netease-confirmation-preview");
await build({ configFile: false, base: "./", build: { outDir: output,
  rollupOptions: { input: resolve("test/fixtures/netease-confirmation.html") } } });
const page = resolve(output, "test/fixtures/netease-confirmation.html");
let html = await readFile(page, "utf8");
for (const match of [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const js = await readFile(resolve(dirname(page), match[1]), "utf8");
  html = html.replace(match[0], `<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`);
}
for (const match of [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
  const path = resolve(dirname(page), match[1]);
  let css = await readFile(path, "utf8");
  for (const url of [...css.matchAll(/url\(([^)]+)\)/g)]) {
    const name = url[1].replaceAll(/["']/g, "");
    if (!name.startsWith("data:") && !name.startsWith("#")) {
      const file = name.split("#")[0];
      const bytes = await readFile(resolve(dirname(path), file));
      const mime = file.endsWith("woff2") ? "font/woff2" : file.endsWith("woff") ? "font/woff" : file.endsWith("svg") ? "image/svg+xml" : "application/octet-stream";
      css = css.replaceAll(url[0], `url(data:${mime};base64,${bytes.toString("base64")})`);
    }
  }
  html = html.replace(match[0], `<style>${css}</style>`);
}
const standalone = resolve(output, "preview.html");
await writeFile(standalone, html);
console.log("Standalone visual preview: " + standalone);
