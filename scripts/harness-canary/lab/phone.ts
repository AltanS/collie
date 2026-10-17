// The phone leg of the lab (M56 spec 10, after step 4): drive a bridge the way the phone does, over
// HTTP, and judge by the receipts and the Surface the bridge reads after. Three bugs of 1.22.0 were
// found on the phone and by no suite (1.22.2 to 1.22.4): a send while Claude streams or as its turn
// ends, a slash command read as an unreadable dialog, and a refusal with no readable reason. Steps 3
// and 4 of the lab call the protocol in this process on an idle pane, so they cannot see any of them.
//
// Two targets:
//   scratch  this checkout's bridge, started by the leg on the lab's tmux server (phone-bridge.ts).
//            The phone panes carry Collie's beacon hooks, so the bridge names the agent and every
//            prompt edge reaches it: a send can end `effective`, and the stream rule asks for it.
//   bridge   a bridge that already runs (`--bridge URL --token-file PATH`), with a device token the
//            operator paired by hand. The leg makes its own panes through `POST /api/workspace`,
//            touches no other pane (the owned-pane rule, phone-client.ts) and closes its panes at the
//            end. The bridge must run on this machine: the start line names the lab's binary by path.
//
// Each scenario gets its own pane: `POST /api/workspace`, then the start line as a send into the
// shell, then the folder trust question answered like a person: through `/api/ask` when the bridge
// lifts it, through the Keys board while the pane has no agent name yet (a tmux pane is named by the
// SessionStart hook, and Claude asks about the folder before that hook runs).
//
// Nothing is written into web/src/fixtures/. Captures (`<scenario>.ansi`, redacted) and summary.json go
// to `<lab root>/phone/<harness>-<version>-<time>/`, which outlives the run folder.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MARKER, installDocument } from "../../../cli/hooks";
import { asJsonObject, asJsonString, type JsonValue } from "../../../web/src/lib/json";
import { askOf, isFree, type Surface } from "../../../web/src/lib/surface/surface";
import type { SendMode, SendReceiptRow } from "../../../web/src/lib/surface/send";
import type { KnownGap } from "../known-gaps";
import type { SlashLists } from "../slash-commands";
import { passCase, failCase, notReachedCase, type CaseResult } from "../verdict";
import { ASK_FILE, ASK_TEXT, SEND_TEXT } from "./legs";
import { mintRequestId, type PhoneClient, type PhonePane } from "./phone-client";
import { applyPhoneGaps, judgeStream, phoneResult, readableSentence, receiptWords, rowOf, streamSettled, WENT_IN, type PhoneScenarioId, type PhoneScenarioResult } from "./phone-verdict";
import { viewOf } from "./screens";
import { paneCommand } from "./tmux";

/** The model turns the phone leg may spend: idle 1, stream 5, turn end 2, ask 2, agents screen 1, and slack. */
export const PHONE_TURN_CAP = 14;

/** The prompt of the stream scenario: a long answer, so the four sends after it land while Claude streams. */
export const FRUIT_TEXT = "List 120 different fruits, one per line, numbered 1 to 120. No other text.";
/** When the four stream sends go out, in ms after the fruit prompt was sent (bug 1's live repro). */
export const STREAM_AT_MS = [3000, 5000, 6000, 7000] as const;
export const SHORT_TEXT = "Reply with one short line: the word ready.";

const START_WAIT_MS = 75_000;
const REPLY_WAIT_MS = 120_000;
/** A held send may wait this long for the pane to read free (the brief of the leg: up to two minutes). */
const HOLD_WAIT_MS = 120_000;
const DIALOG_WAIT_MS = 75_000;
const MENU_WAIT_MS = 5000;
const POLL_MS = 500;
const TURN_POLL_MS = 200;
const CLOSE_PRESS_CAP = 3;

export interface PhoneTurns {
  used: number;
  readonly cap: number;
}

