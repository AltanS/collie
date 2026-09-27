import { expect, test, type Locator } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE BELT'S X, in a real engine (M40 spec 04, issue #291). While the phone's box holds a draft, an
// icon-only X stands on the belt's pinned block, directly left of the Changes pill. One tap empties
// the box and the stored draft and sends nothing to the pane; the same slot then shows Undo, and a
// tap on Undo puts the draft back. Three promises here are ones jsdom cannot keep for us:
//
//  * The keyboard stays up. The field keeps focus through both taps, because the button refuses its
//    own `mousedown` (not `pointerdown`, which costs WebKit the click: actions-row.tsx says why).
//    That is an engine's focus rule, so it is asked of Chromium and WebKit.
//  * Nothing moves. The X arrives over the scroller's end and the scrolling pills stay where they
//    were; the pinned pills are anchored right and stay too; the X and Undo share one box.
//  * The pane hears nothing. Not a key, not a reply: the clear is the phone's own business.
//
// Runs under every `app-*` project, so Chromium and WebKit answer the same questions.

// NO SERVICE WORKER, for the reason `e2e/issue-180.spec.ts` states at length: `page.route` cannot
// see a request the worker makes on the page's behalf, so a worker that claims the page part way
// through a case takes `/api/*` away from the fixture. Measured here on 2026-09-27 under WebKit, 20
// of 20 runs with 8 workers: the second poll went past the fixture to the preview server's proxy
// (`playwright.config.ts` says where that led), the pane read came back `pane_not_found`, and the app
// left `/pane/w1:p1` for the dashboard in the middle of the case. One worker at a time, 10 of 10
// passed: a case that ends before the worker's claim never sees it, which is why it read as a flake.
// The worker has its own case, in `e2e/smoke.spec.ts`.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

const BELT = '[data-slot="composer-actions"]';

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (b === null) throw new Error("no box: the element is not rendered");
  return b;
}

test("the belt's X clears the draft in one tap, Undo puts it back, and the pane hears nothing", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
    }
  });
  await page.goto("/pane/w1:p1");

  const belt = page.locator(BELT);
  const field = page.getByRole("textbox", { name: en["composer.placeholder.reply"] });
  const clear = page.getByRole("button", { name: en["composer.controls.clear"], exact: true });
  const undo = page.getByRole("button", { name: en["composer.controls.undoClear"], exact: true });
  const changes = page.getByRole("button", { name: en["chat.changes.label"], exact: true });
  const switcher = page.getByRole("button", { name: en["chat.switcher.aria"] });
  const keys = belt.getByRole("button", { name: en["composer.controls.keys"], exact: true });
  const stored = () =>
    page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("collie:draft:")));

  await expect(switcher).toBeVisible();
  await expect(changes).toBeVisible();
  // The belt at rest: no X on an empty box.
  await expect(clear).toHaveCount(0);
  // Measured against the belt's own top edge: a long draft grows the field upward and carries the
  // whole belt with it, which is the operator typing lines (DESIGN.md §2, allowed shift (a)). What
  // the X must never do is move anything ACROSS the belt, or change its height.
  const place = async (locator: Locator) => {
    const [b, band] = [await box(locator), await box(belt)];
    return { x: b.x, top: b.y - band.y, width: b.width, height: b.height };
  };
  const rest = {
    belt: await place(belt),
    keys: await place(keys),
    changes: await place(changes),
    switcher: await place(switcher),
  };
  /** The belt, its first scrolling pill and the two pinned pills, exactly where they stood at rest. */
  const nothingMoved = async () => {
    expect(await place(belt)).toEqual(rest.belt);
    expect(await place(keys)).toEqual(rest.keys);
    expect(await place(changes)).toEqual(rest.changes);
    expect(await place(switcher)).toEqual(rest.switcher);
  };

  await field.tap();
  await expect(field).toBeFocused();
  const draft = "a long draft thumbed out on a phone, and then it turned out to be the wrong one";
  await page.keyboard.type(draft);
  await expect(field).toHaveValue(draft);
  await expect.poll(stored).toHaveLength(1);

  // WHERE: directly left of the Changes pill, the same square box, and nothing else moved.
  await expect(clear).toBeVisible();
  const x = await place(clear);
  expect(x.x + x.width).toBeLessThanOrEqual(rest.changes.x);
  expect(rest.changes.x - (x.x + x.width)).toBeLessThanOrEqual(8);
  expect([x.width, x.height]).toEqual([rest.changes.width, rest.changes.height]);
  await nothingMoved();

  // ONE TAP: the box and the stored draft are empty, the keyboard's field still has focus, and the
  // slot is Undo in the very same box.
  await clear.tap();
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await expect(undo).toBeVisible();
  await expect(clear).toHaveCount(0);
  expect(await place(undo)).toEqual(x);
  expect(await stored()).toEqual([]);
  await nothingMoved();

  // UNDO: the draft and its stored copy come back, focus holds, and the slot is the X again.
  await undo.tap();
  await expect(field).toHaveValue(draft);
  await expect(field).toBeFocused();
  await expect(clear).toBeVisible();
  await expect(undo).toHaveCount(0);
  expect(await place(clear)).toEqual(x);
  await expect.poll(stored).toHaveLength(1);
  await nothingMoved();

  // The pane received nothing at all: no key, no reply, no upload.
  expect(writes).toEqual([]);
});

test("a cleared draft stays empty after a reload", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const field = page.getByRole("textbox", { name: en["composer.placeholder.reply"] });
  const clear = page.getByRole("button", { name: en["composer.controls.clear"], exact: true });
  const undo = page.getByRole("button", { name: en["composer.controls.undoClear"], exact: true });

  await field.tap();
  await page.keyboard.type("not this one");
  await clear.tap();
  await expect(undo).toBeVisible();

  await page.reload();
  await expect(field).toHaveValue("");
  // The Undo window lived in memory only, and a reload ends it.
  await expect(undo).toHaveCount(0);
  await expect(clear).toHaveCount(0);
});
