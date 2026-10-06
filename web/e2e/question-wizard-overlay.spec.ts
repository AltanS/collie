import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { SnapshotResponse } from "@/lib/types";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// ── Issue 347: the two-question wizard renders as cards with buttons ────────────────────────────
//
// Automates the manual live test: one `question` call with two single-select questions lifts into
// a `wizard` block (`opencodeBuildBlocks` → `detectQuestionTabs`), and the PWA renders the lifted
// step as tappable cards. The second case pins the overlay half of #347 at the UI layer: a sidebar
// tail row grafted under the free-text row (the same graft the unit layer pins) must still lift,
// because the pointer chip sits on a real option and the tail is foreign chrome, never input.
//
// SELECTORS ARE ROLES, never classes or test ids. No pixel is ever asserted: there are no baseline
// images and there are not meant to be. The pane text comes from the fixture corpus
// (`src/fixtures/panes/oc--question--two--*.txt`), the same captures QUESTION_NOTES.md pins, so a
// TUI drift breaks the unit layer and this suite together instead of one asserting a world that no
// longer exists.
//
// ONE TAP, NO CONVERSATION. The first case taps exactly one answer and asserts the single guarded
// keystroke (`keys: ["1"]`) the race guard sends. It never advances the wizard, never answers a
// second question, never submits — the stub keeps serving the same screen, so there is nothing to
// advance to. A Playwright case that holds a conversation with a live model is a cost centre, not
// a regression test; the live trigger for real panes is `e2e/manual/question-wizard-live.sh`.

const PANE_ID = fixtureAgents[0]!.paneId;
const PANE_URL = `/pane/${encodeURIComponent(PANE_ID)}`;
const PANE_ROUTE = new RegExp(`/api/pane/${encodeURIComponent(PANE_ID)}(?:\\?.*)?$`);
const KEYS_PATH = `/api/pane/${encodeURIComponent(PANE_ID)}/keys`;

/** The pane the app reads, lifted from the corpus instead of the default draft screen. */
const PANES_DIR = fileURLToPath(new URL("../src/fixtures/panes", import.meta.url));
const screenOf = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");

/**
 * The snapshot with an opencode pane. `fixtureAgents[0]` is a claude pane, and the claude adapter
 * would not lift an opencode dialog — the registry routes by the pane's own agent string, so the
 * override names opencode and nothing else changes.
 */
const SNAPSHOT_OPENCODE: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: [{ ...fixtureAgents[0]!, agent: "opencode" }],
};

async function serveScreen(page: Page, text: string): Promise<void> {
  await page.route(PANE_ROUTE, (route) =>
    route.fulfill({ json: { paneId: PANE_ID, text, truncated: false, revision: 1 } }),
  );
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("states"),
    "this case drives the app bundle, not the playground",
  );
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/snapshot", (route) =>
    route.fulfill({ json: SNAPSHOT_OPENCODE }),
  );
});

test("a two-question call renders as cards with buttons; tapping an answer sends its digit", async ({
  page,
}) => {
  await serveScreen(page, screenOf("oc--question--two--q1.txt"));
  await page.goto(PANE_URL);

  // The lifted step replaces the dialog region: one group named by the question …
  await expect(page.getByRole("group", { name: "Which colour?" })).toBeVisible();
  // … with the stepper chips (the two questions plus the fixed Submit stop) …
  await expect(page.getByRole("list", { name: en["dialog.questionsAria"] }).getByRole("listitem")).toHaveText([
    "Colour",
    "Size",
    "Submit",
  ]);
  // … and one button per answer, named by its label.
  for (const label of ["Red", "Green", "Blue"]) {
    await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }

  // The single tap: Red is option 1, and a digit on a single-select step selects it.
  const sent = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === KEYS_PATH,
  );
  await page.getByRole("button", { name: /Red/ }).click();
  expect((await sent).postDataJSON()).toMatchObject({ keys: ["1"] });
});

test("a sidebar tail row under the free-text row still lifts the wizard (#347)", async ({ page }) => {
  // Grafted, not captured: the same splice the unit layer pins — the two--q1 dialog with a
  // Models-panel tail row under the free-text row. The chip sits on option 1, so the tail is
  // foreign chrome and the step must lift anyway.
  // Raw lines wrap the label in SGR runs, so only the bare label matches raw text here.
  const raw = screenOf("oc--question--two--q1.txt").split("\n");
  const at = raw.findIndex((line) => line.includes("Type your own answer"));
  expect(at).toBeGreaterThan(0);
  const grafted = [
    ...raw.slice(0, at + 1),
    "  ┃     │ artistry muse-spark-1.3-contributor │",
    ...raw.slice(at + 1),
  ].join("\n");
  await serveScreen(page, grafted);
  await page.goto(PANE_URL);

  // Render-only: this case pins availability (the card exists despite the overlay), not the tap —
  // the tap path is the first case's.
  await expect(page.getByRole("group", { name: "Which colour?" })).toBeVisible();
  for (const label of ["Red", "Green", "Blue"]) {
    await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }
});
