import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { SessionSummary, SnapshotResponse } from "@/lib/types";
import { fixtureSnapshot } from "@/test/handlers";

import { fill, installApiStub } from "./fixtures/api";

// «возможность движения проектов на телефоне так и на десктопной версии чтобы проекты можно было как-то
// зажать и передвинуть где-то выше, где-то ниже ... все 5 рабочих проектов были бы сразу же наверху».
// The Sessions sheet in a real browser: real layout, a real scrolling sheet, a real mouse, and a finger
// through Chromium's own touch pipeline (CDP `Input.dispatchTouchEvent`), so `touch-action`, the sheet's
// scroll and its pull-to-dismiss all take part. The rules of the order are in
// src/lib/session-order.test.ts.
//
// Chromium phone project only: CDP has no WebKit, and the viewport of each case is its own.

test.use({ serviceWorkers: "block" });

test.beforeEach(({ context: _context }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "one Chromium run: CDP touch, each case names its viewport");
});

const DESKTOP = { viewport: { width: 1280, height: 800 }, hasTouch: false } as const;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true } as const;

const PROJECTS = Array.from({ length: 11 }, (_, i) => `proj-${String(i + 1).padStart(2, "0")}`);
const NAMES = ["default", ...PROJECTS];

/** A row with a count pill is tall enough that 12 of them overflow the sheet at both viewports. */
const summary = (name: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  name,
  isPrimary: name === "default",
  reachable: true,
  agents: 1,
  working: 1,
  blocked: 0,
  ...over,
});

const TWELVE = NAMES.map((name) => summary(name));

async function installSessions(page: Page, sessions: readonly SessionSummary[] = TWELVE) {
  await installApiStub(page);
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => {
      const snapshot: SnapshotResponse = { ...fixtureSnapshot, sessions: [...sessions] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) });
    },
  );
}

const sheet = (page: Page) => page.getByRole("dialog", { name: en["connection.session.title"] });
const listRows = (page: Page) => sheet(page).getByRole("listitem");
const grip = (page: Page, name: string) => sheet(page).getByRole("button", { name: `Move ${name}`, exact: true });

/** A row's own button. Its name starts with the session's; a grip's starts with "Move". */
const rowBody = (page: Page, name: string) => sheet(page).getByRole("button", { name: new RegExp(`^${name}`, "u") });
const rowOf = (page: Page, name: string) => listRows(page).filter({ hasText: name });

function pathOf(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

/** Opens the sheet from the home header and waits out its slide-in, so the boxes read are final. */
async function openSheet(page: Page) {
  await page.getByRole("button", { name: fill(en["connection.session.aria"], { name: "default" }) }).click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).evaluate(async (el) => {
    await Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished));
  });
}

/** The session rows as drawn, top to bottom. The All row must lead them, every time this is read. */
async function drawnOrder(page: Page): Promise<(string | undefined)[]> {
  const [all, ...rows] = await listRows(page).allTextContents();
  expect(all).toContain(en["connection.session.all"]);
  return rows.map((text) => NAMES.find((name) => text.includes(name)));
}

async function expectOrder(page: Page, expected: readonly string[]) {
  await expect.poll(() => drawnOrder(page)).toEqual(expected);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box");
  return box;
}

interface SheetMeasure {
  readonly scrollTop: number;
  readonly maxScroll: number;
  readonly top: number;
  readonly bottom: number;
  readonly listTop: number;
}

/** The sheet's scroller, found from the list up: whichever ancestor really scrolls. */
function measureSheet(page: Page): Promise<SheetMeasure> {
  return sheet(page)
    .getByRole("list")
    .evaluate((list) => {
      let el: HTMLElement | null = list.parentElement;
      while (el !== null && !(el.scrollHeight > el.clientHeight && /auto|scroll/u.test(getComputedStyle(el).overflowY))) {
        el = el.parentElement;
      }
      if (el === null) throw new Error("the sheet does not scroll");
      const rect = el.getBoundingClientRect();
      return {
        scrollTop: el.scrollTop,
        maxScroll: el.scrollHeight - el.clientHeight,
        top: rect.top,
        bottom: rect.bottom,
        listTop: list.getBoundingClientRect().top,
      };
    });
}

/** The session rows whole inside the sheet right now, as `grip` and `drawnOrder` name them. */
async function wholeRowsInView(page: Page): Promise<string[]> {
  const order = await drawnOrder(page);
  const { bottom } = await measureSheet(page);
  const inView: string[] = [];
  for (const name of order) {
    if (name === undefined) continue;
    const box = await boxOf(rowOf(page, name));
    if (box.y + box.height <= bottom) inView.push(name);
  }
  return inView;
}

interface Pointer {
  press(x: number, y: number): Promise<void>;
  moveTo(x: number, y: number): Promise<void>;
  release(): Promise<void>;
}

