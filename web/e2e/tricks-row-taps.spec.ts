import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";
import { hillDecision } from "@/test/hill-fixtures";
import type { OfficialTricksReply, TricksReply, WireTrickInfo } from "@/lib/tricks/schema";

import { installApiStub } from "./fixtures/api";

// SETTINGS, TRICKS: THE WHOLE ROW OPENS THE DETAILS PAGE (2026-11-12; a sheet until 2026-11-21), measured in a
// real engine. The name is the one link and its `::after` is stretched over the row (components/ui/row-open.ts), so a tap on the
// description, the places, the source line or the row's empty space lands on it. The switch and Add are its
// siblings, lifted above that layer, and keep their own taps. jsdom lays nothing out, so every probe here is
// `elementFromPoint` or a tap at a point.

test.use({ serviceWorkers: "block" });

const LEGS: WireTrickInfo = {
  host: "lodge",
  id: "legs",
  name: "Browser leg",
  icon: "flask",
  on: false,
  state: "off",
  places: ["belt", "session"],
  description: "Shows the browser leg.",
  about: "First paragraph.",
  provenance: { via: "cli", at: "2026-11-08T07:41:00Z" },
};

const OFFICIAL: OfficialTricksReply = {
  tricks: [
    {
      id: "running-builds",
      name: "Running Builds",
      description: "Builds and long commands running in your sessions now.",
      repo: "https://github.com/AltanS/collie-tricks",
      repoName: "AltanS/collie-tricks",
      commit: "0c1e5d82346486815073fedcdb994bc4c2041b55",
      state: "absent",
      places: ["dashboard", "session", "status"],
    },
  ],
};

async function stubTricks(page: Page, posts: string[]): Promise<void> {
  await installApiStub(page);
  // Routes added later answer first: the snapshot now says a tricks folder exists, and the three trick routes answer.
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, tricksRev: 1 }) }));
  await page.route("**/api/tricks?*", (route) => {
    const reply: TricksReply = { rev: 1, tricks: [LEGS], parts: [], present: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  });
  await page.route("**/api/tricks/official", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(OFFICIAL) }));
  await page.route("**/api/tricks/*/*/*", (route) => {
    const url = new URL(route.request().url());
    posts.push(url.pathname);
    if (url.pathname.endsWith("/switch")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...LEGS, on: true, state: "ok" }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "running-builds", state: "added" }) });
  });
}

