import type { Page } from "@playwright/test";

import type { PaneChatResponse, TranscriptPart } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureWalkyAgent } from "@/test/handlers";

import { installApiStub, paneCapture } from "./api";
import { wideSnapshot } from "./wide-herd";

// A LARGE-SCREEN WORLD WITH A REAL TRANSCRIPT: five Spaces (wide-herd.ts), and in Space 1 two agent panes
// whose Chat holds what a column carries day to day: your turns, a run of tool steps, a command, prose with
// inline code, a fenced code block and a WalkyTalky message from another agent. Every pane's Terminal view
// reads a recorded Claude screen. Made-up names only.

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);

export const wideChatSnapshot = (() => {
  const snapshot = wideSnapshot({ spaces: 5, blocked: ["w3:p1"], unseen: ["w4:p2"] });
  for (const agent of snapshot.agents) agent.hasSession = true;
  return snapshot;
})();

/** The WalkyTalky message in the rich transcript, addressed to the pane that shows it. */
const walky = { ...fixtureWalkyAgent, to: "w1:p1", receipt: { ...fixtureWalkyAgent.receipt, target: "w1:p1" } };

function chat(paneId: string, turns: readonly { role: "user" | "assistant"; parts: TranscriptPart[] }[]): PaneChatResponse {
  const upserts = turns.map((turn, i) => ({
    uuid: `${paneId}-${i}`,
    ts: new Date(NOW + i * 20_000).toISOString(),
    role: turn.role,
    parts: turn.parts,
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

/** The focused pane's day: every kind of box the transcript draws, the WalkyTalky card among them. */
export function richChat(paneId: string): PaneChatResponse {
  return chat(paneId, [
    { role: "user", parts: [{ kind: "text", text: "The release notes page shows the old date. Find where it comes from and fix it." }] },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "I look at the page and the build step first." },
        { kind: "tool", name: "Read", summary: "docs/release-notes.md", call: { kind: "read", path: "docs/release-notes.md" }, result: { text: "ok" } },
        { kind: "tool", name: "Grep", summary: "buildDate", call: { kind: "search", query: "buildDate", where: "src", hits: 4 }, result: { text: "4 hits" } },
        {
          kind: "tool",
          name: "Bash",
          summary: "git log -3 -- scripts/stamp.ts",
          call: { kind: "execute", command: "git log -3 -- scripts/stamp.ts", description: "Find when the stamp script changed", exitCode: 0 },
          result: { text: "9f2c1ab fix(stamp): read the tag date" },
        },
        {
          kind: "text",
          text:
            "The date comes from `scripts/stamp.ts`. It reads the date of the newest tag, not the date of the build.\n\n" +
            "1. The stamp runs before the tag exists.\n2. The page never refreshes the stamp.\n\n" +
            "The fix is one line:\n\n```ts\nexport const buildDate = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Date.now() / 1000) * 1000);\n```",
        },
      ],
    },
    { role: "user", parts: [{ kind: "text", text: `[walky-talky ${walky.id}] from agent ${walky.from.address} (claude, ${walky.from.label})\n${walky.body}` }] },
    {
      role: "assistant",
      parts: [
        {
          kind: "tool",
          name: "Bash",
          summary: "bun test scripts/stamp.test.ts",
          call: { kind: "execute", command: "bun test scripts/stamp.test.ts", description: "Run the stamp tests", exitCode: 0 },
          result: { text: " 6 pass\n 0 fail" },
        },
        { kind: "text", text: "Six tests pass. I commit the fix on the branch `fix/stamp-date` and wait for your word before the push." },
      ],
    },
  ]);
}

function shortChat(paneId: string): PaneChatResponse {
  return chat(paneId, [
    { role: "user", parts: [{ kind: "text", text: "Check the lint warnings in the settings module." }] },
    {
      role: "assistant",
      parts: [
        { kind: "tool", name: "Bash", summary: "bun run lint src/settings", call: { kind: "execute", command: "bun run lint src/settings", exitCode: 0 }, result: { text: "0 warnings" } },
        { kind: "text", text: "There are no warnings left in the settings module." },
      ],
    },
  ]);
}

const paneOf = (url: URL) => decodeURIComponent(url.pathname.split("/")[3] ?? "");

/** Install the world. Call before the first `page.goto`. */
export async function installWideChatWorld(page: Page): Promise<void> {
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(wideChatSnapshot) }));
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/chat$/.test(url.pathname),
    (route) => {
      const id = paneOf(new URL(route.request().url()));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(id === "w1:p1" ? richChat(id) : shortChat(id)) });
    },
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/walky$/.test(url.pathname),
    (route) => {
      const id = paneOf(new URL(route.request().url()));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: id === "w1:p1" ? [walky] : [] }) });
    },
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = paneOf(new URL(route.request().url()));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ paneId: id, text: paneCapture("claude--done"), truncated: false, revision: 1 }) });
    },
  );
}

const LAYOUT_KEY = "collie:wide-layout:v1";

/**
 * Open Space 1 with these panes as its columns, half a strip each, `focus` in focus. The first visit
 * writes the space's own strip, so the keys come from the app (the pane's full address), never re-typed.
 */
export async function openColumns(page: Page, panes: readonly string[], focus: string): Promise<void> {
  await page.goto(`/pane/${encodeURIComponent(focus)}`);
  await page.locator('[data-slot="wide-layout"] section[data-col-key]').first().waitFor();
  await page.evaluate(
    (arg) => {
      type Stored = { cols: { key: string; preset: string }[]; focus: string | null };
      // SAFETY: the app wrote this entry on the visit just above, in this shape (lib/wide-layout-store.ts).
      const stored = JSON.parse(localStorage.getItem(arg.key) ?? "{}") as Record<string, Stored>;
      const [space, strip] = Object.entries(stored).find(([, s]) => s.cols.some((c) => c.key.endsWith(arg.focus)))!;
      const first = strip.cols[0]!.key;
      const keyOf = (paneId: string) => first.slice(0, first.length - arg.focus.length) + paneId;
      stored[space] = { cols: arg.panes.map((paneId) => ({ key: keyOf(paneId), preset: "half" })), focus: keyOf(arg.focus) };
      localStorage.setItem(arg.key, JSON.stringify(stored));
    },
    { key: LAYOUT_KEY, panes, focus },
  );
  await page.goto(`/pane/${encodeURIComponent(focus)}`);
  await page.locator('[data-slot="wide-layout"] section[data-col-key]').nth(panes.length - 1).waitFor();
}
