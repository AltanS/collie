import { mkdirSync } from "node:fs";

import { test, type Page } from "@playwright/test";

import type { AgentView, SnapshotResponse } from "@/lib/types";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// LAB (wide-home, step 1): screenshots of today and the three `?dw` proposals in every state, for the contact
// sheets. Runs only with WIDE_HOME_SHOTS set to the output folder. Removed with the lab switch.

const OUT = process.env.WIDE_HOME_SHOTS ?? "";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(OUT === "", "lab screenshots only");
  test.skip(testInfo.project.name !== "app-phone", "one project");
  await installApiStub(page);
});

async function serve(page: Page, snapshot: SnapshotResponse) {
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
}

/** Fourteen Spaces, the fifth holding six sessions. */
function fourteen(): SnapshotResponse {
  const snap = wideSnapshot({ spaces: 14, blocked: ["w2:p1", "w7:p1"], unseen: ["w4:p2"] });
  const base = snap.agents.find((a) => a.paneId === "w5:p1")!;
  const extra: AgentView[] = [3, 4, 5, 6].map((n) =>
    Object.assign({}, base, {
      paneId: `w5:p${n}`,
      agent: n % 2 === 0 ? "codex" : "claude",
      status: n === 4 ? ("working" as const) : ("idle" as const),
      terminalTitle: `task ${n} in space-05`,
    }),
  );
  const at = snap.agents.findIndex((a) => a.paneId === "w5:p2");
  snap.agents.splice(at + 1, 0, ...extra);
  for (const w of snap.workspaces) if (w.workspaceId === "w5") w.paneCount = 6;
  for (const tb of snap.tabs) if (tb.workspaceId === "w5") tb.paneCount = 6;
  return snap;
}

const STATES = {
  "not-paired": async (page) => {
    await page.route(
      (url) => url.pathname === "/api/snapshot",
      (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "device not paired" }),
    );
  },
  "no-spaces": (page) => serve(page, wideSnapshot({ spaces: 0 })),
  "three-spaces": (page) => serve(page, wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] })),
  "fourteen-spaces": (page) => serve(page, fourteen()),
  files: async (page) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "changes" }));
    });
    await serve(page, wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] }));
  },
} satisfies Record<string, (page: Page) => Promise<void>>;

for (const [state, arrange] of Object.entries(STATES)) {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ] as const) {
    for (const dw of [0, 1, 2, 3]) {
      test(`${state} ${width} dw=${dw}`, async ({ page }) => {
        mkdirSync(OUT, { recursive: true });
        await page.setViewportSize({ width, height });
        await arrange(page);
        await page.goto(dw === 0 ? "/" : `/?dw=${dw}`);
        await page.locator('[data-slot="app-header"]').waitFor();
        // Let the first reads land and the collapses settle.
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${OUT}/${state}-${width}-dw${dw}.png` });
      });
    }
  }
}

test("phone 390 is unchanged under the switch", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] }));
  for (const dw of [0, 3]) {
    await page.goto(dw === 0 ? "/" : `/?dw=${dw}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/phone-390-dw${dw}.png` });
  }
});
