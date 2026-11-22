// Queued sends as Collie's own receipts know them (ADR 0122). A send into a running turn settles `sent`
// with `queued: true`: the harness took the text and holds it for after the turn. Most harnesses write
// nothing about that wait into their journal until the turn yields, so the Chat could not draw the
// message at all, and a Stop that made the harness give the text back to its input box left the
// receipt saying `sent` + `queued` forever. This memory closes both gaps.
//
// THREE STATES, and no card goes without one of its exits:
//
//   queued       the harness holds the text. Ends when the journal shows it as a prompt (the window's
//                rule, journal/receipt-queue.ts), when a read shows it back in the box (returned), or
//                when Collie can no longer tell (unconfirmed, below).
//   returned     a read of the pane's box showed exactly this text (or a run of queued texts the
//                harness gave back together, which is ONE card): the receipt takes `late: "returned"`,
//                the card offers Send and Discard. Ends when a later read shows the box without it, on
//                its Send or Discard, or when the journal shows the prompt.
//
// A SUBMITTED send (a receipt that settled `sent` or `effective` with no `queued`: the harness started a
// turn with it) is kept the same quiet way. A Stop early in that turn makes the harness give the prompt
// back to the box and take it out of the transcript (Claude Code 2.1.319, lab 2026-11-07: Escape seven
// seconds into the turn), and then the box held a draft nobody had typed at the desk, every later send
// was refused `draft_present`, and nothing said whose text it was. Like a steer it is a card only once a
// read shows it back, and a prompt edge does not end it: the edge comes at the submit, before the Stop.
//
// A STEER (a send whose receipt settled `steered`) is a candidate too, but never a card of its own: it
// is not waiting for the turn to end, the harness takes it at the next step. It is kept only so that a
// Stop which makes the harness give back its steers AND its queued texts together (steers first, then a
// blank row, then the queue) can be matched as one run. A steer that was never seen in the box is
// dropped silently, after {@link IDLE_EMPTY_POLLS} polls that read the turn idle (it landed, or the
// turn ended without it), and at the same bound as a queued card. A steer is not read back from the
// request files after a restart.
//   unconfirmed  Collie cannot tell where the message went: the pane read idle with an empty box on two
//                polls in a row while it was queued, or a clock below ran out. The card says so and
//                offers Discard only, which drops the card and presses nothing. Ends on that Discard,
//                when the journal shows the prompt after all, or one more bound later.
//
// THE CLOCK is the time since the last read that saw the pane's turn running, not the submit key: a
// long turn keeps its queued card. Past {@link QUEUED_SEND_MS} with no busy read, a queued card turns
// unconfirmed; a returned card has the same bound from the last read that saw it in the box.
//
// Reads come from two places: the poll's Surface read (SurfaceShadow.boxOf, through tickQueued) and the
// Stop's own read-back after its key (StopService), which lists what came back on its receipt. Only
// poll reads count toward the idle-and-empty exit: a Stop's read-backs come 0.4 s apart, before the
// harness may have put the text back. A read taken before an entry settled, or while a send runs on
// the pane, never changes an entry: during a send's S1 the box holds that send's own text.
//
// The texts live in memory only, like the row ring: a request file keeps a hash and, at most, the one
// line Sent would keep. After a restart the open entries inside the bound come back from those lines,
// so a text that had no line (several lines, a secret shape, too long) is not drawn again.
//
// No harness name lives here (no-harness-names.test.ts scans this folder).

import type { SurfaceTurn } from "../../web/src/lib/surface/surface.ts";
import { sendLines } from "../../web/src/lib/surface/send.ts";
import type { RequestStore, SendRecord } from "./requests.ts";

/**
 * The bound, as data. A queued card turns `unconfirmed` this long after the last read that saw the
 * pane's turn running (the submit key, before any read); a returned card this long after the last read
 * that saw it in the box; an unconfirmed card ends this long after it turned. The hold queue's 30
 * minutes is the precedent (holds.ts).
 */
export const QUEUED_SEND_MS = 30 * 60_000;
/**
 * The most open queued and returned cards one protocol keeps; past it the oldest turn `unconfirmed`
 * rather than vanish. Unconfirmed cards past twice this number go, oldest first: memory has an end.
 */
export const QUEUED_SENDS_MAX = 64;
/** Polls in a row that read the pane idle with an empty box before a queued card turns unconfirmed. */
export const IDLE_EMPTY_POLLS = 2;

