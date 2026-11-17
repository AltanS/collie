import { test, type Browser, type Locator, type Page } from "@playwright/test";

import type { AgentView } from "@/lib/types";

import { installScanner, scan } from "./inject";
import { writeKey, type Json } from "./out";
import { finger, fling, press, sleep, type Finger } from "./touch";
import { HERD, installWorld, richSnapshot, type SnapshotControl } from "./world";

// PART 1: WHY A DASHBOARD TAP SOMETIMES DOES NOTHING. The Dashboard is driven in a real Chromium at
// phone size, with Chromium's own touch pipeline (`touch.ts`), against the stubbed bridge. Every
// number lands in the `part1:<name>` keys of `src/playground/fixtures/hitbox-census.json`. A tap's outcome is
// whether a `click` reached the target (the browser raises it from a touch that stayed put and lifted),
// which is the one thing every handler on the page depends on; a capture listener on the window
// records it and swallows it, so the app never navigates and the same state serves the next try.
//
//     cd web && bunx vite build && bunx playwright test -c e2e/hitbox/playwright.config.ts dashboard
//
// TRIES. The brief asks 200 per target for the poll test; the other cells run fewer where the answer
// is a yes or no that does not change on the second try (a drift of 15px is a scroll every time).

// 390x844 is the reference phone. `HITBOX_PHONE=360` runs the same cases at 360x780, the narrowest in use,
// and writes its numbers under `part1-360:<name>` so the two sizes sit side by side in the JSON.
const SMALL = process.env.HITBOX_PHONE === "360";
const PHONE = SMALL ? { width: 360, height: 780 } : { width: 390, height: 844 };
const KEY = SMALL ? "part1-360" : "part1";
/** The bottom tab bar's top edge: 56px up from the foot. */
const TAB_BAR_TOP = PHONE.height - 56;
const TRIES = Number(process.env.HITBOX_TRIES ?? "200");

const WATCH = `
window.__hbClicks = [];
window.__hbSwallow = true;
const describe = (el) => {
  if (!(el instanceof Element)) return "none";
  const b = el.closest("button,a,[role=button],select,input") ?? el;
  return b.tagName.toLowerCase() + ":" + (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 28);
};
window.addEventListener("click", (e) => {
  window.__hbClicks.push({ inside: e.target instanceof Element && e.target.closest("[data-hb-watch]") !== null, at: describe(e.target), x: e.clientX, y: e.clientY });
  if (window.__hbSwallow) { e.stopImmediatePropagation(); e.preventDefault(); }
}, true);
`;

interface Click {
  inside: boolean;
  at: string;
  x: number;
  y: number;
}

async function fresh(browser: Browser, opts: { delay?: number } = {}): Promise<{ page: Page; control: SnapshotControl; f: Finger; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
    baseURL: `http://127.0.0.1:${process.env.HITBOX_PORT ?? "5301"}`,
  });
  const page = await context.newPage();
  await page.addInitScript({ content: WATCH });
  await installScanner(page);
  const control = await installWorld(page);
  control.delay = opts.delay ?? 0;
  await page.goto("/");
  await page.waitForSelector('[data-glide-origin="pane"]');
  await sleep(1200);
  return { page, control, f: await finger(page), close: () => context.close() };
}

