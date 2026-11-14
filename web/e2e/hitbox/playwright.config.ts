import { defineConfig } from "@playwright/test";

// THE HITBOX CENSUS (investigate/hitboxes). Its own config, because the census is a measuring script
// and not a gate: `e2e/` specs are collected by `playwright.config.ts` only when they end in `.spec.ts`
// and the files here end in `.run.ts`, so `bun run e2e` never sees them.
//
//     cd web && bunx vite build
//     cd web && HITBOX_PORT=5301 bunx playwright test -c e2e/hitbox/playwright.config.ts
//
// It serves the SHIPPED bundle (`web/dist`) on 127.0.0.1 only, with the dev proxy pointed at a port
// nothing listens on, so a request the stub misses never reaches a bridge (the same rule as
// `playwright.config.ts`). `HITBOX_PORT` picks the port; 5301 is the default.
//
// Chromium only: it is the engine of an installed Android PWA. WebKit and a real phone are what the
// census cannot reach, and the playground section says so.

const PORT = Number(process.env.HITBOX_PORT ?? "5301");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.run.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    browserName: "chromium",
    // The phone. `isMobile` turns on Chromium's mobile emulation (overlay scrollbars, the viewport
    // meta, the touch gesture settings), `hasTouch` the touch events; scale 3 is a modern phone's.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  },
  webServer: {
    command: `bunx vite preview --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    env: { COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
    url: `http://127.0.0.1:${String(PORT)}`,
    // Playwright starts the server in the CONFIG's folder, and `vite preview` there finds no `dist`: it answered 404 and the
    // run timed out (2026-11-14). The preview belongs to `web/`, two folders up.
    cwd: "../..",
    reuseExistingServer: true,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 60_000,
  },
});
