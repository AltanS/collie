// The send leg and the ask leg of a lab run (M56 spec 10). Both go through Collie's own protocol with
// Collie's own tmux adapter and key gate, the way the bridge runs them:
//
//   send  one plain message through the Send Protocol, on the PROBED path. The lab judges a version,
//         so it asks the protocol for the path a provisional profile takes.
//   ask   a message that makes the agent ask before a shell command. The lab lifts the dialog into the
//         ask book, answers it through the AskAnswerer with the option that declines (`No`), and checks
//         that the declined command never ran.
//
// Together the two legs spend at most {@link TURN_PLAN} model turns. The turn counter is checked before
// each one, so a lab never goes past its cap.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AskAnswerer, AskBook, askLifetimeOf } from "../../../bridge/surface/ask";
import { gateFor, type KeyGate } from "../../../bridge/surface/key-gate";
import { SendProtocol, SessionLocks, RowRing, SEND_READ_LINES, type SendLedger } from "../../../bridge/surface/protocol";
import { RequestStore } from "../../../bridge/surface/requests";
import type { TmuxMux } from "../../../bridge/mux/tmux/adapter";
import type { CapState, CounterKey, ExampleEntry, InboxEntry } from "../../../bridge/surface/counters";
import { liftDialog, readerBlocks } from "../../../web/src/lib/surface/lift";
import { profileFor, type ProfileMatch } from "../../../web/src/lib/surface/profile";
import { askOf } from "../../../web/src/lib/surface/surface";
import { agentOf } from "../../../web/src/test/surface-corpus";
import { factOf, viewOf, type ScreenView } from "./screens";
import type { AskFact, ScreenFact, SendFact } from "./verdict";
import type { WalkPane } from "./walk";

/** The model turns the two legs plan: the send, the ask request, and the agent's answer to a No. */
export const TURN_PLAN = 3;

export const SEND_TEXT = "Reply with only the word OK.";
export const ASK_TEXT = "Run the shell command: touch lab-file.txt. Reply with nothing else.";
export const ASK_FILE = "lab-file.txt";

const SESSION = "lab";
const WAIT_REPLY_MS = 90_000;
const WAIT_DIALOG_MS = 75_000;
const WAIT_AFTER_ANSWER_MS = 60_000;
const POLL_MS = 1000;

/** The hands of the walk and the legs on a real tmux pane. Every key leaves through the gate. */
export class TmuxPane implements WalkPane {
  keysSent = 0;
  reads = 0;

  constructor(
    private readonly mux: TmuxMux,
    private readonly gate: KeyGate,
    readonly paneId: string,
    private readonly harness: string,
  ) {}

  async read(): Promise<ScreenView> {
    const grid = await this.mux.readGrid(this.paneId, { scope: "viewport", lines: SEND_READ_LINES, styling: "preserve" });
    if (!grid.ok) throw new Error(`the lab could not read the pane: ${grid.reason} ${grid.detail}`);
    this.gate.noteRead(this.paneId);
    this.reads++;
    return viewOf(grid.value.text, this.harness);
  }

  async type(text: string): Promise<void> {
    const sent = await this.mux.typeText(this.paneId, text);
    if (!sent.ok) throw new Error(`the lab could not type: ${sent.reason} ${sent.detail}`);
    this.gate.noteWrite(this.paneId);
  }

  async keys(...keys: string[]): Promise<void> {
    const sent = await this.gate.press(this.paneId, keys, "person_tap");
    if (!sent.ok) throw new Error(`the lab could not send a key: ${sent.reason} ${sent.detail}`);
    this.keysSent += keys.length;
  }

  sleep(ms: number): Promise<void> {
    return Bun.sleep(ms);
  }
}

/** What the protocol tells the counters, kept in memory for the log. */
export class LabCounters implements SendLedger {
  readonly lines: string[] = [];

  send(key: CounterKey, end: { readonly outcome: string; readonly reason?: string | undefined; readonly probed: boolean }): void {
    this.lines.push(`send ${key.harness} ${key.version} ${key.status}: ${end.outcome}${end.reason === undefined ? "" : ` (${end.reason})`}, probed ${String(end.probed)}`);
  }

