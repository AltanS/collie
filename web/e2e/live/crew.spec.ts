// The crew, as a real bridge with a real deputy reports it.
//
// This is the family Tier 1 cannot answer honestly. Its census is a fixture, and a fixture agrees
// with itself by construction. Here the census comes from the lead's own cached sweep of minibuch,
// and the case reads that census over HTTP in the same run it reads the screen — so the two can
// disagree, which is the whole point.
//
// Replaces the hand check first run on 2026-09-09: open /crew on the dev lane, confirm two machines
// and two reachable, confirm the crown on bluefin and the shield on minibuch.
import { message, plural, readCrew, test, expect } from "./live";

test("the crew page shows every machine reachable", async ({ page, request }) => {
  const crew = await readCrew(request);
  const reachable = crew.members.filter((m) => m.health === "reachable");
  // A LEGITIMATE ANSWER, NOT A FAILURE. A solo lead, or a deputy that has gone quiet, is a state
  // the lane is allowed to be in. The reason is printed so the operator knows which it was.
  test.skip(
    reachable.length < 2,
    `the lane reports ${reachable.length} reachable machine(s); this case needs two`,
  );

  await page.goto("/crew");
  await expect(page.getByRole("heading", { name: message("crew.title") })).toBeVisible();

  // One caption, one sentence, built from the same numbers the endpoint just gave.
  const caption = `${crew.crew.name || crew.crew.id} · ${message("crew.summary.counts", {
    machines: plural("crew.summary.machines", crew.members.length),
    reachable: message("crew.summary.reachable", { count: reachable.length }),
  })}`;
  await expect(page.getByText(caption, { exact: true })).toBeVisible();
});

test("the crew page marks the real lead and the real deputy", async ({ page, request }) => {
  const crew = await readCrew(request);
  const lead = crew.members.find((m) => m.isLead);
  const deputy = crew.members.find((m) => m.id === crew.deputy?.id && !m.isLead);
  test.skip(lead === undefined, "the lane reports no lead");
  test.skip(deputy === undefined, "the lane has no deputy other than the lead");
  if (lead === undefined || deputy === undefined) return;
  test.skip(
    lead.health !== "reachable" || deputy.health !== "reachable",
    `lead is ${lead.health} and deputy is ${deputy.health}; this case reads the reachable wording`,
  );

  await page.goto("/crew");

  // The node is a `<g role="button">` and its accessible name is `crew.node.aria` — name, role,
  // health. The role WORD is what carries the crown and the shield; the glyphs themselves are
  // `aria-hidden`, so the name is the only honest handle for them.
  await expect(
    page.getByRole("button", {
      name: message("crew.node.aria", {
        name: lead.name || lead.id,
        role: message("connection.host.lead"),
        health: message("crew.health.reachable"),
      }),
      exact: true,
    }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", {
      name: message("crew.node.aria", {
        name: deputy.name || deputy.id,
        role: message("crew.role.deputy"),
        health: message("crew.health.reachable"),
      }),
      exact: true,
    }),
  ).toBeVisible();
});

test("the scope switcher lists every machine in the crew", async ({ page, request }) => {
  const crew = await readCrew(request);
  const reachable = crew.members.filter((m) => m.health === "reachable");
  // The switcher hides itself when there is nothing to choose between and the view is on the lead
  // (`server-switcher.tsx`: `reachableCount <= 1 && !onPeer`). That is correct behaviour, not a
  // bug, so the case says so and stands down.
  test.skip(
    reachable.length < 2,
    `the switcher hides below two reachable machines; the lane reports ${reachable.length}`,
  );
  const lead = crew.members.find((m) => m.isLead);
  test.skip(lead === undefined, "the lane reports no lead");
  if (lead === undefined) return;

  await page.goto("/");
  // WAIT FOR THE FIRST SNAPSHOT BEFORE TAPPING ANYTHING. `goto` resolves on load, and the header's
  // switcher is rendered from snapshot data that arrives after it — a tap in that window lands on a
  // button React is about to replace, and the sheet never opens. The crew footer is the cheapest
  // proof that the snapshot is in.
  await expect(page.getByRole("button", { name: message("crew.footer.aria") })).toBeVisible();

  // The trigger names the machine currently in scope. No `?h=`, so that is the lead.
  const trigger = page.getByRole("button", {
    name: message("connection.server.aria", { name: lead.name || lead.id }),
  });
  await expect(trigger).toBeVisible();

  const sheet = page.getByRole("dialog", { name: message("connection.server.title") });
  // TAP UNTIL THE APP IS LISTENING, and say why rather than hide it in a sleep. On a cold context
  // the very first tap can land between paint and the handler being attached, and it then does
  // nothing at all — measured on the phone viewport, which is the first project to run and so the
  // one that pays the cold start. Opening is idempotent (`setOpen(true)`), so a second tap on an
  // already-open sheet changes nothing.
  await expect(async () => {
    await trigger.click();
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  for (const member of crew.members) {
    await expect(sheet.getByText(member.name || member.id, { exact: true })).toBeVisible();
  }
});
