// THE LEAD'S LIMITS ON A MEMBER'S ANSWER (CREW_PROTOCOL.md §9.1).
//
// The goal: a slow, stuck or broken member cannot stall or bloat the lead. A laptop that sleeps in the
// middle of an answer, a member on an old or buggy build, a history that is far too large. Every crew
// machine is the operator's own and the link is pinned mutual TLS (§8.5), so these limits are written
// for a member that fails, not for one that attacks: such a member already has better doors.
//
// Two limits, on the bytes the lead reads (after the runtime's own decompression):
//
// - SIZE: counted as the bytes arrive, here. Past the limit the read fails: 2 MB for JSON the lead parses
//   itself, 32 MB for the rest.
// - TIME: a read the lead takes in full ends by a total deadline, an `AbortSignal.timeout` on the dial
//   (peer-client.ts). A download that streams on to the phone (a blob, a picture) ends when no byte came
//   for {@link BODY_IDLE_MS} while the phone waited for one, and in any case by
//   {@link STREAM_DEADLINE_MS}, which a big honest file on a slow link stays well inside.
//
// Past either limit the member's stream is cancelled, the dial is aborted, and the reader gets an error,
// never a short body that looks whole.

/** Why a member's answer was cut off. The message is plain ASCII, never a byte from the member. */
export class BodyRefused extends Error {
  /** `idle`: the lead's own clock fired, so §10.4 may read it as a slow link rather than a dead host. */
  constructor(
    message: string,
    readonly idle: boolean,
  ) {
    super(message);
  }
}

/**
 * Every body the lead parses as JSON itself: the sweep's snapshot, hello, the warrant, pairing, takeover,
 * the carry and walky answers. An honest 300-pane snapshot is about 190 KB, so 2 MB is ten times the
 * largest herd.
 */
export const CREW_JSON_MAX = 2 * 1024 * 1024;

/**
 * Every other answer: a forwarded read or write, a log page, a blob. The member reads at most 32 MB of a
 * log for one answer (`MAX_TRANSCRIPT_BYTES`) and serves a blob or a picture up to 16 MB.
 */
export const CREW_BODY_MAX = 32 * 1024 * 1024;

/**
 * The idle limit of a download that streams on to the phone. Ten seconds: past TCP's own recovery of a
 * lost burst on a bad link (1 + 2 + 4 = 7 s of back-to-back retransmission timeouts).
 */
export const BODY_IDLE_MS = 10_000;

/**
 * The total deadline of a body the lead reads itself (`json`, `raw`), from the start of the dial: three
 * times the call's budget, 3.6 s on the sweep's 1.2 s. The headers may take one budget; an honest body
 * arrives one round trip after them. The sweep waits for every member, so this is also how long one stuck
 * member can hold it (§10.1).
 */
export const BODY_DEADLINE_FACTOR = 3;

export function bodyDeadlineMs(budgetMs: number): number {
  return BODY_DEADLINE_FACTOR * budgetMs;
}

/**
 * The total deadline of a forwarded answer that is read in full before it is of any use (the lead masks
 * or merges it, or the phone parses it whole): 8 s, or the call's own budget when that is longer (a
 * launch, a worktree create).
 *
 * 8 s is a choice. The phone gives up on its own after 6 s for a poll read and 10 s for a long read
 * (`POLL_TIMEOUT_MS`, `GET_TIMEOUT_MS` in web/src/lib/api.ts), and its abort reaches the member read. A
 * read past that holds memory for an answer no one waits for; 8 s leaves 2 s for the mask. An honest
 * answer that needs longer is cut, for example a 32 MB History over a link slower than about 4 MB/s. The
 * fix for that is smaller reads (pages), never a longer deadline.
 */
export const WHOLE_ANSWER_DEADLINE_MS = 8_000;

export function wholeDeadlineMs(budgetMs?: number): number {
  return Math.max(WHOLE_ANSWER_DEADLINE_MS, budgetMs ?? 0);
}

/**
 * The total limit of a download that streams on to the phone: 10 minutes. The idle limit alone lets a
 * member that sends one byte every 9 s hold a lead connection for as long as the phone waits. The largest
 * answer the lead passes, {@link CREW_BODY_MAX} (32 MB), needs about 55 KB/s to arrive inside it, and a
 * blob or a picture (at most 16 MB) half that: slower than a weak mobile link, where a person has long
 * given up on the download.
 */
export const STREAM_DEADLINE_MS = 10 * 60_000;

export interface BodyLimit {
  /** The most bytes the lead reads. */
  readonly max: number;
  /** For a download that streams on: no byte for this long, while a reader waits, fails the read. */
  readonly idleMs?: number;
  /** For a download that streams on: the read fails at this `performance.now()` time, however steady. */
  readonly endsAt?: number;
  /** Called once when a limit fires, to release the socket (the dial aborts its request). */
  readonly onStop: () => void;
  /** Whether the dial's own total deadline ended the read, so its error is named as such. */
  readonly late: () => boolean;
}

/**
 * `source`, a member's body, under its {@link BodyLimit}. Cancelling the result cancels the member's
 * stream.
 *
 * A pull, not a `TransformStream`: the idle clock must run only while a reader waits, or a phone that
 * reads a big download slowly would trip it.
 */
export function limitedBody(source: ReadableStream<Uint8Array>, limit: BodyLimit): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  const stop = async (controller: ReadableStreamDefaultController<Uint8Array>, error: BodyRefused) => {
    await reader.cancel(error.message).catch(() => undefined);
    limit.onStop();
    controller.error(error);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // The wait for this piece ends at the idle limit or at the end time, whichever comes first.
        const left = limit.endsAt === undefined ? Infinity : limit.endsAt - performance.now();
        if (left <= 0) {
          await stop(controller, new BodyRefused("the answer did not end in time", true));
          return;
        }
        const late = limit.idleMs === undefined ? left !== Infinity : left < limit.idleMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<"idle" | "late">((resolve) => {
          if (late) timer = setTimeout(() => resolve("late"), left);
          else if (limit.idleMs !== undefined) timer = setTimeout(() => resolve("idle"), limit.idleMs);
        });
        let next: Awaited<ReturnType<typeof reader.read>> | "idle" | "late";
        try {
          next = await Promise.race([reader.read(), idle]);
        } catch {
          // The dial's abort errors the read: its total deadline, or a caller that went away.
          await stop(controller, limit.late() ? new BodyRefused("the answer did not end in time", true) : new BodyRefused("the answer broke off", false));
          return;
        } finally {
          clearTimeout(timer);
        }
        if (next === "late") {
          await stop(controller, new BodyRefused("the answer did not end in time", true));
          return;
        }
        if (next === "idle") {
          await stop(controller, new BodyRefused(`no byte of the answer for ${String(limit.idleMs)}ms`, true));
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }
        seen += next.value.length;
        if (seen > limit.max) {
          await stop(controller, new BodyRefused(`the answer passed ${String(limit.max)} bytes`, false));
          return;
        }
        controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason).catch(() => undefined),
    },
    { highWaterMark: 0 },
  );
}

/** Statuses whose answer carries no body (a `Response` may not be built with one). */
const NO_BODY = new Set([204, 205, 304]);

/** `res` with its body under {@link limitedBody}; the status and headers stay. */
export function limitedResponse(res: Response, limit: BodyLimit): Response {
  if (res.body === null || NO_BODY.has(res.status)) return res;
  return new Response(limitedBody(res.body, limit), { status: res.status, statusText: res.statusText, headers: res.headers });
}
