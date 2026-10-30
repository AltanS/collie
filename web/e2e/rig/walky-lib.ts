// What the walky talky cases share: reading a pane's message list, the screen patterns of a header, and
// the operator's message from the phone, which case 6 (Claude) and case 7 (pi, omp) run alike.
//
// Every case is judged twice, by the bridge's receipt and by the pane's own screen. A receipt that says
// `delivered` while the screen shows nothing, or a screen that shows a line the receipt calls refused,
// fails the case.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Browser, Page } from "@playwright/test";
import { devices } from "@playwright/test";

import { asJsonNumber, asJsonObject, asJsonString, type JsonObject } from "../../src/lib/json";
import { SETUPS, harnessDirs, type HarnessId } from "./harnesses";
import {
  NotReached,
  PHONE_DEVICE,
  capture,
  captureScreen,
  freeSurface,
  hold,
  jsonRows,
  message,
  phoneOn,
  sendFromComposer,
  spendTurn,
  tap,
  tapWords,
  waitIdle,
  type Rig,
  type ScenarioId,
  type ScenarioResult,
  type TapLog,
  type TapRecorder,
  type Trail,
} from "./leg";
import { DEVICE_LABEL, machineDirs, memGuard, paneMarkers, readRun, sleep, startInPane, type Machine } from "./rig-lib";

export const PHONE = devices[PHONE_DEVICE];

/** How long a reply on Haiku may take before the case gives up on it. */
export const REPLY_MS = 120_000;

/** A literal string as a RegExp source. */
export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A literal as a RegExp source that lets any run of white space stand for a space. A terminal wraps a
 * long header at its own width, in the middle of a phrase, so a pattern with a plain space misses it.
 */
export function wrapped(text: string): string {
  return text.split(/\s+/u).map(escape).join("\\s+");
}

/** The single-pane address of a pane on a solo install, which is what the rig's bridge is. */
export const addressOf = (paneId: string): string => `local/${paneId}`;

/**
 * An agent's address as the bridge writes it, without the pane instance token (`#` and four
 * characters) that `who` and a sender's `from.address` carry. Compare it with {@link addressOf}.
 */
