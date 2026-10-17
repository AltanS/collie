import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import appConfig from "../playwright.config";

const PORT = 4187;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Local focused runner: use the shipped app projects, without starting the playground or
// service-worker rebuild server. No existing preview or live bridge is reused.
export default defineConfig({
  testDir: ".",
  testMatch: "kiro-chat.spec.ts",
  outputDir: "../test-results/kiro",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "../playwright-report/kiro", open: "never" }]],
  use: {
    ...appConfig.use, baseURL: BASE_URL, serviceWorkers: "block", trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.COLLIE_E2E_CHROMIUM_EXECUTABLE },
  },
  projects: appConfig.projects?.filter((project) => ["app-phone", "app-tablet"].includes(project.name ?? "")),
  webServer: {
    command: `bun x --no-install vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
