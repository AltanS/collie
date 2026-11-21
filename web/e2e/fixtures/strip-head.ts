import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { parseTheme, SHIPPED_THEME_IDS, type Theme } from "@/lib/theme/schema";
import type { AgentView, SnapshotResponse, TabView } from "@/lib/types";

import { STILL_MARK } from "./still-mark";
import { installWideChatWorld } from "./wide-chat";
import { wideSnapshot } from "./wide-herd";

// THE TAB BAR AND THE PANE HEADER, READ FROM THE PAINTED PIXELS (strip-head round, 2026-11-21). A world with five
// tabs in Space 1 (one selected with two panes, one that needs you, one working, one with a long name, one with an
// unseen reply), every bundled theme in the tab look it ships with and in the other one, and the helpers that read a
// contrast from a screenshot rather than from a computed style. Made-up names only.

export type ShippedTheme = (typeof SHIPPED_THEME_IDS)[number];
export type Look = "folder" | "plain";

export const LONG_TAB = "integration-tests-for-the-release-train";
const LONG_PANE = "reviewer-of-the-settings-module-migration";
const LONG_BRANCH = "feature/settings-module-migration-second-pass";

/** A shipped theme's own file, read as the app reads an import. */
function shipped(id: ShippedTheme): Theme {
  const raw = readFileSync(resolve(import.meta.dirname, `../../src/themes/${id}.json`), "utf8");
  const parsed = parseTheme(raw, { maxBytes: 64 * 1024, allowReservedId: true });
  if (!parsed.ok) throw new Error(`${id}.json is refused: ${parsed.refusals[0]?.detail ?? ""}`);
  return parsed.theme;
}

/** The look a shipped theme draws: its own `tabs` word, `plain` when it names none (lib/tab-look.ts). */
export function shippedLook(id: ShippedTheme): Look {
  return shipped(id).surface?.tabs === "folder" ? "folder" : "plain";
}

/** Wear a shipped theme in one half, in the look it ships with or, as an imported twin, in the other one. */
export async function wear(page: Page, id: ShippedTheme, scheme: "dark" | "light", look: Look): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  const own = shipped(id);
  const twin = look === shippedLook(id) ? null : { ...own, id: `${id}-twin`, name: `${own.name} twin`, surface: { ...own.surface, tabs: look } };
  const design = JSON.stringify({ ...STILL_MARK, ...(twin !== null ? { theme: twin.id } : id === "collie" ? {} : { theme: id }) });
  const library = twin === null ? null : JSON.stringify({ version: 1, themes: [twin] });
  await page.addInitScript(
    ([s, d, l]) => {
      localStorage.setItem("collie:theme:v1", s);
      localStorage.setItem("collie:design:v1", d);
      if (l !== null) localStorage.setItem("collie:themes:v1", l);
    },
    [scheme, design, library] as const,
  );
}

function world(): SnapshotResponse {
  const base = wideSnapshot({ spaces: 5, crew: true });
  const proto = base.agents.find((a) => a.paneId === "w1:p1");
  if (proto === undefined) throw new Error("the herd has no w1:p1");
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
  const tabs: TabView[] = labels.map((label, i) => ({ tabId: `w1:t${i + 1}`, workspaceId: "w1", number: i + 1, label, focused: i === 0, paneCount: i === 0 ? 2 : 1, host: "lodge" }));
  return {
    ...base,
    agents: [...agents, ...base.agents.filter((a) => a.workspaceId !== "w1")],
    shellPanes: base.shellPanes.filter((p) => p.workspaceId !== "w1"),
    workspaces: base.workspaces.map((w) => (w.workspaceId === "w1" ? { ...w, label: "space-01", tabCount: 5, paneCount: 6 } : w)),
    tabs: [...tabs, ...base.tabs.filter((t) => t.workspaceId !== "w1")],
  };
}

