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
    // @pmk/shared exposes a browser condition from its public package
    // boundary. Keep it browser-safe: Vite resolves that condition to the
    // TypeScript source while Node consumers use the compiled CJS entry.
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