/** Mark the element as the one a click should reach, and return its centre and box in the viewport. */
async function watch(_page: Page, target: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  await target.first().scrollIntoViewIfNeeded();
  await target.first().evaluate((el) => {
    for (const old of document.querySelectorAll("[data-hb-watch]")) old.removeAttribute("data-hb-watch");
    el.setAttribute("data-hb-watch", "1");
  });
  // The floating button changes width over 200 ms when the list scrolls, so a box read at once is a mid-move box.
  await sleep(350);
  const b = await target.first().boundingBox();
  if (b === null) throw new Error("target has no box");
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

async function clicks(page: Page, reset = true): Promise<Click[]> {
  const got = await page.evaluate((r) => {
    const copy = (window.__hbClicks ?? []).slice();
    if (r) window.__hbClicks = [];
    return copy;
  }, reset);
  return got;
}

interface TargetDef {
  id: string;
  what: string;
  find: (page: Page) => Locator;
}

const TARGETS: TargetDef[] = [
  { id: "row-first", what: "first pane row (claude, needs you)", find: (p) => p.locator('[data-glide-origin="pane"]').first() },
  { id: "row-mid", what: "a pane row in the middle (codex)", find: (p) => p.locator('[data-glide-origin="pane"]').nth(1) },
  { id: "row-last", what: "the last pane row", find: (p) => p.locator('[data-glide-origin="pane"]').last() },
  { id: "mark", what: "header mark (Collie home)", find: (p) => p.getByRole("button", { name: "Collie home" }) },
  { id: "session-pill", what: "space switcher pill", find: (p) => p.getByRole("button", { name: /^Space: / }) },
  { id: "gear", what: "Settings gear", find: (p) => p.getByRole("button", { name: "Settings" }) },
  { id: "summary", what: "status summary line", find: (p) => p.getByRole("button", { name: /needs you .* working/ }).first() },
  { id: "needs-switch", what: "needs-you switch", find: (p) => p.getByRole("button", { name: "Show only panes that need you" }) },
  { id: "ws-filter", what: "workspace filter", find: (p) => p.getByRole("button", { name: /^Workspace / }) },
  { id: "order", what: "order select", find: (p) => p.getByRole("combobox", { name: "Pane order" }) },
  { id: "search", what: "filter magnifier", find: (p) => p.getByRole("button", { name: "Filter sessions" }) },
  { id: "hint-x", what: "dismiss hint (x)", find: (p) => p.getByRole("button", { name: "Dismiss hint" }) },
  { id: "plus", what: "workspace heading plus", find: (p) => p.getByRole("button", { name: /^New tab in webapp/ }) },
  { id: "fab", what: "floating New button", find: (p) => p.locator('[data-slot="fab"]') },
  { id: "tab-files", what: "bottom tab, Files", find: (p) => p.getByRole("button", { name: /^Files$/ }) },
  { id: "tab-hill", what: "bottom tab, Hill", find: (p) => p.getByRole("button", { name: /Hill/ }) },
];

const part1 = new Map<string, Json>([
  ["tries", TRIES],
  ["phone", { width: PHONE.width, height: PHONE.height }],
]);

test.describe.configure({ mode: "serial" });

// ── 1. WHERE A TAP LANDS: nine points on every target ───────────────────────────────────────────
test("tap grid: nine points on every Dashboard target", async ({ browser }) => {
  const { page, f, close } = await fresh(browser);
  const grid: Record<string, Json> = {};
  for (const t of TARGETS) {
    const loc = t.find(page);
    if ((await loc.count()) === 0) {
      grid[t.id] = { missing: true };
      continue;
    }
    const box = await watch(page, loc);
    const pts: [string, number, number][] = [
      ["centre", box.x + box.w / 2, box.y + box.h / 2],
      ["tl", box.x + 2, box.y + 2],
      ["tr", box.x + box.w - 2, box.y + 2],
      ["bl", box.x + 2, box.y + box.h - 2],
      ["br", box.x + box.w - 2, box.y + box.h - 2],
      ["t", box.x + box.w / 2, box.y + 2],
      ["b", box.x + box.w / 2, box.y + box.h - 2],
      ["l", box.x + 2, box.y + box.h / 2],
      ["r", box.x + box.w - 2, box.y + box.h / 2],
      // How far from the edge a tap must land: the pressed look shrinks the element, so a tap on its very edge lands outside it.
      ["r@0.5", box.x + box.w - 0.5, box.y + box.h / 2],
      ["r@1", box.x + box.w - 1, box.y + box.h / 2],
      ["r@3", box.x + box.w - 3, box.y + box.h / 2],
      ["r@4", box.x + box.w - 4, box.y + box.h / 2],
      ["r@6", box.x + box.w - 6, box.y + box.h / 2],
    ];
    const out: Record<string, { delivered: number; of: number; landed: string[] }> = {};
    for (const [name, x, y] of pts) {
      let delivered = 0;
      const landed = new Set<string>();
      for (let k = 0; k < 4; k += 1) {
        await clicks(page);
        await press(f, x, y, { holdMs: 70 });
        await sleep(90);
        const got = await clicks(page);
        if (got.some((c) => c.inside)) delivered += 1;
        else landed.add(got[0]?.at ?? "nothing");
      }
      out[name] = { delivered, of: 4, landed: Array.from(landed) };
    }
    grid[t.id] = { what: t.what, box, points: out };
  }
  part1.set("grid", grid);
  await close();
});

// ── 2. THE NODE UNDER THE FINGER IS REPLACED: a poll answer lands inside a 150 ms press ──────────
interface PollCell {
  id: string;
  target: string;
  variant: "same" | "flip" | "insert" | "remove";
}

const NEW_AGENT: AgentView = { ...HERD[0]!, paneId: "w1:p99", tabId: "w1:t99", agent: "claude", status: "blocked" };


function variantBody(cell: PollCell, targetPane: string) {
  return (n: number) => {
    if (n % 2 === 0) return richSnapshot(n);
    if (cell.variant === "same") return richSnapshot(n);
    if (cell.variant === "flip") return richSnapshot(n, (a) => a.map((x) => (x.paneId === targetPane ? { ...x, status: "blocked" } : x)));
    if (cell.variant === "insert") return richSnapshot(n, (a) => [NEW_AGENT, ...a]);
    return richSnapshot(n, (a) => a.filter((x) => x.paneId !== HERD[0]!.paneId));
  };
}

const CELLS: PollCell[] = [
  { id: "row-mid/same", target: "row-mid", variant: "same" },
  { id: "row-mid/flip", target: "row-mid", variant: "flip" },
  { id: "row-mid/insert", target: "row-mid", variant: "insert" },
  { id: "row-mid/remove", target: "row-mid", variant: "remove" },
  { id: "gear/insert", target: "gear", variant: "insert" },
  { id: "fab/insert", target: "fab", variant: "insert" },
  { id: "plus/insert", target: "plus", variant: "insert" },
  { id: "tab-hill/insert", target: "tab-hill", variant: "insert" },
];

async function runPollCell(browser: Browser, cell: PollCell): Promise<Record<string, Json>> {
  const { page, control, f, close } = await fresh(browser, { delay: 60 });
  const def = TARGETS.find((t) => t.id === cell.target)!;
  const body = variantBody(cell, "w1:p2");
  control.body = () => body(control.asked);
  let delivered = 0;
  let lost = 0;
  const elsewhere: Record<string, number> = {};
  let nodeReplaced = 0;
  // A try is VOID when the target had already moved between the moment its box was read and the moment the finger
  // lands: the page's own poll (not the one this cell sends) answered in that gap, with no finger down to hold it.
  // That is a list moving under no hand, and it tells nothing about a press; the count is reported as `voided`
  // (`HITBOX_VOID=1`). It catches few: a row that ARRIVES glides in over a few hundred ms, so a poll that answered
  // just before the finger lands still looks unmoved at the read and slides under the press. About 9 tries in 100
  // are that (an in-page recorder showed the page's own poll answering 190ms before the finger), after the fix as
  // before; it is the one loss the held list cannot reach, because no finger was down when the poll committed.
  let voided = 0;
  let counted = 0;
  for (let attempt = 0; counted < TRIES && attempt < TRIES * 3; attempt += 1) {
    const box = await watch(page, def.find(page));
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    await clicks(page);
    const stillThere = await def.find(page).first().boundingBox();
    if (process.env.HITBOX_VOID === "1" && (stillThere === null || Math.abs(stillThere.y - box.y) > 1)) {
      voided += 1;
      await sleep(1200);
      continue;
    }
    counted += 1;
    const before = control.asked;
    // The finger lands; 30 ms later the poll starts (what `tick` does on a focus event); the answer
    // comes 60 ms after that and React commits it; the finger lifts at 150 ms.
    await f.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }] });
    await sleep(30);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(120);
    await f.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(60);
    const got = await clicks(page);
    const stillMarked = await page.evaluate(() => document.querySelector("[data-hb-watch]") !== null);
    if (!stillMarked) nodeReplaced += 1;
    if (got.some((c) => c.inside)) delivered += 1;
    else if (got.length === 0) lost += 1;
    else elsewhere[got[0]!.at] = (elsewhere[got[0]!.at] ?? 0) + 1;
    // Settle: let the answer finish and the next try start from a stable page.
    for (let k = 0; k < 20 && control.asked === before; k += 1) await sleep(25);
    // `HITBOX_SETTLE` (default 220) is how long the page rests before the next try. A list held still lets go
    // 300ms after a lift and glides its arrival in, so a try that starts inside that glide measures the previous
    // try's tail, not this one: the held-list numbers are taken with 700.
    await sleep(Number(process.env.HITBOX_SETTLE ?? "220"));
  }
  await close();
  return { ...cell, tries: TRIES, delivered, lost, elsewhere, nodeReplaced, voided };
}