/** What the tap at a point reaches: the accessible name of the button or link there, or its role when it has none. */
async function targetAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px!, py!)?.closest("button, a");
      if (el === null || el === undefined) return null;
      return el.getAttribute("aria-label") ?? el.getAttribute("role");
    },
    [x, y] as const,
  );
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} is not drawn`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("every line of a trick's row reaches its About link, and the switch keeps its own taps", async ({ page }) => {
  const posts: string[] = [];
  await stubTricks(page, posts);
  await page.goto("/settings/tricks");
  const row = '[data-trick="legs"]';
  await expect(page.locator(row)).toBeVisible();
  for (const line of ["description", "places", "slot"]) {
    const { x, y } = await centre(page, `${row} [data-line="${line}"]`);
    expect(await targetAt(page, x, y), line).toBe("About Browser leg");
  }
  // The row's empty space: its padding, below the last line, at its left edge.
  const box = (await page.locator(row).boundingBox())!;
  expect(await targetAt(page, box.x + 4, box.y + box.height - 3)).toBe("About Browser leg");
  // The switch, and its reach just above it.
  const sw = await page.locator(`${row} [role="switch"]`).boundingBox();
  expect(await targetAt(page, sw!.x + sw!.width / 2, sw!.y + sw!.height / 2)).toBe("Browser leg");
  expect(await targetAt(page, sw!.x + sw!.width / 2, sw!.y - 6)).toBe("Browser leg");

  // A tap on the switch switches, and opens no page.
  await page.mouse.click(sw!.x + sw!.width / 2, sw!.y + sw!.height / 2);
  await expect.poll(() => posts).toEqual(["/api/tricks/lodge/legs/switch"]);
  await expect(page).toHaveURL(/\/settings\/tricks$/);

  // A tap on the description opens the details page.
  const { x, y } = await centre(page, `${row} [data-line="description"]`);
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(/\/settings\/tricks\/lodge%3Alegs$/);
  await expect(page.locator('[data-slot="trick-detail-name"]')).toHaveText("Browser leg");
});

test("the Hill's row: its lines open its page, the switch keeps its own taps and a 44px reach", async ({ page }) => {
  const posts: string[] = [];
  await stubTricks(page, posts);
  await page.route("**/api/hill/switch", (route) => {
    posts.push("/api/hill/switch");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ on: false }) });
  });
  await page.goto("/settings/tricks");
  const row = "[data-hill-row]";
  await expect(page.locator(row)).toBeVisible();
  for (const line of ["description"]) {
    const { x, y } = await centre(page, `${row} [data-line="${line}"]`);
    expect(await targetAt(page, x, y), line).toBe("About Asks");
  }
  const sw = (await page.locator(`${row} [role="switch"]`).boundingBox())!;
  expect(await targetAt(page, sw.x + sw.width / 2, sw.y + sw.height / 2)).toBe("Asks");
  // The reach: 44px tall in all, as a trick row's switch.
  expect(await targetAt(page, sw.x + sw.width / 2, sw.y - 6)).toBe("Asks");
  expect(await targetAt(page, sw.x + sw.width / 2, sw.y + sw.height + 6)).toBe("Asks");
  await page.mouse.click(sw.x + sw.width / 2, sw.y + sw.height / 2);
  await expect.poll(() => posts).toEqual(["/api/hill/switch"]);
  await expect(page).toHaveURL(/\/settings\/tricks$/);
  const { x, y } = await centre(page, `${row} [data-line="description"]`);
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(/\/settings\/tricks\/hill$/);
  await expect(page.locator('[data-slot="trick-detail-name"]')).toHaveText("Asks");
});

test("the Hill's row with Decisions waiting: arming swaps the text for the note and moves nothing, the text opens the page while unarmed", async ({ page }) => {
  const posts: string[] = [];
  await stubTricks(page, posts);
  const snap = { ...fixtureSnapshot, tricksRev: 1, hillRev: 1 };
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }));
  const open = [hillDecision({ title: "One" }), hillDecision({ title: "Two" }), hillDecision({ title: "Three" })];
  await page.route((url) => url.pathname === "/api/hill", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open, closed: [] }) }));
  await page.goto("/settings/tricks");
  const row = "[data-hill-row]";
  await expect(page.locator(`${row} [data-line="slot"]`)).toHaveText("3 Decisions wait on you");
  // The token chip is drawn whole on the row (scrollWidth against clientWidth, chip and text).
  const whole = await page.locator(`${row} [data-slot="token-use"]`).evaluate((el) => {
    const text = el.querySelector("span")!;
    return el.scrollWidth <= el.clientWidth && text.scrollWidth <= text.clientWidth;
  });
  expect(whole).toBe(true);
  const rowBox = (await page.locator(row).boundingBox())!;
  const swBox = (await page.locator(`${row} [role="switch"]`).boundingBox())!;
  // Unarmed, a tap on the slot line reaches the stretched link.
  const slot = await centre(page, `${row} [data-line="slot"]`);
  expect(await targetAt(page, slot.x, slot.y)).toBe("About Asks");
  await page.locator(`${row} [role="switch"]`).click();
  await expect(page.locator(`${row} [data-line="armed"]:not([aria-hidden])`)).toBeVisible();
  await expect(page.locator(`${row} [data-layer="text"]`)).toHaveCSS("visibility", "hidden");
  // Nothing moved by one pixel: the row, and its switch.
  expect(await page.locator(row).boundingBox()).toEqual(rowBox);
  expect(await page.locator(`${row} [role="switch"]`).boundingBox()).toEqual(swBox);
  expect(posts).toEqual([]);
  // The note shows on the text's place, inside the row.
  const note = (await page.locator(`${row} [data-line="armed"]`).boundingBox())!;
  expect(note.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(note.y + note.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
});

test("the Hill's page: Send a test Decision taps, says when it arrives and why no notification would be sent, keeps the page in place and holds the button", async ({ page }) => {
  const posts: string[] = [];
  await stubTricks(page, posts);
  const snap = { ...fixtureSnapshot, tricksRev: 1, hillRev: 1 };
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }));
  await page.route((url) => url.pathname === "/api/hill", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open: [], closed: [] }) }));
  const asked: string[] = [];
  await page.route("**/api/hill/test", async (route) => {
    asked.push(`${route.request().method()} ${route.request().postData() ?? ""}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ inSeconds: 20, rings: "crew_member" }) });
  });
  await page.goto("/settings/tricks/hill");
  const button = page.getByRole("button", { name: "Send a test Decision" });
  const result = page.locator('[data-line="test-result"]');
  await expect(button).toBeEnabled();
  // The slot is there and empty before the tap: the group below it (Where it comes from) is where it will stay.
  const fromBefore = (await page.locator('[data-section="from"]').boundingBox())!;
  const slotBefore = (await result.boundingBox())!;
  expect(slotBefore.height).toBeGreaterThanOrEqual(48);
  await button.click();
  await expect(result).toHaveText("A test Decision arrives in 20 seconds. No notification is sent, because this machine is a crew member, and the lead sends the notifications.");
  await expect(button).toBeDisabled();
  expect(asked).toEqual(["POST {}"]);
  // The reserved slot held the sentence: nothing below it moved by one pixel.
  // The tap scrolled the page, so the distance from the slot to the group below is what must stay.
  expect((await page.locator('[data-section="from"]').boundingBox())!.y - (await result.boundingBox())!.y).toBe(fromBefore.y - slotBefore.y);
  expect((await result.boundingBox())!.height).toBe(slotBefore.height);
  // The sentence stays, and a second tap does nothing while the button is held.
  await button.click({ force: true });
  expect(asked).toHaveLength(1);
});

