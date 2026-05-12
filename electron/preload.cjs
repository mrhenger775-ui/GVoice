const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gvoiceDesktop", {
  platform: process.platform,
  checkForUpdates: () => ipcRenderer.invoke("gvoice:check-for-updates"),
  onUpdateStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("gvoice:update-status", listener);
    return () => ipcRenderer.removeListener("gvoice:update-status", listener);
  }
});