test("lost taps while a poll answer lands in the press", async ({ browser }) => {
  // `HITBOX_CELLS=row-mid/insert,plus/insert` runs only those cells.
  const only = process.env.HITBOX_CELLS?.split(",");
  const cells = CELLS.filter((c) => only === undefined || only.includes(c.id));
  // Four pages at a time: each is its own context with its own stub, so they do not interfere.
  for (let i = 0; i < cells.length; i += 4) {
    const done = await Promise.all(cells.slice(i, i + 4).map((c) => runPollCell(browser, c)));
    for (const r of done) part1.set(`poll:${String(r.id)}`, r);
  }
});

// A row that ARRIVES glides in; one that LEAVES is gone at once. So the same poll costs a tap differently by
// direction, and by how long the finger stays down. The press below starts, the poll lands 90 ms in, and the
// finger lifts at `lift` ms; odd polls bring a new needs-you pane to the top of the list, even ones take it away.
test("a row arriving or leaving, and a press that outlasts it", async ({ browser }) => {
  const rows: Record<string, { arrival: { delivered: number; of: number }; departure: { delivered: number; of: number } }> = {};
  const def = TARGETS.find((t) => t.id === "row-mid")!;
  for (const lift of [150, 250, 350, 400]) {
    const { page, control, f, close } = await fresh(browser, { delay: 60 });
    const body = variantBody({ id: "x", target: "row-mid", variant: "insert" }, "w1:p2");
    control.body = () => body(control.asked);
    const tally = { arrival: { delivered: 0, of: 0 }, departure: { delivered: 0, of: 0 } };
    for (let i = 0; i < 30; i += 1) {
      const box = await watch(page, def.find(page));
      await clicks(page);
      const before = control.asked;
      const arrival = (before + 1) % 2 === 1;
      await f.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.w / 2, y: box.y + box.h / 2, radiusX: 8, radiusY: 8, force: 1 }] });
      await sleep(30);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await sleep(lift - 30);
      await f.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(60);
      const got = await clicks(page);
      const side = arrival ? tally.arrival : tally.departure;
      side.of += 1;
      if (got.some((c) => c.inside)) side.delivered += 1;
      for (let k = 0; k < 20 && control.asked === before; k += 1) await sleep(25);
      await sleep(Number(process.env.HITBOX_SETTLE ?? "500"));
    }
    rows[String(lift)] = tally;
    await close();
  }
  part1.set("glide", rows);
});

