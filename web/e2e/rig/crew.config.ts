// The browser leg's CREW LEG: the same Playwright phone, against a two-machine scratch crew. The lead
// is the solo rig's bridge and Herdr; the member is a second Herdr server and a second bridge, enrolled
// into the lead with the real invite and join verbs (rig.ts `up --crew`, crew-enrol.ts). It runs the
// walky talky cases that need a crew (12 to 14 and 19 to 21 in README.md) and the release-line case (15), and
// nothing else.
//
//     cd web && bunx playwright test -c e2e/rig/crew.config.ts
//
// Its own state root (`~/.cache/collie-lab/browser-leg-crew-state`, crew-env.ts), so it never shares
// a rig, a Herdr home or a port with the solo leg. The guards are the solo config's: never in CI, one
// worker, no retry.
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
  testMatch: /walky-crew\.spec\.ts$/,
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
