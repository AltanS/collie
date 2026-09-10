import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

// The `states` target's roll call. Spec 02 gave every card a required `state` prop, rendered as
// `data-state` on the card's wrapper (`src/playground/harness.tsx`'s `Card`), and a vitest test
// refuses a missing or repeated one from inside jsdom. This case asks the SAME question of a real
// Chromium tab on the real page the playground serves on 5199.
//
// The list of handles this case checks against is never re-typed here: `state="…"` is read straight
// out of the playground's own source at test time with a plain `readFileSync`, the same shape
// `app.test.tsx` reads through the rendered DOM. Restating the ids in this file would let the two
// drift the moment a card is added, renamed, removed, or moves into its own file — as most of the
// 56+ already have, into `src/playground/sections/*.tsx` — so every `.tsx` under `src/playground/`
// and `src/playground/sections/` is read, not just `app.tsx`. `harness.tsx` (the `Card` definition
// and its doc comment) and `*.test.tsx` files are excluded: neither ever holds a real `state="…"`
// prop use.
//
// THE PAGE IS TABBED and only the SELECTED tab mounts (M?? — see README.md → "The states
// playground"), so a card's handle is only in the DOM while its own tab is open. Both cases below
// tour every tab in turn (`#<tab-id>`) and pool what they find, rather than reading the page once.
const PLAYGROUND_DIR = fileURLToPath(new URL("../src/playground/", import.meta.url));
const EXCLUDED_FILES = new Set(["harness.tsx"]);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return listSourceFiles(join(dir, entry.name));
    if (!entry.name.endsWith(".tsx")) return [];
    if (entry.name.endsWith(".test.tsx")) return [];
    if (EXCLUDED_FILES.has(entry.name)) return [];
    return [join(dir, entry.name)];
  });
}

function readHandlesFromSource(): string[] {
  const handles = listSourceFiles(PLAYGROUND_DIR).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(/state="([^"]+)"/g)].map((match) => match[1]!);
  });
  // A floor, not a fixed count, for the same reason app.test.tsx's is a floor: adding a card must
  // not mean editing this file too.
  expect(handles.length).toBeGreaterThanOrEqual(56);
  return handles;
}

/** Every tab's id, read off the real tab bar rather than hardcoded — the tab bar is part of the
 *  page's chrome and stays mounted regardless of which tab is selected, so one page load is enough
 *  to learn the whole tour.
 *
 *  TWO tab lists are always mounted (a sidebar's vertical rail at `lg` and up, a top bar's
 *  horizontal row below it — see `app.tsx`'s chrome comment), and only one is shown at a time via a
 *  `lg:` breakpoint Playwright's default viewport does not cross, but both sit in the DOM either
 *  way. Their buttons carry ids `pg-tab-v-<id>` and `pg-tab-h-<id>`, so stripping only `pg-tab-`
 *  left the orientation letter attached to every id and every one of them resolved to no known
 *  section — the tour silently fell back to the first tab (Dashboard) once per button instead of
 *  visiting each section once. Strip the orientation prefix and dedupe. */
async function readTabIds(page: Page): Promise<string[]> {
  const ids = await page.getByRole("tab").evaluateAll((nodes) => nodes.map((node) => node.id));
  const stripped = ids.map((id) => id.replace(/^pg-tab-[hv]-/, ""));
  return [...new Set(stripped)];
}

/** Visit every tab in turn and pool the `data-state` handle of every card on it (`.pg-grid > *`,
 *  the same scope `app.test.tsx` uses to tell a card's own handle apart from `ui/collapse.tsx`'s
 *  unrelated `data-state`). */
async function collectAllCardStates(page: Page, tabIds: string[]): Promise<string[]> {
  const pooled: string[] = [];
  for (const tabId of tabIds) {
    await page.goto(`/playground.html#${tabId}`);
    await expect(page.getByRole("main").first()).toBeVisible();
    const states = await page
      .locator(".pg-grid > *")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-state") ?? ""));
    pooled.push(...states);
  }
  return pooled;
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

test("every handle from source is present on the page exactly once, across the whole tour", async ({
  page,
}) => {
  const handles = readHandlesFromSource();

  await page.goto("/playground.html");
  await expect(page.getByRole("main").first()).toBeVisible();
  const tabIds = await readTabIds(page);

  const pooled = await collectAllCardStates(page, tabIds);
  const counts = new Map<string, number>();
  for (const state of pooled) counts.set(state, (counts.get(state) ?? 0) + 1);

  for (const handle of handles) {
    expect(counts.get(handle) ?? 0, `handle "${handle}" across every tab`).toBe(1);
  }
});

test("no two handles on the page repeat, and none is missing", async ({ page }) => {
  const handles = readHandlesFromSource();

  await page.goto("/playground.html");
  await expect(page.getByRole("main").first()).toBeVisible();
  const tabIds = await readTabIds(page);

  const cardStates = await collectAllCardStates(page, tabIds);

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
