const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("gvoiceDesktop", {
  platform: process.platform
});
