// The CHAOS LEG on the crew rig (M102 spec 15, decision 3; chaos-lib.ts): the leg's own config with
// one change, the test match, so the chaos cases run only when asked and change no gate of the
// solo or crew leg. Everything else is the config it was copied from: its setup, teardown and guards.
import "./crew-env";

import { defineConfig, devices } from "@playwright/test";

import { PHONE_DEVICE } from "./leg";

if (process.env.CI) {
  throw new Error("The browser leg starts two bridges, two Herdr servers and real agents, and spends model turns. It never runs in CI.");
}

export default defineConfig({
  globalSetup: "./crew-setup.ts",
  globalTeardown: "./crew-teardown.ts",
  testDir: ".",
  testMatch: /chaos-crew\.leg\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    ...devices[PHONE_DEVICE],
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "phone", use: { ...devices[PHONE_DEVICE] } }],
});
