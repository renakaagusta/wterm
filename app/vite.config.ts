import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    allowedHosts: ["terminal.renakaagusta.dev"],
    proxy: {
      "/api/terminal": { target: "ws://localhost:3001", ws: true },
      "/api": "http://localhost:3001",
    },
  },
});
