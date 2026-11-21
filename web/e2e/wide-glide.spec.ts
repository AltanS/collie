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
    __watch: (index: number, clock: FrameClock) => void;
    __firstWrites: () => FirstWrites;
    __touchedWhileGliding: () => boolean[];
    __tapped: (before: string | null) => Promise<void>;
    __button: () => { x: number; y: number };
    __swipe: (to: number) => void;
    __scrollOverFrames: (frames: number) => Promise<number[]>;
    __aim: (restAt: { x: number; y: number }) => Promise<{ x: number; y: number } | null>;
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

    // WHICH FRAME FIRST CHANGED EACH VALUE, from the driver's own writes, not from painted frames: a
    // starved machine drops frames, but values written in one animation frame share its
    // `document.timeline.currentTime`, and values written a frame apart do not.
    let firsts: FirstWrites = {};
    let watcher: MutationObserver | null = null;
    window.__watch = (index, clock) => {
      firsts = {};
      watcher?.disconnect();
      const node = strip();
      const docTimeline = document.timeline;
      // On the test's clock every callback of one driven frame reads that frame's time from
      // `performance.now()`, while the document's timeline goes on in real frames, a few driven ones each.
      const frameNow = () => (clock === "test" ? performance.now() : Number(docTimeline.currentTime));
      const col = node.querySelectorAll<HTMLElement>("[data-col-index]")[index]!;
      const add = node.querySelector<HTMLElement>('[data-slot="add-column"]')!;
      const startCol = col.style.flex;
      const startAdd = add.style.flex;
      watcher = new MutationObserver(() => {
        if (firsts.width === undefined && col.style.flex !== startCol) firsts.width = frameNow();
        if (firsts.add === undefined && add.style.flex !== startAdd) firsts.add = frameNow();
      });
      watcher.observe(col, { attributes: true, attributeFilter: ["style"] });
      watcher.observe(add, { attributes: true, attributeFilter: ["style"] });
      const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
      const startScroll = node.scrollLeft;
      Object.defineProperty(node, "scrollLeft", {
        configurable: true,
        // SAFETY: Element's own scrollLeft getter returns a number.
        get: () => own.get!.call(node) as number,
        set: (v: number) => {
          own.set!.call(node, v);
          if (firsts.scroll === undefined && Math.abs(v - startScroll) > 0) firsts.scroll = frameNow();
        },
      });
    };
    // A MutationObserver reports after the task or frame callback that wrote; read once the motion rests.
    window.__firstWrites = () => ({ ...firsts });

    // Whether the strip had a running width glide at each touchstart: read when the finger lands, not
    // when the test sent it.
    const touched: boolean[] = [];
    strip().addEventListener("touchstart", () => touched.push(strip().hasAttribute("data-gliding")), { capture: true, passive: true });
    window.__touchedWhileGliding = () => [...touched];

    // THE TOUCH CASES' STEPS, here, so the steps between two finger taps run in one call: on a slow
    // machine each call from the test costs about a frame or more, and a glide lasts a third of a second.
    const buttonSelector = "[data-slot='header-dock-trail'] [data-slot='column-width']";
    const widthButton = () => document.querySelector<HTMLElement>(buttonSelector)!;
    const nextFrame = window.requestAnimationFrame.bind(window);
    const frame = () => new Promise<number>((go) => nextFrame(go));
    // The tap's click has landed: a glide runs, or (reduced motion) the width changed.
    window.__tapped = async (before) => {
      while (widthButton().getAttribute("aria-label") === before) await frame();
    };
    window.__button = () => {
      const b = widthButton().getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    // A finger that scrolls the strip to `to`: a touchstart, touchmoves past the tap slop and a touchend
    // dispatched on the strip, with the scroll that finger makes, in one task. A swipe through the
    // engine's own touch pipeline takes about 400 ms in headless Chromium, longer than the glide it must
    // land inside. `to` is a column start, so the snap that comes back at rest moves nothing.
    window.__swipe = (to) => {
      const node = strip();
      const from = node.scrollLeft;
      const finger = (x: number) => new Touch({ identifier: 1, target: node, clientX: x, clientY: 500 });
      const fire = (type: string, x: number) =>
        node.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [finger(x)], changedTouches: [finger(x)] }));
      const dx = to - from;
      fire("touchstart", 900);
      fire("touchmove", 900 - dx / 2);
      node.scrollLeft = from + dx / 2;
      fire("touchmove", 900 - dx);
      node.scrollLeft = to;
      fire("touchend", 900 - dx);
    };
    window.__scrollOverFrames = async (frames) => {
      const out: number[] = [];
      while (out.length < frames) {
        await frame();
        out.push(strip().scrollLeft);
      }
      return out;
    };
    // Where a finger lands on the gliding width button however late the tap arrives: 20 px short of the
    // button's rest center, on the side it comes from. The button is 56 px wide and moves straight to
    // its rest (every spring starts from rest with the same stiffness, so they share one shape), so
    // once it covers that point it covers it until it rests, from about 46 px before the end. Null
    // when the glide ended first.
    window.__aim = async (restAt) => {
      const start = window.__button();
      const aim = { x: restAt.x + Math.sign(start.x - restAt.x) * 20, y: restAt.y };
      while (strip().hasAttribute("data-gliding")) {
        const b = widthButton().getBoundingClientRect();
        if (aim.x > b.left + 2 && aim.x < b.right - 2) return aim;
        await frame();
      }
      return null;
    };
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
  /** The animation frame of the first write that changed each value, when it was watched. */
  writes?: FirstWrites;
}

