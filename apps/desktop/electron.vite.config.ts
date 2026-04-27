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
    resolve: {
      // Import @pmk/shared straight from TS source — avoids the
      // CJS→ESM interop issue where Rollup can't statically resolve
      // named exports from TypeScript's `Object.defineProperty`-style
      // compiled output. Only affects renderer bundling; CLI/main
      // still consume the compiled dist via require().
      //
      // CONSTRAINTS:
      // - @pmk/shared MUST stay browser-safe (no `node:fs`, no
      //   `process.env`, no Electron-only globals). Vite bundles the
      //   raw .ts file; any Node-only import will only break at
      //   runtime in the renderer.
      // - The relative path is brittle: if the monorepo is restructured,
      //   this alias must be updated or Vite silently falls back to the
      //   compiled CJS dist (which then re-trips the named-export bug).
      // - Long-term fix: ship @pmk/shared as dual CJS/ESM (tsup or
      //   project-references) so every consumer goes through the
      //   package boundary. Tracked as a v1.1 task.
      alias: {
        "@pmk/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
