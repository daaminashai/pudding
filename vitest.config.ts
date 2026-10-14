// Kept apart from vite.config.ts, which is rooted in web/ for the dashboard build.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
