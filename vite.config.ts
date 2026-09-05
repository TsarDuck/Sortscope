import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // A relative base makes the same static bundle work in an installed desktop
  // app and in Vite's local preview without a web-server route rewrite.
  base: "./",
  plugins: [react()],
  server: {
    host: host || "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
  },
});
