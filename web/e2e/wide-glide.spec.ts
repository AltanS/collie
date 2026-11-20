import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { PRESET_FRACTION, restingScroll, stripGeometry, type Preset } from "@/lib/wide-layout";
import type { AgentView, PaneChatResponse } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureSnapshot } from "@/test/handlers";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// A PANE'S WIDTH CHANGE GLIDES (wide-layout.tsx, hooks/use-width-glide.ts). A tap on a column's width
// button used to change its basis in one frame: the column, its neighbours and the add column jumped,
// and the strip scrolled after them. Now the widths and the scroll travel together on one 240 ms
// ease-out, and they come to rest exactly where the jump put them. Only an engine lays the strip out,
// so a `requestAnimationFrame` sampler (DESIGN.md §2) records, per frame, the cycled column's width,
// its right neighbour's left edge, the add column's left edge and the strip's `scrollLeft`.
//
// 1440 x 900 with the sidebar open: the strip is 1440 - 320 = 1120px, so 1/2 is 560, 4/5 is 896 and
// the add column is never under 440. Every case runs twice, once gliding and once with reduced
// motion, and the two must rest on the same geometry.

test.use({ serviceWorkers: "block" });

const VIEW = { width: 1440, height: 900 } as const;
const STRIP = 1120;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "a large-screen case, run once in Chromium");
  await installApiStub(page);
  await page.setViewportSize(VIEW);
});

// Space w2 holds w2:p1 (codex), w2:p2 (a shell) and, here, a third agent w2:p3, the focused column of
// every case: an agent pane draws its Chat, a shell its terminal.
const base = fixtureSnapshot.agents.find((a) => a.paneId === "w2:p1")!;
const third: AgentView = Object.assign({}, base, { paneId: "w2:p3", focused: false, status: "idle", hasSession: true } as const);
const snapshot = { ...fixtureSnapshot, agents: [...fixtureSnapshot.agents, third] };

/** A long chat in every pane, so a frame of the glide lays out a real transcript. */
function longChat(paneId: string): PaneChatResponse {
  const words = "The strip lays out every column on each frame of the glide, so a long chat is what it costs. ";
  const upserts = Array.from({ length: 240 }, (_, i) => ({
    uuid: `g${i}`,
    ts: new Date(Date.UTC(2026, 10, 20, 8, 0, i)).toISOString(),
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ kind: "text" as const, text: `${i}: ${words.repeat(1 + (i % 5))}` }],
    seq: FIXTURE_SEQ_BASE + i,
  }));
  return {
    paneId,
    available: true,
    page: "live",
    gen: FIXTURE_CHAT_GEN,
    rev: 1,
    head: FIXTURE_SEQ_BASE + upserts.length - 1,
    oldest: FIXTURE_SEQ_BASE,
    hasOlder: false,
    upserts,
  };
}

async function installWorld(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/chat$/.test(url.pathname),
    (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? "");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(longChat(id)) });
    },
  );
}

const paneUrl = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;
const LAYOUT_KEY = "collie:wide-layout:v1";

/**
 * Open a strip of these columns with `focus` in focus. The first visit writes the space's own strip,
 * so the keys come from the app (the pane's full address), never re-typed here.
 */
