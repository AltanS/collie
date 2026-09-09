import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// The `states` target's roll call. Spec 02 gave every card a required `state` prop, rendered as
// `data-state` on the card's wrapper (`src/playground/harness.tsx:414-441`), and a vitest test
// refuses a missing or repeated one from inside jsdom. This case asks the SAME question of a real
// Chromium tab on the real page the playground serves on 5199.
//
// The list of handles this case checks against is never re-typed here: `state="…"` is read straight
// out of the playground's own source at test time with a plain `readFileSync`, the same shape
// `app.test.tsx` reads through the rendered DOM. Restating the ids in this file would let the two
// drift the moment a card is added, renamed, removed, or moves into its own file — as two of the 56
// already have (`dashboard-card.tsx`, `typeface-card.tsx`) — so every `.tsx` in `src/playground/` is
// read, not just `app.tsx`. `harness.tsx` (the `Card` definition and its doc comment) and `*.test.tsx`
// files are excluded: neither ever holds a real `state="…"` prop use.
const PLAYGROUND_DIR = fileURLToPath(new URL("../src/playground/", import.meta.url));
const EXCLUDED_FILES = new Set(["harness.tsx"]);

function readHandlesFromSource(): string[] {
  const files = readdirSync(PLAYGROUND_DIR).filter(
    (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx") && !EXCLUDED_FILES.has(name),
  );
  const handles = files.flatMap((name) => {
    const source = readFileSync(join(PLAYGROUND_DIR, name), "utf8");
    return [...source.matchAll(/state="([^"]+)"/g)].map((match) => match[1]!);
  });
  // A floor, not a fixed count, for the same reason app.test.tsx's is a floor: adding a card must
  // not mean editing this file too.
  expect(handles.length).toBeGreaterThanOrEqual(56);
  return handles;
}

test.beforeEach(async ({ page }) => {
  // The locale pin every case in this tier follows (see CLAUDE.md → e2e selectors), even though the
  // playground itself renders no translated string on this page: consistent with every other case
  // in this tier, and cheap insurance against a card that gains one.
  await page.addInitScript(() => {
    window.localStorage.setItem("collie:locale:v1", "en");
  });
});

test("the playground page has a title and a main landmark", async ({ page }) => {
  await page.goto("/playground.html");

  await expect(page).toHaveTitle(/collie/i);
  await expect(page.getByRole("main").first()).toBeVisible();
});

test("every handle from app.tsx is present on the page exactly once", async ({ page }) => {
  const handles = readHandlesFromSource();

  await page.goto("/playground.html");
  await expect(page.getByRole("main").first()).toBeVisible();

  for (const handle of handles) {
    await expect(page.locator(`[data-state="${handle}"]`)).toHaveCount(1);
  }
});

test("no two handles on the page repeat, and none is missing", async ({ page }) => {
  const handles = readHandlesFromSource();

  await page.goto("/playground.html");
  await expect(page.getByRole("main").first()).toBeVisible();

  // `.pg-grid > *` is the same scope app.test.tsx uses: every card is a direct child of a
  // `Section`'s grid, and `ui/collapse.tsx` renders its OWN `data-state` ("open"/"closed") deep
  // inside several cards, which this scope excludes without a second attribute anywhere.
  const cardStates = await page.locator(".pg-grid > *").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-state") ?? ""),
  );

  expect(cardStates.filter((state) => state === "")).toEqual([]);

  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const state of cardStates) {
    if (seen.has(state)) repeated.push(state);
    seen.add(state);
  }
  expect(repeated).toEqual([]);

  expect(new Set(cardStates)).toEqual(new Set(handles));
});
