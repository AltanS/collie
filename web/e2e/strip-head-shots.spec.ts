import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import type { AgentView, SnapshotResponse, TabView } from "@/lib/types";

import { STILL_MARK } from "./fixtures/still-mark";
import { installWideChatWorld } from "./fixtures/wide-chat";
import { wideSnapshot } from "./fixtures/wide-herd";

// LAB SPEC (strip-head round B, 2026-11-21): screenshots and painted-pixel contrast of the tab strip and the
// pane header, for today (`?th=0`) and the three proposals (`?th=1|2|3`). Throwaway: it goes with the
// proposals. Run with `playwright.strip-head.config.ts`. Made-up names only.

const OUT = process.env.SH_OUT ?? join(homedir(), "projects/collie-workspace/experiments/strip-head/B");
const VARIANTS = (process.env.SH_VARIANTS ?? "0,1,2,3").split(",");
const THEMES = [
  { id: "collie-dark", scheme: "dark", theme: undefined },
  { id: "collie-light", scheme: "light", theme: undefined },
  { id: "nightwatch-dark", scheme: "dark", theme: "nightwatch" },
  { id: "harbour-light", scheme: "light", theme: "harbour" },
] as const;
type Theme = (typeof THEMES)[number];

mkdirSync(join(OUT, "data"), { recursive: true });

// ── The world: Space 1 holds five tabs (one selected with two panes, one that needs you, one working, one
// with a long name, one with an unseen reply), on the machine "lodge" of a two-machine crew.
const LONG_TAB = "integration-tests-for-the-release-train";
const LONG_PANE = "reviewer-of-the-settings-module-migration";
const LONG_BRANCH = "feature/settings-module-migration-second-pass";

function world(): SnapshotResponse {
  const base = wideSnapshot({ spaces: 5, crew: true });
  const others = base.agents.filter((a) => a.workspaceId !== "w1");
  const proto = base.agents.find((a) => a.paneId === "w1:p1")!;
  const soon = Date.now() + 58 * 60_000;
  const pane = (id: string, tab: string, extra: Partial<AgentView>): AgentView => ({ ...proto, paneId: id, tabId: tab, tabLabel: tab, hasSession: true, ...extra });
  const agents: AgentView[] = [
    pane("w1:p1", "w1:t1", {
      agent: "claude",
      status: "working",
      paneLabel: "lead",
      gitHead: { kind: "branch", name: "main" },
      cache: { state: "warm", expiresAt: soon, ttlSeconds: 3600, ruleId: "claude-1h", confidence: "documented" },
    }),
    pane("w1:p2", "w1:t1", { agent: "codex", status: "idle", paneLabel: LONG_PANE, gitHead: { kind: "branch", name: LONG_BRANCH } }),
    pane("w1:p4", "w1:t2", { agent: "claude", status: "blocked", paneLabel: "review", hint: "approve the next step" }),
    pane("w1:p5", "w1:t3", { agent: "codex", status: "working", paneLabel: "build" }),
    pane("w1:p6", "w1:t4", { agent: "claude", status: "idle", paneLabel: LONG_TAB }),
    pane("w1:p7", "w1:t5", { agent: "claude", status: "done", paneLabel: "notes", lastSeenAt: 1 }),
  ];
  const labels = ["main", "review", "build", LONG_TAB, "notes"];
  const tabs: TabView[] = labels.map((label, i) => ({
    tabId: `w1:t${i + 1}`,
    workspaceId: "w1",
    number: i + 1,
    label,
    focused: i === 0,
    paneCount: i === 0 ? 2 : 1,
    host: "lodge",
  }));
  return {
    ...base,
    agents: [...agents, ...others],
    shellPanes: base.shellPanes.filter((p) => p.workspaceId !== "w1"),
    workspaces: base.workspaces.map((w) => (w.workspaceId === "w1" ? { ...w, label: "space-01", tabCount: 5, paneCount: 6 } : w)),
    tabs: [...tabs, ...base.tabs.filter((t) => t.workspaceId !== "w1")],
  };
}

// ── Pixels ───────────────────────────────────────────────────────────────────────────────────────────────
type Rgb = [number, number, number];
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
  return (hi + 0.05) / (lo + 0.05);
}
const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** Every device pixel of a CSS box, read back from a screenshot (top to bottom, left to right). */
async function pixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ w: number; h: number; px: Rgb[] }> {
  const png = (await page.screenshot({ clip, animations: "disabled", caret: "hide" })).toString("base64");
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const px: [number, number, number][] = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i]!, d[i + 1]!, d[i + 2]!]);
    return { w: img.width, h: img.height, px };
  }, png);
}

