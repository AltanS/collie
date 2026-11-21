import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { PaneChatResponse, TranscriptPart } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureWalkyAgent } from "@/test/handlers";

import { installApiStub, paneCapture } from "./fixtures/api";
import { STILL_MARK } from "./fixtures/still-mark";
import { wideSnapshot } from "./fixtures/wide-herd";

// LAB, THROWAWAY (experiments/desktop-surfaces, agent A). Not a test: it draws the wide layout in every
// proposal (`?sf=0..3`) and theme, writes the shots, and with SF_MEASURE=1 writes a table of every painted
// surface (composited colour, OKLCH L, the border colours) for the triage. Run with --workers=1.

test.use({ serviceWorkers: "block" });

const OUT = process.env.SF_OUT ?? join(homedir(), "projects/collie-workspace/experiments/desktop-surfaces/A");
const STATES = (process.env.SF_STATES ?? "0,1,2,3").split(",");
const VIEW = { width: 1440, height: 900 } as const;
const LAYOUT_KEY = "collie:wide-layout:v1";

const snapshot = wideSnapshot({ spaces: 5, blocked: ["w3:p1"], unseen: ["w4:p2"] });
for (const a of snapshot.agents) a.hasSession = true;

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
let seq = FIXTURE_SEQ_BASE;
function turn(role: "user" | "assistant", parts: TranscriptPart[], i: number) {
  seq += 1;
  return { uuid: `s${seq}`, ts: new Date(NOW + i * 20_000).toISOString(), role, parts, seq };
}

function richChat(paneId: string): PaneChatResponse {
  seq = FIXTURE_SEQ_BASE;
  const upserts = [
    turn("user", [{ kind: "text", text: "The release notes page shows the old date. Find where it comes from and fix it." }], 0),
    turn(
      "assistant",
      [
        { kind: "text", text: "I look at the page and the build step first." },
        { kind: "tool", name: "Read", summary: "docs/release-notes.md", call: { kind: "read", path: "docs/release-notes.md" }, result: { text: "ok" } },
        { kind: "tool", name: "Grep", summary: "buildDate", call: { kind: "search", query: "buildDate", where: "src", hits: 4 }, result: { text: "4 hits" } },
        {
          kind: "tool",
          name: "Bash",
          summary: "git log -3 --format='%h %ad %s' -- scripts/stamp.ts",
          call: { kind: "execute", command: "git log -3 --format='%h %ad %s' -- scripts/stamp.ts", description: "Find when the stamp script changed", exitCode: 0 },
          result: { text: "9f2c1ab Tue Nov 18 fix(stamp): read the tag date\n41d0e77 Mon Nov 10 chore: move the stamp\n0ab33c9 Fri Oct 31 feat: stamp the build" },
        },
      ],
      1,
    ),
    turn(
      "assistant",
      [
        {
          kind: "text",
          text:
            "The date comes from `scripts/stamp.ts`. It reads the date of the newest tag, not the date of the build, so a page built today still shows the last tag's date.\n\n" +
            "1. The stamp runs before the tag exists, so it falls back to the previous tag.\n" +
            "2. The page reads the stamp from `dist/meta.json` and never refreshes it.\n" +
            "3. A rebuild without a new tag keeps the old date.\n\n" +
            "The fix is one line:\n\n```ts\nexport const buildDate = new Date(process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now());\n```\n\n" +
            "Do you want me to run the tests and commit it?",
        },
      ],
      2,
    ),
    turn("user", [{ kind: "text", text: "Yes, run the tests first." }], 3),
    turn(
      "assistant",
      [
        {
          kind: "tool",
          name: "Bash",
          summary: "bun test scripts/stamp.test.ts",
          call: { kind: "execute", command: "bun test scripts/stamp.test.ts", description: "Run the stamp tests", exitCode: 0 },
          result: { text: " 6 pass\n 0 fail\nRan 6 tests across 1 file. [212.00ms]" },
        },
        { kind: "text", text: "Six tests pass. I commit the fix on the branch `fix/stamp-date` and wait for your word before the push." },
      ],
      4,
    ),
  ];
  return { paneId, available: true, page: "live", gen: FIXTURE_CHAT_GEN, rev: 1, head: seq, oldest: FIXTURE_SEQ_BASE + 1, hasOlder: false, upserts };
}

