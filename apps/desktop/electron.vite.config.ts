import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Sandboxed preloads cannot `require()` at runtime, so we must bundle
    // everything into preload/index.js. Only `electron` itself stays
    // external (Electron provides it at runtime).
    build: {
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
