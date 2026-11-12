import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, PaneChatResponse, SnapshotResponse, TranscriptEntry } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureAgents, fixtureSnapshot } from "@/test/handlers";

import { installApiStub, installPaneWorld, paneCapture } from "./fixtures/api";

// THE MODEL TAG NEVER COVERS THE LAST LINE (#759). The tag floats on the mirror's bottom-right corner
// (components/model-tag.tsx), absolute, so it takes no layout of its own. The scrollers used to end in
// `pb-3` (12px) and the tag's top edge stands 16px above the box's bottom, so the newest line sat 4px
// under the tag, and a long last line lost its right end. The scrollers now keep the tag's height
// clear below the last line while a tag shows (`TailRoomContext`), so a reader at the tail sees the
// whole line above it. Only a real layout engine can say where a line ends; jsdom has no layout.
//
// Both bodies are measured (the journal Chat and the terminal mirror), with the tag and without it,
// with the keyboard up, and with a docked card. Set `COLLIE_SHOTS=<dir>` to write a screenshot per case.

const PANE_ID = "w1:p1";
const URL = `/pane/${encodeURIComponent(PANE_ID)}`;

/** The two phone sizes the repair is measured at. */
const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
] as const;

const LONG_LAST = "The last words of the reply run on to the far right edge of the line so that the right-aligned model tag would sit exactly on top of them, ENDMARK";

function agentWith(tag: boolean): SnapshotResponse {
  const agent: AgentView = { ...fixtureAgents[0]!, status: "idle", hasSession: true };
  if (tag) {
    agent.model = "claude-opus-5-5";
    agent.effort = "medium";
    agent.usage = { context: 42, cost: 0.57 };
  }
  return { ...fixtureSnapshot, agents: [agent], shellPanes: [] };
}

function chatOf(turns: number): Extract<PaneChatResponse, { available: true }> {
  const entries: TranscriptEntry[] = Array.from({ length: turns }, (_, i): TranscriptEntry => ({
    uuid: `u${i}`,
    ts: `2026-07-25T06:${String(10 + i).padStart(2, "0")}:00.000Z`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ kind: "text", text: i === turns - 1 ? LONG_LAST : `turn ${i}: some words of an earlier reply` }],
  }));
  return {
    paneId: PANE_ID,
    available: true,
    page: "live",
    gen: FIXTURE_CHAT_GEN,
    rev: 1,
    head: FIXTURE_SEQ_BASE + entries.length - 1,
    oldest: FIXTURE_SEQ_BASE,
    hasOlder: false,
    upserts: entries.map((entry, index) => Object.assign({}, entry, { seq: FIXTURE_SEQ_BASE + index })),
  };
}

/** A screen taller than the phone, its last row long. */
function screenOf(rows: number): string {
  const lines = Array.from({ length: rows }, (_, i) => `row ${i} of the terminal screen`);
  lines.push(LONG_LAST);
  return lines.join("\r\n");
}

interface Body {
  name: "chat" | "terminal";
  /** The screen the world serves for this body. */
  screen: string;
}

const BODIES: readonly Body[] = [
  { name: "chat", screen: "" },
  { name: "terminal", screen: screenOf(60) },
];

async function open(page: Page, body: Body, options: { tag: boolean; card?: boolean }): Promise<void> {
  await installApiStub(page);
  await page.addInitScript(
    (view) => window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: view })),
    body.name,
  );
  const screen = options.card === true ? paneCapture("claude--permission-edit") : body.screen === "" ? "idle" : body.screen;
  await installPaneWorld(page, {
    paneId: PANE_ID,
    snapshot: agentWith(options.tag),
    chat: chatOf(40),
    screens: { shown: screen },
    start: "shown",
  });
  await page.goto(URL);
  await expect(page.locator('[data-slot="pane-reading"]')).toBeVisible();
  await expect(page.getByText("ENDMARK").or(page.locator('[data-slot="card-dock"]')).first()).toBeVisible();
  // The tail pins in effects after the first paint.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