export interface PhoneEnv {
  readonly harness: string;
  readonly version: string;
  readonly client: PhoneClient;
  /** `scratch` or `bridge`, see the header. */
  readonly target: "scratch" | "bridge";
  /** The outcomes a stream send must end in: `effective` when the panes' hooks reach the bridge. */
  readonly streamWanted: readonly string[];
  /** The start line's program and arguments, and the environment it gets. */
  readonly agentBinary: string;
  readonly agentArgs: readonly string[];
  readonly agentEnv: Readonly<Record<string, string>>;
  /** Scratch folder for the projects and start scripts. Deleted with the run folder. */
  readonly workDir: string;
  /** Where the captures and summary.json go. Outlives the run. */
  readonly outDir: string;
  readonly redact: (text: string) => string;
  readonly turns: PhoneTurns;
  readonly gaps: readonly KnownGap[];
  readonly lists: SlashLists;
  /** The belt's commands for this harness (see {@link beltCommands}). */
  readonly belt: readonly string[];
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface PhoneFacts {
  readonly target: "scratch" | "bridge";
  readonly results: readonly PhoneScenarioResult[];
  readonly turns: number;
  /** summary.json, an absolute path. */
  readonly summary: string;
}

// ── The belt ─────────────────────────────────────────────────────────────────

/**
 * The shipped belt of one harness, read from web/src/lib/harness-bar.ts as text. That module imports
 * the web tree's `@/` alias, which the lab cannot resolve, so the leg reads the table's `command:`
 * lines instead of guessing them. A test pins that Claude's belt still parses.
 */
export function shippedBelt(source: string, constName = "CLAUDE"): string[] {
  const start = source.indexOf(`const ${constName}: readonly HarnessBarItem[] = [`);
  if (start < 0) return [];
  const end = source.indexOf("\n];", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim().startsWith("//")) continue;
    const found = /command:\s*"(\/[a-z][a-z0-9:_.-]*)"/u.exec(line);
    if (found?.[1] !== undefined && !out.includes(found[1])) out.push(found[1]);
  }
  return out;
}

export const HARNESS_BAR_FILE = join(import.meta.dir, "..", "..", "..", "web", "src", "lib", "harness-bar.ts");

/** The belt as the phone draws it: the operator's own `bar = true` rows for this harness when there are any, else the shipped row. */
export function beltCommands(shipped: readonly string[], operatorBar: readonly string[]): string[] {
  return operatorBar.length > 0 ? [...operatorBar] : [...shipped];
}

/**
 * The commands the slash scenario sends: `/model` and `/help` first (bug 2 and its sibling), then every
 * belt command that is on the lab's safe list. A command on the unsafe list is never sent, and that
 * includes `/clear` (ALWAYS_UNSAFE in slash-commands.ts), even though the phone's palette offers it.
 */
export interface SlashPlan {
  /** Sent, in this order. */
  readonly send: readonly string[];
  /** Offered by the belt and not on the safe list: never sent. */
  readonly skipped: readonly string[];
}

export function slashPlan(belt: readonly string[], lists: SlashLists): SlashPlan {
  const safe = new Set(lists.safe.map((entry) => entry.command));
  const toSend: string[] = [];
  const skipped: string[] = [];
  for (const command of ["/model", "/help", ...belt]) {
    if (toSend.includes(command) || skipped.includes(command)) continue;
    if (safe.has(command)) toSend.push(command);
    else skipped.push(command);
  }
  return { send: toSend, skipped };
}

// ── The phone panes' own config ──────────────────────────────────────────────

/**
 * Write Collie's beacon hooks into the phone panes' own `settings.json`, the way `collie hooks install
 * claude` writes them, with this checkout's CLI as the emitter. Only in the scratch target: the hooks
 * write their edges to `COLLIE_STATE_DIR`, which is the scratch bridge's. The walk's config folder is a
 * different one and never gets a hook, so its Claude never writes an edge anywhere.
 */
export function writeBeaconHooks(configDir: string, repoRoot: string, bun: string = process.execPath): string {
  const command = `${bun} ${join(repoRoot, "cli", "main.ts")} beacon emit ${HOOK_MARKER}`;
  const doc = installDocument(null, command);
  if (doc.kind !== "document") throw new Error(`the hook document was refused: ${doc.reason}`);
  writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(doc.document, null, 2)}\n`, { mode: 0o600 });
  return command;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function surfaceWords(surface: Surface | null): string {
  if (surface === null) return "no surface";
  const ask = askOf(surface.modal);
  const modal = ask !== null ? `ask ${ask.kind}` : String(surface.modal);
  return `turn ${surface.turn}, modal ${modal}, composer ${surface.composer}${surface.reason === undefined ? "" : `, ${surface.reason}`}`;
}

function spend(env: PhoneEnv, what: string): boolean {
  if (env.turns.used >= env.turns.cap) {
    env.log(`phone: turn cap: ${what} not sent, ${String(env.turns.used)} of ${String(env.turns.cap)} turns used`);
    return false;
  }
  env.turns.used++;
  return true;
}

async function waitPane(env: PhoneEnv, pane: string, ok: (view: PhonePane) => boolean, maxMs: number, pollMs = POLL_MS): Promise<{ view: PhonePane | null; met: boolean }> {
  const deadline = Date.now() + maxMs;
  let view = await env.client.pane(pane);
  while (view === null || !ok(view)) {
    if (Date.now() > deadline) return { view, met: false };
    await Bun.sleep(pollMs);
    view = await env.client.pane(pane);
  }
  return { view, met: true };
}

const agentFree = (harness: string) => (view: PhonePane): boolean => view.agent === harness && view.surface !== null && isFree(view.surface);

/** The pane's text, redacted, written as `<scenario>.ansi` (or `<scenario>-<step>.ansi`). Null when nothing could be read. */
async function capture(env: PhoneEnv, id: PhoneScenarioId, pane: string | null, step?: string): Promise<string | null> {
  if (pane === null) return null;
  try {
    const text = await env.client.text(pane);
    mkdirSync(env.outDir, { recursive: true });
    const path = join(env.outDir, step === undefined ? `${id}.ansi` : `${id}-${step.replace(/[^a-z0-9]+/giu, "")}.ansi`);
    writeFileSync(path, env.redact(text));
    return path;
  } catch (err) {
    env.log(`phone ${id}: no capture: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The receipts of the scenario's own requests, newest first. */
