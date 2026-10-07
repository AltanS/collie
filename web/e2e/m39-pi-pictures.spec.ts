import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import {
  type BlobRequest,
  E2E_DEVICE_TOKEN,
  installPiPictureWorld,
  MIRROR_PANE_ID,
  pairDevice,
  stubBlob,
} from "./fixtures/mirror";

// ── M39, #292: a picture pi shows reaches the live mirror ────────────────────────────────────────
//
// pi draws by direct placement, which leaves no placeholder cell, so the placeholder path of
// `issue-180.spec.ts` never fires for it. The mirror reads the newest finished turn's picture from
// the journal instead and shows it as one card right after the mirror. THE TARGET IS `app`: only the
// app runs the real pane loader, the real snapshot poll and the real `useMirrorImages` cadence.

// The shipped service worker would answer `/api/*` itself once it claims the page, past the stub.
// `issue-180.spec.ts` holds the full reason.
test.use({ serviceWorkers: "block" });

const PANE_URL = `/pane/${encodeURIComponent(MIRROR_PANE_ID)}`;

let blobRequests: BlobRequest[] = [];

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "these cases drive the app bundle, not the playground");
  await installApiStub(page);
  blobRequests = await stubBlob(page, "bytes");
  await pairDevice(page);
});

test("a finished pi turn's picture shows after the mirror, in view at the tail", async ({ page }) => {
  await installPiPictureWorld(page, { status: "done" });
  await page.goto(PANE_URL);

  const picture = page.getByRole("img", { name: en["mirror.imageAlt"] });
  await expect(picture).toBeVisible();
  // The journal's picture. Reads need the token (ADR 0086), so the page fetches the blob itself and
  // links an object URL of its own origin; the fetch behind it names the blob the fixture turn named.
  const origin = new URL(page.url()).origin;
  await expect(page.getByRole("link", { name: en["mirror.imageAlt"] })).toHaveAttribute(
    "href",
    new RegExp(`^blob:${origin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/[0-9a-f-]{36}$`),
  );
  expect(blobRequests.length).toBeGreaterThan(0);
  for (const request of blobRequests) {
    expect(request.path).toMatch(/\/api\/blobs\/[0-9a-f]{64}$/);
    expect(request.authorization).toBe(`Bearer ${E2E_DEVICE_TOKEN}`);
  }
  // The card says where it came from, and it is not the order-matched placeholder card.
  await expect(page.getByText(en["mirror.turnImageCaption"], { exact: true })).toBeVisible();
  await expect(page.getByText(en["mirror.imageMatchedByOrder"], { exact: true })).toHaveCount(0);
  await expect(page.getByText(en["mirror.imageBadge"], { exact: true })).toHaveCount(0);
  // Eighty rows of scrollback sit above the reply. The card is after the mirror, and the
  // bottom-pinned view shows it without a scroll: the pin followed it in and followed its load.
  await expect(picture).toBeInViewport();
  // After the mirror, not above it: the reply's row comes first in the document.
  const reply = page.getByText("Here is the screen.", { exact: true }).first();
  const replyBox = await reply.boundingBox();
  const pictureBox = await picture.boundingBox();
  expect(replyBox).not.toBeNull();
  expect(pictureBox).not.toBeNull();
  expect(pictureBox!.y).toBeGreaterThan(replyBox!.y);
});

test("while pi works on a turn, no picture card shows", async ({ page }) => {
  await installPiPictureWorld(page, { status: "working" });
  await page.goto(PANE_URL);

  await expect(page.getByText("Here is the screen.", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(en["mirror.turnImageCaption"], { exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: en["mirror.imageAlt"] })).toHaveCount(0);
});
