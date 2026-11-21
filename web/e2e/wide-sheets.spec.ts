import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { TranscriptEntry } from "@/lib/types";
import { fixtureKiroChat, fixtureKiroHistory, fixtureKiroSnapshot, KIRO_PANE_ID } from "@/test/handlers";

import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";

// ON A WIDE WINDOW A SHEET IS A CENTRED DIALOG (ADR 0167, addendum 2026-11-20). `BottomSheet` reads the
// window's width class: from 900px (expanded) its panel stands in the middle of the window with four round
// corners and no grab handle; below it, the bottom sheet is unchanged. jsdom lays nothing out, so a real
// engine checks the place, the corners, the fit in the window, Escape with the focus going back, and that
// a picture opens wider than the 640px column when its own pixels allow. Three real sheets: the pane menu
// of the pane screen, the Attachment view of a picture in Chat, and the dashboard row's Rename field.

test.use({ serviceWorkers: "block" });

const WIDE = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no app routes");
  // These cases set their own viewports; the tablet project would run each of them a second time.
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  await pinLocale(page, "en");
  await installApiStub(page);
});

/** A picture 1000 x 600 px of its own, as inline bytes the transcript may carry (`imageSrc`, lib/api.ts). */
const PICTURE_W = 1000;
const PICTURE = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_W}" height="600"><rect width="100%" height="100%" fill="#3a7"/></svg>`,
).toString("base64")}`;

/** Kiro's Chat with one more turn: the person sent a picture. */
function chatWithPicture(): typeof fixtureKiroChat {
  const last = fixtureKiroChat.upserts.at(-1)!;
  const picture: TranscriptEntry & { seq: number } = {
    uuid: "e2e-picture",
    ts: last.ts,
    role: "user",
    parts: [{ kind: "image", url: PICTURE }],
    seq: last.seq + 1,
  };
  return Object.assign({}, fixtureKiroChat, { head: picture.seq, upserts: [...fixtureKiroChat.upserts, picture] });
}

async function kiroPane(page: Page) {
  await installPaneWorld(page, {
    paneId: KIRO_PANE_ID,
    snapshot: fixtureKiroSnapshot,
    chat: chatWithPicture(),
    history: fixtureKiroHistory,
    screens: { idle: paneCapture("kiro--v3-idle-w120") },
    start: "idle",
  });
  await page.goto(`/pane/${encodeURIComponent(KIRO_PANE_ID)}`);
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The sheet's panel: the dialog's one child that holds the title row. */
const panelOf = (dialog: Locator) => dialog.locator("[data-presentation]");
const handleOf = (dialog: Locator) => dialog.locator('[data-slot="sheet-handle"]');

/** Centred on both axes within 1px, four round corners, no handle, inside the window with a margin. */
async function expectDialog(page: Page, dialog: Locator) {
  const panel = panelOf(dialog);
  await expect(panel).toHaveAttribute("data-presentation", "dialog");
  // The entrance's zoom is over before the box is read.
  await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);
  const b = await box(panel);
  const { width, height } = page.viewportSize()!;
  expect(Math.abs(b.x + b.width / 2 - width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y + b.height / 2 - height / 2)).toBeLessThanOrEqual(1);
  expect(b.x).toBeGreaterThanOrEqual(12);
  expect(b.y).toBeGreaterThanOrEqual(12);
  expect(b.y + b.height).toBeLessThanOrEqual(height - 12);
  const corners = await panel.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((r) => parseFloat(r));
  });
  for (const r of corners) expect(r).toBeGreaterThan(0);
  const edges = await panel.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth];
  });
  expect(edges).toEqual(["1px", "1px", "1px", "1px"]);
  await expect(handleOf(dialog)).toHaveCount(0);
  expect(await panel.evaluate((el) => el.style.transform)).toBe("");
  return b;
}

/** Stands on the bottom edge, with the handle: the phone's sheet, unchanged. */
async function expectBottomSheet(page: Page, dialog: Locator) {
  const panel = panelOf(dialog);
  await expect(panel).toHaveAttribute("data-presentation", "sheet");
  await expect(handleOf(dialog)).toHaveCount(1);
  await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);
  const b = await box(panel);
  expect(Math.abs(b.y + b.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
}

/** Escape closes the sheet and the focus goes back to the control that opened it. */
async function expectEscapeReturnsFocus(page: Page, dialog: Locator, opener: Locator) {
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
}

async function openPaneMenu(page: Page) {
  await kiroPane(page);
  const opener = page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true });
  await opener.focus();
  await opener.click();
  // The sheet is named by its title; the menu's History row is its mark.
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: en["chat.history.label"], exact: true }) });
  await expect(dialog).toBeVisible();
  return { dialog, opener };
}

async function openAttachment(page: Page) {
  await kiroPane(page);
  const opener = page.getByRole("button", { name: en["transcript.attachmentAlt"], exact: true });
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: en["transcript.attachmentAlt"] });
  await expect(dialog).toBeVisible();
  return { dialog, opener };
}

async function openRename(page: Page) {
  await page.goto("/");
  // The collie codex pane's own menu: a row's right-click is the hold's twin.
  const opener = page.getByRole("main").getByRole("button", { name: /^codex logo codex/u }).first();
  await opener.focus();
  await opener.click({ button: "right" });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: en["paneActions.rename.label"] }).click();
  const field = dialog.getByRole("textbox");
  await expect(field).toBeFocused();
  return { dialog, opener, field };
}

test.describe("at 1440 x 900 a sheet is a centred dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE);
  });

  test("the pane menu a row's right-click opens", async ({ page }) => {
    await page.goto("/");
    const opener = page.getByRole("main").getByRole("button", { name: /^codex logo codex/u }).first();
    await opener.focus();
    await opener.click({ button: "right" });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: en["paneActions.rename.label"] })).toBeVisible();
    await expectDialog(page, dialog);
    await expectEscapeReturnsFocus(page, dialog, opener);
  });

  test("the Attachment view opens the picture wider than the column, never past its own pixels", async ({ page }) => {
    const { dialog, opener } = await openAttachment(page);
    const panel = await expectDialog(page, dialog);
    const picture = await box(dialog.locator("img"));
    expect(picture.width).toBeGreaterThan(640);
    expect(picture.width).toBeLessThanOrEqual(PICTURE_W);
    // The picture is whole in the dialog: no scroll is needed to see it.
    expect(picture.y + picture.height).toBeLessThanOrEqual(panel.y + panel.height);
    expect(panel.width).toBeLessThanOrEqual(Math.min(0.92 * WIDE.width, 1200) + 1);
    await expectEscapeReturnsFocus(page, dialog, opener);
  });

  test("the rename field keeps the focus in a centred dialog", async ({ page }) => {
    const { dialog, opener, field } = await openRename(page);
    await expectDialog(page, dialog);
    await expect(field).toBeFocused();
    await expectEscapeReturnsFocus(page, dialog, opener);
  });
});

// THE ⋮ MENU OF A PANE OPENS BESIDE ITS BUTTON. A tap on the button that opened it makes the dialog a menu:
// under the button, inside the window, no dimming, no title row; a row works and Escape gives the focus back.
test.describe("at 1440 x 900 the pane's three-dots menu opens beside its button", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE);
  });

  test("beside the button, inside the window, nothing dimmed, no title row, Escape back to the button", async ({ page }) => {
    const { dialog, opener } = await openPaneMenu(page);
    const panel = panelOf(dialog);
    await expect(panel).toHaveAttribute("data-presentation", "menu");
    const b = await box(panel);
    const o = await box(opener);
    const { width, height } = page.viewportSize()!;
    // Below the button within 8px, its trailing edge on the button's.
    expect(b.y - (o.y + o.height)).toBeGreaterThanOrEqual(0);
    expect(b.y - (o.y + o.height)).toBeLessThanOrEqual(8);
    expect(Math.abs(b.x + b.width - (o.x + o.width))).toBeLessThanOrEqual(8);
    expect(b.x).toBeGreaterThanOrEqual(8);
    expect(b.y + b.height).toBeLessThanOrEqual(height - 8);
    expect(b.x + b.width).toBeLessThanOrEqual(width - 8);
    // The layer under it is clear: the page is not dimmed.
    const layer = dialog.locator('button[aria-hidden="true"]');
    expect(await layer.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await expect(dialog.locator('[data-slot="sheet-title-row"]')).toHaveCount(0);
    await expect(handleOf(dialog)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: en["common.closeAria"], exact: true })).toHaveCount(0);
    await expectEscapeReturnsFocus(page, dialog, opener);
  });

  test("a row of the menu works", async ({ page }) => {
    const { dialog } = await openPaneMenu(page);
    await expect(panelOf(dialog)).toHaveAttribute("data-presentation", "menu");
    await dialog.getByRole("button", { name: en["chat.history.label"], exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent(KIRO_PANE_ID)}/history$`, "u"));
  });
});