/** One measured page: readings, edges, heights and reaches by their row name in NUMBERS.md. */
type Measured = Record<string, Reading | Edge | Reach | Record<string, number | null | Reach> | null>;
type Edge = { above: Reading; below: Reading };
type Reach = { drawn: string; hit: string; w: number; h: number };

interface Reading {
  fg: string;
  bg: string;
  ratio: number;
}

/** The ink of a box against its ground: the ground is the commonest pixel, the ink the pixel farthest from it. */
async function ink(target: Locator, inset = 0): Promise<Reading | null> {
  if ((await target.count()) === 0) return null;
  const el = target.first();
  if (!(await el.isVisible())) return null;
  const box = (await el.boundingBox())!;
  const clip = { x: box.x + inset, y: box.y + inset, width: Math.max(1, box.width - 2 * inset), height: Math.max(1, box.height - 2 * inset) };
  const { px } = await pixels(el.page(), clip);
  const count = new Map<string, { c: Rgb; n: number }>();
  for (const p of px) {
    const k = p.join(",");
    const e = count.get(k);
    if (e) e.n += 1;
    else count.set(k, { c: p, n: 1 });
  }
  const bg = [...count.values()].toSorted((a, b) => b.n - a.n)[0]!.c;
  let fg = bg;
  let best = 1;
  for (const p of px) {
    const r = contrast(p, bg);
    if (r > best) {
      best = r;
      fg = p;
    }
  }
  return { fg: hex(fg), bg: hex(bg), ratio: Math.round(best * 100) / 100 };
}

/** A region's lower edge: the colour of the line against the ground above it and the ground below it. */
async function lowerEdge(page: Page, region: Locator, xFrac = 0.02): Promise<{ above: Reading; below: Reading } | null> {
  if ((await region.count()) === 0) return null;
  const box = (await region.first().boundingBox())!;
  const x = Math.round(box.x + Math.max(6, box.width * xFrac));
  const top = box.y + box.height - 6;
  const { px } = await pixels(page, { x, y: top, width: 1, height: 12 });
  const above = px[0]!;
  const below = px[px.length - 1]!;
  // The line is the row that stands farthest from both grounds; where there is no line, the step itself.
  let line = px[Math.floor(px.length / 2)]!;
  let score = -1;
  for (const p of px.slice(2, -2)) {
    const s = Math.min(contrast(p, above), contrast(p, below)) + 0.001 * (contrast(p, above) + contrast(p, below));
    if (s > score) {
      score = s;
      line = p;
    }
  }
  const r = (a: Rgb, b: Rgb) => Math.round(contrast(a, b) * 100) / 100;
  return { above: { fg: hex(line), bg: hex(above), ratio: r(line, above) }, below: { fg: hex(line), bg: hex(below), ratio: r(line, below) } };
}

/** The box a finger or pointer reaches: from the centre outward until `elementFromPoint` leaves the control. */
async function reach(target: Locator): Promise<{ drawn: string; hit: string; w: number; h: number } | null> {
  if ((await target.count()) === 0) return null;
  await target.first().scrollIntoViewIfNeeded();
  return target.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const own = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };
    const walk = (dx: number, dy: number) => {
      let n = 0;
      while (n < 400 && own(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1;
      return n;
    };
    const h = walk(0, -1) + walk(0, 1) + 1;
    const w = walk(-1, 0) + walk(1, 0) + 1;
    return { drawn: `${Math.round(r.width)}x${Math.round(r.height)}`, hit: `${w}x${h}`, w, h };
  });
}