function mouse(page: Page): Pointer {
  return {
    press: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
    },
    moveTo: (x, y) => page.mouse.move(x, y),
    release: () => page.mouse.up(),
  };
}

/** One finger through Chromium's touch pipeline, as `pane-nav.touch.spec.ts` drives two. */
async function finger(page: Page): Promise<Pointer> {
  const cdp = await page.context().newCDPSession(page);
  const send = async (type: "touchStart" | "touchMove", x: number, y: number) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
  };
  return {
    press: (x, y) => send("touchStart", x, y),
    moveTo: (x, y) => send("touchMove", x, y),
    release: async () => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },
  };
}

/** A walk in small steps at about a frame each. `onStep` reads the page under the moving pointer. */
async function walk(
  page: Page,
  pointer: Pointer,
  from: { x: number; y: number },
  to: { x: number; y: number },
  onStep?: () => Promise<void>,
) {
  const steps = 14;
  for (let step = 1; step <= steps; step += 1) {
    await pointer.moveTo(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
    await page.waitForTimeout(16);
    await onStep?.();
  }
}

async function gripCentre(page: Page, name: string) {
  const box = await boxOf(grip(page, name));
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A press on the grip, a walk to the target's row and a release. The pointer stops in the half of the
 * row that lies ahead of the move, the half that means "this place" under any drop rule. A drag that
 * ends at the top holds there until the sheet is back at its top, the way a hand waits for an edge.
 */
async function dragGrip(page: Page, pointer: Pointer, name: string, target: string, onStep?: () => Promise<void>) {
  const from = await gripCentre(page, name);
  const row = await boxOf(rowOf(page, target));
  const up = row.y < from.y;
  const to = { x: from.x, y: row.y + row.height * (up ? 0.25 : 0.75) };
  await pointer.press(from.x, from.y);
  await walk(page, pointer, from, to, onStep);
  if (up) await expect.poll(async () => (await measureSheet(page)).scrollTop).toBe(0);
  await pointer.release();
}

/** The given order with these names lifted to its top, in this order. */
const withTop = (top: readonly string[], order: readonly string[] = NAMES) => [
  ...top,
  ...order.filter((name) => !top.includes(name)),
];

async function moveLastVisibleToTop(page: Page, pointer: Pointer): Promise<string> {
  const inView = await wholeRowsInView(page);
  const last = inView.at(-1);
  const first = inView[0];
  if (last === undefined || first === undefined) throw new Error("no row is in view");
  expect((await drawnOrder(page)).indexOf(last)).toBeLessThan(NAMES.length - 1);
  await dragGrip(page, pointer, last, first);
  return last;
}

async function expectSheetScrolls(page: Page) {
  const { maxScroll, scrollTop } = await measureSheet(page);
  expect(maxScroll).toBeGreaterThan(0);
  expect(scrollTop).toBe(0);
}

/** A drop is not a tap: the operator is still on the sheet, on the same page, ready for the next one. */
async function expectStillOnSheet(page: Page) {
  await expect(sheet(page)).toBeVisible();
  expect(pathOf(page)).toBe("/");
}

test.describe("with a mouse on the owner's laptop", () => {
  test.use(DESKTOP);

  test("@oracle:requirement @req:SES-9 the last visible row dragged to the top stays there through a reload and another page", async ({ context, page }) => {
    test.slow();
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);
    await expectSheetScrolls(page);

    const moved = await moveLastVisibleToTop(page, mouse(page));
    const once = withTop([moved]);
    await expectOrder(page, once);
    await expectStillOnSheet(page);

    // The next one follows at once: the owner has five to bring up, and the first stays below it.
    const inView = await wholeRowsInView(page);
    const second = inView.at(-1);
    if (second === undefined) throw new Error("no row is in view");
    await dragGrip(page, mouse(page), second, moved);
    const twice = withTop([second, moved]);
    await expectOrder(page, twice);
    await expectStillOnSheet(page);

    await page.reload();
    await openSheet(page);
    await expectOrder(page, twice);

    // Another page of the app and back, inside the app, with no load in between.
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await page.getByRole("button", { name: en["nav.settings.aria"], exact: true }).click();
    await expect.poll(() => pathOf(page)).toBe("/settings");
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe("/");
    await openSheet(page);
    await expectOrder(page, twice);

    // Another tab of this device reads the same order.
    const tab = await context.newPage();
    await installSessions(tab);
    await tab.goto("/");
    await openSheet(tab);
    await expectOrder(tab, twice);
  });

  test("@oracle:requirement @req:SES-7 an unreachable session moves by its grip while its body stays disabled", async ({ page }) => {
    const down = "proj-03";
    await installSessions(page, NAMES.map((name) => (name === down ? summary(name, { reachable: false, working: 0 }) : summary(name))));
    await page.goto("/");
    await openSheet(page);
    await expect(rowBody(page, down)).toBeDisabled();

    await dragGrip(page, mouse(page), down, "default");

    await expectOrder(page, withTop([down]));
    await expect(rowBody(page, down)).toBeDisabled();
    await expectStillOnSheet(page);
  });

  test("@oracle:requirement @req:SES-11 a mouse held at the sheet's bottom edge scrolls it, and the row lands below where the sheet first ended", async ({ page }) => {
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);
    await expectSheetScrolls(page);
    await dragToUnseenPlace(page, mouse(page));
  });
});

