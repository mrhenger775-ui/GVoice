const { app, BrowserWindow, shell, session, desktopCapturer, dialog, ipcMain } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const DESKTOP_START_URL = process.env.GVOICE_DESKTOP_URL || "https://gvoice.online";

const isDev = process.argv.includes("--dev");
let mainWindow = null;
let splashWindow = null;

async function clearDesktopWebCache() {
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ["serviceworkers", "cachestorage"]
    });
  } catch (error) {
    console.warn("[desktop-cache] failed to clear cache:", error?.message ?? error);
  }
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
async function createWindow() {
  splashWindow = new BrowserWindow({
    width: 560,
    height: 320,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: "#020617",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await splashWindow.loadFile(path.join(__dirname, "splash.html"));

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, "icons", "icon.ico"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  win.webContents.setAudioMuted(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const revealMainWindow = () => {
    if (!win.isDestroyed()) {
      win.show();
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    splashWindow = null;
  };

  win.webContents.once("did-finish-load", revealMainWindow);
  win.webContents.once("did-fail-load", revealMainWindow);

  if (isDev) {
    await win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
    mainWindow = win;
    return;
  }

  await win.loadURL(DESKTOP_START_URL);
  mainWindow = win;
}

function setupAutoUpdates() {
  if (!app.isPackaged || isDev) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send("gvoice:update-status", {
      stage: "error",
      message: err?.message ?? String(err ?? "Unknown update error")
    });
    console.warn("[auto-update] error:", err?.message ?? err);
  });

  autoUpdater.on("checking-for-update", () => {
    mainWindow?.webContents.send("gvoice:update-status", { stage: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("gvoice:update-status", {
      stage: "available",
      version: info?.version ?? null
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("gvoice:update-status", {
      stage: "downloading",
      percent: Number(progress?.percent ?? 0)
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    mainWindow?.webContents.send("gvoice:update-status", {
      stage: "not-available",
      version: info?.version ?? null
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    mainWindow?.webContents.send("gvoice:update-status", {
      stage: "downloaded",
      version: info?.version ?? null
    });
    const response = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "Обновление готово",
      message: `Скачано обновление GVoice ${info?.version ?? ""}.`,
      detail: "Нажми «Перезапустить», чтобы установить обновление сейчас.",
      buttons: ["Перезапустить", "Позже"],
      defaultId: 0,
      cancelId: 1
    });
    if (response.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  void autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => {
    void autoUpdater.checkForUpdatesAndNotify();
  }, 60 * 60 * 1000);

  ipcMain.handle("gvoice:check-for-updates", async () => {
    if (!app.isPackaged || isDev) {
      return {
        ok: false,
        reason: "dev"
      };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error?.message ?? String(error)
      };
    }
  });
}

app.whenReady().then(() => {
  void clearDesktopWebCache();

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === "media" || permission === "display-capture") {
      return true;
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media" || permission === "display-capture") {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        callback({
          video: sources[0],
          audio: "loopback"
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true }
  );

  void createWindow();
  setupAutoUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
