import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The thin facet SPA reuses the 壹座 web app's packs surface verbatim — the
// alias points INTO the main app's source tree (web/src), so
// components/packs, the ui kit, i18n resources, and the tailwind tokens stay
// single-sourced. Facet adds only the shell (header, login state).
const WEB_SRC = path.resolve(import.meta.dirname, "../../web/src");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": WEB_SRC,
    },
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8080",
      "/auth": "http://localhost:8080",
    },
  },
});
