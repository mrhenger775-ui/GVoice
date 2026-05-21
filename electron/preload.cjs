const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gvoiceDesktop", {
  platform: process.platform,
  checkForUpdates: () => ipcRenderer.invoke("gvoice:check-for-updates"),
  setGlobalHotkeys: (bindings) => ipcRenderer.invoke("gvoice:set-global-hotkeys", bindings),
  onGlobalHotkey: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("gvoice:global-hotkey", listener);
    return () => ipcRenderer.removeListener("gvoice:global-hotkey", listener);
  },
  onPushToTalkHold: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("gvoice:ptt-hold", listener);
    return () => ipcRenderer.removeListener("gvoice:ptt-hold", listener);
  },
  onUpdateStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("gvoice:update-status", listener);
    return () => ipcRenderer.removeListener("gvoice:update-status", listener);
  }
});
