// The CHAOS LEG on the solo rig (M102 spec 15, decision 3; chaos-lib.ts): the leg's own config with
// one change, the test match, so the chaos cases run only when asked and change no gate of the
// solo or crew leg. Everything else is the config it was copied from: its setup, teardown and guards.
import { defineConfig, devices } from "@playwright/test";

import { PHONE_DEVICE } from "./leg";

if (process.env.CI) {
  throw new Error("The browser leg starts a bridge, a Herdr server and real agents, and spends model turns. It never runs in CI.");
}

export default defineConfig({
  // The solo rig with a second bridge on its Herdr (`up --second-bridge`, case C3).
  globalSetup: "./chaos-setup.ts",
  globalTeardown: "./global-teardown.ts",
  testDir: ".",
  testMatch: /chaos-solo\.leg\.ts$/,
  // The crew leg's cases need a lead and a member, and run under crew.config.ts only.
  // One worker: one bridge, one Herdr, and the harnesses run one after another so a run stays cheap
  // and its memory stays bounded.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  // A scenario waits on real model turns. The cap is the slowest one (a long streamed reply).
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