function shortChat(paneId: string): PaneChatResponse {
  seq = FIXTURE_SEQ_BASE;
  const upserts = [
    turn("user", [{ kind: "text", text: "Check the lint warnings in the settings module." }], 0),
    turn(
      "assistant",
      [
        { kind: "tool", name: "Bash", summary: "bun run lint src/settings", call: { kind: "execute", command: "bun run lint src/settings", exitCode: 0 }, result: { text: "0 warnings" } },
        { kind: "text", text: "There are no warnings left in the settings module. The last two went away with yesterday's change to the select." },
      ],
      1,
    ),
  ];
  return { paneId, available: true, page: "live", gen: FIXTURE_CHAT_GEN, rev: 1, head: seq, oldest: FIXTURE_SEQ_BASE + 1, hasOlder: false, upserts };
}

async function installWorld(page: Page): Promise<void> {
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }));
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/chat$/.test(url.pathname),
    (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? "");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(id === "w1:p1" ? richChat(id) : shortChat(id)) });
    },
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/walky$/.test(url.pathname),
    (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? "");
      const rows = id === "w1:p1" ? [{ ...fixtureWalkyAgent, to: "w1:p1", at: NOW + 50_000, receipt: { ...fixtureWalkyAgent.receipt, target: "w1:p1" } }] : [];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: rows }) });
    },
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? "");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ paneId: id, text: paneCapture("claude--done"), truncated: false, revision: 1 }) });
    },
  );
}

interface Look {
  scheme: "dark" | "light";
  theme?: string;
  terminal?: boolean;
  rail?: boolean;
}

async function open(page: Page, state: string, look: Look): Promise<void> {
  await page.setViewportSize(VIEW);
  await page.emulateMedia({ colorScheme: look.scheme, reducedMotion: "reduce" });
  await page.addInitScript(
    ([scheme, theme, terminal, sf]) => {
      if (sessionStorage.getItem("sf-seeded") === "1") return;
      sessionStorage.setItem("sf-seeded", "1");
      localStorage.setItem("collie:theme:v1", scheme);
      const design = theme ? { markMoves: false, theme } : { markMoves: false };
      localStorage.setItem("collie:design:v1", JSON.stringify(design));
      if (terminal) localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" }));
      if (sf === "0") localStorage.removeItem("collie:lab:surfaces");
      else localStorage.setItem("collie:lab:surfaces", sf);
    },
    [look.scheme, look.theme ?? "", look.terminal === true, state] as const,
  );
  void STILL_MARK;
  await installWorld(page);
  await page.goto("/pane/w1%3Ap1");
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(1);
  await page.evaluate(
    (arg) => {
      type Stored = { cols: { key: string; preset: string }[]; focus: string | null };
      // SAFETY: the app wrote this entry on the visit just above, in this shape (lib/wide-layout-store.ts).
      const stored = JSON.parse(localStorage.getItem(arg.key) ?? "{}") as Record<string, Stored>;
      const [space, strip] = Object.entries(stored).find(([, s]) => s.cols.some((c) => c.key.endsWith("w1:p1")))!;
      const first = strip.cols[0]!.key;
      const keyOf = (paneId: string) => first.slice(0, first.length - "w1:p1".length) + paneId;
      stored[space] = { cols: [{ key: keyOf("w1:p1"), preset: "half" }, { key: keyOf("w1:p2"), preset: "half" }], focus: keyOf("w1:p1") };
      localStorage.setItem(arg.key, JSON.stringify(stored));
    },
    { key: LAYOUT_KEY },
  );
  await page.goto("/pane/w1%3Ap1");
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(2);
  if (!look.terminal) await expect(page.locator("section[data-focused]")).toContainText("Six tests pass");
  if (look.rail) {
    await page.locator('[data-slot="sidebar-toggle"]').click();
    await expect(page.locator('[data-slot="rail"]')).toBeVisible();
  }
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(600);
}

