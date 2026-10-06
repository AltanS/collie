// The pane screen's Playwright run on its own port and its own build, so it races no other worker:
//   bunx vite build --outDir /tmp/remix-w3-dist && PANE_DIST=/tmp/remix-w3-dist bunx playwright test -c e2e/pane.config.ts
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PANE_PORT ?? "5196");
const DIST = process.env.PANE_DIST ?? "";

export default defineConfig({
  testDir: ".",
  testMatch: "pane*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${String(PORT)}`, trace: "off", serviceWorkers: "block" },
  projects: [{ name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    command: "bun serve.ts",
    env: { PORT: String(PORT), DIST },
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
