// The continuation arithmetic for a backpressured socket write, kept pure so it can be unit-tested
// without a socket. The wiring that owns it lives in dial.ts.
//
// WHY THIS EXISTS: Bun's `Socket.write()` is not all-or-nothing — it returns the number of bytes the
// socket actually ACCEPTED, which under backpressure is fewer than it was handed (and can be 0). The
// unaccepted tail is NOT queued for you: dropping it on the floor silently truncates the request, and
// because Herdr's RPC is one-shot the server then waits forever for a newline that never comes, so
// the call dies on Collie's timeout rather than reporting anything useful. Observed as ~219 KB
// payloads losing their tail. The fix is to remember how far we got and resume from the socket's
// `drain` callback until the cursor is complete.

/** How much of one payload has been accepted by the socket so far. Immutable; advance it. */
export interface WriteCursor {
  /** Total byte length of the payload. */
  readonly total: number;
  /** Bytes the socket has accepted so far. Never exceeds `total`. */
  readonly sent: number;
}

/** A fresh cursor over a payload of `total` bytes. */
export function startWrite(total: number): WriteCursor {
  if (!Number.isFinite(total) || total < 0) throw new Error(`startWrite: bad total ${total}`);
  return { total, sent: 0 };
}

/**
 * The slice still owed to the socket, as a byte offset/length pair to hand to `write()`, or `null`
 * when the payload is fully accepted. A zero-length payload is complete from the start.
 */
export function writeRemaining(cursor: WriteCursor): { offset: number; length: number } | null {
  const length = cursor.total - cursor.sent;
  if (length <= 0) return null;
  return { offset: cursor.sent, length };
}

/**
 * Fold one `write()` return value into the cursor. Anything that is not a positive, finite number —
 * `0` (socket full), a negative (Bun's error signal), `NaN` — counts as zero progress and leaves the
 * cursor untouched, so a caller looping on it can detect the stall instead of spinning. An
 * over-accept can't happen; it is clamped rather than trusted, so the cursor can never run past the
 * payload and re-send garbage from beyond its end.
 */
export function advanceWrite(cursor: WriteCursor, accepted: number): WriteCursor {
  if (!Number.isFinite(accepted) || accepted <= 0) return cursor;
  const sent = Math.min(cursor.total, cursor.sent + Math.floor(accepted));
  return { total: cursor.total, sent };
}

/** True once every byte has been accepted. */
export function writeComplete(cursor: WriteCursor): boolean {
  return writeRemaining(cursor) === null;
}