// The same poll, read as the APP answers it and not as the DOM does: the click is NOT swallowed, and the answer
// is the pane the router opens. A tap that lands on a neighbour but is sent to the pressed row (lib/press-memory.ts)
// is a wrong click to the page and the right pane to the person, and a list held still under the finger
// (hooks/use-still-list.ts) never moves at all; this is the number that says which of them is true.
// `HITBOX_OPEN_TRIES` tries per direction (default 40); the page is reloaded between tries, so it is slow.
test("which pane a tap opens when a row arrives or leaves", async ({ browser }) => {
  const tries = Number(process.env.HITBOX_OPEN_TRIES ?? "40");
  const { page, control, f, close } = await fresh(browser, { delay: 60 });
  const unswallow = () =>
    page.evaluate(() => {
      window.__hbSwallow = false;
    });
  await unswallow();
  const def = TARGETS.find((t) => t.id === "row-mid")!;
  // The herd stays as it was until the poll under test: `live` names what that poll brings.
  let live: "base" | "arrival" | "departure" = "base";
  const arrives = variantBody({ id: "x", target: "row-mid", variant: "insert" }, "w1:p2");
  const leaves = variantBody({ id: "x", target: "row-mid", variant: "remove" }, "w1:p2");
  control.body = () => {
    if (live === "base") return richSnapshot(control.asked);
    return live === "arrival" ? arrives(1) : leaves(1);
  };
  const tally = { arrival: { right: 0, wrong: 0, none: 0, of: 0 }, departure: { right: 0, wrong: 0, none: 0, of: 0 } };
  for (let i = 0; i < tries * 2; i += 1) {
    const loc = def.find(page);
    const box = await watch(page, loc);
    const intended = await loc.first().getAttribute("data-glide-key");
    const arrival = i % 2 === 0;
    await f.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.w / 2, y: box.y + box.h / 2, radiusX: 8, radiusY: 8, force: 1 }] });
    await sleep(30);
    live = arrival ? "arrival" : "departure";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(120);
    await f.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    let opened: string | null = null;
    for (let k = 0; k < 30 && opened === null; k += 1) {
      await sleep(50);
      const path = await page.evaluate(() => window.location.pathname);
      if (path.startsWith("/pane/")) opened = path;
    }
    const side = arrival ? tally.arrival : tally.departure;
    side.of += 1;
    if (opened === null) side.none += 1;
    else if (opened === intended) side.right += 1;
    else side.wrong += 1;
    // Back to a fresh Dashboard for the next try.
    live = "base";
    await page.goto("/");
    await page.waitForSelector('[data-glide-origin="pane"]');
    await unswallow();
    await sleep(900);
  }
  part1.set("opens", { tries, ...tally });
  await close();
});

