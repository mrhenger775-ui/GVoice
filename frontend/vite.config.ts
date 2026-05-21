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
    emptyOutDir: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("react") || id.includes("scheduler")) {
            return "vendor-react";
          }
          if (id.includes("socket.io-client")) {
            return "vendor-socket";
          }
          if (id.includes("livekit-client")) {
            return "vendor-livekit";
          }
          if (id.includes("hls.js")) {
            return "vendor-hls";
          }
          return "vendor-misc";
        }
      }
    }
  },
  server: {
    port: 5173
  }
});
