// A part's permission ask becomes today's hold (M99 spec 04, README decision 9).
//
// The Claude mod is a second emitter of the SAME hold the settings hook gives (`cli/hold.ts`): its
// `ask.open` is turned into the hook's own `HoldRequest` (the same shown input, cut rule and
// screen-only list, from the harness's hold profile) and handed to the session's `takeHold`. So the
// card, its hash check, its receipt and its timing are today's, and nothing on the phone changes.
//
// OWNERSHIP IS PER DIALOG (the lead's design after the review of spec 04). A part owns a permission
// dialog only while its hold for that pane and that dialog is live (`ownsDialog`). Until its
// `ask.open` has become a live hold, the settings hook's hold or the keys ask stays; when its hold
// ends with no decision, the screen reader owns the dialog again and mints a keys ask, as on the hook
// path. A part never takes a card away by saying hello: one card is the target, never zero.
//
// The answer still needs a person's tap: only the hold book's `decide`, which only the phone's answer
// route calls, writes a decision, and this module passes it on to the part as an `answer` command. The
// hold settles from that command's own end: the part's `sent` is `phone`; its `failed` with reason
// `desk` (the desk answered first) is `desk`; any other failure or a withdrawal voids the hold.

import { randomUUID } from "node:crypto";

import { HOLD_GRACE_MS, HOLD_WIRE_VERSION, shownInputOf, type HoldDecision, type HoldProfile, type HoldRequest } from "../../web/src/lib/surface/hold.ts";
import type { JsonValue } from "../../web/src/lib/json.ts";
import type { Held, HoldConn } from "../surface/hold.ts";
import type { AskVerdict, EnqueueOutcome } from "./hub.ts";
import type { PaneAddress, QueuedCommand } from "./queue.ts";
import type { PartView } from "./registry.ts";

/** What a session offers this module. */
export interface PartAskSession {
  /** The harness the multiplexer names on the pane (the profile key), or null. */
  harnessOf(paneId: string): string | null;
  /** The harness's hold profile, or undefined when it holds nothing. */
  holdProfile(harness: string): HoldProfile | undefined;
  /** The session's own hand-off, exactly as a hook's request takes it (`takeHold`). */
  takeHold(paneId: string, request: HoldRequest, conn: HoldConn, onClose: (listener: (how: "closed" | "elsewhere") => void) => void): Held | null;
  /** Settle a hold whose decision went out (`HoldBook.settle`), or end it with no decision (`HoldBook.end`). */
  settle(held: Held, outcome: "phone" | "desk" | "void"): void;
}

export interface PartAsksDeps {
  sessionOf(name: string): PartAskSession | undefined;
  /** Queue the answer for the part's poll on that ask. */
  enqueue(address: PaneAddress, command: { readonly id: string; readonly kind: "answer"; readonly ask: string; readonly decision: HoldDecision }): EnqueueOutcome;
  readonly now?: () => number;
}

/** The ask as the hub hands it over. */
export interface PartAsk {
  readonly id: string;
  readonly kind: string;
  readonly tool: string | null;
  readonly input: JsonValue | null;
}

/** The hook's request for a part's ask: the fields `cli/hold.ts` `holdRequestOf` writes, from the same profile. */
export function partHoldRequest(part: Pick<PartView, "pid" | "pidStartTime">, harness: string, tool: string, input: JsonValue | null, hold: HoldProfile, at: number): HoldRequest {
  const shown = shownInputOf(input ?? undefined, hold.inputShown, hold.inputDetails[tool]);
  const request: HoldRequest = {
    v: HOLD_WIRE_VERSION,
    harness,
    pid: part.pid,
    pidStartTime: part.pidStartTime ?? 0,
    // The part is placed already (its hello); the hold needs no markers.
    markers: [],
    tool,
    input: shown.text,
    // A part reports only its main session's asks: a subagent's stays with the hook and the screen.
    agent: null,
    hold: !hold.screenOnly.includes(tool) && !shown.cut,
    at,
  };
  return shown.cut ? { ...request, cut: true } : request;
}