// A LIST HELD STILL (hooks/use-still-list.ts), read in a real engine. A finger is put down on a row and kept there;
// 300ms in, a poll brings a new needs-you pane AND flips another row to blocked. Recorded: when the summary line
// counts the new pane (the live herd: it must not wait), when the flipped row shows blocked (in place: it must not
// wait), and when the new row appears (it waits for the finger and 300ms). The same poll on a list nobody touches is
// the control: it is not delayed at all. On the old build the new row appears at once in both, which is the fault.
test("a list held still: what waits and what does not", async ({ browser }) => {
  const { page, control, f, close } = await fresh(browser, { delay: Number(process.env.HITBOX_HELD_DELAY ?? "0") });
  const rowCount = () => page.locator('[data-glide-origin="pane"]').count();
  const summaryText = () => page.locator("#dash-summary-line").innerText();
  const flipped = () => page.locator('[data-glide-origin="pane"]').nth(1).innerText();
  const base = await rowCount();
  const baseSummary = await summaryText();
  const baseFlip = await flipped();
  const body = (n: number) =>
    richSnapshot(n, (a) => [NEW_AGENT, ...a.map((x) => (x.paneId === "w1:p2" ? { ...x, status: "blocked" as const } : x))]);

  // CONTROL: nobody touches the list. Time from the poll to the new row on screen.
  control.body = () => body(control.asked);
  const t0 = Date.now();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  let untouchedMs: number | null = null;
  for (let k = 0; k < 80 && untouchedMs === null; k += 1) {
    await sleep(25);
    if ((await rowCount()) > base) untouchedMs = Date.now() - t0;
  }

  // HELD: back to the old herd, then a finger down on a row while the new poll lands.
  control.body = () => richSnapshot(control.asked);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  for (let k = 0; k < 80 && (await rowCount()) !== base; k += 1) await sleep(50);
  await sleep(600);
  const pressed = page.locator('[data-glide-origin="pane"]').nth(Number(process.env.HITBOX_HELD_ROW ?? "3"));
  const pressedKey = await pressed.getAttribute("data-glide-key");
  const box = await watch(page, pressed);
  const keyed = () => page.locator(`[data-glide-key="${String(pressedKey)}"]`).first().boundingBox();
  control.body = () => body(control.asked);
  await f.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.w / 2, y: box.y + box.h / 2, radiusX: 8, radiusY: 8, force: 1 }] });
  const down = Date.now();
  const pollAt = Number(process.env.HITBOX_HELD_POLL_AT ?? "300");
  await sleep(pollAt);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  let summaryMs: number | null = null;
  let flipMs: number | null = null;
  let rowMs: number | null = null;
  let rowsWhileDown = base;
  while (Date.now() - down < 2300) {
    await sleep(25);
    if (summaryMs === null && (await summaryText()) !== baseSummary) summaryMs = Date.now() - down - pollAt;
    if (flipMs === null && (await flipped()) !== baseFlip) flipMs = Date.now() - down - pollAt;
    rowsWhileDown = await rowCount();
    if (rowMs === null && rowsWhileDown > base) rowMs = Date.now() - down - pollAt;
  }
  const rowsBeforeLift = await rowCount();
  const moved = await keyed();
  const rowMovedPx = moved === null ? null : Math.round(moved.y - box.y);
  await f.cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  const lift = Date.now();
  let afterLiftMs: number | null = null;
  for (let k = 0; k < 60 && afterLiftMs === null; k += 1) {
    await sleep(25);
    if ((await rowCount()) > base) afterLiftMs = Date.now() - lift;
  }
  part1.set("held", {
    untouchedRowMs: untouchedMs,
    whileFingerDown: { summaryMs, flippedRowMs: flipMs, newRowMsAfterPoll: rowMs, rowsBeforeLift, rowsAtStart: base, pressedRowMovedPx: rowMovedPx },
    newRowMsAfterLift: afterLiftMs,
  });
  await close();
});

