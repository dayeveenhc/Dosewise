import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test-only config (jsdom). Kept separate from the Vite build so `npm run build`
// is untouched. Picks up *.test.ts(x) under src/; Playwright specs in e2e/ run
// via `npx playwright test`, never vitest.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
