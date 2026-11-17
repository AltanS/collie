import { useSyncExternalStore } from "react";

import type { TranscriptEntry } from "@/lib/types";

// THE LINES A PERSON HAS SENT TO A DURABLE PANE THAT THE PROGRAM HAS NOT WRITTEN BACK YET (M53 spec 10).
//
// A durable program owns its conversation, so the person's own line reaches the thread only when the next
// read carries the program's `user` item: one second away over the socket, two over https, plus the hop to
// the phone. Waiting for that made a send look like nothing happened. So the composer puts the line in the
// thread at once, as a PENDING line keyed by the request id of the send, and the thread draws it after the
// program's items. When the program's item arrives, the pending line goes and the program's takes its place.
//
// The composer and the thread are two components that never meet, so this module is where they do. It is a
// tiny store keyed by the pane (`paneScopeKey`), read with `useSyncExternalStore`. Nothing is persisted: a
// pending line is a fact about this screen's last few seconds, and a reload reads the program's own history.
//
// MATCHING (the whole rule, and `unmatched` is the only place it lives):
//   1. The program's `user` item carries `requestId` (WIRE.md 7.15): the pending line with that id is replaced.
//   2. A program that does not know the id leaves it out. Then the first user item with the SAME TEXT, no
//      request id of its own, and a time within 30 seconds of the send, is the same line. One item answers
//      one pending line, the oldest first, so two identical sends in a row are not both hidden by one reply.
//   An item with ANOTHER request id is another send: it never matches by text.

/** How close the program's `ts` must be to the moment of the send for a match by text. */
export const PENDING_MATCH_MS = 30_000;

/** A line the program never wrote back stops being drawn after this long: a program with no echo cannot hold a clock on screen. */
export const PENDING_KEEP_MS = 10 * 60_000;

/**
 * How far the line has come.
 *  - `sending`: the POST is in flight. Drawn with a clock.
 *  - `sent`: the program took the POST. Still drawn with the clock, until its own line is in the thread; the thread
 *    then shows its working row at once, before the next read says `working`.
 *  - `unconfirmed`: the answer never came, so the program may or may not have it. "Send again" retries it once.
 *  - `notSent`: the program refused, or the turn had moved on. The words are back in the field.
 */
export type PendingState = "sending" | "sent" | "unconfirmed" | "notSent";

export interface PendingLine {
  requestId: string;
  text: string;
  /** Milliseconds since the epoch, when the person tapped Send. */
  at: number;
  state: PendingState;
  /**
   * A line from a pane with a screen (M104): the ids of the user turns the thread held at the tap. Such a pane's log
   * carries no request id, and its text can differ from what was sent (a chip's path, a paste), so when no turn has
   * the same text the first user turn that is NEW since the tap is this line's. Never two rows for one message.
   */
  seen?: ReadonlySet<string>;
  /**
   * The bridge held or queued the send (M104): the line waits for the row that shows it there, the queue card in the
   * thread or the held row above the box, and goes in the frame that row arrives. At most {@link HANDOVER_KEEP_MS}.
   */
  handover?: boolean;
}

/** A line handed over to a held or queued row goes after this long, whether or not that row came. */
export const HANDOVER_KEEP_MS = 20_000;

/** How far before the tap a NEW user turn's time may lie and still be this line's (clocks of two machines). */
const NEW_TURN_SLACK_MS = 5_000;

const EMPTY: readonly PendingLine[] = [];
const store = new Map<string, readonly PendingLine[]>();
const listeners = new Set<() => void>();