/** For each value the driver writes, the `document.timeline` time of the frame whose write first changed
 *  it: the cycled column's basis, the add column's basis, the strip's scroll. Absent: it never changed. */
interface FirstWrites {
  width?: number;
  add?: number;
  scroll?: number;
}

/**
 * Which clock a page's frames run on. "test": Playwright's clock, so the test draws every frame of a
 * motion at the time the spring reads (`holdFrames`, `driveFrames`). "real": the engine's own frames.
 */
type FrameClock = "test" | "real";

/**
 * THE GLIDE RUNS ON THE TEST'S CLOCK. The spring takes its time from `requestAnimationFrame` and
 * `performance.now()`. On a busy machine the real frames come 50 to 130 ms apart, and the first one after
 * the tap comes late, so a curve read against wall time measured the machine and not the spring: the CI
 * run of 2026-11-21 read a third of the motion done at a third of the time. So a page that glides installs
 * Playwright's clock before it loads (time flows as usual while it loads and rests), the clock stops just
 * before the act, and the test then advances it in frames of 16 ms until the motion rests. Every frame of
 * the glide is drawn, at the time the spring reads, however slow the machine is. The clock goes on in
 * real time afterwards.
 */
const DRIVE_MS = 2000;

async function holdFrames(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
}

async function driveFrames(page: Page, ms = DRIVE_MS): Promise<void> {
  await page.clock.runFor(ms);
}

