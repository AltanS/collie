import { defineConfig } from "@playwright/test";

import { stillMarkState } from "./e2e/fixtures/still-mark";

// LAB CONFIG (strip-head round B, 2026-11-21): runs only `e2e/strip-head-shots.spec.ts`, against this
// worktree's own `web/dist` on a port of its own (4192), so it can never reuse another worker's preview
// server on 4173. Goes with the proposals.

const PORT = 4192;
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: ["**/strip-head-shots.spec.ts"],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 600_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    storageState: stillMarkState(BASE),
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "lab", use: { browserName: "chromium", deviceScaleFactor: 2 } }],
  webServer: [
    {
      command: `bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      env: { COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
      url: BASE,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 60_000,
    },
  ],
});
