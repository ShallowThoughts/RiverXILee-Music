import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  optimizeDeps: {
    // Avoid crawling Rust build artifacts, installer pages and test fixtures.
    entries: ["index.html"],
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
