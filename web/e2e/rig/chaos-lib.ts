// The chaos leg (M102 spec 15, decision 3): the browser leg's rig, with the world going wrong in the
// middle of a person's input. Each case passes when the person gets the input through from the phone,
// or the phone says in words what became of it. No input is lost without words.
//
// The cases send into a SHELL pane of the rig (`echo chaos-<id>-<n>`), so no case spends a model turn
// and none needs a recording: the shell's own echo of the line is the proof that the text arrived, and
// counting it proves "at most once". A shell pane takes the Send Protocol's blind road (no profile); the
// cases are about the request, the link, the restart and the second phone, not about a reader.
//
// The leg is its own Playwright run, outside the solo and crew legs' match patterns, so it changes no
// gate until the lead adds it to one (README "The browser leg"):
//
//     cd web && bunx playwright test -c e2e/rig/chaos.config.ts        # solo rig
//     cd web && bunx playwright test -c e2e/rig/chaos-crew.config.ts   # crew rig
//
// A case whose world needs a seam the rig does not have is written with `test.skip` and names the seam
// in CHAOS_CASES. The rows go to `<run dir>/chaos-ledger.jsonl`, one per case.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Page } from "@playwright/test";

import { STATE_ROOT, sleep, startInPane, type Machine } from "./rig-lib";
import { message, runDir, tap, type Host, type Rig, type TapLog, type TapRecorder } from "./leg";

/** One chaos case: its id, its world, which rig it needs, and the seam it waits for when it cannot run yet. */
export interface ChaosCase {
  readonly id: string;
  readonly title: string;
  readonly rig: "solo" | "crew";
  /** The seam the rig lacks for this world, or null when the case runs. */
  readonly seam: string | null;
}

export const CHAOS_CASES = [
  {
    id: "bridge-dies-mid-send",
    title: "C1 the lead's bridge dies in the middle of a send and comes back",
    rig: "solo",
    seam: "rig.ts has no verb that stops and restarts the LEAD's bridge (only `crew stop-member | start-member` for the member, SIGUSR1/SIGUSR2 in the daemon). Needed: `rig.ts bridge restart`, the same stopBridge/bridgeReady pair for machine `lead`. Until then C1m runs the same world on the member.",
  },
  { id: "member-dies-mid-send", title: "C1m the member's bridge dies in the middle of a send to its pane and comes back", rig: "crew", seam: null },
  { id: "crew-link-drops", title: "C2 the crew link is down when the person taps Send on a member's pane", rig: "crew", seam: null },
  {
    id: "two-bridges-one-pane",
    title: "C3 two bridges watch one pane, and the person sends through each",
    rig: "solo",
    seam: "the rig starts one bridge per Herdr session. Needed: `rig.ts up --second-bridge`, a second `bun bridge/index.ts` on the same Herdr socket with its own COLLIE_STATE_DIR, port and paired device, as a release lane and a dev lane on one machine are.",
  },
  {
    id: "resize-mid-send",
    title: "C4 the pane is resized while the send runs",
    rig: "solo",
    seam: "a rig pane fills its tab, and Herdr's pane.resize moves only a split (HERDR_API.md, pane.resize). Needed: rig-lib `resizeDuring(paneId)`: a split beside the pane at start, then `pane.resize` on it while the send runs.",
  },
  { id: "second-phone", title: "C5 a second phone sends to the same pane at the same moment", rig: "solo", seam: null },
  {
    id: "slow-mux",
    title: "C6 the multiplexer answers slowly (every read and write waits)",
    rig: "solo",
    seam: "the bridge has no injected delay on its multiplexer. Needed: a test-only `COLLIE_RIG_MUX_DELAY_MS` that the rig sets and the Herdr adapter (bridge/mux/herdr/adapter.ts) waits before each read and write, never read outside the rig.",
  },
  {
    id: "background-job",
    title: "C7 the agent runs as a background job (the shadowed pane), and the person sends to it",
    rig: "solo",
    seam: "the rig cannot start a harness as a durable job that shadows its pane (bridge/inside/hub.ts:308-326). Needed: `rig.ts start <harness> --job`, the agent run under the pane's job so the bridge reads the pane as shadowed.",
  },
] as const satisfies readonly ChaosCase[];

