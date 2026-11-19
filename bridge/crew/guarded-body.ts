// THE LEAD'S BOUNDS ON EVERY BODY A MEMBER SENDS (CREW_PROTOCOL.md §9.1 and §10.1, review round 6).
//
// The dial's budget ends when the member's headers arrive. Without this module a member that sent its
// headers and then went silent held the lead's read open for ever, and a member that sent an identity
// body with no end could send as many bytes as it liked. So every member body, whatever the route and
// whatever its encoding, comes through {@link guardedBody}, which holds three bounds:
//
// - An IDLE limit, not a total one: the read fails when no byte arrived for `idleMs` while the lead was
//   waiting for one. A big honest answer on a slow link passes, however long it takes in all, as long as
//   its bytes keep coming. The clock runs only while a reader waits: a phone that reads slowly holds the
//   member's stream back and never trips it.
// - A TOTAL deadline, from the start of the dial, for every body that is read in full before it is of
//   any use: one the lead reads itself (round 8), and a forwarded answer the lead masks or merges, or the
//   phone parses whole (round 9, the `whole` class in forward.ts `bodyRuleOf`). The idle limit alone
//   lets a member that drips one byte a second hold such a read for ever. Only a body that truly streams
//   on to the phone (a blob, a picture) keeps the idle limit alone.
// - A SIZE cap on the bytes the member sent, counted as they pass. Past it the read fails. A gzip body is
//   also capped on its inflated output, in bounded-gunzip.ts, on top of this.
//
// On any limit the member's stream is cancelled, `onStop` releases the socket, and the reader gets an
// error, never a short body that looks whole: a body streamed on to the phone breaks off there too.

/** Why a member's body was cut off. The message is plain ASCII, never a byte from the member. */
export class BodyRefused extends Error {
  /** `idle`: the lead's own clock fired, so §10.4 may read it as a slow link rather than a dead host. */
  constructor(
    message: string,
    readonly idle: boolean,
  ) {
    super(message);
  }
}

// ── THE CAPS (review round 7) ───────────────────────────────────────────────────────────────────
// A cap bounds the member's bytes as sent AND, for gzip, the inflated bytes. Each one is the largest
// honest answer of its kind times a small factor. JSON is the expensive kind: `JSON.parse` turns a body of
// tiny values (`[{},{},...]`) into about 30 times its size in memory, so every body the lead PARSES has a
// small cap. A body the lead only streams on to the phone costs the lead nothing per byte. The table of
// forwarded routes and their caps is `bodyCapOf` in forward.ts.

/**
 * Every body the lead parses as JSON itself: the sweep's snapshot, hello, warrant, pairing, takeover, the
 * 403 and 409 bodies, the deputy copies, a lead's walky answer, and every forwarded route with no larger
 * tier in `bodyCapOf`. An honest 300-pane snapshot is about 190 KB (30 panes: 19 KB), so 2 MB is ten
 * times the largest herd. At the cap a hostile body costs the lead about 64 MB while it is parsed.
 */
export const CREW_JSON_MAX = 2 * 1024 * 1024;

/**
 * A Changes or Files answer: a file is read up to 1 MB and a diff up to 512 KB (changes.ts), and a
 * Changes list holds up to 20 repositories of 1000 files each, about 4 MB at its fullest.
 */
export const CREW_FILES_MAX = 8 * 1024 * 1024;

/**
 * An answer read out of a log: a History or Chat page, a durable conversation's items, Sent (200 lines of
 * up to 64 KB, 12.8 MB) and pins. A page carries a session's inline pictures, and the member reads at most
 * 32 MB of a log for one answer (`MAX_TRANSCRIPT_BYTES`), so the cap is that number.
 */
export const CREW_LOG_MAX = 32 * 1024 * 1024;

/**
 * Raw bytes: a blob and a file's picture, each served up to 16 MB (`BLOB_MAX_BYTES`, `MAX_IMAGE_READ_BYTES`),
 * twice that. A member never gzips them; they stream to the phone and the lead holds no copy.
 */
export const CREW_BYTES_MAX = 32 * 1024 * 1024;

/**
 * The idle limit of a body the lead streams on to the phone (a forwarded read or a write's answer).
 *
 * Ten seconds: past TCP's own recovery of a lost burst on a bad link (three back-to-back retransmission
 * timeouts from a one second start are 1 + 2 + 4 = 7 s), and the same number as the picture route's
 * total limit, so a picture never meets the idle limit first. A stall here costs one phone read, never
 * the sweep.
 */
export const BODY_IDLE_MS = 10_000;