/** Tap the focused column's width button `taps` times (a second tap `gapMs` after the first), record. */
async function cycleFocused(page: Page, index: number, taps: 1 | 2, gapMs: number, clock: FrameClock): Promise<Run> {
  const before = await rest(page);
  const box = (await widthButton(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (clock === "test") await holdFrames(page);
  await page.evaluate((arg) => {
    window.__record(arg.index, arg.point);
    window.__watch(arg.index, arg.clock);
  }, { index, point, clock });
  await page.mouse.click(point.x, point.y);
  if (taps === 2) {
    if (clock === "test") await driveFrames(page, gapMs);
    else await page.waitForTimeout(gapMs);
    // Wherever the button is now: the second press of the same control, mid-glide.
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-slot='header-dock-trail'] [data-slot='column-width']")!.click());
  }
  if (clock === "test") {
    await driveFrames(page);
    await page.clock.resume();
  }
  const samples = await page.evaluate(() => window.__recorded());
  const after = await rest(page);
  const writes = await page.evaluate(() => window.__firstWrites());
  return { before, after, samples, url: page.url(), writes };
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

/** The share of a series' travel done at time `t`, read between the samples around `t`. */
function doneAt(run: Run, series: Series, t: number): number {
  const xs = run.samples;
  const from = xs[0]![series];
  const to = xs.at(-1)![series];
  const at = (k: number) => (xs[k]![series] - from) / (to - from);
  for (let k = 1; k < xs.length; k += 1) {
    if (xs[k]!.t < t) continue;
    const a = xs[k - 1]!;
    const b = xs[k]!;
    return at(k - 1) + ((at(k) - at(k - 1)) * (t - a.t)) / (b.t - a.t);
  }
  return 1;
}

/**
 * A spring from rest, by the time the spring reads (the test's clock, `driveFrames`): the
 * motion runs from the last sample at its start value to the first sample at its end value, and by a
 * third of that time more than half the travel is done (a constant speed does a third; the spring about
 * four fifths), while the last third adds under a quarter (a constant speed adds a third; the spring a
 * few percent). Reading between samples only lowers the first share and raises the last one, the safe
 * side for both.
 */
function expectSpring(run: Run, series: Series): void {
  const xs = run.samples;
  const from = xs[0]![series];
  const to = xs.at(-1)![series];
  expect(Math.abs(to - from), `${series} moves`).toBeGreaterThan(1);
  const start = xs[xs.findIndex((x) => Math.abs(x[series] - from) > 0.5) - 1]!.t;
  const end = xs[xs.findIndex((x) => Math.abs(x[series] - to) <= 0.5)]!.t;
  const span = (end - start) / 3;
  const shares = `${series}: ${xs.map((x) => `${Math.round(x.t - start)}ms ${x[series].toFixed(1)}`).join(", ")}`;
  expect(doneAt(run, series, start + span), `half done by a third of the time; ${shares}`).toBeGreaterThan(0.5);
  expect(1 - doneAt(run, series, start + 2 * span), `under a quarter left for the last third; ${shares}`).toBeLessThan(0.25);
}

function expectGlide(run: Run, moving: readonly Series[], fromRest: boolean): void {
  for (const series of ["width", "neighbour", "add", "scroll"] as const) {
    const xs = run.samples.map((s) => s[series]);
    expectMonotonic(xs, series);
    // A glide: values between the two ends, not a jump of two. However many frames the machine drops,
    // a motion of a third of a second paints at least one of them.
    if (moving.includes(series)) expect(distinct(xs), `${series} glides`).toBeGreaterThanOrEqual(3);
    else expect(distinct(xs), `${series} stays`).toBe(1);
  }
  // One driver writes the widths and the scroll: the first write that changes each of them comes in the
  // SAME animation frame. Read from the writes themselves, so a dropped frame cannot part them, and a
  // value that starts one frame late does.
  // The cycled column's basis always changes and the scroll does when it moves; the add column's basis
  // changes only when the last column's does (its left edge follows the widths either way).
  const writes = run.writes!;
  expect(writes.width, `the width is written: ${JSON.stringify(writes)}`).toBeDefined();
  if (run.after.scrollLeft !== run.before.scrollLeft) expect(writes.scroll, `the scroll is written: ${JSON.stringify(writes)}`).toBeDefined();
  else expect(writes.scroll, `the scroll is not written: ${JSON.stringify(writes)}`).toBeUndefined();
  const frames = [writes.width, writes.add, writes.scroll].filter((f) => f !== undefined);
  expect(new Set(frames).size, `the first writes share one frame: ${JSON.stringify(writes)}`).toBe(1);
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
    await page.clock.install();
    await openStrip(page, c.cols, c.focus, false);
    if (c.scrollTo !== undefined) {
      await page.locator('[data-slot="strip"]').evaluate((el, x) => el.scrollTo({ left: x, behavior: "auto" }), c.scrollTo);
      await rest(page);
    }
    const glided = await cycleFocused(page, c.index, c.taps, 80, "test");

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
    const jumped = await cycleFocused(other, c.index, c.taps, 150, "real");
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

test("a tap on Remove from view while the width glides is dropped", async ({ page }) => {
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
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // While the glide runs, a tap on the column's Remove from view: its pointerup and its click, sent at the
  // button in the same task that checks the glide runs. Hunting for the frame where the button passes
  // under the first tap's point would hang on which frames a busy machine paints.
  const held = await page.evaluate((label) => {
    const strip = document.querySelector('[data-slot="strip"]')!;
    if (!strip.hasAttribute("data-gliding")) return false;
    const remove = document.querySelector<HTMLButtonElement>(`section[data-focused] button[aria-label="${label}"]`)!;
    remove.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }));
    remove.click();
    return true;
  }, en["wide.removeFromView"]);
  expect(held).toBe(true);
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

interface Point {
  x: number;
  y: number;
}

/**
 * Tap the width button with a finger, run `between` (one call to the page, which first waits for the
 * tap to land with `__tapped`), and tap again at the point it returns. `mid` is that point.
 */
async function touchTwice(page: Page, between: (label: string | null) => Promise<Point | null>): Promise<{ rest: Geometry; glidingAtSecond: boolean; samples: Sample[]; mid: Point | null }> {
  await rest(page);
  await cdpOf(page);
  const first = await buttonNow(page);
  await page.evaluate(() => window.__record(1, { x: 0, y: 0 }));
  await fingerTap(page, first.x, first.y);
  const mid = await between(first.label);
  if (mid !== null) await fingerTap(page, mid.x, mid.y);
  const samples = await page.evaluate(() => window.__recorded());
  const after = await rest(page);
  const touched = await page.evaluate(() => window.__touchedWhileGliding());
  return { rest: after, glidingAtSecond: touched.at(-1) ?? false, samples, mid };
}

/** One CDP session per page, opened before the act, so no touch waits for a session to open. */
async function cdpOf(page: Page): Promise<CDPSession> {
  const had = sessions.get(page);
  if (had !== undefined) return had;
  const cdp = await page.context().newCDPSession(page);
  sessions.set(page, cdp);
  return cdp;
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
async function reducedPage(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ viewport: VIEW, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block", baseURL: test.info().project.use.baseURL });
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
  // Reduced motion first: it shows where the button rests after the first tap.
  const { context, other } = await reducedPage(browser);
  await openStrip(other, TWO, "w2:p3", true);
  const jumped = await touchTwice(other, async (label) => {
    await other.evaluate((before) => window.__tapped(before), label);
    return other.evaluate(() => window.__button());
  });
  await context.close();

  await openStrip(page, TWO, "w2:p3", false);
  // Late in the glide, at a point the button covers from there to its rest.
  const glided = await touchTwice(page, (label) =>
    page.evaluate(
      async (arg) => {
        await window.__tapped(arg.label);
        return window.__aim(arg.restAt);
      },
      { label, restAt: jumped.mid! },
    ),
  );
  // The second finger came down on the button while the first glide ran, or this case proves nothing.
  expect(glided.mid, "the button reached the aim before its rest").not.toBeNull();
  expect(glided.glidingAtSecond).toBe(true);

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
  // Reduced motion first: it shows where the button rests after the tap and the swipe.
  const { context, other } = await reducedPage(browser);
  await openStrip(other, TWO, "w2:p3", true);
  const jumped = await touchTwice(other, async (label) => {
    await other.evaluate((before) => window.__tapped(before), label);
    await other.evaluate(() => window.__swipe(560));
    await rest(other);
    return other.evaluate(() => window.__button());
  });
  await context.close();

  await openStrip(page, TWO, "w2:p3", false);
  // The swipe early in the glide, ahead of where the glide's scroll stands; the second tap late in it,
  // at a point the button covers from there to its rest.
  let held: number[] = [];
  let early = -1;
  const glided = await touchTwice(page, async (label) => {
    const between = await page.evaluate(
      async (arg) => {
        await window.__tapped(arg.label);
        const scrollAtSwipe = document.querySelector<HTMLElement>('[data-slot="strip"]')!.scrollLeft;
        window.__swipe(560);
        // The finger has the scroll: the glide no longer writes it, while the widths go on.
        const frames = await window.__scrollOverFrames(3);
        return { scrollAtSwipe, frames, aim: await window.__aim(arg.restAt) };
      },
      { label, restAt: jumped.mid! },
    );
    early = between.scrollAtSwipe;
    held = between.frames;
    return between.aim;
  });
  expect(glided.mid, "the button reached the aim before its rest").not.toBeNull();
  expect(glided.glidingAtSecond).toBe(true);
  expect(early).toBeLessThan(500);
  expect(held).toEqual([560, 560, 560]);

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
  const step = async (p: Page, clock: FrameClock) => {
    const before = await rest(p);
    if (clock === "test") await holdFrames(p);
    await p.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.__record(2, { x: 0, y: 0 });
    });
    await p.keyboard.press("Control+b");
    await p.keyboard.press("l");
    if (clock === "test") {
      await driveFrames(p);
      await p.clock.resume();
    }
    const samples = await p.evaluate(() => window.__recorded());
    return { before, after: await rest(p), samples, url: p.url() } satisfies Run;
  };
  await page.clock.install();
  await openStrip(page, three, "w2:p3", false);
  const glided = await step(page, "test");
  const { context, other } = await reducedPage(browser);
  await openStrip(other, three, "w2:p3", true);
  const jumped = await step(other, "real");
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
