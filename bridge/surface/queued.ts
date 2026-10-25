// Queued sends as Collie's own receipts know them (ADR 0122). A send into a running turn settles `sent`
// with `queued: true`: the harness took the text and holds it for after the turn. Most harnesses write
// nothing about that wait into their journal until the turn yields, so the Chat could not draw the
// message at all, and a Stop that made the harness give the text back to its input box left the
// receipt saying `sent` + `queued` forever. This memory closes both gaps:
//
//   - the live window draws each queued send as a card until the journal shows its text as a prompt
//     (journal/receipt-queue.ts holds that rule; this file only lists what is open);
//   - a read of the pane's box that holds the text of an open queued send marks it `returned`: the
//     receipt takes `late: "returned"` (RequestStore.markReturned), the card says the text is back in
//     the box and offers Send (a `submit` of the box) and Discard;
//   - a returned row ends when a later read shows the box without that text (sent, cleared, edited).
//
// Reads come from two places: the poll's Surface read (SurfaceShadow.boxOf, through tickQueued) and the
// Stop's own read-back after its key (StopService), which lists what came back on its receipt. A read
// taken before an entry settled, or while a send runs on the pane, never changes an entry: during a
// send's S1 the box holds that send's own text.
//
// The texts live in memory only, like the row ring: a request file keeps a hash and, at most, the one
// line Sent would keep. After a restart the open entries come back from those lines, so a text that
// had no line (several lines, a secret shape, too long) is not drawn again. Short is the safe side: a
// card missing is a screen that says less; a card for a message that is not waiting is a screen that lies.
//
// No harness name lives here (no-harness-names.test.ts scans this folder).

import { sendLines } from "../../web/src/lib/surface/send.ts";
import type { RequestStore, SendRecord } from "./requests.ts";

/**
 * How long a queued send counts as waiting, from its submit key. Past it the card goes, whatever the
 * box or the journal says. The hold queue's 30 minutes is the precedent (holds.ts): a turn that runs
 * longer than that with a message behind it is rare, and a card that outlives the queue it stood for
 * is the worse fault. A returned row keeps the same clock.
 */
export const QUEUED_SEND_MS = 30 * 60_000;
/** The most open queued sends one protocol keeps; past it the oldest go first. */
export const QUEUED_SENDS_MAX = 64;

/** Where an open queued send stands: waiting in the harness, or given back to the input box. */
export type QueuedSendState = "queued" | "returned";

/** One open queued send, as the protocol keeps it. */
interface Entry {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  /** The pane's agent when the send settled (the part of the generation before `:`). */
  readonly agent: string;
  readonly text: string;
  /** The lines as the send wrote them: what the box shows when the text comes back. */
  readonly lines: readonly string[];
  /** The profile's collapse pattern at settle, or null: a long paste may come back folded. */
  readonly collapse: string | null;
  /** When the submit key went out (settle time for a seeded entry), epoch ms. */
  readonly at: number;
  state: QueuedSendState;
  /** When a read first showed it back in the box. */
  returnedAt?: number;
}

/** What the live window is handed for one pane: oldest first. */
export interface ReceiptQueued {
  readonly requestId: string;
  readonly text: string;
  readonly at: number;
  readonly state: QueuedSendState;
}

/** What `add` takes from a settled run. */
export interface QueuedSendInput {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly generation: string;
  readonly text: string;
  readonly collapse: string | null;
  readonly at: number;
}

/** Whether a box text equals these lines, white space and the collapse form as the protocol reads them. */
export type BoxMatcher = (box: string, lines: readonly string[], collapse: RegExp | null) => boolean;

export interface QueuedSendsDeps {
  readonly store: Pick<RequestStore, "list" | "markReturned">;
  readonly generation: (paneId: string) => string | null;
  readonly matches: BoxMatcher;
  readonly now: () => number;
  /** Whether a send runs on the pane now: its box holds that send's text, not a returned one. */
  readonly busy: (session: string, paneId: string) => boolean;
}

/** The agent part of a pane generation (`<agent>:<session>`). */
function agentOf(generation: string): string {
  const cut = generation.indexOf(":");
  return cut === -1 ? generation : generation.slice(0, cut);
}

export class QueuedSends {
  private entries: Entry[] = [];
  /** The sessions whose open entries were read back from the request files once. */
  private readonly seeded = new Set<string>();

  constructor(private readonly deps: QueuedSendsDeps) {}

  /** A send settled `sent` with `queued`: it waits in the harness from now on. */
  add(input: QueuedSendInput): void {
    this.entries = this.entries.filter((entry) => entry.id !== input.id);
    this.entries.push({
      id: input.id,
      session: input.session,
      paneId: input.paneId,
      agent: agentOf(input.generation),
      text: input.text,
      lines: sendLines(input.text),
      collapse: input.collapse,
      at: input.at,
      state: "queued",
    });
    this.prune();
  }