async function openStrip(page: Page, cols: readonly (readonly [string, Preset])[], focus: string, reduced: boolean): Promise<void> {
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await installWorld(page);
  await page.goto(paneUrl("w2:p1"));
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(1);
  await page.evaluate(
    (arg) => {
      type Stored = { cols: { key: string; preset: string }[]; focus: string | null };
      // SAFETY: the app wrote this entry on the visit just above, in this shape (lib/wide-layout-store.ts).
      const stored = JSON.parse(localStorage.getItem(arg.key) ?? "{}") as Record<string, Stored>;
      const [space, strip] = Object.entries(stored).find(([, s]) => s.cols.some((c) => c.key.endsWith("w2:p1")))!;
      const first = strip.cols[0]!.key;
      const keyOf = (paneId: string) => first.slice(0, first.length - "w2:p1".length) + paneId;
      stored[space] = { cols: arg.cols.map(([paneId, preset]) => ({ key: keyOf(paneId), preset })), focus: keyOf(arg.focus) };
      localStorage.setItem(arg.key, JSON.stringify(stored));
    },
    { key: LAYOUT_KEY, cols, focus },
  );
  await page.goto(paneUrl(focus));
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(cols.length);
  await expect(page.locator("section[data-focused] [data-slot='column-width']")).toBeVisible();
  // The long chat is drawn, so a frame of the glide lays it out.
  await expect(page.locator("section[data-focused]")).toContainText("239: The strip");
  await installSampler(page);
  await rest(page);
}

interface Geometry {
  lefts: number[];
  widths: number[];
  addLeft: number;
  scrollLeft: number;
  focus: string | null;
  focusWhole: boolean;
}

interface Sample {
  t: number;
  width: number;
  /** The right neighbour's left edge, and the add column's, in scroll coordinates. */
  neighbour: number;
  add: number;
  scroll: number;
  /** What a tap at the width button's first place would hit now. */
  hit: string;
  /** The width button's left edge on screen. */
  button: number;
}

declare global {
  interface Window {
    __geometry: () => Geometry;
    __rest: () => Promise<Geometry>;
    __record: (index: number, point: { x: number; y: number }) => void;
    __recorded: () => Promise<Sample[]>;
  }
}