  noteManual(key: CounterKey): void {
    this.lines.push(`manual ${key.harness} ${key.version} ${key.status}`);
  }

  capState(): CapState {
    return { count: 0, limit: Number.MAX_SAFE_INTEGER, reached: false };
  }

  inbox(entry: InboxEntry): void {
    this.lines.push(`inbox ${entry.harness} ${entry.version}: frame ${entry.frame}`);
  }

  example(entry: ExampleEntry): void {
    this.lines.push(`example ${entry.harness} ${entry.version}: ${entry.outcome}, text length ${String(entry.textLength)}, frame ${entry.frame}`);
  }
}

export interface LegEnv {
  readonly harness: string;
  readonly version: string;
  readonly mux: TmuxMux;
  readonly pane: TmuxPane;
  readonly sendsDir: string;
  readonly project: string;
  readonly counters: LabCounters;
  readonly turns: { used: number; readonly cap: number };
  readonly log: (line: string) => void;
}

/** The profile at the lab's version, as the provisional one: the lab judges the probed path. */
export function labProfile(harness: string, version: string, log: (line: string) => void): ProfileMatch | null {
  const match = profileFor(harness, version, { log });
  return match === null ? null : { ...match, status: "provisional" };
}

interface Rig {
  readonly protocol: SendProtocol;
  readonly answerer: AskAnswerer;
  readonly book: AskBook;
  readonly match: ProfileMatch | null;
}

function rigFor(env: LegEnv): Rig {
  mkdirSync(env.sendsDir, { recursive: true });
  const gate = gateFor(env.mux);
  const store = new RequestStore(env.sendsDir);
  const locks = new SessionLocks();
  const ring = new RowRing();
  const book = new AskBook();
  const match = labProfile(env.harness, env.version, env.log);
  const profile = (): Promise<ProfileMatch | null> => Promise.resolve(match);
  const generation = (): string => `${env.harness}:lab`;
  const protocol = new SendProtocol({ mux: env.mux, gate, store, locks, ring, profile, generation, ledger: env.counters, asks: book });
  const answerer = new AskAnswerer({ mux: env.mux, gate, store, locks, book, ring, profile, generation });
  return { protocol, answerer, book, match };
}

let rigs = new WeakMap<TmuxMux, Rig>();

function rigOf(env: LegEnv): Rig {
  let rig = rigs.get(env.mux);
  if (rig === undefined) {
    rig = rigFor(env);
    rigs.set(env.mux, rig);
  }
  return rig;
}

/** For a test: forget every rig. */
export function resetRigs(): void {
  rigs = new WeakMap<TmuxMux, Rig>();
}

async function waitFor(pane: TmuxPane, ok: (view: ScreenView) => boolean, maxMs: number): Promise<ScreenView | null> {
  const deadline = Date.now() + maxMs;
  let view = await pane.read();
  while (!ok(view)) {
    if (Date.now() > deadline) return null;
    await pane.sleep(POLL_MS);
    view = await pane.read();
  }
  return view;
}

function spend(env: LegEnv, what: string): boolean {
  if (env.turns.used >= env.turns.cap) {
    env.log(`turn cap: ${what} not sent, ${String(env.turns.used)} of ${String(env.turns.cap)} turns used`);
    return false;
  }
  env.turns.used++;
  return true;
}

export interface LegResult<T> {
  readonly fact: T | null;
  readonly screens: ScreenFact[];
  readonly note: string;
}

