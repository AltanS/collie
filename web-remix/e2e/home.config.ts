import { defineConfig, devices } from "@playwright/test";
import { tourSeen } from "./tour-seen";

// The dashboard's own browser pass (wave 2): home.spec.ts against the stub bridge in home-api.ts.
// A config of its own, on port 5195 by default, so it never fights the smoke for 5194 or the
// settings pass for 5196. Build into a directory of your own so a parallel run cannot swap the files
// under it (Playwright starts the server from this directory):
//
//   bunx vite build --outDir /tmp/collie-remix-home --emptyOutDir
//   HOME_DIST=/tmp/collie-remix-home bunx playwright test -c e2e/home.config.ts
//
// 127.0.0.1 only; Chromium at 390x844.
const PORT = Number(process.env.HOME_PORT ?? "5195");
const DIST = process.env.HOME_DIST ?? "";

export default defineConfig({
  testDir: ".",
  testMatch: "home.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${String(PORT)}`, trace: "off", storageState: tourSeen(`http://127.0.0.1:${String(PORT)}`), serviceWorkers: "block" },
  projects: [{ name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    command: "bun serve.ts",
    env: { PORT: String(PORT), DIST },
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
