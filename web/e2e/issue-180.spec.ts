import { expect, test } from "@playwright/test";

import { de } from "@/lib/i18n/messages/de";
import { en } from "@/lib/i18n/messages/en";

import { fill, installApiStub, pinLocale } from "./fixtures/api";
import { installMirrorWorld, MIRROR_NEEDLE, MIRROR_PANE_ID, stubBlob } from "./fixtures/mirror";

// ── Issue 180: the mirror shows the picture, or says a picture is there ──────────────────────────
//
// Seven checks that were driven by hand in a browser on 2026-09-09, on the five commits that closed
// issue 180 (`fd28d018`, `fbae4cf6`, `8e8cf78a`, `ba8e19a0`, `797318d6`). Each is now a case, so
// nothing proven once is proven only once.
//
// THE TARGET IS `app`, all seven. The playground renders a pane too, but only the app target runs
// the real router, the real pane loader and the real `useMirrorImages` cadence — and the journal
// read is half of what issue 180 was about, so the case has to be able to fail on it. The API stub
// supplies the screen; the blob route supplies the bytes.
//
// SELECTORS are a role plus an accessible name, or the app's own string out of the dictionary. The
// one attribute selector is `[data-find-match]`, which the app already carries
// (`components/ansi-output.tsx:489`) and which is the only handle on a highlighted run — no class,
// and no test id was added to the app for it.

// ── NO SERVICE WORKER IN THESE CASES, AND THE REASON IS THE STUB ────────────────────────────────
// `page.route` does not see a request the service worker makes on the page's behalf. So once the
// shipped worker takes control — one to two seconds after the first load — `/api/*` and
// `/api/blobs/*` start being answered by the real static server instead of by the fixture, the
// picture 404s, and the case fails on the second thing it asserts with no hint as to why. Worse, it
// is a RACE: a short case finishes before the worker claims the page and a longer one does not, so
// the suite would be green on Tuesday and red on Wednesday. The worker is not what these seven
// cases are about — `e2e/smoke.spec.ts` owns it, and owns it properly, by registering it and
// waiting for it.
test.use({ serviceWorkers: "block" });

/** The live pane route, `pane/:paneId` (`src/router.tsx:72`). */
const PANE_URL = `/pane/${encodeURIComponent(MIRROR_PANE_ID)}`;
/** The transcript route, `pane/:paneId/history` (`src/router.tsx:73`). */
const HISTORY_URL = `${PANE_URL}/history`;

test.beforeEach(async ({ page }, testInfo) => {
  // The `states-*` projects address the playground on 5199, where none of these routes exist. This
  // file is the `app` target's, and says so rather than failing there.
  test.skip(
    testInfo.project.name.startsWith("states"),
    "these cases drive the app bundle, not the playground",
  );
  await installApiStub(page);
  await installMirrorWorld(page);
});

// Replaces the hand check "open a pane whose screen holds a Kitty placeholder run and see the
// picture instead of a black box", run by hand 2026-09-09.
test("a run of image placeholders shows the picture the journal is holding", async ({ page }) => {
  await stubBlob(page, "bytes");
  await page.goto(PANE_URL);

  // The picture, by its alt text — which is the app's own `mirror.imageAlt`.
  const picture = page.getByRole("img", { name: en["mirror.imageAlt"] });
  await expect(picture).toBeVisible();

  // And it is the JOURNAL's picture, not a decoration: the anchor around it points at the blob path
  // the fixture transcript named. The anchor takes its accessible name from the picture's alt text,
  // so it is reachable by role as well.
  const link = page.getByRole("link", { name: en["mirror.imageAlt"] });
  await expect(link).toHaveAttribute("href", /\/api\/blobs\/[0-9a-f]{64}$/);

  // The screen holds two clusters and the journal holds one image, so the cluster with nothing left
  // of it says "a picture is here" rather than repeating the one that is.
  await expect(page.getByText(en["mirror.imageBadge"], { exact: true })).toBeVisible();
});

// Replaces the hand check "the picture on the mirror admits it is a guess, and points at History",
// run by hand 2026-09-09.
test("the picture admits it was matched by order and points at History", async ({ page }) => {
  await stubBlob(page, "bytes");
  await page.goto(PANE_URL);

  // The caption under the picture, in the app's own words.
  await expect(page.getByText(en["mirror.imageMatchedByOrder"], { exact: true })).toBeVisible();

  // The same sentence as the anchor's tooltip, because the caption may be scrolled out of the tap
  // target on a phone.
  const link = page.getByRole("link", { name: en["mirror.imageAlt"] });
  await expect(link).toHaveAttribute("title", en["mirror.imageMatchedByOrder"]);
});

