const { app, BrowserWindow, shell, session, desktopCapturer, dialog, ipcMain, globalShortcut } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const DESKTOP_START_URL = process.env.GVOICE_DESKTOP_URL || "https://gvoice.online";

const isDev = process.argv.includes("--dev");
let mainWindow = null;
let splashWindow = null;
const globalHotkeyActions = ["toggleMic", "toggleDeafen", "toggleScreenShare"];
let activeGlobalHotkeys = {};
let pushToTalkBinding = null;
let pushToTalkPressed = false;

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

function unregisterAllGlobalHotkeys() {
  globalShortcut.unregisterAll();
  activeGlobalHotkeys = {};
}

function registerGlobalHotkeys(bindings) {
  unregisterAllGlobalHotkeys();
  if (!bindings || typeof bindings !== "object") {
    return { ok: true, registered: [] };
  }

  const registered = [];
  const failed = [];
  for (const action of globalHotkeyActions) {
    const raw = bindings[action];
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }
    const accelerator = raw.trim();
    const success = globalShortcut.register(accelerator, () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("gvoice:global-hotkey", { action });
    });
    if (success) {
      activeGlobalHotkeys[action] = accelerator;
      registered.push({ action, accelerator });
    } else {
      failed.push({ action, accelerator });
    }
  }

  return { ok: failed.length === 0, registered, failed };
}

function resolveUiohookKeycode(token) {
  if (!token) {
    return null;
  }
  const raw = String(token).trim();
  if (!raw) {
    return null;
  }
  const aliases = {
    Esc: "Escape",
    Spacebar: "Space",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Del: "Delete",
    Ins: "Insert",
    Return: "Enter",
    `+`: "Equal"
  };
  const normalized = aliases[raw] || raw;
  const candidates = [
    normalized,
    normalized.toUpperCase(),
    normalized.charAt(0).toUpperCase() + normalized.slice(1),
    normalized.replace(/\s+/g, "")
  ];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(UiohookKey, candidate)) {
      return UiohookKey[candidate];
    }
  }
  return null;
}

function parsePttBinding(binding) {
  if (typeof binding !== "string" || !binding.trim()) {
    return null;
  }
  const parts = binding
    .split("+")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const keyToken = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((item) => item.toLowerCase());
  const keycode = resolveUiohookKeycode(keyToken);
  if (keycode == null) {
    return null;
  }
  return {
    raw: binding.trim(),
    keycode,
    ctrl: modifiers.includes("ctrl") || modifiers.includes("control"),
    alt: modifiers.includes("alt") || modifiers.includes("option"),
    shift: modifiers.includes("shift"),
    meta: modifiers.includes("meta") || modifiers.includes("cmd") || modifiers.includes("command") || modifiers.includes("super")
  };
}

function matchesPttBinding(event) {
  if (!pushToTalkBinding) {
    return false;
  }
  if (event.keycode !== pushToTalkBinding.keycode) {
    return false;
  }
  if (Boolean(event.ctrlKey) !== pushToTalkBinding.ctrl) {
    return false;
  }
  if (Boolean(event.altKey) !== pushToTalkBinding.alt) {
    return false;
  }
  if (Boolean(event.shiftKey) !== pushToTalkBinding.shift) {
    return false;
  }
  if (Boolean(event.metaKey) !== pushToTalkBinding.meta) {
    return false;
  }
  return true;
}

function setupGlobalPushToTalkHook() {
  uIOhook.on("keydown", (event) => {
    if (!matchesPttBinding(event) || pushToTalkPressed) {
      return;
    }
    pushToTalkPressed = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gvoice:ptt-hold", { down: true });
    }
  });

  uIOhook.on("keyup", (event) => {
    if (!pushToTalkPressed || !matchesPttBinding(event)) {
      return;
    }
    pushToTalkPressed = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gvoice:ptt-hold", { down: false });
    }
  });

  uIOhook.start();
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
        const sources = await desktopCapturer.getSources({
          types: ["window", "screen"],
          fetchWindowIcons: true,
          thumbnailSize: { width: 320, height: 180 }
        });

        if (!sources.length) {
          callback({});
          return;
        }

        const maxItems = 12;
        const listedSources = sources.slice(0, maxItems);
        const buttons = listedSources.map((source, index) => {
          const prefix = source.id.startsWith("window:") ? "Окно" : "Экран";
          const title = source.name?.trim() || `Источник ${index + 1}`;
          return `${index + 1}. ${prefix}: ${title}`;
        });
        buttons.push("Отмена");

        const pick = await dialog.showMessageBox(mainWindow ?? undefined, {
          type: "question",
          title: "Выбор демонстрации",
          message: "Что показать в демонстрации экрана?",
          detail: "Выберите окно или экран для трансляции.",
          buttons,
          cancelId: buttons.length - 1,
          defaultId: 0,
          noLink: true
        });

        if (pick.response < 0 || pick.response >= listedSources.length) {
          callback({});
          return;
        }

        callback({
          video: listedSources[pick.response],
          audio: "loopback"
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  void createWindow();
  setupAutoUpdates();

  ipcMain.handle("gvoice:set-global-hotkeys", async (_event, bindings) => {
    const globalResult = registerGlobalHotkeys(bindings);
    pushToTalkBinding = parsePttBinding(bindings?.pushToTalk);
    pushToTalkPressed = false;
    return {
      ...globalResult,
      pushToTalk: pushToTalkBinding ? pushToTalkBinding.raw : null
    };
  });

  setupGlobalPushToTalkHook();

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

app.on("will-quit", () => {
  unregisterAllGlobalHotkeys();
  try {
    uIOhook.stop();
  } catch {
    // ignore shutdown errors
  }
});