// A BUTTON SHOWS THAT ITS MENU IS OPEN (ui/button.tsx `TRIGGER_OPEN`). The three dots in a pane's header and the
// open tab wear the app's "on" look while their menu stands: a different fill, the same box, `aria-expanded`
// true. Escape gives the focus back to the button and the keyboard ring is drawn on it. jsdom reads no cascade,
// so the computed colours and the outline are read in a real engine.
interface Look {
  bg: string;
  box: number[];
  outlineStyle: string;
  outlineWidth: number;
  shadow: string;
}

async function lookOf(l: Locator): Promise<Look> {
  return l.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      bg: s.backgroundColor,
      box: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100),
      outlineStyle: s.outlineStyle,
      outlineWidth: parseFloat(s.outlineWidth),
      shadow: s.boxShadow,
    };
  });
}

/** The colour has finished its transition: two reads 60ms apart agree. */
async function settledLook(l: Locator): Promise<Look> {
  let last = await lookOf(l);
  for (let i = 0; i < 20; i += 1) {
    await l.page().waitForTimeout(60);
    const next = await lookOf(l);
    if (next.bg === last.bg) return next;
    last = next;
  }
  return last;
}

/** A ring the keyboard can see: an outline that is drawn, or a shadow. */
function expectRing(look: Look) {
  const outlined = look.outlineStyle !== "none" && look.outlineWidth > 0;
  expect(outlined || look.shadow !== "none").toBe(true);
}