async function ownReceipts(env: PhoneEnv, pane: string | null, ids: ReadonlySet<string>): Promise<SendReceiptRow[]> {
  if (pane === null) return [];
  try {
    return (await env.client.receipts(pane)).filter((row) => ids.has(row.requestId));
  } catch {
    return [];
  }
}

interface Sent {
  readonly id: string;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
  /** True when the first answer was `refused unconfirmed` and the commit tap followed. */
  readonly committed: boolean;
  /** The rows hash of the last answer: a Discard after `typed_not_submitted` carries it. */
  readonly rowsHash: string | null;
}

async function send(env: PhoneEnv, pane: string, text: string, mode: SendMode, ids: Set<string>, label: string): Promise<Sent> {
  const made = await env.client.sendAsPhone(pane, text, mode);
  const last = made.answers[made.answers.length - 1]!;
  ids.add(made.id);
  if (made.answers.length > 1) {
    const first = made.answers[0]!;
    env.log(`phone: ${label}: first answer refused (unconfirmed), committed with the rows hash: ${first.detail ?? ""}`.trimEnd());
  }
  if (made.answers.length > 2) {
    const capped = made.answers[1]!;
    env.log(`phone: ${label}: the commit met the cap, confirmed once more with capAck: ${capped.detail ?? ""}`.trimEnd());
  }
  env.log(`phone: ${label}: ${last.outcome ?? "no outcome"}${last.reason === null ? "" : ` (${last.reason})`}${last.detail === null ? "" : `: ${last.detail}`}`);
  return { id: made.id, outcome: last.outcome, reason: last.reason, detail: last.detail ?? last.receiptDetail, committed: made.answers.length > 1, rowsHash: last.rowsHash };
}

/** Escape through the Keys board until the box reads free. True when it did. */
async function escapeToFree(env: PhoneEnv, pane: string): Promise<boolean> {
  for (let press = 0; press < CLOSE_PRESS_CAP; press++) {
    await env.client.keys(pane, ["Escape"]);
    const { met } = await waitPane(env, pane, agentFree(env.harness), 2500, 250);
    if (met) return true;
  }
  return false;
}

// ── One agent pane ───────────────────────────────────────────────────────────

interface Started {
  readonly pane: string | null;
  readonly ready: boolean;
  readonly note: string;
  readonly project: string;
}

/** Wait for the fresh shell to draw its prompt: some text, the same on two reads in a row. */
async function waitShell(env: PhoneEnv, pane: string): Promise<void> {
  let last = "";
  for (let i = 0; i < 20; i++) {
    const text = await env.client.text(pane).catch(() => "");
    if (text.trim().length > 0 && text === last) return;
    last = text;
    await Bun.sleep(500);
  }
}

/**
 * A fresh pane with the agent in it, idle and free: `POST /api/workspace`, the start line as a send,
 * then the folder trust question answered like a person. `ready: false` with a note when the agent
 * never came; the scenario is then `not-reached`.
 */
/** The wait before the start line goes once more, after a refusal on a shell that was still drawing. */
const START_RETRY_MS = 1500;

