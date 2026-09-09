import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import { fixtureCrewStatus, fixtureServers } from "@/test/handlers";

import { fill, installApiStub, installCrewWorld, pinLocale } from "./fixtures/api";

// ── M24: the pack is a crew, and the old spelling still works ───────────────────────────────────
//
// Six checks that were driven by hand in a browser on 2026-09-09, on the two commits that renamed
// the word a person reads (`15f1f987`, `db6f9a5e`). Each is now a case.
//
// THE TARGET IS `app`, all six, and for one of them that is not a preference: a redirect is a router
// fact and the playground mounts a `MemoryRouter` (`src/playground/harness.tsx:151`), which has no
// browser history to leave an entry in. So the redirect cases can only run here.
//
// SELECTORS are roles and accessible names. The crew page carries no data attribute of its own, and
// none was added: the formation's `role="group"` and its per-node `role="button"` labels
// (`components/crew-formation.tsx:313-314`, `:406-409`) are the handles, which is why those labels
// exist.
//
// THE TRAP THIS FILE STEPS AROUND: `crew.title` is "Crew" in English AND in German, so a German
// case asserting the page title would pass in English and prove nothing. Japanese does translate it
// ("クルー"), so the locale case here is the Japanese one.

// NO SERVICE WORKER, for the reason `e2e/issue-180.spec.ts` states at length: `page.route` cannot
// see a request the worker makes on the page's behalf, so a worker that claims the page part way
// through a case takes the census away from the fixture and hands it to the real static server. The
// worker has its own case, in `e2e/smoke.spec.ts`.
test.use({ serviceWorkers: "block" });

/** The three machines `fixtureCrewStatus` describes: the lead, the deputy, and the conflicted one. */
const LEAD = fixtureCrewStatus.members[0]!;
const DEPUTY = fixtureCrewStatus.members[1]!;

/** A member's own name, the way the switcher spells it in a URL. */
const DEPUTY_QUERY = `?h=${DEPUTY.id}`;

test.beforeEach(async ({ page }, testInfo) => {
  // The `states-*` projects address the playground on 5199, which has no browser router and no
  // `/settings` route. This file is the `app` target's, and says so rather than failing there.
  test.skip(
    testInfo.project.name.startsWith("states"),
    "these cases drive the app bundle, not the playground",
  );
  await installApiStub(page);
  await installCrewWorld(page);
});

// Replaces the hand check "open /crew on a lead with a deputy and read the drawing", run by hand
// 2026-09-09.
test("the crew page names its lead and its deputy out loud", async ({ page }) => {
  await page.goto("/crew");

  await expect(page.getByRole("heading", { name: en["crew.title"] })).toBeVisible();

  // The drawing is an SVG, so the ONLY thing a person or a test can address it by is the accessible
  // name it was given. A crown and a shield are drawn for the two ranks; these two labels are what
  // say the same thing out loud.
  await expect(
    page.getByRole("group", {
      name: fill(en["crew.formation.aria"], {
        machines: fill(en["crew.summary.machines.other"], {
          count: fixtureCrewStatus.members.length,
        }),
      }),
    }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", {
      name: fill(en["crew.node.aria"], {
        name: LEAD.name,
        role: en["connection.host.lead"],
        health: en["crew.health.reachable"],
      }),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: fill(en["crew.node.aria"], {
        name: DEPUTY.name,
        role: en["crew.role.deputy"],
        health: en["crew.health.reachable"],
      }),
    }),
  ).toBeVisible();
});

// Replaces the hand check "open a bookmark on the old /pack path and watch where it lands", run by
// hand 2026-09-09.
test("an old /pack link lands on /crew with the host query intact", async ({ page }) => {
  await page.goto(`/pack${DEPUTY_QUERY}`);

  // The query is what makes the destination the right MACHINE, so it has to ride along: `?h=` is the
  // scope, and a redirect that dropped it would land the operator on the lead's census instead.
  await expect(page).toHaveURL(new RegExp(`/crew\\${DEPUTY_QUERY}$`));
  await expect(page.getByRole("heading", { name: en["crew.title"] })).toBeVisible();
});

// Replaces the hand check "after the /pack redirect, press Back", run by hand 2026-09-09.
test("the redirect leaves no history entry, so Back does not return to /pack", async ({ page }) => {
  await page.goto("/");
  await page.goto(`/pack${DEPUTY_QUERY}`);
  await expect(page).toHaveURL(new RegExp(`/crew\\${DEPUTY_QUERY}$`));

  // `replace`, not a push (`src/router.tsx:66-69`). A push would trap the operator between the two
  // spellings of one page: Back to /pack, which redirects forward to /crew, forever.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  expect(page.url()).not.toContain("/pack");
});

// Replaces the hand check "open Settings on a lead and find the two crew rows", run by hand
// 2026-09-09.
test("Settings offers a way into the crew and into the updates", async ({ page }) => {
  await page.goto("/settings");

  // Both rows are gated on the roster having more than one machine, so their presence is also the
  // proof that a solo install still sees byte-identical chrome without them.
  await expect(page.getByRole("button", { name: en["crew.entry.title"] })).toBeVisible();
  await expect(page.getByRole("button", { name: en["updates.entry.title"] })).toBeVisible();
});

// Replaces the hand check "look at the dashboard footer on a lead", run by hand 2026-09-09.
test("the dashboard footer says crew", async ({ page }) => {
  await page.goto("/");

  // The third way into the census, and the one that has to read as a crew rather than as a pack: the
  // label counts the machines and the aria-label names the destination.
  const line = page.getByRole("button", { name: en["crew.footer.aria"] });
  await expect(line).toBeVisible();
  await expect(line).toHaveText(
    fill(en["crew.footer.label"], {
      machines: fill(en["crew.summary.machines.other"], { count: fixtureServers.length }),
      reachable: fill(en["crew.summary.reachable"], {
        count: fixtureServers.filter((server) => server.reachable).length,
      }),
    }),
  );
});

// Replaces the hand check "switch to Japanese and open the crew page", run by hand 2026-09-09.
test("in Japanese the crew page is called クルー", async ({ page }) => {
  await pinLocale(page, "ja");
  await page.goto("/crew");

  // Both strings differ from their English originals, so this cannot pass in English. Japanese is
  // the locale used here for exactly that reason: German translates neither `crew.title` nor
  // `crew.summary.deputy`, so a German case on this page would be a case about nothing.
  await expect(page.getByRole("heading", { name: ja["crew.title"] })).toBeVisible();
  await expect(page.getByRole("button", { name: ja["crew.nav.back"] })).toBeVisible();
  expect(ja["crew.title"]).not.toBe(en["crew.title"]);
  expect(ja["crew.nav.back"]).not.toBe(en["crew.nav.back"]);
});