function publish(key: string, next: readonly PendingLine[]): void {
  if (next.length === 0) store.delete(key);
  else store.set(key, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pending lines of a pane, oldest first. The same array until something changes. */
export function pendingLines(key: string): readonly PendingLine[] {
  return store.get(key) ?? EMPTY;
}

/** Put a line in the thread, or move a retry of the same request id back to `sending` with the same place. */
export function addPending(key: string, line: PendingLine): void {
  const lines = pendingLines(key);
  if (!lines.some((have) => have.requestId === line.requestId)) {
    publish(key, [...lines, line]);
    return;
  }
  publish(
    key,
    lines.map((have) => (have.requestId === line.requestId ? inState(have, line.state) : have)),
  );
}

export function setPendingState(key: string, requestId: string, state: PendingState): void {
  const lines = pendingLines(key);
  if (!lines.some((line) => line.requestId === requestId && line.state !== state)) return;
  publish(
    key,
    lines.map((line) => (line.requestId === requestId ? inState(line, state) : line)),
  );
}

/** The same line in another state. */
function inState(line: PendingLine, state: PendingState): PendingLine {
  return { ...line, state };
}

/** The same line, taken by the bridge into a held or queued row it now waits for. */
function handedOver(line: PendingLine): PendingLine {
  return { ...line, state: "sent", handover: true };
}

/** The bridge held or queued the send: the line waits for that row ({@link PendingLine.handover}). */
export function handOverPending(key: string, requestId: string): void {
  const lines = pendingLines(key);
  if (!lines.some((line) => line.requestId === requestId && line.handover !== true)) return;
  publish(
    key,
    lines.map((line) => (line.requestId === requestId ? handedOver(line) : line)),
  );
}

export function dropPending(key: string, requestIds: readonly string[]): void {
  if (requestIds.length === 0) return;
  const lines = pendingLines(key);
  const next = lines.filter((line) => !requestIds.includes(line.requestId));
  if (next.length !== lines.length) publish(key, next);
}

/** Forget the lines that never left: a new send is a new try. */
export function dropNotSent(key: string): void {
  const lines = pendingLines(key);
  const next = lines.filter((line) => line.state !== "notSent");
  if (next.length !== lines.length) publish(key, next);
}

/** Forget every pending line. For tests, which share one module between cases. */
export function __resetPending(): void {
  store.clear();
  for (const listener of listeners) listener();
}

export function usePending(key: string): readonly PendingLine[] {
  return useSyncExternalStore(
    subscribe,
    () => pendingLines(key),
    () => EMPTY,
  );
}

/** The text of a turn: its text parts, joined. */
function wordsOf(entry: TranscriptEntry): string {
  return entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}

/** What {@link unmatched} finds: the lines still to draw, and the request ids the thread has caught up with. */
export interface PendingSplit {
  open: PendingLine[];
  done: string[];
}

/**
 * Which pending lines the thread has not caught up with, and which request ids it has.
 *
 * PURE: the clock is a parameter. `open` keeps the order of `pending`. A line older than {@link PENDING_KEEP_MS} is
 * neither: it is dropped from the view, and `done` names it so the store can forget it. A line handed over
 * ({@link PendingLine.handover}) is done once `queued` (the texts the thread's queue cards show) holds its text, or
 * after {@link HANDOVER_KEEP_MS}.
 */
export function unmatched(
  pending: readonly PendingLine[],
  entries: readonly TranscriptEntry[],
  now: number,
  queued: readonly string[] = [],
): PendingSplit {
  const users = entries.filter((entry) => entry.role === "user" && entry.abandoned !== true);
  const taken = new Set<TranscriptEntry>();
  const matched = new Map<PendingLine, TranscriptEntry>();
  const live: PendingLine[] = [];
  const done: string[] = [];
  for (const line of pending) {
    if (now - line.at > PENDING_KEEP_MS || (line.handover === true && (now - line.at > HANDOVER_KEEP_MS || queued.some((text) => text.trim() === line.text.trim())))) {
      done.push(line.requestId);
      continue;
    }
    live.push(line);
    const byId = users.find((entry) => entry.requestId === line.requestId && !taken.has(entry));
    const byText =
      byId ??
      users.find((entry) => {
        if (taken.has(entry) || entry.requestId !== undefined || wordsOf(entry).trim() !== line.text.trim()) return false;
        const sent = Date.parse(entry.ts);
        return Number.isNaN(sent) || Math.abs(sent - line.at) <= PENDING_MATCH_MS;
      });
    if (byText === undefined) continue;
    taken.add(byText);
    matched.set(line, byText);
  }
  // A second pass, so a turn that matches a later line by its words is never taken by an earlier line's new-turn rule.
  for (const line of live) {
    if (matched.has(line)) continue;
    const fresh = newTurn(line, users, taken);
    if (fresh === undefined) continue;
    taken.add(fresh);
    matched.set(line, fresh);
  }
  const open: PendingLine[] = [];
  for (const line of live) {
    if (matched.has(line)) done.push(line.requestId);
    else open.push(line);
  }
  return { open, done };
}

/** The first user turn that is new since the tap of a line from a pane with a screen ({@link PendingLine.seen}). */
function newTurn(line: PendingLine, users: readonly TranscriptEntry[], taken: ReadonlySet<TranscriptEntry>): TranscriptEntry | undefined {
  const seen = line.seen;
  if (seen === undefined) return undefined;
  return users.find((entry) => {
    if (taken.has(entry) || entry.requestId !== undefined || seen.has(entry.uuid)) return false;
    // A turn with no time cannot say it is new: only a text match takes it.
    const sent = Date.parse(entry.ts);
    return !Number.isNaN(sent) && sent >= line.at - NEW_TURN_SLACK_MS;
  });
}