test("an official entry's lines open its details page, and Add adds without opening it", async ({ page }) => {
  const posts: string[] = [];
  await stubTricks(page, posts);
  await page.goto("/settings/tricks");
  const row = '[data-official="running-builds"]';
  await expect(page.locator(row)).toBeVisible();
  const { x, y } = await centre(page, `${row} [data-line="description"]`);
  expect(await targetAt(page, x, y)).toBe("About Running Builds");
  const add = await centre(page, `${row} [data-slot="official-add"]`);
  expect(await targetAt(page, add.x, add.y)).toBe("Add Running Builds");
  await page.mouse.click(add.x, add.y);
  await expect.poll(() => posts).toEqual(["/api/tricks/official/running-builds/add"]);
  await expect(page).toHaveURL(/\/settings\/tricks$/);
});

// THE NAME LINE WRAPS (2026-11-12): at 360 px, a row with both labels keeps the whole name and moves the labels
// under it as one group. Only a name wider than the line alone may truncate. The long German chip words are
// put in by hand here: the translation pass has not run, and the width is what is checked.
test("at 360 px Design Review keeps its whole name beside Official and Uses agent tokens, in English and with long words", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await installApiStub(page);
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, tricksRev: 1 }) }));
  await page.route("**/api/tricks?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ rev: 1, tricks: [LEGS], parts: [], present: [] } satisfies TricksReply) }));
  const review: OfficialTricksReply = {
    tricks: [
      {
        id: "design-review",
        name: "Design Review",
        description: "Turns an agent's UI notes into Decisions you approve by name.",
        repo: "https://github.com/AltanS/collie-tricks",
        repoName: "AltanS/collie-tricks",
        commit: "0c1e5d82346486815073fedcdb994bc4c2041b55",
        state: "absent",
        places: ["belt", "session"],
        decidesReply: true,
      },
    ],
  };
  await page.route("**/api/tricks/official", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(review) }));
  await page.goto("/settings/tricks");
  const row = page.locator('[data-official="design-review"]');
  await expect(row.locator('[data-slot="token-use"]')).toBeVisible();
  const measure = () =>
    row.evaluate((el) => {
      const name = el.querySelector('[data-slot="row-name"] > span');
      const chip = el.querySelector('[data-slot="token-use"] > span');
      const labels = el.querySelector('[data-slot="row-labels"]');
      const add = el.querySelector('[data-slot="official-add"]');
      const button = el.querySelector('[data-slot="official-about"]');
      if (!(name instanceof HTMLElement) || !(chip instanceof HTMLElement) || !(labels instanceof HTMLElement) || !(add instanceof HTMLElement) || !(button instanceof HTMLElement)) throw new Error("the row is not drawn");
      const box = el.getBoundingClientRect();
      const addBox = add.getBoundingClientRect();
      return {
        nameWhole: name.scrollWidth <= name.clientWidth,
        chipWhole: chip.scrollWidth <= chip.clientWidth,
        labelsRight: labels.getBoundingClientRect().right,
        buttonRight: button.getBoundingClientRect().right,
        addCentreOffset: Math.abs(addBox.top + addBox.height / 2 - (box.top + box.height / 2)),
      };
    });
  const english = await measure();
  expect(english.nameWhole).toBe(true);
  expect(english.chipWhole).toBe(true);
  expect(english.labelsRight).toBeLessThanOrEqual(english.buttonRight + 0.5);
  // Add stays where it is today: centred on the row, whatever the row's height.
  expect(english.addCentreOffset).toBeLessThan(1.5);
  await row.locator('[data-slot="token-use"] > span').evaluate((el) => {
    el.textContent = "Verbraucht Agenten-Tokens";
  });
  const german = await measure();
  expect(german.nameWhole).toBe(true);
  expect(german.chipWhole).toBe(true);
  expect(german.labelsRight).toBeLessThanOrEqual(german.buttonRight + 0.5);
  expect(german.addCentreOffset).toBeLessThan(1.5);
});
