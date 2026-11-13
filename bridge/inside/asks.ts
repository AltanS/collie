// A part's permission ask becomes today's hold (M99 spec 04, README decision 9).
//
// The Claude mod is a second emitter of the SAME hold the settings hook gives (`cli/hold.ts`): its
// `ask.open` is turned into the hook's own `HoldRequest` (the same shown input, cut rule and
// screen-only list, from the harness's hold profile) and handed to the session's `takeHold`. So the
// card, its hash check, its receipt and its timing are today's, and nothing on the phone changes.
//
// The answer still needs a person's tap: only the hold book's `decide`, which only the phone's answer
// route calls, writes a decision, and this module passes it on to the part as an `answer` command.
// Nothing here answers by itself. A hold that ends with no decision (the limit, a hash that moved,
// the desk) leaves the part to time out and hand the dialog back to the desk.

import { randomUUID } from "node:crypto";

import { HOLD_GRACE_MS, HOLD_WIRE_VERSION, shownInputOf, type HoldDecision, type HoldProfile, type HoldRequest } from "../../web/src/lib/surface/hold.ts";
import type { JsonValue } from "../../web/src/lib/json.ts";
import type { Held, HoldConn } from "../surface/hold.ts";
import type { AskVerdict, EnqueueOutcome } from "./hub.ts";
import type { PaneAddress } from "./queue.ts";
import type { PartView } from "./registry.ts";

/** What a session offers this module. */
export interface PartAskSession {
  /** The harness the multiplexer names on the pane (the profile key), or null. */
  harnessOf(paneId: string): string | null;
  /** The harness's hold profile, or undefined when it holds nothing. */
  holdProfile(harness: string): HoldProfile | undefined;
  /** The session's own hand-off, exactly as a hook's request takes it (`takeHold`). */
  takeHold(paneId: string, request: HoldRequest, conn: HoldConn, onClose: (listener: (how: "closed" | "elsewhere") => void) => void): Held | null;
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
    agent: null,
    hold: !hold.screenOnly.includes(tool) && !shown.cut,
    at,
  };
  return shown.cut ? { ...request, cut: true } : request;
}

/** The part side of today's holds. */
export class PartAsks {
  /** The close listener of each open hold, by part id and ask id. */
  private readonly open = new Map<string, (how: "closed" | "elsewhere") => void>();
  /**
   * The asks a part opened that the hold did not take (a cut input, a screen-only tool, a pane with no
   * known agent), by key, with their pane. While one is open the screen reader owns the pane's
   * permission dialog again, so the phone keeps today's keys ask for it (`ownsPermission`).
   */
  private readonly toScreen = new Map<string, string>();

  constructor(private readonly deps: PartAsksDeps) {}

  /** An `ask.open` of a part: a hold, and the wait it asks of the part; undefined when this is no permission. */
  ask(part: PartView, ask: PartAsk): AskVerdict | undefined {
    if (ask.kind !== "permission" || ask.tool === null) return undefined;
    const session = this.deps.sessionOf(part.address.session);
    const harness = session?.harnessOf(part.address.paneId) ?? null;
    const hold = harness === null ? undefined : session?.holdProfile(harness);
    const key = `${part.partId}\u0000${ask.id}`;
    if (session === undefined || harness === null || hold === undefined) return this.screen(key, part);
    const request = partHoldRequest(part, harness, ask.tool, ask.input, hold, (this.deps.now ?? Date.now)());
    const conn: HoldConn = {
      // Only the hold book's decide calls this: a person's tap on the card.
      reply: (decision) => this.deps.enqueue(part.address, { id: `ans-${randomUUID().replaceAll("-", "")}`, kind: "answer", ask: ask.id, decision }).ok,
      release: () => this.open.delete(key),
    };
    const held = session.takeHold(part.address.paneId, request, conn, (listener) => this.open.set(key, listener));
    if (held === null) return this.screen(key, part);
    // The hook's own wait: the hold's limit and the grace (cli/hold.ts).
    return { wait: true, waitMs: hold.limitMs + HOLD_GRACE_MS };
  }

  /** Whether the pane has a part ask open that the hold did not take: then the screen owns the dialog. */
  screenAskOpen(session: string, paneId: string): boolean {
    for (const [key, pane] of this.toScreen) if (pane === paneId && key.startsWith(`${session}\u0001`)) return true;
    return false;
  }

  private screen(key: string, part: PartView): AskVerdict {
    this.toScreen.set(`${part.address.session}\u0001${key}`, part.address.paneId);
    return { wait: false };
  }

  private forget(match: (key: string) => boolean): void {
    for (const key of Array.from(this.toScreen.keys())) if (match(key.slice(key.indexOf("\u0001") + 1))) this.toScreen.delete(key);
  }

  /** The part closed its ask (the desk answered, its wait ran out): the hold ends as a closed hook would. */
  closed(partId: string, askId: string): void {
    const key = `${partId}\u0000${askId}`;
    const listener = this.open.get(key);
    this.open.delete(key);
    this.forget((k) => k === key);
    listener?.("closed");
  }

  /** The part is gone: each of its open holds ends as a closed hook would. */
  gone(partId: string): void {
    this.forget((key) => key.startsWith(`${partId}\u0000`));
    for (const [key, listener] of Array.from(this.open)) {
      if (!key.startsWith(`${partId}\u0000`)) continue;
      this.open.delete(key);
      listener("closed");
    }
  }
}
