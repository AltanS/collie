// Tier 2 — the live dev lane. A separate config, and deliberately not an extension of the Tier 1
// one (M26/05).
//
// WHY ITS OWN FILE. Tier 1 serves `web/dist` and answers every `/api/*` request from the fixture
// modules. Tier 2 answers nothing: it drives a real bridge with a real crew behind it. A config
// that could be either would be one env var away from pointing a CI runner at somebody's machine.
// Two files cannot make that mistake, so there is no `webServer` here, no `page.route`, and no
// import from the Tier 1 config.
//
// WHAT IT MAY DO. Read. Nothing in this directory pairs a device, taps "Take over", starts an
// update, revokes a device, closes a pane or renames anything. The lane is disposable, and a test
// that restarts it is a test nobody runs twice.
//
// HOW IT IS RUN. `make e2e` at the workspace root. That target checks the port, prints the build it
// drove, and then names this config by path. By hand it is the same command:
//
//     cd collie/web && bunx playwright test -c e2e/live/playwright.config.ts
import { defineConfig } from "@playwright/test";

/** The dev lane's lead: instance `next`, port 8788. The workspace README owns that table. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8788";

// A HARD THROW, NOT A SKIP. A skipped suite reports green, and green is exactly the wrong answer
// when a workflow file has started driving a developer's bridge. `.github/workflows/` sets neither
// this variable nor a base URL, and this line is what keeps that true after a copy-paste.
if (process.env.CI) {
  throw new Error(
    "Tier 2 drives a live Collie bridge and must never run in CI. Unset CI, or run the Tier 1 suite instead.",
  );
}

const baseURL = process.env.COLLIE_E2E_BASE_URL ?? DEFAULT_BASE_URL;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  // One worker. There is one bridge, its census is shared state, and a parallel run would read the
  // same sweep from four contexts for no gain — these cases are seconds long.
  workers: 1,
  fullyParallel: false,
  // No retries. A live case that fails has found either a real bug or a lane that is not up, and
  // both want a person reading the reason rather than a second attempt hiding it.
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  // Beside this config, not at the top of `web/`: the failure screenshots of a live run are one
  // operator's evidence about one machine, and they are ignored by the `.gitignore` next door.
  outputDir: "test-results",
  use: {
    baseURL,
    // Evidence for a person after a failure, never a baseline to compare against. This milestone
    // asserts no pixel.
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  // The two viewports the milestone fixed. Every case runs at both: the crew formation and the
  // machine sheet are the two surfaces whose layout actually differs between a phone and a tablet.
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 } } },
  ],
});