/** Whether a live hold is the one dialog a hook's request names: the same pane, tool, input and agent. Pure. */
export function sameDialog(held: Pick<Held, "paneId" | "state" | "request">, paneId: string, request: Pick<HoldRequest, "tool" | "input" | "agent">): boolean {
  if (held.state !== "held" && held.state !== "answering") return false;
  return held.paneId === paneId && request.agent === null && held.request.agent === null && held.request.tool === request.tool && held.request.input === request.input;
}

interface Open {
  readonly session: string;
  readonly held: Held;
  listener: ((how: "closed" | "elsewhere") => void) | null;
}

/** The part side of today's holds. */
export class PartAsks {
  /** Each part ask that became a hold, by part id and ask id. */
  private readonly open = new Map<string, Open>();
  /** The hold each answer command is for, by command id. */
  private readonly answers = new Map<string, Open>();

  constructor(private readonly deps: PartAsksDeps) {}

  /** An `ask.open` of a part: a hold, and the wait it asks of the part; undefined when this is no permission. */
  ask(part: PartView, ask: PartAsk): AskVerdict | undefined {
    if (ask.kind !== "permission" || ask.tool === null) return undefined;
    const session = this.deps.sessionOf(part.address.session);
    const harness = session?.harnessOf(part.address.paneId) ?? null;
    const hold = harness === null ? undefined : session?.holdProfile(harness);
    if (session === undefined || harness === null || hold === undefined) return { wait: false };
    const request = partHoldRequest(part, harness, ask.tool, ask.input, hold, (this.deps.now ?? Date.now)());
    const key = `${part.partId}\u0000${ask.id}`;
    let entry: Open | null = null;
    // `takeHold` hands its close listener over before it returns: keep it until the entry exists.
    let pending: ((how: "closed" | "elsewhere") => void) | null = null;
    const conn: HoldConn = {
      // Only the hold book's decide calls this: a person's tap on the card. True means queued; the
      // hold settles from the command's own end (`command`).
      reply: (decision) => {
        const id = `ans-${randomUUID().replaceAll("-", "")}`;
        const queued = this.deps.enqueue(part.address, { id, kind: "answer", ask: ask.id, decision }).ok;
        if (queued && entry !== null) this.answers.set(id, entry);
        return queued;
      },
      release: () => {
        this.open.delete(key);
      },
    };
    const held = session.takeHold(part.address.paneId, request, conn, (listener) => {
      if (entry !== null) entry.listener = listener;
      else pending = listener;
    });
    if (held === null) return { wait: false };
    entry = { session: part.address.session, held, listener: pending };
    this.open.set(key, entry);
    // The hook's own wait: the hold's limit and the grace (cli/hold.ts).
    return { wait: true, waitMs: hold.limitMs + HOLD_GRACE_MS };
  }

  /** Whether the pane's dialog that a hook's request names is held by a part now. */
  ownsDialog(session: string, paneId: string, request: Pick<HoldRequest, "tool" | "input" | "agent">): boolean {
    for (const entry of this.open.values()) if (entry.session === session && sameDialog(entry.held, paneId, request)) return true;
    return false;
  }

  /** An answer command ended: settle its hold from the part's own word. */
  command(entry: Readonly<Pick<QueuedCommand, "command" | "state" | "reason">>): void {
    const open = this.answers.get(entry.command.id);
    if (open === undefined || entry.state === "queued" || entry.state === "taken") return;
    this.answers.delete(entry.command.id);
    const session = this.deps.sessionOf(open.session);
    if (session === undefined) return;
    if (entry.state === "sent") session.settle(open.held, "phone");
    else session.settle(open.held, entry.state === "failed" && entry.reason === "desk" ? "desk" : "void");
  }

  /** The part closed its ask (the desk answered, its wait ran out): the hold ends as a closed hook would. */
  closed(partId: string, askId: string): void {
    const key = `${partId}\u0000${askId}`;
    const entry = this.open.get(key);
    this.open.delete(key);
    entry?.listener?.("closed");
  }

  /** The part is gone: each of its open holds ends as a closed hook would. */
  gone(partId: string): void {
    for (const [key, entry] of Array.from(this.open)) {
      if (!key.startsWith(`${partId}\u0000`)) continue;
      this.open.delete(key);
      entry.listener?.("closed");
    }
  }
}