export async function startAgent(env: PhoneEnv, id: PhoneScenarioId, makeProject: (dir: string) => void): Promise<Started> {
  const project = join(env.workDir, "projects", id);
  makeProject(project);
  const script = join(env.workDir, `start-${id}.sh`);
  writeFileSync(script, `#!/bin/sh\nexec ${paneCommand(env.agentEnv, env.agentBinary, env.agentArgs)}\n`, { mode: 0o700 });
  chmodSync(script, 0o700);
  let pane: string;
  try {
    pane = await env.client.createPane(project, `phone-${id}`);
  } catch (err) {
    return { pane: null, ready: false, note: `POST /api/workspace failed: ${err instanceof Error ? err.message : String(err)}`, project };
  }
  env.log(`phone ${id}: pane ${pane} made through POST /api/workspace`);
  await waitShell(env, pane);
  let start = await send(env, pane, `exec ${script}`, "send", new Set(), `${id}: the start line`);
  // A fresh shell may still draw its prompt (the bridge answers `not_free` or `stale_surface`). A person
  // taps Send again a moment later; the leg does that once.
  if (start.outcome === "refused" && start.reason !== "unconfirmed") {
    await Bun.sleep(START_RETRY_MS);
    start = await send(env, pane, `exec ${script}`, "send", new Set(), `${id}: the start line, once more`);
  }
  if (start.outcome === "refused") return { pane, ready: false, note: `the start line was refused (${start.reason ?? "?"}): ${start.detail ?? ""}`, project };

  const deadline = Date.now() + START_WAIT_MS;
  let trustByKeys = false;
  let trustByAsk = false;
  let lastText = 0;
  while (Date.now() < deadline) {
    const view = await env.client.pane(pane);
    if (view !== null && view.agent === env.harness && view.surface !== null) {
      const ask = askOf(view.surface.modal);
      const yes = ask?.options.find((option) => /trust/iu.test(option.label) && /^yes/iu.test(option.label));
      if (ask !== null && yes !== undefined && !trustByAsk) {
        trustByAsk = true;
        const reply = await env.client.ask(ask.id, pane, ask.hash, yes.id);
        env.log(`phone ${id}: the folder trust question answered through /api/ask: ${reply.outcome ?? "no outcome"}${reply.reason === null ? "" : ` (${reply.reason})`}, keys ${reply.keys.join(" ")}`);
      } else if (isFree(view.surface)) {
        env.log(`phone ${id}: the agent is up, the bridge names it ${view.agent}, hooks ${view.hooks ?? "-"}, ${surfaceWords(view.surface)}`);
        return { pane, ready: true, note: "", project };
      }
    } else if (!trustByKeys && Date.now() - lastText > 1500) {
      // No agent name yet: the bridge cannot lift a dialog in a pane it calls a shell. A person taps the Keys board.
      lastText = Date.now();
      const text = await env.client.text(pane).catch(() => "");
      if (/trust this folder/iu.test(text)) {
        trustByKeys = true;
        await env.client.keys(pane, ["Down"]);
        await Bun.sleep(600);
        const after = viewOf(await env.client.text(pane).catch(() => ""), env.harness);
        const pointed = after.plain.some((row) => /❯\s*(\d\.\s*)?Yes, I trust/u.test(row));
        if (pointed) {
          await env.client.keys(pane, ["Enter"]);
          env.log(`phone ${id}: the folder trust question came before the bridge named the agent, so it was answered through the Keys board (Down, Enter)`);
        } else {
          env.log(`phone ${id}: the folder trust question did not point at Yes after Down, so no Enter was sent`);
        }
      }
    }
    await Bun.sleep(POLL_MS);
  }
  const view = await env.client.pane(pane).catch(() => null);
  return { pane, ready: false, note: `the agent was not up and free within ${String(START_WAIT_MS / 1000)} s (${view === null ? "no pane" : `${view.agent}, ${surfaceWords(view.surface)}`})`, project };
}

// ── The scenarios ────────────────────────────────────────────────────────────

interface Ran {
  readonly cases: CaseResult[];
  readonly ids: Set<string>;
  readonly pane: string | null;
}

async function idleSend(env: PhoneEnv, started: Started): Promise<Ran> {
  const ids = new Set<string>();
  const pane = started.pane!;
  if (!spend(env, "idle-send")) return { cases: [notReachedCase("send", "turn cap")], ids, pane };
  const sent = await send(env, pane, SEND_TEXT, "send", ids, "idle-send");
  const cases: CaseResult[] = [];
  cases.push(sent.outcome !== null && WENT_IN.includes(sent.outcome) ? passCase("send", sent.outcome) : failCase("send", `answer ${sent.outcome ?? "none"}${sent.reason === null ? "" : ` (${sent.reason})`}: ${sent.detail ?? ""}`));
  const { view, met } = await waitPane(env, pane, agentFree(env.harness), REPLY_WAIT_MS);
  cases.push(met ? passCase("box-empty", "free after the reply") : notReachedCase("box-empty", `the reply did not end in time (${surfaceWords(view?.surface ?? null)})`));
  return { cases, ids, pane };
}