/** The send leg: one message through the Send Protocol on the probed path. */
export async function runSendLeg(env: LegEnv, id = "lab-send-1"): Promise<LegResult<SendFact>> {
  const { protocol, match } = rigOf(env);
  const screens: ScreenFact[] = [];
  const before = await env.pane.read();
  if (!before.free) return { fact: null, screens, note: "the box was not free before the send" };
  if (!spend(env, "the send")) return { fact: null, screens, note: "turn cap" };
  const answer = await protocol.handle({ id, text: SEND_TEXT, mode: "send" }, { session: SESSION, paneId: env.pane.paneId, harness: env.harness });
  const receipt = answer.receipt;
  if (receipt === undefined) return { fact: null, screens, note: `no receipt: ${answer.detail ?? "none"}` };
  env.log(`send: ${receipt.outcome}${receipt.reason === undefined ? "" : ` (${receipt.reason})`}, keys ${receipt.keys.join(" ")}, profile ${match?.status ?? "none"} ${match?.version ?? "-"}`);
  const fact: SendFact = { outcome: receipt.outcome, reason: receipt.reason, probed: receipt.keys.some((key) => key === "probe") || match?.status !== "verified", keys: receipt.keys.length };
  const done = await waitFor(env.pane, (view) => view.free && view.plain.some((row) => /^\s*●\s*OK\b/u.test(row)), WAIT_REPLY_MS);
  const after = done ?? (await env.pane.read());
  screens.push(factOf(after, "send", done === null ? "after the send, no reply seen" : "after the send and the reply", "idle"));
  return { fact, screens, note: done === null ? "the reply did not show in time" : "" };
}

/** The ask leg: a dialog lifted into the ask book and answered with its No, through the AskAnswerer. */
export async function runAskLeg(env: LegEnv, id = "lab-send-2"): Promise<LegResult<AskFact>> {
  const { protocol, answerer, book, match } = rigOf(env);
  const screens: ScreenFact[] = [];
  const before = await waitFor(env.pane, (view) => view.free, 30_000);
  if (before === null) return { fact: null, screens, note: "the box was not free before the ask request" };
  if (!spend(env, "the ask request")) return { fact: null, screens, note: "turn cap" };
  const sent = await protocol.handle({ id, text: ASK_TEXT, mode: "send" }, { session: SESSION, paneId: env.pane.paneId, harness: env.harness });
  env.log(`ask request: ${sent.receipt?.outcome ?? "no receipt"}${sent.receipt?.reason === undefined ? "" : ` (${sent.receipt.reason})`}`);
  if (sent.receipt === undefined || !["sent", "effective"].includes(sent.receipt.outcome)) return { fact: null, screens, note: "the ask request did not settle" };

  const dialog = await waitFor(env.pane, (view) => askOf(view.surface.modal) !== null || view.cue === "strong", WAIT_DIALOG_MS);
  if (dialog === null) {
    screens.push(factOf(await env.pane.read(), "ask", "waiting for the dialog", "either"));
    return { fact: null, screens, note: "the agent opened no dialog in time" };
  }
  screens.push(factOf(dialog, "ask", "the permission dialog", "dialog"));
  const lifted = liftDialog(readerBlocks(dialog.rows, agentOf(env.harness)));
  if (lifted === null) return { fact: null, screens, note: "the dialog was on screen and no reader lifted it" };
  const ask = book.publish(env.pane.paneId, `${env.harness}:lab`, lifted, askLifetimeOf(match));
  if (ask === null) return { fact: null, screens, note: "the ask book minted no ask" };
  const no = ask.options.find((option) => /^no\b/iu.test(option.label));
  if (no === undefined) return { fact: null, screens, note: `the dialog has no No option: ${ask.options.map((option) => option.label).join(" | ")}` };
  const reply = await answerer.handle({ askId: ask.id, hash: ask.hash, optionId: no.id, origin: "person_tap" }, { session: SESSION, paneId: env.pane.paneId, harness: env.harness });
  const receipt = reply.receipt;
  env.log(`ask answer: option ${no.id} "${no.label}": ${receipt?.outcome ?? "no receipt"}${receipt?.reason === undefined ? "" : ` (${receipt.reason})`}, keys ${receipt?.keys.join(" ") ?? ""}`);

  // The agent answers a No with one more turn. The leg waits for the box, then checks the file.
  const afterView = await waitFor(env.pane, (view) => view.free, WAIT_AFTER_ANSWER_MS);
  if (afterView !== null) env.turns.used = Math.min(env.turns.cap, Math.max(env.turns.used, TURN_PLAN));
  screens.push(factOf(afterView ?? (await env.pane.read()), "ask", "after the answer", "idle"));
  const fileCreated = existsSync(join(env.project, ASK_FILE));
  const fact: AskFact = { outcome: receipt?.outcome ?? "unknown", reason: receipt?.reason, fileCreated };
  return { fact, screens, note: afterView === null ? "the box did not come back after the answer" : "" };
}