/** Every painted box in the wide layout: its effective (composited) fill, OKLCH L, and its edges. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (colours: string[]): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      for (const c of colours) {
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
      }
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    };
    const MAX = 255;
    const DEPTH = 3;
    const css = window.getComputedStyle.bind(window);
    const lin = (v: number) => {
      const c = v / MAX;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const okL = ([r, g, b]: number[]) => {
      const R = lin(r!), G = lin(g!), B = lin(b!);
      const l = Math.cbrt(0.4122214708 * R + 0.5363282 * G + 0.0514459929 * B);
      const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
      const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
      return Math.round((0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 1000) / 1000;
    };
    const hex = (c: number[]) => "#" + c.map((v) => Math.min(v, MAX).toString(16).padStart(2, "0")).join("");
    const chain = (el: Element): string[] => {
      const out: string[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = css(e).backgroundColor;
        out.unshift(bg);
      }
      return out;
    };
    const label = (el: Element) => {
      const slot = el.getAttribute("data-slot");
      const parts: string[] = [];
      for (let e: Element | null = el; e && parts.length < DEPTH; e = e.parentElement) {
        const s = e.getAttribute("data-slot");
        if (s) parts.push(s);
      }
      return `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ""} in ${parts.slice(slot ? 1 : 0).join("<") || "-"}`;
    };
    const root = document.querySelector('[data-slot="wide-layout"]')!;
    const rows: unknown[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const hasBg = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
      const sides = ["Top", "Right", "Bottom", "Left"].filter((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)));
      const shadow = cs.boxShadow !== "none" ? cs.boxShadow : "";
      if (!hasBg && sides.length === 0) continue;
      const fill = paint(chain(el));
      const under = el.parentElement ? paint(chain(el.parentElement)) : fill;
      const edge = sides.length ? paint([...chain(el), cs.getPropertyValue(`border-${sides[0]!.toLowerCase()}-color`)]) : null;
      rows.push({
        el: label(el),
        cls: (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /^(bg|border|divide|ring|shadow|dark:bg|rounded)/.test(c)).join(" "),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        bg: hasBg ? cs.backgroundColor : "",
        fill: hex(fill),
        L: okL(fill),
        underL: okL(under),
        edges: sides.map((s) => s[0]).join(""),
        edge: edge ? hex(edge) : "",
        edgeL: edge ? okL(edge) : null,
        shadow,
      });
    }
    return rows;
  });
}

/** The inks, resolved to sRGB on the root: the text and the status marks the contrast table needs. */
async function inks(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const out: Record<string, number[]> = {};
    for (const t of ["foreground", "muted-foreground", "status-working", "status-blocked", "status-done", "status-idle", "status-info", "pane-active", "ring"]) {
      const probe = document.createElement("span");
      probe.style.color = `var(--${t})`;
      document.body.append(probe);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = getComputedStyle(probe).color;
      ctx.fillRect(0, 0, 1, 1);
      out[t] = Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      probe.remove();
    }
    return out;
  });
}

const LOOKS: [string, Look][] = [
  ["dark", { scheme: "dark" }],
  ["light", { scheme: "light" }],
  ["theme-harbour", { scheme: "dark", theme: "harbour" }],
  ["theme-nightwatch", { scheme: "dark", theme: "nightwatch" }],
  ["dark-terminal", { scheme: "dark", terminal: true }],
  ["dark-rail", { scheme: "dark", rail: true }],
];

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "one project");
});

for (const state of STATES) {
  for (const [name, look] of LOOKS) {
    test(`shot ${state}-${name}`, async ({ page }) => {
      await open(page, state, look);
      await page.screenshot({ path: join(OUT, `${state}-${name}.png`) });
      if (process.env.SF_MEASURE === "1" && (name === "dark" || name === "light" || name.startsWith("theme-"))) {
        writeFileSync(join(OUT, "measure", `${state}-${name}.json`), JSON.stringify(await measure(page), null, 1));
        writeFileSync(join(OUT, "measure", `${state}-${name}.inks.json`), JSON.stringify(await inks(page), null, 1));
      }
    });
  }
}

test("phone stays the same", async ({ browser }) => {
  test.skip(process.env.SF_PHONE !== "1", "on request");
  for (const state of ["0", process.env.SF_PHONE_STATE ?? "1"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, colorScheme: "dark", serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.addInitScript((sf) => {
      localStorage.setItem("collie:theme:v1", "dark");
      localStorage.setItem("collie:design:v1", JSON.stringify({ markMoves: false }));
      if (sf === "0") localStorage.removeItem("collie:lab:surfaces");
      else localStorage.setItem("collie:lab:surfaces", sf);
    }, state);
    await installWorld(page);
    await page.goto("/pane/w1%3Ap1");
    await expect(page.getByText("Six tests pass")).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `phone-${state}.png`) });
    await ctx.close();
  }
});
