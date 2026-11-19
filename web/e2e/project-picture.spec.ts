import { deflateSync } from "node:zlib";

import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE PROJECT PICTURE IN AN ENGINE (issue 811, ADR 0160). jsdom cannot decode a picture, draw a canvas or
// lay out a row, so these claims are read here: the page decodes the bridge's bytes into its own copy and
// draws it, with the agent logo in its corner, in the session's row and in the session view's title; the
// Collie mark is never replaced; a row with a picture sits exactly where the same row without one sits, at
// 390 and 360 px; and the closed sidebar on a large screen draws it without moving a box.

test.use({ serviceWorkers: "block" });

const VERSION = "abcdef012345abcdef012345";

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "a layout claim at set sizes; the tablet adds nothing");
  await installApiStub(page);
  await keepPhoneLayout(page);
});

/** CRC-32 of PNG chunk bytes, for a PNG a real decoder takes. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real 128 x 128 PNG: two colours in quarters, so a copy that drew nothing would be visible. */
function picture(): Buffer {
  const side = 128;
  const raw = Buffer.alloc(side * (side * 4 + 1));
  for (let y = 0; y < side; y++) {
    raw[y * (side * 4 + 1)] = 0;
    for (let x = 0; x < side; x++) {
      const at = y * (side * 4 + 1) + 1 + x * 4;
      const warm = (x < side / 2) === (y < side / 2);
      raw[at] = warm ? 0xe8 : 0x22;
      raw[at + 1] = warm ? 0x6a : 0x88;
      raw[at + 2] = warm ? 0x1c : 0xdd;
      raw[at + 3] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

const withPicture = { ...fixtureSnapshot, agents: fixtureSnapshot.agents.map((a, i) => (i === 0 ? { ...a, picture: VERSION } : a)) };

/** The snapshot with or without the first pane's picture, and the picture's bytes. */
async function serve(page: Page, on: boolean): Promise<void> {
  await page.route("**/api/snapshot*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(on ? withPicture : fixtureSnapshot) }));
  await page.route(`**/api/project-picture/${VERSION}*`, (route) => route.fulfill({ contentType: "image/png", body: picture() }));
}

/** Where every row's title and name sit, read in the engine. */
function rows(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="agent-row-title"]')].map((row) => {
      const r = row.getBoundingClientRect();
      const name = row.querySelector<HTMLElement>('[data-glide="name"]')?.getBoundingClientRect();
      return { top: r.top, height: r.height, nameLeft: name?.left ?? null };
    }),
  );
}

const firstTile = (page: Page) => page.locator('[data-slot="agent-tile"]').first();
/** Every picture the Collie mark's button holds: none, always (the mark is never replaced). */
const markPictures = (page: Page) => page.locator('[data-slot="collie-mark"]').locator("xpath=ancestor::button[1]").locator('img[src^="data:"]');

test("the row shows the picture with the agent logo in its corner, and the dashboard keeps the Collie mark", async ({ page }) => {
  await serve(page, true);
  await page.goto("/");
  await expect(firstTile(page)).toHaveAttribute("data-picture", "on");
  // The page drew its own copy: a PNG data URL, decoded, not the bridge's address.
  const img = firstTile(page).locator("img");
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  // The harness stays visible: the agent's own logo, named, in the corner.
  await expect(firstTile(page).getByRole("img", { name: /claude/i })).toBeVisible();
  // The Collie mark stays the Collie mark.
  await expect(page.locator('header [data-slot="collie-mark"]')).toBeVisible();
  await expect(markPictures(page)).toHaveCount(0);
});

test("in the session view the title's tile shows the picture, and the Collie mark stays", async ({ page }) => {
  await serve(page, true);
  await page.goto(`/pane/${encodeURIComponent(fixtureSnapshot.agents[0]!.paneId)}`);
  const title = page.locator('header [data-slot="agent-tile"]');
  await expect(title).toHaveAttribute("data-picture", "on");
  await expect(title.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.locator('header [data-slot="collie-mark"]')).toBeVisible();
  await expect(markPictures(page)).toHaveCount(0);
});

for (const width of [390, 360]) {
  test(`a row with a picture sits where the row without one sits, at ${String(width)} px`, async ({ browser }) => {
    const measure = async (on: boolean) => {
      const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: "block" });
      const page = await context.newPage();
      await installApiStub(page);
      await keepPhoneLayout(page);
      await serve(page, on);
      await page.goto("/");
      await expect(firstTile(page)).toHaveAttribute("data-picture", on ? "on" : "off");
      // Past the fade, so the reading is the resting layout.
      await expect(page.locator('[data-slot="crossfade-out"]')).toHaveCount(0);
      const read = await rows(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      await context.close();
      return { read, overflow };
    };
    const without = await measure(false);
    const withIt = await measure(true);
    expect(withIt.read).toEqual(without.read);
    expect(withIt.overflow).toBe(false);
  });
}

// THE CLOSED SIDEBAR ON A LARGE SCREEN (round 14). The rail's 44 px buttons hold a 28 px tile, and the
// picture takes the logo's place in it with the logo at 14 px in its corner. Nothing on the rail moves
// when the picture arrives: its width and every button's box are the same with and without it.
test("the closed sidebar draws the picture, and its width and buttons do not move when it loads", async ({ browser }) => {
  const measure = async (on: boolean) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await installApiStub(page);
    await page.addInitScript(() => localStorage.setItem("collie:wide-sidebar:v1", "0"));
    await serve(page, on);
    await page.goto(`/pane/${encodeURIComponent(fixtureSnapshot.agents[1]!.paneId)}`);
    const rail = page.locator('aside[data-slot="rail"]');
    await expect(rail).toBeVisible();
    const pictured = rail.locator('[data-slot="agent-tile"][data-picture="on"]');
    await expect(pictured).toHaveCount(on ? 1 : 0);
    await expect(rail.locator('[data-slot="agent-tile"]').first()).toBeVisible();
    await expect(page.locator('[data-slot="crossfade-out"]')).toHaveCount(0);
    const sizes = on ? await pictured.evaluate((tile) => [tile, ...tile.querySelectorAll("img, svg")].map((el) => Math.round(el.getBoundingClientRect().width))) : [];
    const read = await rail.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      buttons: [...el.querySelectorAll<HTMLElement>("button[data-pane-key]")].map((b) => {
        const r = b.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    }));
    await context.close();
    return { read, sizes };
  };
  const without = await measure(false);
  const withIt = await measure(true);
  expect(withIt.read).toEqual(without.read);
  expect(withIt.read.width).toBe(56);
  // The tile, the picture in it, and the corner logo: 28, 28 and 14 px.
  expect(withIt.sizes[0]).toBe(28);
  expect(withIt.sizes).toContain(14);
});