// ── 3. A GESTURE EATS THE TAP: drift, press length, a fling ─────────────────────────────────────
test("drift, press length and fling", async ({ browser }) => {
  const { page, f, close } = await fresh(browser);

  // Drift: the finger moves `d` px while down. Rows sit in a vertical scroller; the FAB and the gear do not.
  const drift: Record<string, Record<string, { delivered: number; of: number }>> = {};
  for (const id of ["row-mid", "gear", "fab", "tab-hill"]) {
    const loc = TARGETS.find((t) => t.id === id)!.find(page);
    const box = await watch(page, loc);
    drift[id] = {};
    for (const axis of id === "row-mid" || id === "gear" ? (["x", "y"] as const) : (["y"] as const)) {
      for (const d of [0, 3, 6, 8, 10, 15, 20]) {
        let delivered = 0;
        const of = 5;
        for (let k = 0; k < of; k += 1) {
          await clicks(page);
          await press(f, box.x + box.w / 2 - (axis === "x" ? d / 2 : 0), box.y + box.h / 2 - (axis === "y" ? d / 2 : 0), {
            holdMs: 80,
            drift: axis === "x" ? d : 0,
            driftY: axis === "y" ? d : 0,
          });
          await sleep(120);
          if ((await clicks(page)).some((c) => c.inside)) delivered += 1;
          // A drift that scrolled the list moved the row: put it back before the next try.
          await page.evaluate(() => document.querySelector("[data-hb-watch]")?.scrollIntoView({ block: "center" }));
          await sleep(60);
        }
        drift[id]![`${axis}${String(d)}`] = { delivered, of };
      }
    }
  }
  part1.set("drift", drift);

  // Press length on a row, with the hold's own outcome: a click, a sheet (the hold fired), or nothing.
  const lengths: Record<string, Record<string, number>> = {};
  for (const ms of [50, 150, 300, 440, 470, 600, 900, 1500]) {
    const tally = { click: 0, sheet: 0, nothing: 0 };
    for (let k = 0; k < 5; k += 1) {
      await page.goto("/");
      await page.waitForSelector('[data-glide-origin="pane"]');
      await sleep(500);
      const loc = TARGETS[1]!.find(page);
      const box = await watch(page, loc);
      await press(f, box.x + box.w / 2, box.y + box.h / 2, { holdMs: ms });
      await sleep(400);
      const got = await clicks(page);
      const sheet = (await page.locator('[role="dialog"]').count()) > 0;
      if (got.some((c) => c.inside)) tally.click += 1;
      else if (sheet) tally.sheet += 1;
      else tally.nothing += 1;
    }
    lengths[String(ms)] = tally;
  }
  part1.set("pressLength", lengths);
  await close();
});

test("fling: a tap while the list coasts", async ({ browser }) => {
  const { page, f, close } = await fresh(browser);
  // A real fling (touch down, a fast swipe, lift, the list coasts), then a tap `after` ms after the lift at
  // (200, 300). `moving` says whether the list was still scrolling when the tap landed; `delivered` counts
  // taps that produced ANY click, because a tap that only stops the coasting list is not a click.
  const flings: Record<string, { delivered: number; of: number; moving: number }> = {};
  for (const after of [30, 120, 250, 350, 450, 800]) {
    let delivered = 0;
    let moving = 0;
    const of = 6;
    for (let k = 0; k < of; k += 1) {
      await page.goto("/");
      await page.waitForSelector('[data-glide-origin="pane"]');
      await sleep(600);
      await fling(f, 200, PHONE.height - 190, -200);
      await sleep(after);
      const top0 = await page.evaluate(() => [...document.querySelectorAll("div")].find((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))?.scrollTop ?? 0);
      await clicks(page);
      await sleep(16);
      const top1 = await page.evaluate(() => [...document.querySelectorAll("div")].find((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))?.scrollTop ?? 0);
      if (top1 !== top0) moving += 1;
      await press(f, 200, 300, { holdMs: 60 });
      await sleep(150);
      if ((await clicks(page)).length > 0) delivered += 1;
    }
    flings[String(after)] = { delivered, of, moving };
  }
  part1.set("fling", flings);
  await close();
});