// Replaces the hand check "search the mirror for a word below an image and watch where the
// highlight lands", run by hand 2026-09-09.
test("a search highlight is exact on the far side of a blanked placeholder run", async ({
  page,
}) => {
  await stubBlob(page, "bytes");
  await page.goto(PANE_URL);
  await expect(page.getByRole("img", { name: en["mirror.imageAlt"] })).toBeVisible();

  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await page.getByRole("button", { name: en["chat.find.label"] }).click();
  await page
    .getByRole("textbox", {
      name: fill(en["find.aria"], { subject: en["find.subject.output"] }),
    })
    .fill(MIRROR_NEEDLE);

  // THIS is the case that only a browser can run. `blankPlaceholders` replaces a placeholder run
  // with spaces of the SAME character count, and the renderer walks the shared offset over the rows
  // it does not draw, so that every match below an image still addresses the character it did above
  // one (`lib/mirror-images.ts:43-44`). A unit test can assert the function. Only a rendered screen
  // can assert that the yellow lands on the word.
  const highlights = page.locator("[data-find-match]");
  await expect(highlights).toHaveCount(2);
  await expect(highlights.nth(0)).toHaveText(MIRROR_NEEDLE);
  // The second one sits under two placeholder clusters — four rows the screen never draws. An offset
  // that slid by even one character highlights something that is not the word.
  await expect(highlights.nth(1)).toHaveText(MIRROR_NEEDLE);
  await expect(page.locator('[data-find-match="current"]')).toHaveText(MIRROR_NEEDLE);
});

// Replaces the hand check "a member that answers 404 for the blob must not show a broken image",
// run by hand 2026-09-09.
test("a blob that answers 404 leaves the badge where the picture would be", async ({ page }) => {
  await stubBlob(page, "notFound");
  await page.goto(PANE_URL);

  // Both clusters end as badges: one had no image to begin with, and the other's bytes are gone.
  await expect(page.getByText(en["mirror.imageBadge"], { exact: true })).toHaveCount(2);
  await expect(page.getByRole("img", { name: en["mirror.imageAlt"] })).toHaveCount(0);
});

// Replaces the hand check "a half-written blob must fall back to the badge, not to a broken-image
// glyph", run by hand 2026-09-09.
test("an image whose bytes will not decode falls back to the badge", async ({ page }) => {
  await stubBlob(page, "truncated");
  await page.goto(PANE_URL);

  // The other road to the badge, and a different one: the request SUCCEEDED, so this is the `onError`
  // path in the component (`ansi-output.tsx:382-389`) rather than a URL the client refused.
  await expect(page.getByText(en["mirror.imageBadge"], { exact: true })).toHaveCount(2);
  await expect(page.getByRole("img", { name: en["mirror.imageAlt"] })).toHaveCount(0);
});

// Replaces the hand check "open History on the same pane and see the attached picture", run by hand
// 2026-09-09.
test("the History view renders the journal's own picture", async ({ page }) => {
  await stubBlob(page, "bytes");
  await page.goto(HISTORY_URL);

  // A different component and a different route: `JournalImage` (`components/transcript-view.tsx:74`)
  // under `pane/:paneId/history`, reading the SAME transcript the mirror aligned by order. History
  // is the exact view the mirror's caption sends the operator to, so it has to hold the picture.
  await expect(page.getByRole("img", { name: en["transcript.attachmentAlt"] })).toBeVisible();
});

// Replaces the hand check "switch to German and read the image card", run by hand 2026-09-09.
test("in German the image card speaks German", async ({ page }) => {
  await pinLocale(page, "de");
  await stubBlob(page, "bytes");
  await page.goto(PANE_URL);

  // The picture first, by its GERMAN alt text — and not only because that is a third translated
  // string. Until the journal read lands, BOTH clusters carry a badge, and "one badge" is only true
  // of the settled screen. Waiting on the picture is waiting on that, without a timeout.
  await expect(page.getByRole("img", { name: de["mirror.imageAlt"] })).toBeVisible();

  // All three strings differ from their English originals, so this cannot pass in English:
  // "[Bild]" vs "[Image]", and the caption vs "matched by order, open History to check".
  await expect(page.getByText(de["mirror.imageBadge"], { exact: true })).toBeVisible();
  await expect(page.getByText(de["mirror.imageMatchedByOrder"], { exact: true })).toBeVisible();
  expect(de["mirror.imageAlt"]).not.toBe(en["mirror.imageAlt"]);
  expect(de["mirror.imageBadge"]).not.toBe(en["mirror.imageBadge"]);
  expect(de["mirror.imageMatchedByOrder"]).not.toBe(en["mirror.imageMatchedByOrder"]);
});