async function streamSends(env: PhoneEnv, started: Started): Promise<Ran> {
  const ids = new Set<string>();
  const pane = started.pane!;
  const cases: CaseResult[] = [];
  if (!spend(env, "the fruit prompt")) return { cases: [notReachedCase("fruit", "turn cap")], ids, pane };
  const t0 = Date.now();
  const order: string[] = [];
  const fruit = await send(env, pane, FRUIT_TEXT, "send", ids, "stream-sends: the fruit prompt");
  order.push(fruit.id);
  if (fruit.outcome === null || !WENT_IN.includes(fruit.outcome)) {
    cases.push(failCase("fruit", `answer ${fruit.outcome ?? "none"}${fruit.reason === null ? "" : ` (${fruit.reason})`}: ${fruit.detail ?? ""}`));
    return { cases, ids, pane };
  }
  let lastAt = Date.now();
  for (const [index, at] of STREAM_AT_MS.entries()) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    if (!spend(env, `stream send ${String(index + 1)}`)) {
      cases.push(notReachedCase(`send-${String(index + 2)}`, "turn cap"));
      continue;
    }
    const view = await env.client.pane(pane);
    const sent = await send(env, pane, `Stream note ${String(index + 1)}: reply with only OK${String(index + 1)}.`, "send", ids, `stream-sends: send ${String(index + 1)} at ${String(Math.round((Date.now() - t0) / 100) / 10)} s (${surfaceWords(view?.surface ?? null)})`);
    order.push(sent.id);
    lastAt = Date.now();
    // An unconfirmed refusal mid-stream is the bug itself (the screen read as one Collie cannot read).
    if (sent.committed) cases.push(failCase(`send-${String(index + 2)}-first-answer`, "the first answer was refused (unconfirmed) while Claude streamed"));
  }
  // Every receipt must settle: a held send may wait up to two minutes for the pane to read free.
  const deadline = lastAt + HOLD_WAIT_MS;
  let receipts: readonly SendReceiptRow[] = [];
  while (Date.now() < deadline) {
    receipts = await env.client.receipts(pane);
    if (streamSettled(receipts, order, env.streamWanted)) break;
    await Bun.sleep(1000);
  }
  for (const [index, id] of order.entries()) env.log(`phone stream-sends: receipt ${String(index + 1)}: ${receiptWords(rowOf(receipts, id))}`);
  cases.push(...judgeStream(receipts, order, env.streamWanted));
  const end = await waitPane(env, pane, agentFree(env.harness), Math.max(5000, deadline - Date.now()));
  cases.push(end.met ? passCase("box-empty", "free at the end") : failCase("box-empty", `the box was not free at the end (${surfaceWords(end.view?.surface ?? null)}, ${String(end.view?.held.length ?? 0)} held)`));
  return { cases, ids, pane };
}

async function turnEndSend(env: PhoneEnv, started: Started): Promise<Ran> {
  const ids = new Set<string>();
  const pane = started.pane!;
  const cases: CaseResult[] = [];
  if (!spend(env, "the short prompt")) return { cases: [notReachedCase("prompt", "turn cap")], ids, pane };
  const first = await send(env, pane, SHORT_TEXT, "send", ids, "turn-end-send: the short prompt");
  if (first.outcome === null || !WENT_IN.includes(first.outcome)) return { cases: [failCase("prompt", `answer ${first.outcome ?? "none"}: ${first.detail ?? ""}`)], ids, pane };
  // Poll the snapshot every 200 ms; the send goes the moment the Surface flips from running to idle.
  const deadline = Date.now() + REPLY_WAIT_MS;
  let sawRunning = false;
  let flipped = false;
  while (Date.now() < deadline) {
    const view = await env.client.pane(pane);
    const turn = view?.surface?.turn;
    if (turn === "running") sawRunning = true;
    else if (sawRunning && turn === "idle") {
      flipped = true;
      break;
    }
    await Bun.sleep(TURN_POLL_MS);
  }
  if (!flipped) return { cases: [notReachedCase("flip", sawRunning ? "the turn did not end in time" : "the Surface never read the turn as running")], ids, pane };
  if (!spend(env, "the turn-end send")) return { cases: [notReachedCase("send", "turn cap")], ids, pane };
  const sent = await send(env, pane, SEND_TEXT, "send", ids, "turn-end-send: the send at the flip");
  cases.push(sent.outcome !== null && WENT_IN.includes(sent.outcome) ? passCase("send", sent.outcome) : failCase("send", `answer ${sent.outcome ?? "none"}${sent.reason === null ? "" : ` (${sent.reason})`}: ${sent.detail ?? ""}`));
  const end = await waitPane(env, pane, agentFree(env.harness), REPLY_WAIT_MS);
  cases.push(end.met ? passCase("box-empty", "free after the reply") : failCase("box-empty", `the box was not free after the reply (${surfaceWords(end.view?.surface ?? null)})`));
  return { cases, ids, pane };
}

