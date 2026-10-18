// The browser leg (Tier 3): a Playwright phone against a SCRATCH Collie bridge that mirrors a SCRATCH
// Herdr server, in which real Claude Code, pi and omp run. See README.md beside this file.
//
// ITS OWN CONFIG, for the reason live/ has one: Tier 1 answers every /api/* from fixtures and Tier 2
// reads the dev lane; this one starts its own bridge and Herdr and spends model turns. Tier 1's config
// ignores this folder (`**/rig/**`), so CI never collects it, and the throw below keeps it so.
//
//     cd web && bunx playwright test -c e2e/rig/playwright.config.ts
//
// The global setup brings the rig up (`bun e2e/rig/rig.ts up`) and the global teardown prints the
// harness x scenario table and brings it down. Nothing here touches a Collie lane, a systemd unit or
// the operator's own Herdr session (rig-lib.ts says how).
import { defineConfig, devices } from "@playwright/test";

import { PHONE_DEVICE } from "./leg";

if (process.env.CI) {
  throw new Error("The browser leg starts a bridge, a Herdr server and real agents, and spends model turns. It never runs in CI.");
}

export default defineConfig({
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  // The crew leg's cases need a lead and a member, and run under crew.config.ts only.
  testIgnore: /walky-crew\.spec\.ts$/,
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
