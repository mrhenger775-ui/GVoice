import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";

document.documentElement.style.backgroundColor = "#030712";
document.documentElement.style.minHeight = "100%";
document.body.style.backgroundColor = "#030712";
document.body.style.minHeight = "100vh";
document.body.style.margin = "0";
document.body.style.color = "#e5e7eb";

const rootElement = document.getElementById("root")!;
rootElement.style.minHeight = "100vh";

createRoot(rootElement).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
