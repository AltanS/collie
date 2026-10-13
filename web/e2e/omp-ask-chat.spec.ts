import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { PaneChatResponse, SnapshotResponse } from "@/lib/types";
import { fixtureAgents, fixtureOmpAskBatchChat, fixtureOmpAskSingleChat, fixtureSnapshot } from "@/test/handlers";

import { installApiStub, pinLocale } from "./fixtures/api";

// Replay captured OMP Ask screens through Chat with a key-driven pane stub.
// History stays read-only; live answers use walk/verify/commit. Live proof: ASK_NOTES.md.

// No service worker: `page.route` does not see a request the worker makes for the page, so once it
// takes control the pane read reaches the real static server instead of the capture
// (`e2e/issue-180.spec.ts` has the whole story).
test.use({ serviceWorkers: "block" });

const PANE_ID = fixtureAgents[0]!.paneId;
const PANE_URL = `/pane/${encodeURIComponent(PANE_ID)}`;
const PANE_ROUTE = new RegExp(`/api/pane/${encodeURIComponent(PANE_ID)}(?:\\?.*)?$`);
const CHAT_ROUTE = new RegExp(`/api/pane/${encodeURIComponent(PANE_ID)}/chat(?:\\?.*)?$`);
const KEYS_PATH = `/api/pane/${encodeURIComponent(PANE_ID)}/keys`;

/** A pane screen, from the corpus the unit layer reads. */
const PANES_DIR = fileURLToPath(new URL("../src/fixtures/panes", import.meta.url));
const screenOf = (name: string): string => readFileSync(join(PANES_DIR, `${name}.txt`), "utf8");
const POINTER = "❯ ";
const GAP = "  ";

/** Move only the pointer glyph, preserving columns and SGR runs from the real capture. */
function pointerOn(screen: string, label: string): string {
  return screen
    .split("\n")
    .map((line) => {
      const pointed = line.includes(POINTER);
      const target = line.includes(label);
      if (pointed && !target) return line.replace(POINTER, GAP);
      if (!pointed && target) return line.replace(` ${GAP}`, ` ${POINTER}`);
      return line;
    })
    .join("\n");
}

const SNAPSHOT_OMP: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: [Object.assign({}, fixtureAgents[0]!, { agent: "omp", hasSession: true })],
};

interface SentKeys {
  readonly keys: readonly string[];
  readonly expected_prompt?: string;
}

/** A terminal transition driven by the app's emitted keys. */
interface Step {
  readonly on: string;
  readonly keys: readonly string[];
  readonly to: string;
}

/** A static pane would reject a guarded walk: each read must show where its arrows landed. */
async function installPaneWorld(
  page: Page,
  world: {
    readonly chat: PaneChatResponse;
    readonly screens: Readonly<Record<string, string>>;
    readonly start: string;
    readonly script: readonly Step[];
  },
): Promise<SentKeys[]> {
  const sent: SentKeys[] = [];
  let showing = world.start;

  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ json: SNAPSHOT_OMP }),
  );
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: world.chat }));
  await page.route(
    (url) => url.pathname === KEYS_PATH,
    async (route) => {
      // SAFETY: the body is the app's own — `lib/api.ts`'s `sendKeys` is the only caller of this
      // endpoint, and it posts exactly `{ keys, expected_prompt?, expected_styled? }`.
      const body = route.request().postDataJSON() as SentKeys;
      sent.push(body);
      const step = world.script.find(
        (s) => s.on === showing && s.keys.join("+") === body.keys.join("+"),
      );
      if (step) showing = step.to;
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.route(PANE_ROUTE, (route) =>
    route.fulfill({
      json: { paneId: PANE_ID, text: world.screens[showing], truncated: false, revision: 1 },
    }),
  );
  return sent;
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("states"),
    "this case drives the app bundle, not the playground",
  );
  await pinLocale(page, "en");
  // Show the journal card too; with tool calls hidden it is normally folded to a summary.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "collie:dash-prefs:v1",
      JSON.stringify({ paneView: "chat", showToolCalls: true }),
    );
  });
  await installApiStub(page);
});

// ── One question ────────────────────────────────────────────────────────────────────────────────

const QUESTION = "Pick a colour";
const ANSWER = "Blue";