/** The page side: read the strip, wait for it to rest, and record frames. */
async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stripSelector = '[data-slot="wide-layout"] [data-slot="strip"]';
    const strip = () => document.querySelector<HTMLElement>(stripSelector)!;
    window.__geometry = () => {
      const node = strip();
      const box = node.getBoundingClientRect();
      const cols = [...node.querySelectorAll<HTMLElement>("[data-col-index]")].map((c) => c.getBoundingClientRect());
      const add = node.querySelector<HTMLElement>('[data-slot="add-column"]')!.getBoundingClientRect();
      const focused = node.querySelector<HTMLElement>("section[data-focused]");
      const f = focused?.getBoundingClientRect();
      // In scroll coordinates, to the tenth of a pixel.
      const at = (x: number) => Math.round((x - box.left + node.scrollLeft) * 10) / 10;
      return {
        lefts: cols.map((c) => at(c.left)),
        widths: cols.map((c) => Math.round(c.width * 10) / 10),
        addLeft: at(add.left),
        scrollLeft: Math.round(node.scrollLeft * 10) / 10,
        focus: focused?.dataset.colKey ?? null,
        focusWhole: f !== undefined && f.left >= box.left - 1 && f.right <= box.right + 1,
      };
    };
    // At rest: the geometry has not changed for 20 frames in a row (no fixed sleep).
    window.__rest = () =>
      new Promise((done) => {
        let last = "";
        let same = 0;
        const t0 = performance.now();
        const tick = () => {
          const geometry = window.__geometry();
          const g = JSON.stringify(geometry);
          same = g === last ? same + 1 : 0;
          last = g;
          if (same >= 20 || performance.now() - t0 > 5000) done(geometry);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    let samples: Sample[] = [];
    let finished: Promise<Sample[]> = Promise.resolve([]);
    window.__record = (index, point) => {
      samples = [];
      finished = new Promise((done) => {
        let last = "";
        let same = 0;
        const t0 = performance.now();
        const tick = (t: number) => {
          const node = strip();
          const cols = [...node.querySelectorAll<HTMLElement>("[data-col-index]")];
          const col = cols[index]!;
          const next = cols[index + 1] ?? node.querySelector<HTMLElement>('[data-slot="add-column"]')!;
          const add = node.querySelector<HTMLElement>('[data-slot="add-column"]')!;
          const hitEl = document.elementFromPoint(point.x, point.y);
          const hit = hitEl?.closest<HTMLElement>("button")?.getAttribute("aria-label") ?? hitEl?.closest<HTMLElement>("[data-slot]")?.dataset.slot ?? "none";
          const button = document.querySelector<HTMLElement>("section[data-focused] [data-slot='column-width'], [data-slot='header-dock-trail'] [data-slot='column-width']");
          // The edges in scroll coordinates: the layout itself, apart from where the strip is scrolled.
          const origin = node.getBoundingClientRect().left - node.scrollLeft;
          const s: Sample = {
            t,
            width: col.getBoundingClientRect().width,
            neighbour: next.getBoundingClientRect().left - origin,
            add: add.getBoundingClientRect().left - origin,
            scroll: node.scrollLeft,
            hit: node.hasAttribute("data-gliding") ? `${hit} (held)` : hit,
            button: button?.getBoundingClientRect().left ?? Number.NaN,
          };
          samples.push(s);
          const key = JSON.stringify([s.width, s.neighbour, s.add, s.scroll]);
          same = key === last ? same + 1 : 0;
          last = key;
          if ((same >= 20 && samples.length > 25) || performance.now() - t0 > 5000) done(samples);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    };
    window.__recorded = () => finished;
  });
}

const rest = (page: Page) => page.evaluate(() => window.__rest());

/** The focused column's width button, docked in the header over the column. */
const widthButton = (page: Page) => page.locator("[data-slot='header-dock-trail'] [data-slot='column-width']");

interface Run {
  before: Geometry;
  after: Geometry;
  samples: Sample[];
  url: string;
}

/** Tap the focused column's width button `taps` times (a second tap `gapMs` after the first), record. */
async function cycleFocused(page: Page, index: number, taps: 1 | 2, gapMs = 80): Promise<Run> {
  const before = await rest(page);
  const box = (await widthButton(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate((arg) => window.__record(arg.index, arg.point), { index, point });
  await page.mouse.click(point.x, point.y);
  if (taps === 2) {
    await page.waitForTimeout(gapMs);
    // Wherever the button is now: the second press of the same control, mid-glide.
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-slot='header-dock-trail'] [data-slot='column-width']")!.click());
  }
  const samples = await page.evaluate(() => window.__recorded());
  const after = await rest(page);
  return { before, after, samples, url: page.url() };
}

/** How many distinct values a series takes, to the half pixel. */
function distinct(xs: readonly number[]): number {
  return new Set(xs.map((x) => Math.round(x * 2) / 2)).size;
}

function expectMonotonic(xs: readonly number[], name: string): void {
  const first = xs[0]!;
  const last = xs.at(-1)!;
  const up = last >= first;
  for (let i = 1; i < xs.length; i += 1) {
    const step = xs[i]! - xs[i - 1]!;
    expect(up ? step : -step, `${name} reverses at frame ${i}: ${xs[i - 1]} to ${xs[i]}`).toBeGreaterThanOrEqual(-0.5);
  }
  const lo = Math.min(first, last) - 0.5;
  const hi = Math.max(first, last) + 0.5;
  for (const x of xs) expect(x, `${name} leaves the span ${first} to ${last}`).toBeGreaterThanOrEqual(lo);
  for (const x of xs) expect(x, `${name} leaves the span ${first} to ${last}`).toBeLessThanOrEqual(hi);
}

type Series = "width" | "neighbour" | "add" | "scroll";

/** The frame-to-frame steps of a series, from its first move to its last. */
function motion(run: Run, series: Series): number[] {
  const xs = run.samples.map((s) => s[series]);
  const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]!));
  const first = steps.findIndex((d) => d > 0.5);
  const last = steps.findLastIndex((d) => d > 0.5);
  return first < 0 ? [] : steps.slice(first, last + 1);
}

/** A spring from rest: the fastest step comes in the first third of the motion, and the steps of the
 *  last third are smaller than those of the first, not a constant speed. */
function expectSpring(run: Run, series: Series): void {
  const steps = motion(run, series);
  expect(steps.length, `${series} moves over frames`).toBeGreaterThanOrEqual(6);
  const fastest = steps.indexOf(Math.max(...steps));
  const share = Math.ceil(steps.length / 3);
  expect(fastest, `${series}: the fastest step, of ${steps.map((d) => d.toFixed(1)).join(" ")}`).toBeLessThan(share);
  expect(mean(steps.slice(-share)), `${series} slows toward its end`).toBeLessThan(mean(steps.slice(0, share)) / 2);
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function expectGlide(run: Run, moving: readonly Series[], fromRest: boolean): void {
  for (const series of ["width", "neighbour", "add", "scroll"] as const) {
    const xs = run.samples.map((s) => s[series]);
    expectMonotonic(xs, series);
    // A glide: a run of eased values between the two ends, not a jump of two.
    if (moving.includes(series)) expect(distinct(xs), `${series} glides`).toBeGreaterThanOrEqual(6);
    else expect(distinct(xs), `${series} stays`).toBe(1);
  }
  // The widths, the neighbours and the scroll move on one clock: they all start on the same frame. (Each
  // has its own spring, so a short one comes to rest before a long one.)
  const firstMove = (series: Series) => {
    const xs = run.samples.map((s) => s[series]);
    return xs.findIndex((x, i) => i > 0 && Math.abs(x - xs[i - 1]!) > 0.5);
  };
  const starts = moving.map(firstMove);
  expect(Math.max(...starts) - Math.min(...starts), "every series starts on the same frame, give or take one").toBeLessThanOrEqual(1);
  if (fromRest) for (const series of moving) expectSpring(run, series);
}

/** With reduced motion each tap is one jump: at most one value more than there were taps. */
function expectJump(run: Run, taps: number): void {
  for (const series of ["width", "neighbour", "add", "scroll"] as const) {
    expect(distinct(run.samples.map((s) => s[series])), `${series} jumps with reduced motion`).toBeLessThanOrEqual(taps + 1);
  }
}

/** The longest frame of the glide, in ms: the gaps between the sampler's frames while anything moved. */
function longestFrame(run: Run): number {
  let longest = 0;
  for (let i = 1; i < run.samples.length; i += 1) {
    const a = run.samples[i - 1]!;
    const b = run.samples[i]!;
    if (a.width === b.width && a.scroll === b.scroll && a.add === b.add && i > 3) continue;
    longest = Math.max(longest, b.t - a.t);
  }
  return Math.round(longest * 10) / 10;
}

/** What a tap at the width button's first place hit, frame by frame, as the times it changed. */
function timeline(run: Run): string {
  const t0 = run.samples[0]!.t;
  const out: string[] = [];
  let last = "";
  for (const s of run.samples) {
    if (s.hit === last) continue;
    last = s.hit;
    out.push(`+${Math.round(s.t - t0)}ms ${s.hit}`);
  }
  return out.join(" | ");
}

/** The resting geometry, as `lib/wide-layout.ts` computes it before anything moves. */
function predicted(fractions: readonly number[], focusAt: number, scrollLeft: number) {
  const g = stripGeometry(fractions, STRIP, true);
  return { lefts: g.lefts, widths: g.widths, addLeft: g.contentWidth - g.addWidth, scrollLeft: restingScroll(g, focusAt, scrollLeft, STRIP) };
}

function expectSameRest(glided: Geometry, jumped: Geometry): void {
  expect(glided.lefts).toEqual(jumped.lefts);
  expect(glided.widths).toEqual(jumped.widths);
  expect(glided.addLeft).toBe(jumped.addLeft);
  expect(Math.abs(glided.scrollLeft - jumped.scrollLeft)).toBeLessThanOrEqual(0.5);
  expect(glided.focus).toBe(jumped.focus);
  expect(glided.focusWhole).toBe(jumped.focusWhole);
}

const HALF = PRESET_FRACTION.half;
const FOUR = PRESET_FRACTION.fourfifths;
const FULL = PRESET_FRACTION.full;

for (const c of [
  {
    name: "grow the last column, 1/2 to 4/5: it grows, the add column moves, the strip scrolls to its start",
    cols: [
      ["w2:p1", "half"],
      ["w2:p3", "half"],
    ] as const,
    focus: "w2:p3",
    index: 1,
    taps: 1 as const,
    moving: ["width", "neighbour", "add", "scroll"] as const,
    end: [HALF, FOUR],
  },
  {
    name: "shrink the last column, Full to 1/2: it shrinks and the add column follows, the strip stays",
    cols: [
      ["w2:p1", "half"],
      ["w2:p3", "full"],
    ] as const,
    focus: "w2:p3",
    index: 1,
    taps: 1 as const,
    moving: ["width", "neighbour", "add"] as const,
    end: [HALF, HALF],
  },
  {
    name: "grow the first column in view while the strip is scrolled right: its neighbours move, the strip stays",
    cols: [
      ["w2:p1", "half"],
      ["w2:p3", "half"],
      ["w2:p2", "half"],
    ] as const,
    focus: "w2:p3",
    index: 1,
    taps: 1 as const,
    scrollTo: 560,
    moving: ["width", "neighbour", "add"] as const,
    end: [HALF, FOUR, HALF],
  },
  {
    name: "a quick second tap, 1/2 to 4/5 to Full: the motion goes on to the new end, never back",
    cols: [
      ["w2:p1", "half"],
      ["w2:p3", "half"],
    ] as const,
    focus: "w2:p3",
    index: 1,
    taps: 2 as const,
    moving: ["width", "neighbour", "add", "scroll"] as const,
    end: [HALF, FULL],
  },
]) {
  test(`a width change glides: ${c.name}`, async ({ page, browser }) => {
    test.setTimeout(90_000);
    await openStrip(page, c.cols, c.focus, false);
    if (c.scrollTo !== undefined) {
      await page.locator('[data-slot="strip"]').evaluate((el, x) => el.scrollTo({ left: x, behavior: "auto" }), c.scrollTo);
      await rest(page);
    }
    const glided = await cycleFocused(page, c.index, c.taps);

    // The same act on a device that reduces motion, in a page of its own.
    const context = await browser.newContext({ viewport: VIEW, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block", baseURL: new URL(page.url()).origin });
    const other = await context.newPage();
    await installApiStub(other);
    await openStrip(other, c.cols, c.focus, true);
    if (c.scrollTo !== undefined) {
      await other.locator('[data-slot="strip"]').evaluate((el, x) => el.scrollTo({ left: x, behavior: "auto" }), c.scrollTo);
      await rest(other);
    }
    // The reduced run taps the second time only after the first change landed, as a jump allows.
    const jumped = await cycleFocused(other, c.index, c.taps, 150);
    await context.close();

    // Where it started is the same in both runs, so the two ends can be compared.
    expectSameRest(glided.before, jumped.before);
    expectGlide(glided, c.moving, c.taps === 1);
    expectJump(jumped, c.taps);
    expectSameRest(glided.after, jumped.after);

    // The focus is where it was, and the URL with it.
    expect(glided.after.focus).toBe(glided.before.focus);
    expect(new URL(glided.url).pathname).toBe(paneUrl(c.focus));
    expect(glided.after.focusWhole).toBe(true);

    // The end the glide computed before anything moved is the end the page measures.
    const want = predicted(c.end, c.index, glided.before.scrollLeft);
    expect(glided.after.lefts).toEqual(want.lefts);
    expect(glided.after.widths).toEqual(want.widths);
    expect(glided.after.addLeft).toBe(want.addLeft);
    expect(Math.abs(glided.after.scrollLeft - want.scrollLeft)).toBeLessThanOrEqual(0.5);

    // For the report: the longest frame, and what a tap at the button's first place hit on each frame.
    console.log(
      `[glide] ${c.name}\n  frames=${glided.samples.length} longest=${longestFrame(glided)}ms scroll ${glided.before.scrollLeft} -> ${glided.after.scrollLeft}` +
        `\n  glide tap point: ${timeline(glided)}\n  jump tap point:  ${timeline(jumped)}` +
        `\n  button left: ${Math.round(glided.samples[0]!.button)} -> ${Math.round(glided.samples.at(-1)!.button)}`,
    );
  });
}

test("a window resize does not glide: the columns follow the window in one step", async ({ page }) => {
  await openStrip(
    page,
    [
      ["w2:p1", "half"],
      ["w2:p3", "half"],
    ],
    "w2:p3",
    false,
  );
  await page.evaluate(() => window.__record(1, { x: 0, y: 0 }));
  await page.setViewportSize({ width: 1600, height: VIEW.height });
  const samples = await page.evaluate(() => window.__recorded());
  // The column's basis is a share of the strip, so it follows the window; the width settles in at most
  // two distinct values after the resize (no run of eased ones).
  expect(distinct(samples.map((s) => s.width))).toBeLessThanOrEqual(2);
  expect(distinct(samples.map((s) => s.add))).toBeLessThanOrEqual(2);
});

test("a second tap that lands on Remove from view while the button glides away is dropped", async ({ page }) => {
  await openStrip(
    page,
    [
      ["w2:p1", "half"],
      ["w2:p3", "half"],
    ],
    "w2:p3",
    false,
  );
  const box = (await widthButton(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(point.x, point.y);
  // Wait, frame by frame, until the column's Remove from view has slid under the point, then tap there.
  const under = await page.evaluate(
    (arg) =>
      new Promise<string>((done) => {
        const t0 = performance.now();
        const tick = () => {
          const hit = document.elementFromPoint(arg.point.x, arg.point.y)?.closest("button")?.getAttribute("aria-label") ?? "";
          if (hit === arg.label || performance.now() - t0 > 1000) done(hit);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { point, label: en["wide.removeFromView"] },
  );
  expect(under).toBe(en["wide.removeFromView"]);
  await page.mouse.click(point.x, point.y);
  await rest(page);
  // Both columns stand, the focus stayed, and the width is the one the first tap chose.
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(2);
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent("w2:p3")}$`));
  await expect(widthButton(page)).toHaveAccessibleName(en["wide.width.aria"].replace("{width}", "4/5"));
});

// TOUCH. On a touchscreen a second tap on the width button starts with a `touchstart` on the strip
// while the first glide runs. A finger that only taps must not take the scroll from the glide; only one
// that moves past the tap slop does. And a width act after the person scrolled takes the scroll back.

/** The width button's centre and whether a glide runs, read in one go. */
function buttonNow(page: Page) {
  return page.evaluate(() => {
    const b = document.querySelector<HTMLElement>("[data-slot='header-dock-trail'] [data-slot='column-width']")!.getBoundingClientRect();
    return {
      x: b.left + b.width / 2,
      y: b.top + b.height / 2,
      gliding: document.querySelector('[data-slot="strip"]')!.hasAttribute("data-gliding"),
      label: document.querySelector("[data-slot='header-dock-trail'] [data-slot='column-width']")!.getAttribute("aria-label"),
    };
  });
}

/** Tap the width button with a finger, `then` act in between, and tap it again where it is now. */
async function touchTwice(page: Page, gapMs: number, between?: () => Promise<void>): Promise<{ rest: Geometry; glidingAtSecond: boolean; samples: Sample[] }> {
  await rest(page);
  await cdpOf(page);
  const first = await buttonNow(page);
  await page.evaluate(() => window.__record(1, { x: 0, y: 0 }));
  await fingerTap(page, first.x, first.y);
  // The tap's click has landed: a glide runs, or (reduced motion) the width changed.
  await page.waitForFunction((before) => document.querySelector("[data-slot='header-dock-trail'] [data-slot='column-width']")?.getAttribute("aria-label") !== before, first.label, { polling: "raf" });
  await page.waitForTimeout(gapMs);
  if (between !== undefined) await between();
  const second = await buttonNow(page);
  await fingerTap(page, second.x, second.y);
  const samples = await page.evaluate(() => window.__recorded());
  return { rest: await rest(page), glidingAtSecond: second.gliding, samples };
}

/** A finger tap as the touchscreen sends it, a touchstart and a touchend, without
 *  `page.touchscreen.tap`'s wait for the page, so a tap can come down mid-glide. */
async function fingerTap(page: Page, x: number, y: number): Promise<void> {
  const cdp = await cdpOf(page);
  // Both sent at once (one session keeps the order), so the finger comes down a round trip sooner.
  await Promise.all([
    cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }),
    cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
  ]);
}

const sessions = new WeakMap<Page, CDPSession>();
/** One CDP session per page, opened before the act, so no touch waits for a session to open. */
async function cdpOf(page: Page): Promise<CDPSession> {
  const had = sessions.get(page);
  if (had !== undefined) return had;
  const cdp = await page.context().newCDPSession(page);
  sessions.set(page, cdp);
  return cdp;
}

/** Wait, frame by frame, until the gliding width button moves under 8 px a frame, late in the glide,
 *  so a finger lands on it where it was read. False when the glide ended first. */
function slowButton(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((done) => {
        const strip = document.querySelector('[data-slot="strip"]')!;
        const left = () => strip.closest('[data-slot="wide-layout"]')!.querySelector("[data-slot='header-dock-trail'] [data-slot='column-width']")!.getBoundingClientRect().left;
        let last = left();
        let moved = false;
        const tick = () => {
          if (!strip.hasAttribute("data-gliding")) return done(false);
          const now = left();
          const step = Math.abs(now - last);
          last = now;
          if (step > 8) moved = true;
          if (moved && step < 8) return done(true);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * A finger that scrolls the strip to `to`: a touchstart, touchmoves past the tap slop and a touchend
 * dispatched on the strip, with the scroll that finger makes, in one task. A swipe through the engine's
 * own touch pipeline takes about 400 ms in headless Chromium, longer than the glide it must land inside.
 * `to` is a column start, so the snap that comes back at rest moves nothing under the second tap.
 */
async function swipe(page: Page, to: number): Promise<void> {
  await page.evaluate((target) => {
    const strip = document.querySelector<HTMLElement>('[data-slot="strip"]')!;
    const from = strip.scrollLeft;
    const touch = (x: number) => new Touch({ identifier: 1, target: strip, clientX: x, clientY: 500 });
    const fire = (type: string, x: number) =>
      strip.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch(x)], changedTouches: [touch(x)] }));
    const dx = target - from;
    fire("touchstart", 900);
    fire("touchmove", 900 - dx / 2);
    strip.scrollLeft = from + dx / 2;
    fire("touchmove", 900 - dx);
    strip.scrollLeft = target;
    fire("touchend", 900 - dx);
  }, to);
}

/** The strip's scroll on the next `frames` frames. */
function scrollOverFrames(page: Page, frames: number): Promise<number[]> {
  return page.evaluate(
    (n) =>
      new Promise<number[]>((done) => {
        const strip = document.querySelector<HTMLElement>('[data-slot="strip"]')!;
        const out: number[] = [];
        const tick = () => {
          out.push(strip.scrollLeft);
          if (out.length >= n) done(out);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

async function reducedPage(page: Page, browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ viewport: VIEW, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block", baseURL: new URL(page.url()).origin });
  const other = await context.newPage();
  await installApiStub(other);
  return { context, other };
}

const TWO = [
  ["w2:p1", "half"],
  ["w2:p3", "half"],
] as const;

test("a touch double tap on the width button rests where the reduced-motion double tap rests", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await openStrip(page, TWO, "w2:p3", false);
  // Late in the glide, where the button moves slowly, so the finger lands on it where it was read.
  const glided = await touchTwice(page, 0, async () => {
    await slowButton(page);
  });
  // The second finger came down while the first glide ran, or this case proves nothing.
  expect(glided.glidingAtSecond).toBe(true);

  const { context, other } = await reducedPage(page, browser);
  await openStrip(other, TWO, "w2:p3", true);
  const jumped = await touchTwice(other, 200);
  await context.close();

  expectSameRest(glided.rest, jumped.rest);
  // No series reverses across the two glides. Which half of the scroll the second glide drives
  // depends on when the finger lands, so the claim that a tap does not free the scroll is held frame by
  // frame in src/hooks/use-width-glide.test.tsx, where the clock is the test's.
  for (const series of ["width", "neighbour", "add", "scroll"] as const) expectMonotonic(glided.samples.map((x) => x[series]), series);
  expect(glided.rest.widths).toEqual([560, 1120]);
  expect(glided.rest.scrollLeft).toBe(560);
  await expect(widthButton(page)).toHaveAccessibleName(en["wide.width.aria"].replace("{width}", en["wide.width.full"]));
});

test("a swipe during a glide, then a width tap: it rests where reduced motion rests for the same acts", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await openStrip(page, TWO, "w2:p3", false);
  // The swipe early in the glide, ahead of where the glide's scroll stands; the second tap late in it,
  // where the button moves slowly.
  let held: number[] = [];
  let early = -1;
  const glided = await touchTwice(page, 0, async () => {
    early = await page.locator('[data-slot="strip"]').evaluate((el) => el.scrollLeft);
    await swipe(page, 560);
    // The finger has the scroll: the glide no longer writes it, while the widths go on.
    held = await scrollOverFrames(page, 3);
    await slowButton(page);
  });
  expect(glided.glidingAtSecond).toBe(true);
  expect(early).toBeLessThan(500);
  expect(held).toEqual([560, 560, 560]);

  const { context, other } = await reducedPage(page, browser);
  await openStrip(other, TWO, "w2:p3", true);
  const jumped = await touchTwice(other, 20, async () => {
    await swipe(other, 560);
    await rest(other);
  });
  await context.close();

  expectSameRest(glided.rest, jumped.rest);
  expect(glided.rest.focus).toBe(jumped.rest.focus);
  console.log(`[glide] swipe at scroll ${early} to 560, then tap: rest scroll ${glided.rest.scrollLeft} (reduced ${jumped.rest.scrollLeft})`);
});

test("a focus step by the keyboard moves the scroll on the same spring and rests where reduced motion rests", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const three = [
    ["w2:p1", "half"],
    ["w2:p3", "half"],
    ["w2:p2", "half"],
  ] as const;
  const step = async (p: Page) => {
    const before = await rest(p);
    await p.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.__record(2, { x: 0, y: 0 });
    });
    await p.keyboard.press("Control+b");
    await p.keyboard.press("l");
    const samples = await p.evaluate(() => window.__recorded());
    return { before, after: await rest(p), samples, url: p.url() } satisfies Run;
  };
  await openStrip(page, three, "w2:p3", false);
  const glided = await step(page);
  const { context, other } = await reducedPage(page, browser);
  await openStrip(other, three, "w2:p3", true);
  const jumped = await step(other);
  await context.close();

  expect(new URL(glided.url).pathname).toBe(paneUrl("w2:p2"));
  expect(new URL(jumped.url).pathname).toBe(paneUrl("w2:p2"));
  expect(glided.before.scrollLeft).toBe(0);
  expect(glided.after.scrollLeft).toBe(1120);
  expectSameRest(glided.after, jumped.after);
  expectMonotonic(glided.samples.map((x) => x.scroll), "scroll");
  expectSpring(glided, "scroll");
  expect(distinct(jumped.samples.map((x) => x.scroll))).toBeLessThanOrEqual(2);
  console.log(`[glide] keyboard focus step: frames=${glided.samples.length} longest=${longestFrame(glided)}ms scroll 0 -> ${glided.after.scrollLeft}`);
});