async function open(browser: Browser, opts: { variant: string; theme: Theme; phone?: boolean }): Promise<Page> {
  const context = await browser.newContext({
    viewport: opts.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    hasTouch: opts.phone === true,
    isMobile: opts.phone === true,
    colorScheme: opts.theme.scheme,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await page.addInitScript(
    ([s, t, still]) => {
      localStorage.setItem("collie:theme:v1", s);
      localStorage.setItem("collie:design:v1", JSON.stringify(t === "" ? still : { ...still, theme: t }));
    },
    [opts.theme.scheme, opts.theme.theme ?? "", STILL_MARK] as const,
  );
  await installWideChatWorld(page);
  const snapshot = world();
  await page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }));
  const th = `?th=${opts.variant}`;
  if (opts.phone) {
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}${th}`);
    await expect(page.locator('[data-slot="pane-name"]').first()).toBeVisible();
    await page.waitForTimeout(400);
    return page;
  }
  // Two columns, the first in focus: the first visit writes the space's strip, then it is rewritten.
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}${th}`);
  await page.locator('[data-slot="wide-layout"] section[data-col-key]').first().waitFor();
  await page.evaluate(() => {
    type Stored = { cols: { key: string; preset: string }[]; focus: string | null };
    const key = "collie:wide-layout:v1";
    // SAFETY: the app wrote this entry on the visit just above, in this shape (lib/wide-layout-store.ts).
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, Stored>;
    const [space, strip] = Object.entries(stored).find(([, s]) => s.cols.some((c) => c.key.endsWith("w1:p1")))!;
    const first = strip.cols[0]!.key;
    const keyOf = (id: string) => first.slice(0, first.length - "w1:p1".length) + id;
    stored[space] = { cols: ["w1:p1", "w1:p2"].map((id) => ({ key: keyOf(id), preset: "half" })), focus: keyOf("w1:p1") };
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await page.locator('[data-slot="wide-layout"] section[data-col-key]').nth(1).waitFor();
  await expect(page.locator('[data-slot="wide-layout"] section[data-focused]')).toContainText("Six tests pass");
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(500);
  return page;
}

async function wideClip(page: Page) {
  const sidebar = (await page.locator('[data-slot="wide-sidebar"]').boundingBox())!;
  const left = Math.round(sidebar.x + sidebar.width);
  return { x: left, y: 0, width: 1440 - left, height: 200 };
}

const FOCUSED = '[data-slot="wide-layout"] section[data-focused]';
const OTHER = '[data-slot="wide-layout"] section[data-col-key]:not([data-focused])';
const BAR = '[data-slot="space-header"]';
const label = (button: Locator) => button.locator("span.grid > span:nth-child(2)");

async function measureWide(page: Page) {
  const bar = page.locator(BAR);
  const tabs = bar.locator("nav button[aria-current], nav button:not([aria-current])");
  const tab = (n: number) => bar.locator("nav button").filter({ hasText: n === 4 ? LONG_TAB : ["", "main", "review", "build", "", "notes"][n]! });
  const head = page.locator(`${FOCUSED} header[data-slot="app-header"]`);
  const otherHead = page.locator(`${OTHER} [data-slot="column-header"]`);
  const r = {
    "tab label, not selected": await ink(label(tab(3))),
    "tab label, selected": await ink(label(tab(1))),
    "tab mark, working": await ink(tab(3).locator("> span").first()),
    "tab mark, idle (resting)": await ink(tab(4).locator("> span").first()),
    "tab mark, needs you": await ink(tab(2).locator("> span").first()),
    "space name": await ink(bar.locator('[data-slot="space-title-name"]')),
    "space machine": await ink(bar.locator('[data-slot="space-title-machine"]')),
    "space n of m": await ink(bar.locator('[data-slot="space-position"]')),
    "Actions icon": await ink(bar.getByRole("button", { name: "Actions" }).locator("svg")),
    "space chevron icon": await ink(bar.getByRole("button", { name: /next space/i }).locator("svg")),
    "new tab icon": await ink(bar.getByRole("button", { name: "New tab" }).locator("svg")),
    "pane name": await ink(head.locator('[data-slot="pane-name"]')),
    "pane name, column without focus": await ink(otherHead.locator("span.truncate").first()),
    "branch line": await ink(head.locator('[data-slot="branch-label"]')),
    "branch line, column without focus": await ink(otherHead.locator('[data-slot="branch-label"]')),
    "place line: host": await ink(head.locator('[data-slot="pane-meta"] > *').first()),
    "place line: time": await ink(head.locator('[data-slot="cache-chip"]')),
    "header icon: pane menu": await ink(head.getByRole("button", { name: "Pane actions" }).locator("svg")),
    "header control: width (text)": await ink(page.locator(`${FOCUSED} [data-slot="column-width"]`), 4),
    "header icon: remove from view": await ink(page.locator(`${FOCUSED} [data-slot="column-remove"] svg`)),
    "header icon: remove, column without focus": await ink(page.locator(`${OTHER} [data-slot="column-remove"] svg`)),
    "header edge (bar's lower edge)": await lowerEdge(page, bar, 0.6),
    "header lower edge (focused)": await lowerEdge(page, head),
    "header lower edge (without focus)": await lowerEdge(page, otherHead),
  };
  const box = async (sel: string) => {
    const b = await page.locator(sel).first().boundingBox();
    return b === null ? null : Math.round(b.height * 10) / 10;
  };
  const heights = {
    bar: await box(BAR),
    "selected tab": await box(`${BAR} nav button[aria-current]`),
    header: await box(`${FOCUSED} header[data-slot="app-header"]`),
    "header without focus": await box(`${OTHER} [data-slot="column-header"]`),
  };
  void tabs;
  return { ...r, heights } satisfies Measured;
}

async function measurePhone(page: Page) {
  const nav = page.locator('nav[aria-label]').filter({ has: page.locator("button[aria-current]") }).first();
  const head = page.locator('header[data-slot="app-header"]');
  const r = {
    "tab label, not selected": await ink(label(nav.locator("button").filter({ hasText: "build" }))),
    "tab label, selected": await ink(label(nav.locator("button[aria-current]"))),
    "tab mark, idle (resting)": await ink(nav.locator("button").filter({ hasText: LONG_TAB }).locator("> span").first()),
    "pane name": await ink(head.locator('[data-slot="pane-name"]')),
    "branch line": await ink(head.locator('[data-slot="branch-label"]')),
    "place line: host": await ink(head.locator('[data-slot="pane-meta"] > *').first()),
    "header icon: pane menu": await ink(head.getByRole("button", { name: "Pane actions" }).locator("svg")),
    "header lower edge": await lowerEdge(page, head),
  };
  const targets = {
    "tab, selected": await reach(nav.locator("button[aria-current]")),
    "tab, not selected": await reach(nav.locator("button").filter({ hasText: "build" })),
    "New tab": await reach(page.getByRole("button", { name: "New tab" })),
    "Hide tabs and panes": await reach(page.locator('button[aria-label*="ide tabs"], button[aria-label*="ide panes"]')),
    "pane chip": await reach(page.locator('[data-slot="pane-pill"]').nth(1)),
    "name (Pane settings)": await reach(page.locator('[data-slot="pane-identity-name"]')),
    "place (space)": await reach(page.locator('[data-slot="pane-identity"]')),
    "pane menu": await reach(head.getByRole("button", { name: "Pane actions" })),
    "back (Collie home)": await reach(head.getByRole("button", { name: "Collie home" })),
    "space cell or place": await reach(page.locator('[data-slot="pane-identity"]')),
  };
  return { ...r, targets } satisfies Measured;
}

function save(name: string, data: Measured) {
  writeFileSync(join(OUT, "data", `${name}.json`), JSON.stringify(data, null, 2));
}

test.describe.configure({ mode: "serial" });

for (const variant of VARIANTS) {
  for (const theme of THEMES) {
    test(`${variant} ${theme.id} wide`, async ({ browser }) => {
      const page = await open(browser, { variant, theme });
      await page.screenshot({ path: join(OUT, `${variant}-${theme.id}-wide.png`), clip: await wideClip(page), animations: "disabled", caret: "hide" });
      save(`${variant}-${theme.id}-wide`, await measureWide(page));
      if (theme.id === "collie-dark") {
        await page.screenshot({ path: join(OUT, `${variant}-collie-dark-full.png`), animations: "disabled", caret: "hide" });
        // States: one tab hovered, one focused by keyboard.
        const nav = page.locator(`${BAR} nav`);
        await page.keyboard.press("Shift");
        await nav.locator("button").filter({ hasText: "review" }).focus();
        const hover = (await nav.locator("button").filter({ hasText: "build" }).boundingBox())!;
        await page.mouse.move(hover.x + hover.width / 2, hover.y + hover.height / 2);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(OUT, `${variant}-states-a.png`), clip: await wideClip(page), animations: "disabled", caret: "hide" });
        // And the pane menu open.
        await page.locator(`${FOCUSED} header`).getByRole("button", { name: "Pane actions" }).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `${variant}-states-b.png`), clip: { ...(await wideClip(page)), height: 420 }, animations: "disabled", caret: "hide" });
      }
      await page.context().close();
    });
  }
  for (const theme of THEMES.slice(0, 2)) {
    test(`${variant} ${theme.id} phone`, async ({ browser }) => {
      const page = await open(browser, { variant, theme, phone: true });
      await page.screenshot({ path: join(OUT, `${variant}-${theme.id}-phone.png`), clip: { x: 0, y: 0, width: 390, height: 260 }, animations: "disabled", caret: "hide" });
      if (theme.id === "collie-dark") await page.screenshot({ path: join(OUT, `${variant}-collie-dark-phone-full.png`), animations: "disabled", caret: "hide" });
      save(`${variant}-${theme.id}-phone`, await measurePhone(page));
      if (process.env.SH_DUMP === "1") writeFileSync(join(OUT, "data", `${variant}-${theme.id}-phone.html`), await page.locator("header").first().evaluate((h) => h.parentElement!.outerHTML.slice(0, 60000)));
      await page.context().close();
    });
  }
}
