import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// The Keys tray's pad, measured in a real engine. jsdom (`components/nav-tray.test.tsx`) can only
// pin the CLASSES that produce the layout — it never lays anything out — so this is the check that
// the classes actually did what they were meant to on a real phone viewport.
//
// Two faults shipped in 6d7e701a: Enter's `row-span-2` was overridden back to one 36px row by the
// shared `h-9` every key gets (tailwind-merge resolves same-group conflicts by class order, and
// `h-9` used to win), and "Ctrl C" was wider than its 1/7 column at 390px. The fix is a stretch
// class on Enter alone plus explicit grid row heights, and a shorter "^C" label — see nav-tray.tsx.
//
// No pairing, no device, no second machine: the Keys dock only writes into a pane through
// `POST /api/pane/:id/keys`, which the stub answers unconditionally (`{ ok: true }`), so opening it
// against a fixture pane costs nothing this suite doesn't already pay elsewhere.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("states"),
    "the playground has no /api/pane/:id route and no Keys dock to open",
  );
  await installApiStub(page);
});

test("Enter spans both rows and no key's label overflows its column", async ({ page }) => {
  // w1:p1 is the default fixture agent pane (`src/test/handlers.ts`), writable with no capability
  // declared false, so the Keys toggle in its composer is enabled with no further setup.
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toBeVisible();

  await page.getByRole("button", { name: en["composer.controls.keys"] }).click();

  // exact: true throughout — the pad's short one-word labels ("Up", "Tab", "Down"…) are substrings
  // of unrelated chrome elsewhere on the page (the tab strip's "needs you tab", "New tab"…), and
  // Playwright's default role-name match is a case-insensitive CONTAINS, not an equals.
  const up = page.getByRole("button", { name: "Up", exact: true });
  const enter = page.getByRole("button", { name: "Enter", exact: true });
  await expect(up).toBeVisible();
  await expect(enter).toBeVisible();

  const [upBox, enterBox] = await Promise.all([up.boundingBox(), enter.boundingBox()]);
  expect(upBox).not.toBeNull();
  expect(enterBox).not.toBeNull();
  // Two 36px rows plus the 4px gap is ~2.1x a single row — 1.8x is the floor a regression back to
  // one row (36/36 = 1x) or a partial fix (e.g. 36+2px leak) would both still fail.
  expect(enterBox!.height).toBeGreaterThanOrEqual(upBox!.height * 1.8);

  // Every key on the fixed pad, including the quick "^C": none may scroll its own content.
  const keyNames = ["Esc", "Tab", "Shift", "Ctrl", "Alt", "Up", "Ctrl+C", "Space", "Left", "Down", "Right", "Enter"];
  for (const name of keyNames) {
    const overflow = await page
      .getByRole("button", { name, exact: true })
      .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  }
});
