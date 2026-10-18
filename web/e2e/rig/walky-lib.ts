// What the walky talky cases share: reading a pane's message list, the screen patterns of a header, and
// the operator's message from the phone, which case 6 (Claude) and case 7 (pi, omp) run alike.
//
// Every case is judged twice, by the bridge's receipt and by the pane's own screen. A receipt that says
// `delivered` while the screen shows nothing, or a screen that shows a line the receipt calls refused,
// fails the case.
import type { Browser } from "@playwright/test";
import { devices } from "@playwright/test";

import { asJsonObject, asJsonString, type JsonObject } from "../../src/lib/json";
import type { HarnessId } from "./harnesses";
import {
  PHONE_DEVICE,
  capture,
  captureScreen,
  hold,
  jsonRows,
  message,
  phoneOn,
  spendTurn,
  tap,
  tapWords,
  waitIdle,
  type Rig,
  type ScenarioId,
  type ScenarioResult,
  type Trail,
} from "./leg";
import { DEVICE_LABEL } from "./rig-lib";

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
    await page.getByRole("textbox").last().fill(c.body);
    const send = page.getByRole("button", { name: message("composer.send.sendAria"), exact: true });
    log.push(await hold(page, send, "hold Send"));
    const row = page.getByRole("button", { name: message("walky.composer.sendAsMessage"), exact: true });
    const menu = await row
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!menu) {
      trail.captures.push(await capture(page, `walky-${c.tag}-no-menu`));
      return { verdict: "fail", taps: log.length, minTaps: 2, note: "the first hold on Send opened no 'Send as message' row", taps_log: log, captures: trail.captures };
    }
    const t = await tap(recorder, row, "Send as message");
    log.push(t);
    const answer = t.answers.find((a) => a.path === "/api/walky");
    const id = answer?.requestId ?? null;
    if (id === null) throw new Error(`the tap made no walky talky request: ${tapWords(t)}`);
    const strip = message("walky.composer.outcome", { label: message("walky.composer.toThisPane"), state: "" }).trim();
    const stripShown = await page
      .getByText(strip)
      .first()
      .isVisible()
      .catch(() => false);
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
