// `/pack` still lands somewhere sensible, on a real bundle served by a real bridge.
//
// The route was `/pack` until 1.7.0 (`src/router.tsx`). A bookmark, an installed PWA's start URL
// and a service worker holding the old shell all still ask for that spelling, and the query is what
// carries the scope, so it has to survive the move. Tier 1 proves the router; this proves the
// shipped bundle on the lane does it too.
//
// Replaces the hand check first run on 2026-09-09: open /pack?h=<member> on the dev lane and
// confirm the address bar reads /crew?h=<member>.
import { message, readCrew, test, expect } from "./live";

test("/pack redirects to /crew and keeps the query", async ({ page, request }) => {
  const crew = await readCrew(request);
  const peer = crew.members.find((m) => !m.isLead);
  test.skip(peer === undefined, "the lane has no member other than the lead to scope to");
  if (peer === undefined) return;

  await page.goto(`/pack?h=${encodeURIComponent(peer.id)}`);

  await expect(page).toHaveURL(new RegExp(`/crew\\?h=${encodeURIComponent(peer.id)}$`));
  await expect(page.getByRole("heading", { name: message("crew.title") })).toBeVisible();

  // `replace`, not a push: Back must not bounce the operator between the two spellings. Nothing to
  // go back to in a fresh context, so the assertion is that the URL does not become /pack again.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/pack(\?|$)/);
});
