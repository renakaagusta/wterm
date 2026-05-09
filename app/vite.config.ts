import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Add your public dev hostname via VITE_ALLOWED_HOSTS (comma-separated).
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean),
    proxy: {
      "/api/terminal": { target: "ws://localhost:3001", ws: true },
      "/api": "http://localhost:3001",
    },
  },
});
