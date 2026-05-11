import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildVersion = process.env.VITE_APP_VERSION ?? new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion)
  },
  build: {
    // Keep old hashed assets so clients with stale index.html do not break on deploy.
    emptyOutDir: false
  },
  server: {
    port: 5173
  }
});
