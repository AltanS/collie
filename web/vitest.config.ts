import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Vitest runs without the PWA/Tailwind plugins (tests don't need a service worker or compiled CSS).
// jsdom + Testing Library + MSW cover components and the /api fetch layer; no headless browser.
export default defineConfig({
  // Stub the build stamp (real values are injected by vite.config.ts at build time).
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: "0.0.0-test",
      sha: "test",
      time: "1970-01-01T00:00:00.000Z",
      id: "test",
    }),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      // No VitePWA plugin under Vitest, so the virtual register module is stubbed (see the stub).
      "virtual:pwa-register": resolve(import.meta.dirname, "src/test/pwa-register-stub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
