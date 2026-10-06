import { defineConfig, devices } from "@playwright/test";

import { SETTINGS_PORT } from "./settings-builds";
import { tourSeen } from "./tour-seen";

// Phase B3's own browser pass: settings, pairing, locale, service worker and the update sheet.
//
// A config of its own rather than a row in playwright.config.ts, for two reasons. The service-worker
// case needs TWO real builds and a server that can swap between them, and the shared smoke serves one
// `dist`. And this file owns port 5196 (the phase B3 port), so it never fights the smoke for 5194.
//
//   bunx playwright test -c e2e/settings.config.ts
//
// The global setup builds bundle A and bundle B into /tmp (outside the tree, nothing to ignore) and
// the server serves whichever one the pointer file names. Chromium only, at the phone size.
export default defineConfig({
  testDir: ".",
  testMatch: "settings.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./settings-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${String(SETTINGS_PORT)}`,
    trace: "off",
    storageState: tourSeen(`http://127.0.0.1:${String(SETTINGS_PORT)}`),
  },
  projects: [{ name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    // Playwright starts the command in this directory.
    command: "bun settings-serve.ts",
    url: `http://127.0.0.1:${String(SETTINGS_PORT)}/__served`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