async function commandSlash(env: PhoneEnv, started: Started): Promise<Ran> {
  const ids = new Set<string>();
  const pane = started.pane!;
  const cases: CaseResult[] = [];
  const plan = slashPlan(env.belt, env.lists);
  if (plan.skipped.length > 0) env.log(`phone command-slash: not on the safe list, so not sent: ${plan.skipped.join(" ")}`);
  const opens = new Map(env.lists.safe.map((entry) => [entry.command, entry.opens] as const));
  for (const command of plan.send) {
    const sent = await send(env, pane, command, "command", ids, `command-slash: ${command}`);
    if (sent.outcome === null || !WENT_IN.includes(sent.outcome)) {
      // The screen the bridge withheld Enter on, before anything moves it.
      const shot = await capture(env, "command-slash", pane, command);
      cases.push(failCase(command, `answer ${sent.outcome ?? "none"}${sent.reason === null ? "" : ` (${sent.reason})`}: ${sent.detail ?? ""}${shot === null ? "" : ` (capture ${env.redact(shot)})`}`));
      // The text may still sit in the box. Tap Discard as the phone offers it, then Escape, or stop.
      if (sent.outcome === "typed_not_submitted" && sent.rowsHash !== null) {
        const dropId = mintRequestId();
        ids.add(dropId);
        const dropped = await env.client.send({ id: dropId, pane, text: command, mode: "discard", rowsHash: sent.rowsHash }).catch(() => null);
        env.log(`phone command-slash: ${command}: Discard: ${dropped?.outcome ?? "no answer"}${dropped?.reason === null || dropped?.reason === undefined ? "" : ` (${dropped.reason})`}`);
      }
      if (!(await escapeToFree(env, pane))) {
        cases.push(failCase(`${command}-close`, "the box did not come back after Escape"));
        break;
      }
      continue;
    }
    // What the phone shows within five seconds: a readable menu for /model, never a free box over a dialog.
    const wantsMenu = command === "/model";
    const seen = await waitPane(env, pane, (view) => view.surface !== null && (wantsMenu ? askOf(view.surface.modal)?.kind === "menu" : view.surface.modal !== "none"), MENU_WAIT_MS, 250);
    const surface = seen.view?.surface ?? null;
    const local = viewOf(await env.client.text(pane).catch(() => ""), env.harness);
    if (wantsMenu) {
      cases.push(seen.met ? passCase(command, `sent, then a readable menu (${surfaceWords(surface)})`) : failCase(command, `sent, and no readable menu within 5 s (${surfaceWords(surface)})`));
    } else if (seen.met) {
      cases.push(passCase(command, `sent, then ${surfaceWords(surface)}`));
    } else if (surface !== null && isFree(surface) && local.cue === "strong") {
      cases.push(failCase(command, `sent, and the bridge read a dialog screen as a free box (${surfaceWords(surface)})`));
    } else if (opens.get(command) === "dialog") {
      cases.push(notReachedCase(command, `sent, and no dialog came within 5 s (${surfaceWords(surface)})`));
    } else {
      cases.push(passCase(command, `sent, inline (${surfaceWords(surface)})`));
    }
    env.log(`phone command-slash: ${command}: ${surfaceWords(surface)}, local cue ${local.cue}`);
    if (seen.view !== null && seen.view.surface !== null && isFree(seen.view.surface)) continue;
    if (!(await escapeToFree(env, pane))) {
      cases.push(failCase(`${command}-close`, "the box did not come back after three Escapes"));
      break;
    }
  }
  return { cases, ids, pane };
}

