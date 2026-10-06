import { defineConfig, devices } from "@playwright/test";
import { tourSeen } from "./tour-seen";

// The wave-4 route specs (Crew, Machines, History, Changes, Files, Settings sections). A config of
// its own so several runs can go at once without fighting for a port or a `dist`:
//
// (Playwright starts the server from this directory.)
//   bunx vite build --outDir /tmp/collie-remix-wave4-a --emptyOutDir
//   ROUTES_DIST=/tmp/collie-remix-wave4-a ROUTES_PORT=5181 ROUTES_MATCH='routes-crew*.spec.ts' \
//     bunx playwright test -c e2e/routes.config.ts
//
// Defaults: the shared `dist`, port 5195, every `routes*.spec.ts`. 127.0.0.1 only; Chromium at 390x844.
const PORT = Number(process.env.ROUTES_PORT ?? "5195");
const DIST = process.env.ROUTES_DIST ?? "";

export default defineConfig({
  testDir: ".",
  testMatch: process.env.ROUTES_MATCH ?? "routes*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${String(PORT)}`, trace: "off", storageState: tourSeen(`http://127.0.0.1:${String(PORT)}`) },
  projects: [{ name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    command: "bun serve.ts",
    env: { PORT: String(PORT), DIST },
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