/** Where an open queued send stands. */
export type QueuedSendState = "queued" | "returned" | "unconfirmed";

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
  /** The newest read that saw the pane's turn running (starts at {@link at}): the queued clock. */
  busyAt: number;
  /** The newest read that showed it in the box: the returned clock. */
  seenAt?: number;
  /** When it turned unconfirmed: the unconfirmed clock. */
  unconfirmedAt?: number;
  /** Poll reads in a row that found the pane idle with an empty box, and the newest one's time. */
  idleEmpty: number;
  idleEmptyAt?: number;
  /** The first id of the run of returned texts this one came back with; absent when it came back alone. */
  group?: string;
  /** A steer or a submitted send, not a queued send: never drawn until it is returned, and dropped silently when it landed. */
  readonly steer: boolean;
  /** A submitted send (see the header): a prompt edge does not end it. */
  readonly submitted: boolean;
  /**
   * The text is the request's own, whole: false for an entry read back from a request file after a restart,
   * whose text is the one kept line. Only a whole text may go into the person's composer (Edit on its card).
   */
  readonly whole: boolean;
  /**
   * A take-back pressed its key and the log showed no `back` move (ADR 0122, the 2026-11-22 addendum): a box
   * that shows this text now holds a copy the key recalled from history, so no box read makes it `returned`.
   * It leaves when the journal shows it sent, or on the clock.
   */
  boxBlind?: true;
}

/** One card the live window is handed for a pane, oldest first. A returned run is one card. */
export interface ReceiptQueued {
  /** The card's request id; for a returned run, the run's first. */
  readonly requestId: string;
  /** The text; for a returned run, the run's texts joined with a newline, as the box holds them. */
  readonly text: string;
  readonly at: number;
  readonly state: QueuedSendState;
  /** Every text of the card is its request's own text, whole (see `Entry.whole`); absent means not known whole. */
  readonly whole?: true;
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
  /** The send settled `steered`, not `sent` + `queued` (see the header). */
  readonly steer?: boolean;
  /** The send settled `sent` or `effective` with no `queued`: the harness started a turn with it (see the header). */
  readonly submitted?: boolean;
}

