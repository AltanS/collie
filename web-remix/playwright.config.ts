import { defineConfig, devices } from "@playwright/test";
import { tourSeen } from "./e2e/tour-seen";

// The browser smoke for web-remix: the built bundle from `dist`, served by `e2e/serve.ts`, with
// every `/api/*` answered by the spec itself (`page.route`). Chromium only, at the phone size web/'s
// own e2e uses (390x844, iPhone 14/15 CSS). The browsers are the ones Playwright already keeps in
// ~/.cache/ms-playwright; nothing here downloads one.
//
// Port 5194 is in the range this rewrite owns (5190-5196) and collides with no Collie instance.
const PORT = 5194;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: "off",
    storageState: tourSeen(`http://127.0.0.1:${String(PORT)}`),
  },
  projects: [{ name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    command: `PORT=${String(PORT)} bun e2e/serve.ts`,
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