/**
 * The total deadline for a body the lead reads itself, from the start of the dial to its last byte:
 * three times the call's budget, 3.6 s on the sweep's 1.2 s. The headers may take one budget; the
 * honest bodies (a 300-pane snapshot is about 190 KB) arrive in one round trip after them, so two more
 * budgets are room, not a squeeze. The idle limit alone does not bound such a read: a member that sends
 * one byte a second never trips it, and the sweep, which waits for every member, would never end (review
 * round 8). A forwarded answer that is read in full has its own, longer deadline
 * ({@link WHOLE_ANSWER_DEADLINE_MS}); only one that streams on to the phone has none: a large blob on a
 * slow link is honest, and one phone read holds one socket and stalls nothing else.
 */
export const BODY_DEADLINE_FACTOR = 3;

export function bodyDeadlineMs(budgetMs: number): number {
  return BODY_DEADLINE_FACTOR * budgetMs;
}

/**
 * The idle limit for one dial's body, from what the dial is for.
 *
 * A body the LEAD consumes (the sweep's snapshot, hello, the warrant and the other `json` calls) may be
 * silent no longer than the call's own budget: the sweep awaits every member together, so a member that
 * stalls its body would otherwise hold every other member's freshness for as long as the limit, every
 * poll (§10.1). Those bodies are small JSON that arrives right behind its headers.
 *
 * A body the lead streams on to the phone may be silent for {@link BODY_IDLE_MS}, or the call's budget
 * when that is longer (a deputy copy on 30 s).
 */
export function bodyIdleMs(mode: "consumed" | "passthrough", budgetMs: number): number {
  return mode === "consumed" ? budgetMs : Math.max(budgetMs, BODY_IDLE_MS);
}

export interface BodyGuard {
  /** No byte for this long, while a reader waits, fails the read. */
  readonly idleMs: number;
  /** The most bytes the member may send. */
  readonly max: number;
  /**
   * A total deadline, as a `performance.now()` time: past it the read fails however steadily bytes come.
   * Set for a body read in full ({@link bodyDeadlineMs}, {@link wholeDeadlineMs}); absent for one streamed to the phone.
   */
  readonly deadline?: number;
  /** Called once when any limit fires, to release the socket (the dial aborts its request). */
  readonly onStop?: () => void;
}

/** `source`, a member's body, under the two bounds of {@link BodyGuard}. Cancelling the result cancels the member's stream. */
export function guardedBody(source: ReadableStream<Uint8Array>, guard: BodyGuard): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;

  const stop = async (controller: ReadableStreamDefaultController<Uint8Array>, error: BodyRefused) => {
    await reader.cancel(error.message).catch(() => undefined);
    guard.onStop?.();
    controller.error(error);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // The wait for this piece ends at the idle limit or at the total deadline, whichever comes first.
        const left = guard.deadline === undefined ? Infinity : guard.deadline - performance.now();
        const late = left < guard.idleMs;
        if (left <= 0) {
          await stop(controller, new BodyRefused("the answer did not end in time", true));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<"idle">((resolve) => {
          timer = setTimeout(() => resolve("idle"), late ? left : guard.idleMs);
        });
        let next: Awaited<ReturnType<typeof reader.read>> | "idle";
        try {
          next = await Promise.race([reader.read(), idle]);
        } catch {
          clearTimeout(timer);
          await stop(controller, new BodyRefused("the answer broke off", false));
          return;
        }
        clearTimeout(timer);
        if (next === "idle") {
          const why = late ? "the answer did not end in time" : `no byte of the answer for ${String(guard.idleMs)}ms`;
          await stop(controller, new BodyRefused(why, true));
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }
        seen += next.value.length;
        if (seen > guard.max) {
          await stop(controller, new BodyRefused(`the answer passed ${String(guard.max)} bytes`, false));
          return;
        }
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Statuses whose answer carries no body (a `Response` may not be built with one). */
const NO_BODY = new Set([204, 205, 304]);

/** `res` with its body under {@link guardedBody}: the same status and headers, since the bytes do not change. */
export function guardedResponse(res: Response, guard: BodyGuard): Response {
  if (res.body === null || NO_BODY.has(res.status)) return res;
  return new Response(guardedBody(res.body, guard), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * The total deadline of a `whole` answer, from the start of the dial to its last byte: 8 s, or the
 * call's own budget when that is longer (a launch, a worktree create). The lead's server drops a request
 * whose socket stays silent for 10 s (Bun's default `idleTimeout`, which the bridge does not set), and a
 * whole answer sends the phone nothing until it is complete; 8 s leaves 2 s for the lead's own work on it
 * (the mask, a merge). A 32 MB History page needs about 7 s on a 5 MB/s link, so the deadline does not cut
 * an honest one on a reasonable link, and 3 times the poll budget (3.6 s) would.
 */
export const WHOLE_ANSWER_DEADLINE_MS = 8_000;

/** The deadline of a whole answer on a call with `budgetMs` (absent: the poll budget, which is shorter). */
export function wholeDeadlineMs(budgetMs?: number): number {
  return Math.max(WHOLE_ANSWER_DEADLINE_MS, budgetMs ?? 0);
}