/** The world's routes. Call before the first `page.goto`. */
export async function installStripHeadWorld(page: Page): Promise<void> {
  await installWideChatWorld(page);
  const snapshot = world();
  await page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }));
}

/** Space 1 with its first two panes as two columns, the first in focus. */
export async function openTwoColumns(page: Page): Promise<void> {
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await page.locator('[data-slot="wide-layout"] section[data-col-key]').first().waitFor();
  await page.evaluate(() => {
    type Stored = { cols: { key: string; preset: string }[]; focus: string | null };
    const key = "collie:wide-layout:v1";
    // SAFETY: the app wrote this entry on the visit just above, in this shape (lib/wide-layout-store.ts).
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, Stored>;
    const entry = Object.entries(stored).find(([, s]) => s.cols.some((c) => c.key.endsWith("w1:p1")));
    if (entry === undefined) throw new Error("no strip for w1:p1");
    const [space, strip] = entry;
    const first = strip.cols[0]?.key ?? "";
    const keyOf = (id: string) => first.slice(0, first.length - "w1:p1".length) + id;
    stored[space] = { cols: ["w1:p1", "w1:p2"].map((id) => ({ key: keyOf(id), preset: "half" })), focus: keyOf("w1:p1") };
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await page.locator('[data-slot="wide-layout"] section[data-col-key]').nth(1).waitFor();
  await page.locator('[data-slot="wide-layout"] section[data-focused]').getByText("Six tests pass").waitFor();
  await page.mouse.move(1430, 890);
}

// ── Pixels ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type Rgb = [number, number, number];

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG contrast of two sRGB colours, to two decimals. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** Every device pixel of a CSS box, read back from a screenshot, top to bottom and left to right. */
export async function pixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Rgb[]> {
  const png = (await page.screenshot({ clip, animations: "disabled", caret: "hide" })).toString("base64");
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const px: [number, number, number][] = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0]);
    return px;
  }, png);
}

export interface Reading {
  fg: string;
  bg: string;
  ratio: number;
}

/** The ink of a box against its ground: the ground is the commonest pixel, the ink the pixel farthest from it. */
export async function ink(target: Locator, inset = 0): Promise<Reading> {
  const box = await target.first().boundingBox();
  if (box === null) throw new Error("the box is not on screen");
  const px = await pixels(target.page(), { x: box.x + inset, y: box.y + inset, width: Math.max(1, box.width - 2 * inset), height: Math.max(1, box.height - 2 * inset) });
  const count = new Map<string, { c: Rgb; n: number }>();
  for (const p of px) {
    const k = p.join(",");
    const e = count.get(k);
    if (e === undefined) count.set(k, { c: p, n: 1 });
    else e.n += 1;
  }
  const bg = [...count.values()].toSorted((a, b) => b.n - a.n)[0]?.c ?? [0, 0, 0];
  let fg: Rgb = bg;
  for (const p of px) if (contrast(p, bg) > contrast(fg, bg)) fg = p;
  return { fg: hex(fg), bg: hex(bg), ratio: contrast(fg, bg) };
}

export interface Edge {
  line: string;
  above: number;
  below: number;
}

/** A region's lower edge at `x`: the line's colour against the ground above it and the ground below it. */
export async function lowerEdge(page: Page, region: Locator, x: number): Promise<Edge> {
  const box = await region.first().boundingBox();
  if (box === null) throw new Error("the region is not on screen");
  const px = await pixels(page, { x: Math.round(x), y: box.y + box.height - 6, width: 1, height: 12 });
  const above = px[0] ?? [0, 0, 0];
  const below = px[px.length - 1] ?? [0, 0, 0];
  let line: Rgb = above;
  let score = -1;
  for (const p of px.slice(2, -2)) {
    const s = Math.min(contrast(p, above), contrast(p, below));
    if (s > score) {
      score = s;
      line = p;
    }
  }
  return { line: hex(line), above: contrast(line, above), below: contrast(line, below) };
}