async function askAnswer(env: PhoneEnv, started: Started): Promise<Ran> {
  const ids = new Set<string>();
  const pane = started.pane!;
  const cases: CaseResult[] = [];
  if (!spend(env, "the ask request")) return { cases: [notReachedCase("request", "turn cap")], ids, pane };
  const sent = await send(env, pane, ASK_TEXT, "send", ids, "ask-answer: the request");
  if (sent.outcome === null || !WENT_IN.includes(sent.outcome)) return { cases: [failCase("request", `answer ${sent.outcome ?? "none"}: ${sent.detail ?? ""}`)], ids, pane };
  cases.push(passCase("request", sent.outcome));
  const dialog = await waitPane(env, pane, (view) => view.surface !== null && askOf(view.surface.modal) !== null, DIALOG_WAIT_MS);
  const ask = dialog.view?.surface === undefined || dialog.view?.surface === null ? null : askOf(dialog.view.surface.modal);
  if (!dialog.met || ask === null) {
    cases.push(notReachedCase("dialog", `no dialog was lifted within ${String(DIALOG_WAIT_MS / 1000)} s (${surfaceWords(dialog.view?.surface ?? null)})`));
    return { cases, ids, pane };
  }
  const no = ask.options.find((option) => /^no\b/iu.test(option.label));
  if (no === undefined) {
    cases.push(failCase("dialog", `a ${ask.kind} ask with no No option: ${ask.options.map((option) => option.label).join(" | ")}`));
    return { cases, ids, pane };
  }
  const reply = await env.client.ask(ask.id, pane, ask.hash, no.id);
  env.log(`phone ask-answer: option ${no.id} "${no.label}": ${reply.outcome ?? "no outcome"}${reply.reason === null ? "" : ` (${reply.reason})`}, keys ${reply.keys.join(" ")}${reply.detail === null ? "" : `: ${reply.detail}`}`);
  cases.push(reply.outcome !== null && WENT_IN.includes(reply.outcome) ? passCase("answer", reply.outcome) : failCase("answer", `answer ${reply.outcome ?? "none"}${reply.reason === null ? "" : ` (${reply.reason})`}: ${reply.detail ?? ""}`));
  // Claude answers a No with one more turn.
  env.turns.used = Math.min(env.turns.cap, env.turns.used + 1);
  const after = await waitPane(env, pane, agentFree(env.harness), REPLY_WAIT_MS);
  const made = existsSync(join(started.project, ASK_FILE));
  cases.push(made ? failCase("file", "the declined command made its file") : passCase("file", "the declined file does not exist"));
  if (!after.met) cases.push(notReachedCase("box-empty", `the box did not come back after the answer (${surfaceWords(after.view?.surface ?? null)})`));
  return { cases, ids, pane };
}

async function sendOnAgentsScreen(env: PhoneEnv, started: Started): Promise<Ran> {
  const ids = new Set<string>();
  const pane = started.pane!;
  const cases: CaseResult[] = [];
  const opened = await send(env, pane, "/agents", "command", ids, "send-on-agents-screen: /agents");
  if (opened.outcome === null || !WENT_IN.includes(opened.outcome)) return { cases: [failCase("open", `answer ${opened.outcome ?? "none"}${opened.reason === null ? "" : ` (${opened.reason})`}: ${opened.detail ?? ""}`)], ids, pane };
  const screen = await waitPane(env, pane, (view) => view.surface !== null && view.surface.modal !== "none", MENU_WAIT_MS, 250);
  if (!screen.met) {
    await escapeToFree(env, pane);
    return { cases: [notReachedCase("open", `the agents screen did not come within 5 s (${surfaceWords(screen.view?.surface ?? null)})`)], ids, pane };
  }
  env.log(`phone send-on-agents-screen: the screen reads ${surfaceWords(screen.view?.surface ?? null)}`);
  // A message onto that screen must be refused, and the refusal must say why in words a person reads.
  const refusedId = mintRequestId();
  ids.add(refusedId);
  const refused = await env.client.send({ id: refusedId, pane, text: SEND_TEXT, mode: "send" });
  const detail = refused.detail ?? refused.receiptDetail;
  env.log(`phone send-on-agents-screen: the message on the screen: ${refused.outcome ?? "no outcome"}${refused.reason === null ? "" : ` (${refused.reason})`}: ${detail ?? "(no detail)"}`);
  if (refused.outcome !== "refused") cases.push(failCase("refused", `expected refused, the answer was ${refused.outcome ?? "none"}${refused.reason === null ? "" : ` (${refused.reason})`}`));
  else if (!readableSentence(detail)) cases.push(failCase("refused", `refused (${refused.reason ?? "?"}) with no readable sentence: ${JSON.stringify(detail ?? "")}`));
  else cases.push(passCase("refused", `refused (${refused.reason ?? "?"}): ${detail ?? ""}`));
  if (!(await escapeToFree(env, pane))) {
    cases.push(failCase("close", "the box did not come back after Escape"));
    return { cases, ids, pane };
  }
  if (!spend(env, "the message after Escape")) return { cases: [...cases, notReachedCase("again", "turn cap")], ids, pane };
  const again = await send(env, pane, SEND_TEXT, "send", ids, "send-on-agents-screen: the message again");
  cases.push(again.outcome !== null && WENT_IN.includes(again.outcome) ? passCase("again", again.outcome) : failCase("again", `answer ${again.outcome ?? "none"}${again.reason === null ? "" : ` (${again.reason})`}: ${again.detail ?? ""}`));
  await waitPane(env, pane, agentFree(env.harness), REPLY_WAIT_MS);
  return { cases, ids, pane };
}

