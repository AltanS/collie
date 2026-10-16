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
}

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
  return { requestId: line.requestId, text: line.text, at: line.at, state };
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
 * neither: it is dropped from the view, and `done` names it so the store can forget it.
 */
export function unmatched(
  pending: readonly PendingLine[],
  entries: readonly TranscriptEntry[],
  now: number,
): PendingSplit {
  const users = entries.filter((entry) => entry.role === "user" && entry.abandoned !== true);
  const taken = new Set<TranscriptEntry>();
  const open: PendingLine[] = [];
  const done: string[] = [];
  for (const line of pending) {
    if (now - line.at > PENDING_KEEP_MS) {
      done.push(line.requestId);
      continue;
    }
    const byId = users.find((entry) => entry.requestId === line.requestId && !taken.has(entry));
    const byText =
      byId ??
      users.find((entry) => {
        if (taken.has(entry) || entry.requestId !== undefined || wordsOf(entry).trim() !== line.text.trim()) return false;
        const sent = Date.parse(entry.ts);
        return Number.isNaN(sent) || Math.abs(sent - line.at) <= PENDING_MATCH_MS;
      });
    if (byText === undefined) {
      open.push(line);
      continue;
    }
    taken.add(byText);
    done.push(line.requestId);
  }
  return { open, done };
}