  /** The send closed another way (a prompt edge confirmed it, a Send from its card took it). */
  drop(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }

  /** The pane's open queued sends, oldest first. A pane that holds another agent now has none. */
  of(session: string, paneId: string): ReceiptQueued[] {
    this.seed(session);
    this.prune();
    const generation = this.deps.generation(paneId);
    if (generation === null) return [];
    const agent = agentOf(generation);
    return this.entries
      .filter((entry) => entry.session === session && entry.paneId === paneId && entry.agent === agent)
      .map((entry) => ({ requestId: entry.id, text: entry.text, at: entry.at, state: entry.state }));
  }

  /** The text of a returned row, for its Send or Discard; null when the row is not back in the box. */
  returnedText(session: string, paneId: string, id: string): string | null {
    const entry = this.entries.find((e) => e.id === id && e.session === session && e.paneId === paneId);
    return entry?.state === "returned" ? entry.text : null;
  }

  /** The panes of a session with open entries, for the poll's tick. */
  panes(session: string): string[] {
    this.seed(session);
    return [...new Set(this.entries.filter((entry) => entry.session === session).map((entry) => entry.paneId))];
  }

  /**
   * One read of a pane's input box, taken at `readAt`. `box` is the box's text (empty for an empty box),
   * or null when the read found no box: then nothing changes. The open entries, oldest first, whose
   * texts the box holds in order and nothing else (one text, or several the harness put back together)
   * are `returned`, and each receipt takes its late mark once. A returned entry the box no longer holds
   * ends. A read older than an entry's settle, or taken while a send runs on the pane, changes nothing.
   * Returns the ids the box holds now.
   */
  boxRead(session: string, paneId: string, box: string | null, readAt: number): string[] {
    if (box === null || this.deps.busy(session, paneId)) return [];
    this.seed(session);
    this.prune();
    const open = this.entries.filter((entry) => entry.session === session && entry.paneId === paneId && entry.at <= readAt);
    if (open.length === 0) return [];
    const held = this.heldRun(box, open);
    for (const entry of held) {
      if (entry.state === "returned") continue;
      entry.state = "returned";
      entry.returnedAt = readAt;
      try {
        this.deps.store.markReturned(entry.id);
      } catch (err) {
        console.warn(`[send] could not mark ${entry.id} returned: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const gone = open.filter((entry) => entry.state === "returned" && !held.includes(entry) && (entry.returnedAt ?? 0) < readAt);
    if (gone.length > 0) this.entries = this.entries.filter((entry) => !gone.includes(entry));
    return held.map((entry) => entry.id);
  }

  /**
   * The longest run of entries, in order, whose lines together are exactly the box. The harness may
   * give back one queued text or all of them in one box; a box that holds anything else matches none.
   */
  private heldRun(box: string, open: readonly Entry[]): Entry[] {
    if (box.trim().length === 0) return [];
    for (let start = 0; start < open.length; start++) {
      for (let end = open.length; end > start; end--) {
        const run = open.slice(start, end);
        const lines = run.flatMap((entry) => entry.lines);
        // One collapse pattern serves the run: the entries of one pane share a profile.
        const pattern = run[0]!.collapse;
        if (this.deps.matches(box, lines, pattern === null ? null : new RegExp(pattern, "uy"))) return run;
      }
    }
    return [];
  }

  private prune(): void {
    const now = this.deps.now();
    this.entries = this.entries.filter((entry) => now - entry.at <= QUEUED_SEND_MS);
    if (this.entries.length > QUEUED_SENDS_MAX) this.entries.splice(0, this.entries.length - QUEUED_SENDS_MAX);
  }

  /**
   * After a restart: the session's queued sends inside the bound come back from their request files,
   * text from the kept line. A receipt already marked returned stays out: its box read is gone with
   * the process, and the next read of a box that still holds the text would not be told apart from a
   * draft typed at the desk. Once per session.
   */
  private seed(session: string): void {
    if (this.seeded.has(session)) return;
    this.seeded.add(session);
    let records: SendRecord[];
    try {
      records = this.deps.store.list();
    } catch (err) {
      console.warn(`[send] could not read the queued sends back: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const now = this.deps.now();
    for (const record of records) {
      const receipt = record.receipt;
      if (record.session !== session || record.phase !== "settled" || receipt === undefined) continue;
      if (receipt.outcome !== "sent" || receipt.queued !== true || receipt.late !== undefined || record.line === undefined) continue;
      const at = record.submitSentAt ?? record.acceptedAt;
      if (now - at > QUEUED_SEND_MS || this.entries.some((entry) => entry.id === record.id)) continue;
      this.entries.push({
        id: record.id,
        session,
        paneId: record.paneId,
        agent: agentOf(record.paneGeneration),
        text: record.line,
        lines: sendLines(record.line),
        collapse: null,
        at,
        state: "queued",
      });
    }
    this.entries.sort((a, b) => a.at - b.at);
    this.prune();
  }
}