/**
 * The first row carried to the bottom edge and held still there. The hand does not move, so only the
 * sheet's own edge scroll can reach the rows below. The drop lands past every row seen at the start.
 */
async function dragToUnseenPlace(page: Page, pointer: Pointer) {
  const seen = await wholeRowsInView(page);
  const carried = seen[0];
  if (carried === undefined) throw new Error("no row is in view");
  const from = await gripCentre(page, carried);
  const { bottom } = await measureSheet(page);

  await pointer.press(from.x, from.y);
  await walk(page, pointer, from, { x: from.x, y: bottom - 24 });
  await expect.poll(async () => (await measureSheet(page)).scrollTop, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const { scrollTop, maxScroll } = await measureSheet(page);
        return maxScroll - scrollTop;
      },
      { timeout: 15_000 },
    )
    .toBeLessThanOrEqual(2);
  await pointer.release();

  await expect(sheet(page)).toBeVisible();
  await expect
    .poll(async () => (await drawnOrder(page)).indexOf(carried))
    .toBeGreaterThanOrEqual(seen.length);
  const after = await drawnOrder(page);
  expect(after.toSorted()).toEqual([...NAMES].toSorted());
  expect(pathOf(page)).toBe("/");
}

test.describe("with a finger on the phone", () => {
  test.use(PHONE);

  test("@oracle:requirement @req:SES-10 a finger on the grip carries a row to the top with the sheet still under it, and a reload keeps it", async ({ page }) => {
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);
    await expectSheetScrolls(page);

    // A row in the middle of the sheet, off both edges, so a scroll here could only be the finger's.
    const carried = "proj-05";
    const pointer = await finger(page);
    const scrolls: number[] = [];
    await dragGrip(page, pointer, carried, "default", async () => {
      scrolls.push((await measureSheet(page)).scrollTop);
    });

    expect(new Set(scrolls)).toEqual(new Set([0]));
    await expectOrder(page, withTop([carried]));
    await expectStillOnSheet(page);

    await page.reload();
    await openSheet(page);
    await expectOrder(page, withTop([carried]));

    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await page.getByRole("button", { name: en["nav.settings.aria"], exact: true }).click();
    await expect.poll(() => pathOf(page)).toBe("/settings");
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe("/");
    await openSheet(page);
    await expectOrder(page, withTop([carried]));
  });

  test("@oracle:requirement @req:SES-10 the last visible row reaches the top by a finger too", async ({ page }) => {
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);

    const moved = await moveLastVisibleToTop(page, await finger(page));

    await expectOrder(page, withTop([moved]));
    await expectStillOnSheet(page);
  });

  // The sheet closes on a pull down from its top, and a finger on a grip at the top of the sheet is
  // that same motion. The drag must win: the panel stays where it is and the sheet stays open.
  test("@oracle:requirement @req:SES-10 a finger dragging a row down from the sheet's top moves the row and does not pull the sheet closed", async ({ page }) => {
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);
    await expectSheetScrolls(page);

    const start = await measureSheet(page);
    const shifts: number[] = [];
    await dragGrip(page, await finger(page), "default", "proj-04", async () => {
      const now = await measureSheet(page);
      shifts.push(Math.abs(now.listTop - start.listTop), now.scrollTop);
    });

    expect(Math.max(...shifts)).toBeLessThanOrEqual(1);
    await expectStillOnSheet(page);
    await expectOrder(page, [...PROJECTS.slice(0, 4), "default", ...PROJECTS.slice(4)]);
  });

  test("@oracle:requirement @req:SES-10 a swipe on a row body scrolls the sheet and reorders nothing", async ({ page }) => {
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);
    await expectSheetScrolls(page);

    const body = await boxOf(rowBody(page, "proj-05"));
    const from = { x: body.x + 60, y: body.y + body.height / 2 };
    const pointer = await finger(page);
    await pointer.press(from.x, from.y);
    await walk(page, pointer, from, { x: from.x, y: from.y - 200 });
    await pointer.release();

    await expect.poll(async () => (await measureSheet(page)).scrollTop).toBeGreaterThan(50);
    await expectOrder(page, NAMES);
    await expectStillOnSheet(page);
  });

  test("@oracle:requirement @req:SES-11 a finger held at the sheet's bottom edge scrolls it, and the row lands below where the sheet first ended", async ({ page }) => {
    await installSessions(page);
    await page.goto("/");
    await openSheet(page);
    await expectSheetScrolls(page);
    await dragToUnseenPlace(page, await finger(page));
  });
});
