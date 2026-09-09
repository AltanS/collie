// The update card, against the build that is actually answering.
//
// The card reads `/api/update/check` and the snapshot; the case reads `/api/health` in the same run
// and compares. A fixture can make those two agree; only a live bridge can prove they do.
//
// NO CONFIRM IS EVER TAPPED. Starting a real update restarts the lane, and the deputy on minibuch
// cannot receive a dev build anyway (M22's dev-crew checkpoint). This case reads and leaves.
//
// Replaces the hand check first run on 2026-09-09: open /settings/updates on the dev lane, confirm
// the card names the running version.
import { message, readHealth, releaseVersion, test, expect } from "./live";

test("/settings/updates names the version /api/health reports", async ({ page, request }) => {
  const health = await readHealth(request);
  expect(health.ok).toBe(true);
  const running = releaseVersion(health.version);

  await page.goto("/settings/updates");
  await expect(page.getByRole("heading", { name: message("updates.title") })).toBeVisible();

  // "Running 1.7.0", and the card appends " · Newest <version>" to the same text node, so the match
  // is a substring by necessity. It is still unambiguous: the page's other version line is the
  // check control's, which prints a `v` prefix ("Running v1.7.0 · checked 2m ago").
  const runningLine = page.getByText(message("settings.updateCard.running", { current: running }));
  await expect(runningLine).toHaveCount(1);
  await expect(runningLine).toBeVisible();

  // And never the placeholder. A card that has no version at all still renders this line, with
  // "an unknown version" in the slot, which would otherwise read as a pass.
  await expect(
    page.getByText(
      message("settings.updateCard.running", {
        current: message("settings.updateCard.versionUnknown"),
      }),
    ),
  ).toHaveCount(0);
});