/** One read of a pane, as {@link QueuedSends.boxRead} takes it. */
export interface BoxReading {
  /** The input box's text, "" when empty, null when the read found no box (then the box says nothing). */
  readonly box: string | null;
  /** When the screen was read, epoch ms. */
  readonly at: number;
  /** The turn the read's Surface claimed. */
  readonly turn: SurfaceTurn;
  /** A poll read (true) or a Stop's read-back (false): only polls count toward the idle-and-empty exit. */
  readonly poll: boolean;
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

/** Steers before queued texts, each kept in send order: how the harness puts them back into the box. */
function inBoxOrder(entries: readonly Entry[]): Entry[] {
  return [...entries.filter((entry) => entry.steer), ...entries.filter((entry) => !entry.steer)];
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
      busyAt: input.at,
      idleEmpty: 0,
      steer: input.steer === true || input.submitted === true,
      submitted: input.submitted === true,
      whole: true,
    });
    this.age();
  }

  /**
   * A prompt edge took the send: a queued send or a steer is not waiting any more and goes, with its run.
   * A submitted send stays: its edge comes at the submit, and a Stop after it may still give it back.
   */
  taken(id: string): void {
    if (this.entries.some((entry) => entry.id === id && entry.submitted)) return;
    this.drop(id);
  }

  /** The send closed another way (a prompt edge confirmed it, a Send from its card took it): it goes, with its run. */
  drop(id: string): void {
    const group = this.entries.find((entry) => entry.id === id)?.group ?? id;
    this.entries = this.entries.filter((entry) => entry.id !== id && (entry.group ?? entry.id) !== group);
  }

  /**
   * The pane's cards, oldest first: one per open send, one per returned run. A pane that holds another
   * agent now has none.
   */
  of(session: string, paneId: string): ReceiptQueued[] {
    this.seed(session);
    this.age();
    const generation = this.deps.generation(paneId);
    if (generation === null) return [];
    const agent = agentOf(generation);
    const mine = this.entries.filter((entry) => entry.session === session && entry.paneId === paneId && entry.agent === agent);
    const cards: ReceiptQueued[] = [];
    for (const entry of mine) {
      if (entry.group !== undefined && entry.group !== entry.id) continue;
      // A steer that nobody gave back is no card: the harness took it, it does not wait.
      if (entry.steer && entry.state !== "returned") continue;
      const run = this.runOf(entry, mine);
      const card: ReceiptQueued = { requestId: entry.id, text: run.map((e) => e.text).join("\n"), at: entry.at, state: entry.state };
      // Said on a returned card only, the one card Edit may act on.
      cards.push(entry.state === "returned" && run.every((e) => e.whole) ? { ...card, whole: true } : card);
    }
    return cards;
  }

  /**
   * The text of a returned card, for its Send or Discard: the run's texts joined as the box holds them.
   * Null when the card is not back in the box on this pane, or the id is not the card's own.
   */
  returnedText(session: string, paneId: string, id: string): string | null {
    const entry = this.entries.find((e) => e.id === id && e.session === session && e.paneId === paneId);
    if (entry === undefined || entry.state !== "returned" || (entry.group !== undefined && entry.group !== entry.id)) return null;
    return this.runOf(entry, this.entries).map((e) => e.text).join("\n");
  }

  /**
   * A take-back moved these texts into the person's composer (ADR 0122, the 2026-11-22 addendum): for each
   * text, the oldest open send of the pane with the same text (white space folded) goes, with its run.
   * A submitted send stays: it is no queued message.
   */
  takenBack(session: string, paneId: string, texts: readonly string[]): void {
    for (const text of texts) {
      const want = text.replace(/\s+/gu, "");
      const entry = this.entries.find((e) => e.session === session && e.paneId === paneId && !e.submitted && e.text.replace(/\s+/gu, "") === want);
      if (entry !== undefined) this.drop(entry.id);
    }
  }

  /**
   * A take-back pressed its key and the log showed no `back` move: for each text, the oldest open queued send of
   * the pane with the same text (white space folded) that is not blind yet stops matching the box (`Entry.boxBlind`).
   */
  blindToBox(session: string, paneId: string, texts: readonly string[]): void {
    for (const text of texts) {
      const want = text.replace(/\s+/gu, "");
      const entry = this.entries.find((e) => e.session === session && e.paneId === paneId && e.state === "queued" && !e.steer && e.boxBlind !== true && e.text.replace(/\s+/gu, "") === want);
      if (entry !== undefined) entry.boxBlind = true;
    }
  }

  /** Discard on an unconfirmed card: the card goes and nothing is pressed. False when there is no such card. */
  dismissUnconfirmed(session: string, paneId: string, id: string): boolean {
    const entry = this.entries.find((e) => e.id === id && e.session === session && e.paneId === paneId);
    if (entry === undefined || entry.state !== "unconfirmed") return false;
    this.drop(id);
    return true;
  }

  /** The panes of a session with open entries, for the poll's tick. */
  panes(session: string): string[] {
    this.seed(session);
    return [...new Set(this.entries.filter((entry) => entry.session === session).map((entry) => entry.paneId))];
  }

  /**
   * One read of a pane. The entries settled before the read, oldest first, whose texts the box holds in
   * order and nothing else (one text, or a run the harness put back together) are `returned`, and each
   * receipt takes its late mark once. A returned entry a box no longer holds ends. A running turn resets
   * the queued clock; two polls in a row of an idle turn over an empty box turn a queued card
   * `unconfirmed`. A read older than an entry's settle, or taken while a send runs on the pane, changes
   * nothing. Returns the ids the box holds now.
   */
  boxRead(session: string, paneId: string, reading: BoxReading): string[] {
    if (this.deps.busy(session, paneId)) return [];
    this.seed(session);
    const readAt = reading.at;
    const open = this.entries.filter((entry) => entry.session === session && entry.paneId === paneId && entry.at <= readAt);
    if (open.length === 0) {
      this.age();
      return [];
    }
    const idleEmpty = reading.poll && reading.turn === "idle" && reading.box === "";
    for (const entry of open) {
      if (reading.turn === "running") entry.busyAt = Math.max(entry.busyAt, readAt);
      if (entry.state !== "queued" || entry.steer) continue;
      if (!idleEmpty) {
        if (reading.poll) entry.idleEmpty = 0;
        continue;
      }
      if (entry.idleEmptyAt !== undefined && entry.idleEmptyAt >= readAt) continue;
      entry.idleEmpty++;
      entry.idleEmptyAt = readAt;
      if (entry.idleEmpty >= IDLE_EMPTY_POLLS) this.unconfirm(entry, readAt);
    }
    if (reading.box === null) {
      this.age();
      return [];
    }
    // A send a take-back left blind is no candidate: the box holds a recalled copy of it, not the queue.
    const held = this.heldRun(reading.box, open.filter((entry) => entry.boxBlind !== true));
    const leader = held.length > 1 ? held[0]!.id : undefined;
    for (const entry of held) {
      entry.seenAt = readAt;
      entry.group = leader;
      if (entry.state === "returned") continue;
      entry.state = "returned";
      entry.unconfirmedAt = undefined;
      try {
        this.deps.store.markReturned(entry.id);
      } catch (err) {
        console.warn(`[send] could not mark ${entry.id} returned: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const gone = open.filter((entry) => entry.state === "returned" && !held.includes(entry) && (entry.seenAt ?? 0) < readAt);
    if (gone.length > 0) this.entries = this.entries.filter((entry) => !gone.includes(entry));
    this.letSteersGo(open, held, reading);
    this.age();
    return held.map((entry) => entry.id);
  }

  /** The entry's run, in the order the box holds it (steers first): itself alone, or every entry that came back with it. */
  private runOf(entry: Entry, among: readonly Entry[]): Entry[] {
    if (entry.group === undefined) return [entry];
    return inBoxOrder(among.filter((e) => e.group === entry.group));
  }

  /**
   * A steer the box does not hold on a poll that reads the turn idle has not come back: after
   * {@link IDLE_EMPTY_POLLS} such polls in a row it is gone without a card (it landed, or the turn ended
   * without it). Any other read of the turn starts the count again. A Stop's read-backs never count: they
   * come before the harness may have put the text back.
   */
  private letSteersGo(open: readonly Entry[], held: readonly Entry[], reading: BoxReading): void {
    if (!reading.poll) return;
    const gone = new Set<Entry>();
    for (const entry of open) {
      if (!entry.steer || entry.state !== "queued" || held.includes(entry)) continue;
      if (reading.turn !== "idle") {
        entry.idleEmpty = 0;
        continue;
      }
      if (entry.idleEmptyAt !== undefined && entry.idleEmptyAt >= reading.at) continue;
      entry.idleEmpty++;
      entry.idleEmptyAt = reading.at;
      if (entry.idleEmpty >= IDLE_EMPTY_POLLS) gone.add(entry);
    }
    if (gone.size > 0) this.entries = this.entries.filter((entry) => !gone.has(entry));
  }

  private unconfirm(entry: Entry, at: number): void {
    entry.state = "unconfirmed";
    entry.unconfirmedAt = at;
    entry.group = undefined;
  }

  /**
   * The longest run of entries, in order, whose lines together are exactly the box. The harness may
   * give back one queued text or all of them in one box; a box that holds anything else matches none.
   */
  private heldRun(box: string, candidates: readonly Entry[]): Entry[] {
    if (box.trim().length === 0) return [];
    // The harness restores its steers first and its queue after, whatever order they were sent in.
    const open = inBoxOrder(candidates);
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

  /** The clocks and the cap: a card past its bound turns unconfirmed, an unconfirmed one past its own goes. */
  private age(): void {
    const now = this.deps.now();
    for (const entry of this.entries) {
      if (entry.state === "queued" && now - entry.busyAt > QUEUED_SEND_MS) this.unconfirm(entry, now);
      else if (entry.state === "returned" && now - (entry.seenAt ?? entry.busyAt) > QUEUED_SEND_MS) this.unconfirm(entry, now);
    }
    // A steer nobody saw in the box has nothing to say: it goes without a card.
    this.entries = this.entries.filter((entry) => !(entry.steer && entry.state === "unconfirmed" && entry.seenAt === undefined));
    this.entries = this.entries.filter((entry) => entry.state !== "unconfirmed" || now - (entry.unconfirmedAt ?? now) <= QUEUED_SEND_MS);
    const live = this.entries.filter((entry) => entry.state !== "unconfirmed");
    for (const entry of live.slice(0, Math.max(0, live.length - QUEUED_SENDS_MAX))) this.unconfirm(entry, now);
    if (this.entries.length > 2 * QUEUED_SENDS_MAX) {
      const over = this.entries.length - 2 * QUEUED_SENDS_MAX;
      const oldest = new Set(this.entries.filter((entry) => entry.state === "unconfirmed").slice(0, over));
      this.entries = this.entries.filter((entry) => !oldest.has(entry));
    }
  }

  /**
   * After a restart: the session's queued sends inside the bound come back from their request files,
   * text from the kept line, as queued. A receipt already marked returned stays out: its box read is
   * gone with the process, and the next read of a box that still holds the text would not be told apart
   * from a draft typed at the desk. Once per session.
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
        busyAt: at,
        idleEmpty: 0,
        steer: false,
        submitted: false,
        whole: false,
      });
    }
    this.entries.sort((a, b) => a.at - b.at);
  }
}