const SCENARIOS: readonly { readonly id: Exclude<PhoneScenarioId, "crew-send">; readonly run: (env: PhoneEnv, started: Started) => Promise<Ran> }[] = [
  { id: "idle-send", run: idleSend },
  { id: "stream-sends", run: streamSends },
  { id: "turn-end-send", run: turnEndSend },
  { id: "command-slash", run: commandSlash },
  { id: "ask-answer", run: askAnswer },
  { id: "send-on-agents-screen", run: sendOnAgentsScreen },
];

/** Run every scenario once, each in its own pane, and write summary.json. Never throws for a scenario. */
export async function runPhoneLeg(env: PhoneEnv, makeProject: (dir: string) => void): Promise<PhoneFacts> {
  mkdirSync(env.outDir, { recursive: true });
  const results: PhoneScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    let pane: string | null = null;
    let result: PhoneScenarioResult;
    try {
      const started = await startAgent(env, scenario.id, makeProject);
      pane = started.pane;
      if (!started.ready) {
        result = phoneResult(scenario.id, [notReachedCase("start", started.note)], [], await capture(env, scenario.id, pane));
      } else {
        const ran = await scenario.run(env, started);
        const receipts = await ownReceipts(env, pane, ran.ids);
        result = phoneResult(scenario.id, ran.cases, receipts, await capture(env, scenario.id, pane));
      }
    } catch (err) {
      // A failed HTTP call is not a reader verdict: the scenario is not reached, and the log says why.
      const note = err instanceof Error ? err.message : String(err);
      result = phoneResult(scenario.id, [notReachedCase("run", `the scenario stopped: ${note}`)], [], await capture(env, scenario.id, pane));
    }
    result = applyPhoneGaps(result, env.harness, env.gaps);
    results.push(result);
    env.log(`phone ${scenario.id}: ${result.verdict}: ${result.detail}${result.capture === null ? "" : ` (capture ${result.capture})`}`);
    if (pane !== null) {
      const closed = await env.client.close(pane).catch(() => false);
      if (!closed) env.log(`phone ${scenario.id}: pane ${pane} did not close through /api/pane/close`);
    }
  }
  // TODO(phone leg, crew member): a member leg needs a second bridge as a crew member of the scratch
  // bridge, on an older Collie, and a send from the lead to the member's pane (bug 3 of 1.22.0,
  // bridge/crew/forward.ts). Not built: the lab has no member.
  results.push(applyPhoneGaps(phoneResult("crew-send", [notReachedCase("member", "no member in the lab")]), env.harness, env.gaps));
  env.log("phone crew-send: not-reached: no member in the lab");
  const summary = join(env.outDir, "summary.json");
  writeFileSync(
    summary,
    `${env.redact(
      JSON.stringify(
        {
          harness: env.harness,
          version: env.version,
          target: env.target,
          bridge: env.client.base,
          turns: env.turns.used,
          streamWanted: env.streamWanted,
          results: results.map((result) => ({ id: result.id, verdict: result.verdict, detail: result.detail, cases: result.cases, receipts: result.receipts, capture: result.capture, gap: result.gap?.ref ?? null, staleGap: result.staleGap === true })),
        },
        null,
        2,
      ),
    )}\n`,
  );
  return { target: env.target, results, turns: env.turns.used, summary };
}

/** The operator's own belt rows for a harness from `/api/config` (`commands`, `bar = true`). Empty when there are none. */
export function operatorBelt(config: JsonValue | undefined, harness: string): string[] {
  const node = asJsonObject(config);
  const rows = node?.commands;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const raw of rows) {
    const row = asJsonObject(raw);
    const command = asJsonString(row?.command);
    const agent = asJsonString(row?.agent);
    if (row?.bar !== true || command === undefined) continue;
    if (agent !== undefined && agent !== harness) continue;
    if (!out.includes(command)) out.push(command);
  }
  return out;
}

/** The shipped belt, read from disk. */
export function shippedBeltFromDisk(harness: string, file: string = HARNESS_BAR_FILE): string[] {
  const name = harness.toUpperCase().replace(/[^A-Z0-9]/gu, "_");
  try {
    return shippedBelt(readFileSync(file, "utf8"), name);
  } catch {
    return [];
  }
}