export type ChaosId = (typeof CHAOS_CASES)[number]["id"];

export function chaosCase(id: ChaosId): ChaosCase {
  const found = CHAOS_CASES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no chaos case ${id}`);
  return found;
}

export type ChaosVerdict = "pass" | "fail" | "skipped";

/** One row of the chaos ledger. */
export interface ChaosRow {
  readonly id: ChaosId;
  readonly verdict: ChaosVerdict;
  readonly note: string;
  readonly taps?: readonly TapLog[];
}

export function recordChaos(row: ChaosRow): void {
  appendFileSync(join(runDir(), "chaos-ledger.jsonl"), `${JSON.stringify(row)}\n`);
}

/** The rig CLI, for the member's stop and start. */
const RIG_TS = resolve(import.meta.dirname, "rig.ts");

export function stopMember(): void {
  execFileSync("bun", [RIG_TS, "crew", "stop-member"], { stdio: "inherit", timeout: 60_000 });
}

export function startMember(): void {
  execFileSync("bun", [RIG_TS, "crew", "start-member"], { stdio: "inherit", timeout: 90_000 });
}

/** A shell pane on a machine of the rig, for the chaos cases: a fresh workspace running the default shell. */
export async function shellPane(rig: Rig, machine: Machine, host: Host, label: string): Promise<string> {
  const cwd = join(STATE_ROOT, "chaos", label);
  mkdirSync(cwd, { recursive: true });
  const paneId = await startInPane(cwd, `chaos-${label}`, "clear", machine);
  // The bridge names the pane in its snapshot once it has read it.
  const seen = await rig.until(() => rig.pane(paneId, host), (pane) => pane !== null, 30_000, 700);
  if (seen === null) throw new Error(`the bridge never listed the chaos shell pane ${paneId}`);
  return paneId;
}

/** The line a case sends: unique per case and tap, so its echo on the screen counts its arrivals. */
export function chaosLine(id: ChaosId, n: number): string {
  return `echo chaos-${id}-${String(n)}-${String(Date.now() % 100_000)}`;
}

/** How many times the shell printed the line's word on its own row (the command line itself is `echo ...`). */
export function arrivals(screen: string, line: string): number {
  const word = line.replace(/^echo /u, "");
  return screen.split("\n").filter((row) => row.trim() === word).length;
}

/**
 * The words the phone shows about the last input: the composer's status area and every notice or
 * alert. Empty when it says nothing.
 */
export async function phoneWords(page: Page): Promise<string> {
  const parts = await page.locator('[data-slot="status-area"], [role="status"], [role="alert"]').allInnerTexts();
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" | ");
}

/** Type a line in the composer and tap Send, as a person does; the tap's log. */
export async function sendLine(page: Page, recorder: TapRecorder, line: string, label: string): Promise<TapLog> {
  const box = page.getByRole("textbox").last();
  await box.fill(line);
  return tap(recorder, page.getByRole("button", { name: message("composer.send.sendAria"), exact: true }), label, { answerMs: 25_000 });
}

/**
 * The end every chaos case checks: within `ms`, the line arrived exactly once, or the phone shows words
 * about it. Returns what it saw.
 */
export async function settled(rig: Rig, page: Page, paneId: string, host: Host, line: string, ms: number): Promise<{ readonly arrived: number; readonly words: string }> {
  const end = Date.now() + ms;
  let arrived = 0;
  let words = "";
  for (;;) {
    arrived = arrivals(await rig.screen(paneId, 80, host).catch(() => ""), line);
    words = await phoneWords(page).catch(() => "");
    if (arrived > 0 || words !== "" || Date.now() > end) break;
    await sleep(700);
  }
  return { arrived, words };
}

/** The Send button is live again (not disabled, not aria-disabled) once the input ended. */
export async function sendLive(page: Page): Promise<boolean> {
  const send = page.getByRole("button", { name: message("composer.send.sendAria"), exact: true });
  await page.getByRole("textbox").last().fill("x");
  const live = (await send.isEnabled().catch(() => false)) && (await send.getAttribute("aria-disabled").catch(() => null)) !== "true";
  await page.getByRole("textbox").last().fill("");
  return live;
}