// ── 4. THE TARGET MOVES: cold-open timeline, an arrival slide, a row appearing ───────────────────
test("shifts: load timeline, arrival slide, a new row", async ({ browser }) => {
  // Cold open with realistic delays: the herd in 300 ms, the update check in 1200 ms, the launchers in 600 ms.
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block", baseURL: `http://127.0.0.1:${process.env.HITBOX_PORT ?? "5301"}` });
  const page = await context.newPage();
  await installWorld(page);
  await page.route("**/api/update/check", async (route) => {
    await sleep(1200);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "1.0.0", latest: "1.1.0", latestUrl: "https://example.invalid/r", releaseAvailable: true, majorAvailable: null, majorUrl: null, bridgeStale: false, checkedAt: Date.now() }) });
  });
  await page.route("**/api/snapshot", async (route) => {
    await sleep(300);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(richSnapshot()) });
  });
  await page.route("**/api/launchers", async (route) => {
    await sleep(600);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ launchers: [], home: "/home/you" }) });
  });
  await page.addInitScript(() => {
    const track: { t: number; first: number | null; fab: number | null; summary: number | null }[] = [];
    window.__hbTrack = track;
    const t0 = performance.now();
    const tick = () => {
      const row = document.querySelector('[data-glide-origin="pane"]')?.getBoundingClientRect();
      const fab = document.querySelector('[data-slot="fab"]')?.getBoundingClientRect();
      const sum = Array.from(document.querySelectorAll("main button")).find((b) => /needs you|Nothing needs/.test(b.textContent ?? ""))?.getBoundingClientRect();
      track.push({ t: Math.round(performance.now() - t0), first: row ? Math.round(row.top) : null, fab: fab ? Math.round(fab.top) : null, summary: sum ? Math.round(sum.top) : null });
      if (performance.now() - t0 < 4500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto("/");
  await sleep(4800);
  const track = await page.evaluate(() => window.__hbTrack ?? []);
  // Collapse the frames to the moments something moved.
  const moves: { t: number; first: number | null; fab: number | null; summary: number | null }[] = [];
  for (const row of track) {
    const last = moves[moves.length - 1];
    if (last === undefined || last.first !== row.first || last.fab !== row.fab || last.summary !== row.summary) moves.push(row);
  }
  part1.set("coldOpen", moves);
  await context.close();

  // The arrival slide: tap a row, come back, and ask what stands at the row's centre as the screen slides in.
  const { page: p2, f, close } = await fresh(browser);
  await p2.evaluate(() => {
    window.__hbSwallow = false;
  });
  const row = TARGETS[1]!.find(p2);
  const box = await watch(p2, row);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  await press(f, cx, cy, { holdMs: 60 });
  await p2.waitForURL(/\/pane\//);
  await sleep(900);
  await p2.evaluate(
    ([x, y]) => {
      const out: { t: number; hit: string }[] = [];
      window.__hbSlide = out;
      const t0 = performance.now();
      const tick = () => {
        const hit = document.elementFromPoint(x!, y!);
        out.push({ t: Math.round(performance.now() - t0), hit: hit?.closest('[data-glide-origin="pane"]') !== null && hit?.closest('[data-glide-origin="pane"]') !== undefined ? "row" : (hit?.tagName ?? "none").toLowerCase() });
        if (performance.now() - t0 < 700) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [cx, cy],
  );
  await p2.goBack();
  await sleep(900);
  const slide = await p2.evaluate(() => window.__hbSlide ?? []);
  const firstRow = slide.find((s) => s.hit === "row");
  const stayed = slide.filter((s) => s.hit === "row");
  part1.set("arrival", { samples: slide.length, firstRowAtMs: firstRow?.t ?? null, rowHitMs: stayed.length === 0 ? 0 : (stayed[stayed.length - 1]!.t - (firstRow?.t ?? 0)), first: slide.slice(0, 3), note: "ms until the row's centre first answers elementFromPoint after Back" });
  await close();
});

// ── 5. DEAD TIME: the glide wait, and the idle cover ───────────────────────────────────────────
test("dead time: the pane read wait and the idle cover", async ({ browser }) => {
  // Time from the finger's lift to the URL changing, with the pane's read answered after `d` ms.
  const waits: Record<string, number | null> = {};
  for (const d of [0, 100, 300, 1000, 3000]) {
    const { page, f, close } = await fresh(browser);
    await page.evaluate(() => {
      window.__hbSwallow = false;
    });
    await page.route(/\/api\/pane\/[^/]+(\/chat)?(\?.*)?$/, async (route) => {
      await sleep(d);
      await route.fallback();
    });
    const box = await watch(page, TARGETS[1]!.find(page));
    const start = Date.now();
    await press(f, box.x + box.w / 2, box.y + box.h / 2, { holdMs: 60 });
    const lifted = Date.now();
    try {
      await page.waitForURL(/\/pane\//, { timeout: 8000 });
      waits[String(d)] = Date.now() - lifted;
    } catch {
      waits[String(d)] = null;
    }
    void start;
    await close();
  }
  part1.set("paneReadWait", waits);

  // The natural answer to a tap that shows nothing is another tap. With the pane read taking 3 s, tap the
  // row again after 800 ms and again after 1600 ms: does the wait restart, and how many reads go out?
  {
    const { page, f, close } = await fresh(browser);
    await page.evaluate(() => {
      window.__hbSwallow = false;
    });
    let reads = 0;
    await page.route(/\/api\/pane\/[^/]+(\/chat)?(\?.*)?$/, async (route) => {
      reads += 1;
      await sleep(1500);
      await route.fallback();
    });
    const box = await watch(page, TARGETS[1]!.find(page));
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    const first = Date.now();
    await press(f, x, y, { holdMs: 60 });
    await sleep(700);
    await press(f, x, y, { holdMs: 60 });
    await sleep(700);
    await press(f, x, y, { holdMs: 60 });
    let landedAfter: number | null = null;
    try {
      await page.waitForURL(/\/pane\//, { timeout: 9000 });
      landedAfter = Date.now() - first;
    } catch {
      landedAfter = null;
    }
    part1.set("retap", { readMs: 1500, tapsAtMs: [0, 800, 1600], landedAfterMs: landedAfter, readsSent: reads, note: "a single tap on a 1500 ms read lands at about 1500 ms (see paneReadWait)" });
    await close();
  }

  // The idle cover: 31 minutes of no input, then a tap on a row, with the snapshot answered after `d` ms.
  const cover: Record<string, { navigatedOnFirstTap: boolean; coverMsAfterTap: number | null; secondTapNavigated: boolean }> = {};
  for (const d of [0, 800, 3000, 9000]) {
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block", baseURL: `http://127.0.0.1:${process.env.HITBOX_PORT ?? "5301"}` });
    const page = await context.newPage();
    await page.clock.install();
    const control = await installWorld(page);
    await page.goto("/");
    await page.waitForSelector('[data-glide-origin="pane"]');
    await page.clock.runFor(1500);
    const rowBox = await page.locator('[data-glide-origin="pane"]').nth(1).boundingBox();
    await page.clock.fastForward(31 * 60_000);
    await page.clock.runFor(1000);
    const locked = (await page.locator('[role="dialog"][aria-label]').count()) > 0;
    control.delay = d;
    const g = await finger(page);
    const box = rowBox;
    if (box === null || !locked) {
      cover[String(d)] = { navigatedOnFirstTap: false, coverMsAfterTap: null, secondTapNavigated: false };
      await context.close();
      continue;
    }
    await press(g, box.x + box.width / 2, box.y + box.height / 2, { holdMs: 60 });
    await page.clock.runFor(300);
    const navigated = /\/pane\//.test(page.url());
    // How long the cover stays after that tap.
    let gone: number | null = null;
    for (let t = 0; t <= 9500; t += 250) {
      if ((await page.locator('[role="dialog"][aria-label]').count()) === 0) {
        gone = t;
        break;
      }
      await page.clock.runFor(250);
    }
    await page.clock.runFor(500);
    const box2 = rowBox;
    if (box2 !== null) await press(g, box2.x + box2.width / 2, box2.y + box2.height / 2, { holdMs: 60 });
    await page.clock.runFor(600);
    cover[String(d)] = { navigatedOnFirstTap: navigated, coverMsAfterTap: gone, secondTapNavigated: /\/pane\//.test(page.url()) };
    await context.close();
  }
  part1.set("idleCover", cover);
});

// ── 6. WHAT LIES OVER THE LIST: the floating button and the bottom bar, at the foot of the herd ───
test("what lies over the rows", async ({ browser }) => {
  const { page, close } = await fresh(browser);
  const over: Record<string, Json> = {};
  const offsets = [0, 120, 240, 360, 480, 600];
  const rowsLost: { scrollTop: number; rows: { name: string; share: number }[] }[] = [];
  for (const top of offsets) {
    await page.evaluate((t) => {
      const scroller = document.querySelector("main")?.parentElement;
      if (scroller) scroller.scrollTop = t;
    }, top);
    await sleep(150);
    const r = await scan(page, { scroll: false });
    rowsLost.push({
      scrollTop: top,
      rows: r.targets.filter((t) => t.holdGuard && t.box.y + t.box.h > 64 && t.box.y < TAB_BAR_TOP && t.hitShare < 0.97).map((t) => ({ name: t.name, share: t.hitShare })),
    });
  }
  over.rowsLost = rowsLost;
  over.layers = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="fab"], [role="tablist"], nav[aria-label]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { layer: el.getAttribute("data-slot") ?? el.tagName.toLowerCase(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );
  part1.set("over", over);
  await close();
});

test.afterAll(() => {
  // One key per experiment (`part1:grid`), so a run of one case with `-g` adds to the others instead of replacing them.
  for (const [name, value] of part1) writeKey(`${KEY}:${name}`, value);
});
