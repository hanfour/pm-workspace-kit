import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { registerIpcHandlers } from "./ipc";
import { augmentUserBinPath } from "./path";
import { findRepoRoot } from "./workspace";

// Do this BEFORE anything spawns a child process (registerIpcHandlers →
// resolveProvider → `which claude`). Launchd-launched apps get a
// skeletal PATH that excludes ~/.local/bin etc.
augmentUserBinPath();

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "pmk desktop",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    if (is.dev) {
      win.webContents.openDevTools({ mode: "right" });
    }
  });

  // External links open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(
      `[pmk-main] renderer load failed ${code}: ${desc} url=${url}`,
    );
  });

  // Dev: load Vite's HMR server; Prod: load bundled HTML.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("dev.pmk.desktop");

  app.on("browser-window-created", (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerIpcHandlers(findRepoRoot());

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