export const withoutInstance = (address: string): string => address.replace(/#[a-z0-9]{4}$/u, "");

/** A RegExp source for an agent's address in a header: the bare address, and its token if any. */
export const addressPattern = (address: string): string => `${escape(address)}(?:#[a-z0-9]{4})?`;

/** A fresh message id: `wt_` and 12 characters of [a-z0-9], as the phone mints one. */
export function mintId(): string {
  let out = "wt_";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  while (out.length < 15) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** The messages that reached one pane, newest first, each with its receipt (`GET /api/pane/:id/walky`). */
export async function walkyRows(rig: Rig, paneId: string, limit = 50): Promise<JsonObject[]> {
  return jsonRows(asJsonObject(await rig.get(`/api/pane/${encodeURIComponent(paneId)}/walky?limit=${String(limit)}`))?.messages);
}

/** The receipt state of one row, or null. */
export const stateOf = (row: JsonObject | undefined): string | null => asJsonString(asJsonObject(row?.receipt)?.state) ?? null;

/** The receipt reason of one row, or null. */
export const reasonOf = (row: JsonObject | undefined): string | null => asJsonString(asJsonObject(row?.receipt)?.reason) ?? null;

/** The first row of a pane's list that `pick` accepts, polled until it is there. */
export async function firstRow(rig: Rig, paneId: string, pick: (row: JsonObject) => boolean, ms: number): Promise<JsonObject | null> {
  const row = await rig.until(
    async () => (await walkyRows(rig, paneId)).find(pick) ?? null,
    (found) => found !== null,
    ms,
    700,
  );
  return row;
}

/** The row of one message id in a pane's list, once it is there. */
export async function rowOf(rig: Rig, paneId: string, id: string, ms: number): Promise<JsonObject | null> {
  return firstRow(rig, paneId, (row) => row.id === id, ms);
}

/** The message's receipt state once it left `accepted`, read from the pane's own walky list. */
export async function settledWalky(rig: Rig, paneId: string, id: string, ms: number): Promise<string> {
  const state = await rig.until(
    async () => stateOf((await walkyRows(rig, paneId)).find((row) => row.id === id)),
    (value) => value !== null && value !== "accepted",
    ms,
    700,
  );
  return state ?? `not settled in ${String(ms / 1000)} s`;
}

/** The operator's header, as the bridge types it. */
export const operatorHeader = (id: string): string => `[walky-talky ${id}] from operator (${DEVICE_LABEL})`;

export interface OperatorMessage {
  readonly harness: HarnessId;
  readonly scenario: ScenarioId;
  /** The case's number in the table, for the capture names. */
  readonly tag: string;
  /** The body. One short line that fits the pane's width, so the screen shows it whole. */
  readonly body: string;
  /** The harness's own line for the answer: the only line of the pane that is just the word. */
  readonly reply: RegExp;
}

/** What "Send as message" made of one tap: the request it posted, or why the menu never opened. */
export type AsMessage = { readonly menu: true; readonly tap: TapLog; readonly id: string } | { readonly menu: false };

/**
 * The phone's way to a walky talky message, as a thumb does it: write the line, hold Send, tap "Send as
 * message" in the menu that opens. The hold is no request and is logged as a tap that sent nothing; the
 * tap posts `/api/walky`. Throws when the tap made no walky talky request.
 */
export async function sendAsMessage(page: Page, recorder: TapRecorder, body: string, log: TapLog[]): Promise<AsMessage> {
  await page.getByRole("textbox").last().fill(body);
  const send = page.getByRole("button", { name: message("composer.send.sendAria"), exact: true });
  log.push(await hold(page, send, "hold Send"));
  const row = page.getByRole("button", { name: message("walky.composer.sendAsMessage"), exact: true });
  const menu = await row
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!menu) return { menu: false };
  const t = await tap(recorder, row, "Send as message");
  log.push(t);
  const id = t.answers.find((a) => a.path === "/api/walky")?.requestId ?? null;
  if (id === null) throw new Error(`the tap made no walky talky request: ${tapWords(t)}`);
  return { menu: true, tap: t, id };
}

/** The line under the composer that follows the receipt ("Message to this pane: ..."), or null while none shows. */
export async function composerStrip(page: Page): Promise<string | null> {
  const prefix = message("walky.composer.outcome", { label: message("walky.composer.toThisPane"), state: "" }).trim();
  const strip = page.getByText(prefix).first();
  if (!(await strip.isVisible().catch(() => false))) return null;
  return ((await strip.textContent().catch(() => null)) ?? "").trim() || null;
}

/**
 * The operator's message from the phone to one pane: write a line, hold Send, tap "Send as message".
 * With the first hold and the first tap: the bridge takes it; the pane gets one prompt, the header and
 * then the body on the next row; the receipt settles at `delivered`; the agent answers the body; the
 * phone's Chat draws the "Message from" card with the operator badge, from the bridge's log.
 */
export async function operatorMessage(browser: Browser, rig: Rig, pane: string, trail: Trail, c: OperatorMessage): Promise<ScenarioResult> {
  spendTurn(c.harness, `walky: an operator message (${c.harness})`);
  const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
  const log = trail.log;
  const notes = trail.notes;
  try {
    const sent = await sendAsMessage(page, recorder, c.body, log);
    if (!sent.menu) {
      trail.captures.push(await capture(page, `walky-${c.tag}-no-menu`));
      return { verdict: "fail", taps: log.length, minTaps: 2, note: "the first hold on Send opened no 'Send as message' row", taps_log: log, captures: trail.captures };
    }
    const t = sent.tap;
    const id = sent.id;
    const stripShown = (await composerStrip(page)) !== null;
    notes.push(`${tapWords(t)}; strip ${stripShown ? "shown" : "not shown"}`);

    // One prompt: the header row, then the body on the next row, in the pane's input history.
    const typed = new RegExp(`${escape(operatorHeader(id))}\\s*\\n\\s*${escape(c.body)}`);
    const screen = await rig.screenUntil(pane, typed, 30_000, 120);
    notes.push(screen === null ? "the header and body did not reach the pane as one prompt" : "the pane got the header and body as one prompt");
    const receipt = await settledWalky(rig, pane, id, 30_000);
    notes.push(`receipt ${receipt}`);
    const reply = (await rig.screenUntil(pane, c.reply, REPLY_MS, 120)) !== null;
    notes.push(reply ? `${c.harness} answered the body` : "no answer to the body on screen");
    await waitIdle(rig, pane, REPLY_MS);

    // The card, drawn from the log: its title names the device, its badge names the kind.
    const title = page.getByText(message("walky.card.title", { label: DEVICE_LABEL }), { exact: true }).last();
    const card = await title
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (card) await title.scrollIntoViewIfNeeded();
    const badge = await page
      .getByText(message("walky.kind.operator"), { exact: true })
      .last()
      .isVisible()
      .catch(() => false);
    // The title and the badge are the same on every earlier card of this device, so the body, which is this message's own, pins the card.
    const bodyShown = card ? await page.getByText(c.body, { exact: true }).last().isVisible().catch(() => false) : false;
    notes.push(`card ${card ? "shown" : "not shown"}, operator badge ${badge ? "shown" : "not shown"}, body ${bodyShown ? "shown" : "not shown"}`);
    trail.captures.push(await capture(page, `walky-${c.tag}-card`), await captureScreen(rig, pane, `walky-${c.tag}-pane`));
    const verdict = t.worked && screen !== null && receipt === "delivered" && card && badge && bodyShown && reply ? "pass" : "fail";
    return { verdict, taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: trail.captures };
  } finally {
    await context.close();
  }
}

/** Whether the agent's turn runs now, by the Surface when the harness has one, else by Herdr's status. */
export async function turnRuns(rig: Rig, pane: string): Promise<boolean> {
  const found = await rig.pane(pane).catch(() => null);
  if (found === null) return false;
  return found.surface === null ? found.status === "working" : found.surface.turn === "running";
}

export interface BusyMessage {
  readonly harness: HarnessId;
  readonly tag: string;
  /** The numbered lines the long reply holds. */
  readonly items: number;
  /** The first lines of the list: the screen shows them once the reply streams. */
  readonly streaming: RegExp;
  /** The operator's body, and the harness's own line for the answer. */
  readonly body: string;
  readonly reply: RegExp;
}

/** The last item of a long reply, as a line of the pane. */
const lastItem = (items: number): RegExp => new RegExp(`^\\s*(?:[⏺●]\\s*)?${String(items)}\\.\\s+\\S`, "gm");

/**
 * A message from the phone while a turn runs (docs/walky-talky.md, "Into a busy pane"). The turn is a long
 * numbered list. The operator holds Send and taps "Send as message" while it streams, with the first
 * hold and the first tap. The message must not steer the turn: the list runs to its last line, and only
 * then does the agent answer the body. The receipt ends at `delivered`, the header is on the screen once,
 * and the phone's line under the box ends on "typed into the pane". When the bridge typed the message,
 * and what the strip said on the way, go into the note: a harness that queues takes it in during the turn.
 */
export async function busyMessage(browser: Browser, rig: Rig, pane: string, trail: Trail, c: BusyMessage): Promise<ScenarioResult> {
  spendTurn(c.harness, "walky busy: the long reply");
  spendTurn(c.harness, "walky busy: the message sent during it");
  const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
  const log = trail.log;
  const notes = trail.notes;
  try {
    const prompt = `List ${String(c.items)} different fruits, one per line, numbered 1 to ${String(c.items)}, each with one sentence of about twenty words about its taste. Write the list as plain text in your reply and call no tool. No other text.`;
    log.push(await sendFromComposer(page, recorder, prompt, "send the long prompt"));
    if ((await rig.screenUntil(pane, c.streaming, 60_000, 120)) === null) {
      trail.captures.push(await captureScreen(rig, pane, `walky-${c.tag}-no-stream`));
      throw new NotReached("the long reply never started streaming");
    }
    const running = await turnRuns(rig, pane);
    const startedAt = Date.now();
    const sent = await sendAsMessage(page, recorder, c.body, log);
    if (!sent.menu) {
      trail.captures.push(await capture(page, `walky-${c.tag}-no-menu`));
      return { verdict: "fail", taps: log.length, minTaps: 3, note: "the first hold on Send opened no 'Send as message' row", taps_log: log, captures: trail.captures };
    }
    const id = sent.id;
    const header = `[walky-talky ${id}]`;
    notes.push(`the turn ${running ? "ran" : "was already over"} at the tap; ${tapWords(sent.tap)}`);

    // Watch until the turn is over and the receipt has settled: when the header showed, when the
    // receipt left `accepted`, when the turn ended, and the words the phone's line went through.
    const strips: string[] = [];
    let headerAt: number | null = null;
    let headerWhileRunning = false;
    let deliveredAt: number | null = null;
    let endedAt: number | null = null;
    const end = Date.now() + 240_000;
    while (Date.now() < end) {
      const now = await turnRuns(rig, pane);
      if (!now && endedAt === null) endedAt = Date.now();
      if (deliveredAt === null && stateOf((await walkyRows(rig, pane)).find((row) => row.id === id)) === "delivered") deliveredAt = Date.now();
      if (headerAt === null && (await rig.screen(pane, 300)).includes(header)) {
        headerAt = Date.now();
        headerWhileRunning = now;
      }
      const strip = await composerStrip(page);
      if (strip !== null && strips.at(-1) !== strip) strips.push(strip);
      if (endedAt !== null && deliveredAt !== null) break;
      await sleep(700);
    }
    // The phone's line follows the receipt on the pane's ordinary revalidation: allow it a moment more.
    const deliveredWord = message("walky.state.delivered");
    const stripEnd = Date.now() + 45_000;
    let stripAt: number | null = null;
    while (Date.now() < stripEnd) {
      const strip = await composerStrip(page);
      if (strip !== null && strips.at(-1) !== strip) strips.push(strip);
      if (strip !== null && strip.includes(deliveredWord)) {
        stripAt = Date.now();
        break;
      }
      await sleep(700);
    }
    const seconds = (at: number | null): string => (at === null ? "never" : `${String(Math.round((at - startedAt) / 1000))} s`);
    notes.push(`after the tap: header on screen ${seconds(headerAt)}${headerAt === null ? "" : headerWhileRunning ? " (during the turn, queued by the harness)" : " (after the turn)"}, receipt delivered ${seconds(deliveredAt)}, turn ended ${seconds(endedAt)}, the phone's line said "${deliveredWord}" ${seconds(stripAt)}`);

    // The list runs to its last line, then the answer: a message that steered would cut the list.
    const answered = await rig.screenUntil(pane, c.reply, REPLY_MS, 600);
    await waitIdle(rig, pane, REPLY_MS);
    const screen = await rig.screen(pane, 800);
    const lastAt = [...screen.matchAll(lastItem(c.items))].at(-1)?.index ?? -1;
    const replyAt = screen.search(c.reply);
    const inOrder = lastAt !== -1 && replyAt > lastAt;
    const headers = screen.split(header).length - 1;
    notes.push(lastAt === -1 ? `the list never reached item ${String(c.items)}` : `the list ran to item ${String(c.items)}`, answered === null ? "no answer to the body on screen" : inOrder ? "the answer came after the last item" : "the answer came BEFORE the last item", `the header is on screen ${String(headers)} time(s)`);
    const receipt = await settledWalky(rig, pane, id, 30_000);
    const finalStrip = await composerStrip(page);
    notes.push(`receipt ${receipt}`, `the phone's line went through: ${strips.length === 0 ? "nothing shown" : strips.map((line) => `"${line}"`).join(" -> ")}`);
    trail.captures.push(await capture(page, `walky-${c.tag}`), await captureScreen(rig, pane, `walky-${c.tag}`));
    const verdict = sent.tap.worked && running && receipt === "delivered" && lastAt !== -1 && answered !== null && inOrder && headers === 1 && finalStrip !== null && finalStrip.includes(deliveredWord) ? "pass" : "fail";
    return { verdict, taps: log.length, minTaps: 3, note: notes.join("; "), taps_log: log, captures: trail.captures };
  } finally {
    await context.close();
  }
}

/** The address `who` prints for one pane, token included, or null when `who` does not list it. */
export async function whoAddress(rig: Rig, paneId: string): Promise<string | null> {
  const who = asJsonObject(await rig.get("/api/walky/who"));
  const found = jsonRows(who?.targets).find((target) => withoutInstance(asJsonString(target.address) ?? "") === addressOf(paneId));
  return asJsonString(found?.address) ?? null;
}

/** Quote a word for /bin/sh. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Start one more agent of a harness in a fresh pane, from the start script the run already wrote
 * (`prepareHarness` ran when the session started, so the scratch config is not rewritten under a
 * running agent). Throws NotReached when it never comes up idle. The caller closes the pane.
 */
export async function startExtraAgent(rig: Rig, id: HarnessId): Promise<string> {
  memGuard(`an extra ${id}`);
  const dirs = harnessDirs(id);
  const paneId = await startInPane(dirs.project, `leg-${id}-extra`, `exec ${quoted(dirs.start)}`);
  const up = await rig.until(() => rig.pane(paneId), (pane) => pane !== null && pane.agent === SETUPS[id].agent && (freeSurface(pane) || (pane.surface === null && pane.status === "idle")), 90_000, 700);
  if (up === null) throw new NotReached(`an extra ${id} did not come up idle in 90 s`);
  return paneId;
}

/** This checkout: web/e2e/rig/walky-lib.ts is three levels below it. */
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");

export interface CliSend {
  /** The exit code: 0 taken, 4 refused, 1 unknown, 3 and up another failure. */
  readonly code: number;
  readonly id: string | null;
  readonly receipts: JsonObject[];
  readonly out: string;
}

/**
 * `collie walky send` as an agent's Bash tool runs it, with no model turn: this checkout's CLI, the
 * sender pane's own mux markers (Herdr's `HERDR_PANE_ID` or the core's `HC_TERMINAL_ID`, and the machine's socket) and its machine's state dir.
 * The HOME is the bridge's empty one, so the CLI can reach no bridge but the rig's own. The bridge
 * proves the sender the way it proves an agent's: the markers name the pane.
 */
export async function cliSend(senderPane: string, to: string, text: string, machine: Machine = "lead"): Promise<CliSend> {
  const result = await runCli(senderPane, ["send", "--json", to, text], machine);
  const doc = asJsonObject(parseJsonLine(result.out));
  return { code: result.code, id: asJsonString(doc?.id) ?? null, receipts: jsonRows(doc?.receipts), out: result.out.trim() };
}

export interface CliCancel {
  /** The exit code: 0 taken back (or already in the inbox), 3 nothing to take back, 4 not the sender. */
  readonly code: number;
  /** One result per target: `taken`, `repeat`, `already typed`, `not held` or `elsewhere`, with the receipt. */
  readonly results: JsonObject[];
  readonly out: string;
}

/** `collie walky cancel <id> --json` from a pane (M62 spec 03): the bridge checks that pane sent the message. */
export async function cliCancel(senderPane: string, id: string, machine: Machine = "lead"): Promise<CliCancel> {
  const result = await runCli(senderPane, ["cancel", id, "--json"], machine);
  const doc = asJsonObject(parseJsonLine(result.out));
  return { code: result.code, results: jsonRows(doc?.results), out: result.out.trim() };
}

/** One `collie walky` verb from a pane's own environment, as `cliSend` describes it. */
async function runCli(senderPane: string, args: readonly string[], machine: Machine): Promise<{ code: number; out: string }> {
  const run = readRun();
  const socket = machine === "lead" ? run?.socket : run?.member?.socket;
  if (socket === undefined || socket === "") throw new Error(`the rig has no ${machine} socket`);
  const dirs = machineDirs(machine);
  const env = { PATH: process.env.PATH ?? "", HOME: dirs.bridgeHome, COLLIE_STATE_DIR: dirs.state, ...paneMarkers(senderPane, socket, machine) };
  return new Promise<{ code: number; out: string }>((done) => {
    const child = spawn("bun", [join(WORKTREE, "cli", "main.ts"), "walky", ...args], { env, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => done({ code: 1, out }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** The first line of a CLI's output that is a JSON object. */
function parseJsonLine(out: string): JsonObject | undefined {
  for (const line of out.split("\n")) {
    try {
      const doc = asJsonObject(JSON.parse(line));
      if (doc !== undefined) return doc;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** How many messages a machine refused for one reason, from its own `walky/refusals.json` (no bodies, no senders). */
export function refusalCount(machine: Machine, reason: string): number {
  try {
    const doc = asJsonObject(JSON.parse(readFileSync(join(machineDirs(machine).state, "walky", "refusals.json"), "utf8")));
    return asJsonNumber(asJsonObject(doc?.counts)?.[reason]) ?? 0;
  } catch {
    return 0;
  }
}