function singleWorld(page: Page): Promise<SentKeys[]> {
  const asking = screenOf("omp--v18-10-ask-single");
  return installPaneWorld(page, {
    chat: fixtureOmpAskSingleChat,
    screens: { asking, answering: pointerOn(asking, ANSWER), answered: screenOf("omp--v18-10-draft-blank-line") },
    start: "asking",
    script: [
      { on: "asking", keys: ["Down"], to: "answering" },
      { on: "answering", keys: ["Enter"], to: "answered" },
    ],
  });
}

test("the pending ask is drawn in Chat as history, and its options are not buttons", async ({ page }) => {
  await singleWorld(page);
  await page.goto(PANE_URL);

  await expect(page.getByText(en["chat.tool.question"], { exact: true })).toBeVisible();
  await expect(page.getByText(QUESTION, { exact: true }).first()).toBeVisible();
  for (const label of ["Red", ANSWER]) {
    const row = page.getByRole("listitem").filter({ hasText: label });
    await expect(row).toHaveCount(1);
    // History must never become a second, stale set of answer buttons.
    await expect(row.getByRole("button")).toHaveCount(0);
  }
});

test("the dock answers it: tapping Blue walks the pointer, verifies, then commits", async ({ page }) => {
  const sent = await singleWorld(page);
  await page.goto(PANE_URL);

  const dock = page.getByRole("group", { name: QUESTION });
  await expect(dock).toBeVisible();
  for (const label of ["Red", ANSWER, "Other (type your own)"]) {
    await expect(dock.getByRole("button", { name: label })).toBeVisible();
  }

  await expect(page.getByText(en["chat.question.answerBelow"])).toBeVisible();

  await dock.getByRole("button", { name: ANSWER }).click();
  await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(2);
  expect(sent.map((write) => write.keys)).toEqual([["Down"], ["Enter"]]);
  for (const write of sent) expect(write.expected_prompt).toContain(QUESTION);
  await expect(dock).toHaveCount(0);
});

// Question/review screens are real captures; only the third pointer move is derived.
function batchWorld(page: Page): Promise<SentKeys[]> {
  const q3 = screenOf("omp--v18-10-ask-batch-third");
  return installPaneWorld(page, {
    chat: fixtureOmpAskBatchChat,
    screens: {
      q1: screenOf("omp--v18-10-ask-batch"),
      "q1-below": screenOf("omp--v18-10-ask-batch-moved"),
      q2: screenOf("omp--v18-10-ask-batch-second"),
      q3,
      "q3-separate": pointerOn(q3, "Separate"),
      review: screenOf("omp--v18-10-ask-batch-review"),
      answered: screenOf("omp--v18-10-draft-blank-line"),
    },
    start: "q1",
    script: [
      { on: "q1", keys: ["Down"], to: "q1-below" },
      { on: "q1-below", keys: ["Enter"], to: "q2" },
      { on: "q2", keys: ["Enter"], to: "q3" },
      { on: "q3", keys: ["Down", "Down"], to: "q3-separate" },
      { on: "q3-separate", keys: ["Enter"], to: "review" },
      { on: "review", keys: ["Enter"], to: "answered" },
    ],
  });
}

test("a three-question ask is answered in the dock, question by question, through Submit", async ({ page }) => {
  const sent = await batchWorld(page);
  await page.goto(PANE_URL);

  for (const header of ["Location", "Alternative", "Confirm"]) {
    await expect(page.getByText(header, { exact: true })).toBeVisible();
  }

  const first = page.getByRole("group", { name: "Where should the note go?" });
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "Below" }).click();

  const second = page.getByRole("group", { name: "Which alternative should we keep?" });
  await expect(second).toBeVisible();
  await second.getByRole("button", { name: "Above" }).click();

  const third = page.getByRole("group", { name: "Confirm this plan?" });
  await expect(third).toBeVisible();
  await third.getByRole("button", { name: "Separate" }).click();

  const review = page.getByRole("group", { name: /Review answers/ });
  await expect(review).toBeVisible();
  for (const line of ["Location: Below", "Alternative: Above", "Confirm: Separate"]) {
    await expect(review.getByText(line)).toBeVisible();
  }
  await review.getByRole("button", { name: "Submit" }).click();

  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(6);
  expect(sent.map((write) => write.keys)).toEqual([
    ["Down"],
    ["Enter"],
    ["Enter"],
    ["Down", "Down"],
    ["Enter"],
    ["Enter"],
  ]);
  expect(sent[0]!.expected_prompt).toContain("Where should the note go?");
  expect(sent[5]!.expected_prompt).toContain("Review answers");

  await expect(page.getByRole("button", { name: "Submit" })).toHaveCount(0);
});
