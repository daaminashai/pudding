// Builds the dashboard (web/) into dist/web, which the local server serves.
// `npm start` runs this first; `npm run build -- --watch` rebuilds on save.
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src") } },
  build: { outDir: "../dist/web", emptyOutDir: true, assetsInlineLimit: 0 },
});