test.describe("at 1440 x 900 a button shows that its menu is open", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE);
  });

  test("the three dots light up while the menu is open, keep their box, and take the ring back on Escape", async ({ page }) => {
    await kiroPane(page);
    const opener = page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true });
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(2, 2);
    const rest = await settledLook(opener);
    await opener.click();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: en["chat.history.label"], exact: true }) });
    await expect(dialog).toBeVisible();
    // The pointer still rests on the button: the open fill wins over the hover fill.
    const open = await settledLook(opener);
    expect(open.bg).not.toBe(rest.bg);
    expect(open.box).toEqual(rest.box);
    await page.mouse.move(2, 2);
    const apart = await settledLook(opener);
    expect(apart.bg).toBe(open.bg);
    await expectEscapeReturnsFocus(page, dialog, opener);
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    const back = await settledLook(opener);
    expect(back.box).toEqual(rest.box);
    expectRing(back);
  });

  test("the open tab lights up while its menu is open, keeps its box, and takes the ring back on Escape", async ({ page }) => {
    await kiroPane(page);
    const strip = page.getByRole("navigation", { name: en["space.tabStrip.title"] });
    const tab = strip.locator('button[aria-current="true"]').first();
    await expect(tab).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(2, 2);
    const rest = await settledLook(tab);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-expanded", "true");
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: en["space.tab.rename"], exact: true }) });
    await expect(dialog).toBeVisible();
    const open = await settledLook(tab);
    expect(open.bg).not.toBe(rest.bg);
    expect(open.box).toEqual(rest.box);
    await page.mouse.move(2, 2);
    expect((await settledLook(tab)).bg).toBe(open.bg);
    await expectEscapeReturnsFocus(page, dialog, tab);
    await expect(tab).toHaveAttribute("aria-expanded", "false");
    const back = await settledLook(tab);
    expect(back.box).toEqual(rest.box);
    expectRing(back);
  });
});

test.describe("at 390 x 844 the same sheets stay bottom sheets with the handle", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test("the pane menu", async ({ page }) => {
    const { dialog } = await openPaneMenu(page);
    await expectBottomSheet(page, dialog);
  });

  test("the three dots show the open look while the bottom sheet is open", async ({ page }) => {
    await kiroPane(page);
    const opener = page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true });
    const rest = await settledLook(opener);
    await opener.click();
    await expectBottomSheet(page, page.getByRole("dialog").filter({ has: page.getByRole("button", { name: en["chat.history.label"], exact: true }) }));
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    const open = await settledLook(opener);
    expect(open.bg).not.toBe(rest.bg);
    expect(open.box).toEqual(rest.box);
  });

  test("the Attachment view", async ({ page }) => {
    const { dialog } = await openAttachment(page);
    await expectBottomSheet(page, dialog);
  });

  test("the rename field", async ({ page }) => {
    const { dialog } = await openRename(page);
    await expectBottomSheet(page, dialog);
  });
});

// A PHONE FRAME IN A WIDE WINDOW KEEPS THE BOTTOM SHEET. The design reference (and the website, the same way)
// draws the app in phone frames in the page, no iframe; a frame's transform makes it the containing block of
// the sheet's fixed layer. The window is expanded, the layer's room is a phone's, so the sheet is a bottom
// sheet inside the frame. Card 4 of the Pinned messages section opens its actions sheet at rest.
test("at 1440 x 900 a sheet in a phone frame of the design reference is a bottom sheet inside the frame", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto("http://127.0.0.1:4176/design.html#pins/pins-block-actions");
  const card = page.locator('[data-state="pins-block-actions"]');
  const frame = card.locator("[data-pg-frame]");
  const dialog = frame.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expectBottomSheetIn(dialog, await box(frame));
});

/** A bottom sheet with its handle, its panel standing on the frame's bottom edge and inside its sides. */
async function expectBottomSheetIn(dialog: Locator, frame: { x: number; y: number; width: number; height: number }) {
  const panel = panelOf(dialog);
  await expect(panel).toHaveAttribute("data-presentation", "sheet");
  await expect(handleOf(dialog)).toHaveCount(1);
  await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);
  const b = await box(panel);
  expect(b.x).toBeGreaterThanOrEqual(frame.x - 1);
  expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  expect(Math.abs(b.y + b.height - (frame.y + frame.height))).toBeLessThanOrEqual(2);
}