interface Gap {
  tag: { top: number; bottom: number; left: number; right: number } | null;
  /** The last painted line of text in the reading box, in the tail position. */
  line: { top: number; bottom: number; left: number; right: number };
  /** The box's own bottom edge, for the log. */
  boxBottom: number;
  atBottom: boolean;
  padBottom: number;
}

async function measure(page: Page): Promise<Gap> {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-slot="pane-reading"]')!;
    const scroller = [...box.querySelectorAll<HTMLElement>("*")].find((el) => getComputedStyle(el).overflowY === "auto" && el.scrollHeight > el.clientHeight)!;
    scroller.scrollTop = scroller.scrollHeight;
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
    let last: DOMRect | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() === "") continue;
      const parent = node.parentElement;
      if (parent === null || parent.closest(".sr-only") !== null) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      const rect = rects.at(-1);
      if (rect !== undefined && (last === null || rect.bottom >= last.bottom - 1)) last = rect;
    }
    const tag = document.querySelector('[data-slot="model-tag"]')?.getBoundingClientRect() ?? null;
    return {
      tag: tag === null ? null : { top: tag.top, bottom: tag.bottom, left: tag.left, right: tag.right },
      line: { top: last!.top, bottom: last!.bottom, left: last!.left, right: last!.right },
      boxBottom: box.getBoundingClientRect().bottom,
      atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1,
      padBottom: Number.parseFloat(getComputedStyle(scroller).paddingBottom),
    };
  });
}

/** How far the last line ends above the tag's top edge: positive is clear, negative is covered. */
function clearance(gap: Gap): number {
  if (gap.tag === null) throw new Error("no tag to clear");
  return gap.tag.top - gap.line.bottom;
}

async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.COLLIE_SHOTS;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test.use({ serviceWorkers: "block" });

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "phone sizes; each case sets its own viewport");
});

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;
  for (const body of BODIES) {
    test(`${size} ${body.name}: the last line ends above the tag`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, body, { tag: true });
      const gap = await measure(page);
      console.log(`tag-room ${body.name} ${size} ${JSON.stringify(gap)} clearance=${clearance(gap)}`);
      await shoot(page, `${body.name}-${size}-tag`);
      expect(gap.atBottom).toBe(true);
      expect(clearance(gap)).toBeGreaterThanOrEqual(0);
    });

    test(`${size} ${body.name}: with no tag the tail keeps its 12px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, body, { tag: false });
      const gap = await measure(page);
      console.log(`tag-room ${body.name} ${size} no-tag ${JSON.stringify(gap)}`);
      await shoot(page, `${body.name}-${size}-notag`);
      expect(gap.tag).toBeNull();
      expect(gap.padBottom).toBe(12);
    });
  }
}

test("with the keyboard up the Chat tail still ends above the tag", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, BODIES[0]!, { tag: true });
  await page.getByRole("textbox", { name: en["composer.placeholder.reply"] }).focus();
  await page.setViewportSize({ width: 390, height: 508 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const gap = await measure(page);
  console.log(`tag-room chat keyboard ${JSON.stringify(gap)} clearance=${clearance(gap)}`);
  await shoot(page, "chat-390-keyboard");
  expect(clearance(gap)).toBeGreaterThanOrEqual(0);
});

test("with the keyboard up the terminal tail still ends above the tag", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, BODIES[1]!, { tag: true });
  await page.getByRole("textbox", { name: en["composer.placeholder.reply"] }).focus();
  await page.setViewportSize({ width: 390, height: 508 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const gap = await measure(page);
  console.log(`tag-room terminal keyboard ${JSON.stringify(gap)} clearance=${clearance(gap)}`);
  await shoot(page, "terminal-390-keyboard");
  expect(clearance(gap)).toBeGreaterThanOrEqual(0);
});

test("with a docked card the Chat tail still ends above the tag", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, BODIES[0]!, { tag: true, card: true });
  await expect(page.locator('[data-slot="card-dock"]')).toBeVisible();
  const gap = await measure(page);
  console.log(`tag-room chat card ${JSON.stringify(gap)} clearance=${clearance(gap)}`);
  await shoot(page, "chat-390-card");
  expect(clearance(gap)).toBeGreaterThanOrEqual(0);
});
