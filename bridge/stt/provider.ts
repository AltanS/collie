// ── SPEECH-TO-TEXT: ONE SEAM, ONE SHAPE, NOTHING ABOUT A VENDOR ──────────────────────────────
//
// The bridge knows exactly this much about transcription: bytes of a completed recording go in,
// one string comes out, and a provider can say ahead of time whether it is usable at all. Every
// vendor detail — base URL, model, credential, wire format — lives behind an implementation of
// {@link SttProvider} and is never named on the route, in the snapshot, or on the phone.
//
// The seam is deliberately narrow so `bun test` covers all of it: nothing here opens a socket,
// reads a file or touches `Bun.serve`. The one implementation that talks to a network takes its
// `fetch` as a parameter (bridge/stt/openai.ts), which is what makes the whole provider testable
// under Bun's runner rather than only through a live endpoint.

/** One completed recording, handed over whole. The bridge never persists it. */
export interface SttAudio {
  /**
   * The raw container bytes exactly as the browser recorded them.
   *
   * Backed by a plain `ArrayBuffer`, not the wider `ArrayBufferLike` — a `SharedArrayBuffer` is not
   * a `BlobPart`, and pinning it here is what lets the provider wrap these bytes in a `File`
   * without an assertion.
   */
  audio: Uint8Array<ArrayBuffer>;
  /** The `Content-Type` the client sent, parameters included (`audio/webm;codecs=opus`). */
  mimeType: string;
  /**
   * A server-generated name with a conventional extension. NEVER the caller's own filename — that is
   * metadata Collie has no reason to forward, and a provider only needs the extension to pick a
   * demuxer.
   */
  filename: string;
}

/**
 * Whether the provider could serve a request right now, and why not when it could not.
 *
 * `reason` is operator-facing prose the UI may show verbatim, so it must never carry a credential,
 * a URL or an upstream error body — "not signed in", not "401 from https://…?key=…".
 */
export interface SttStatus {
  available: boolean;
  reason?: string;
}

/** The transcription result. One field today, an object so it can gain one without a wire break. */
export interface SttResult {
  text: string;
}

export interface SttProvider {
  /**
   * The provider's name as the operator and the phone see it (`openai-compatible`, later `codex`).
   * It is a label, not a capability: nothing branches on it, and it never carries an endpoint.
   */
  readonly id: string;
  /** Can this provider serve a request — asked for the capability flag, never with audio in hand. */
  status(): Promise<SttStatus>;
  /**
   * Transcribe one completed recording.
   *
   * The optional signal lets an HTTP caller stop waiting when its recording leaves; CLI callers
   * have no caller signal. Throws {@link SttError} on provider failure and
   * {@link SttCancelledError} when its caller cancelled.
   */
  transcribe(input: SttAudio, signal?: AbortSignal): Promise<SttResult>;
  /**
   * Let go of whatever this provider is holding open — OPTIONAL, and absent on a provider that is
   * nothing but a `fetch`.
   *
   * It exists for the codex provider, whose auth broker owns a long-running `codex app-server`
   * child. The gate calls it when the settings change under it and once at shutdown, so a config
   * edit replaces the child rather than accumulating one per edit. It must be safe to call twice
   * and safe to call on a provider that never started anything.
   */
  close?(): void;
}

/**
 * How a transcription failed, in the only terms the route needs to pick a status code:
 *
 *  - `timeout`   — the provider did not answer inside the deadline (504).
 *  - `oversized` — it answered with more bytes than Collie will buffer (502).
 *  - `refused`   — it answered, and the answer was not a usable transcript (502).
 *  - `unavailable` — it could not be reached, or is not configured (502).
 */
export type SttFailureKind = "timeout" | "oversized" | "refused" | "unavailable";

/**
 * A deliberately body-free provider failure.
 *
 * The message is Collie's own sentence, chosen from the kind — an upstream error body may name an
 * account, a model or an endpoint, so it is never reflected to a browser and never audited. The
 * `kind` is the only thing the route reads.
 */
export class SttError extends Error {
  constructor(
    readonly kind: SttFailureKind,
    message: string = defaultMessage(kind),
  ) {
    super(message);
    this.name = "SttError";
  }
}

function defaultMessage(kind: SttFailureKind): string {
  if (kind === "timeout") return "transcription timed out";
  if (kind === "oversized") return "the transcription service answered with too much data";
  if (kind === "refused") return "the transcription service refused the recording";
  return "transcription is unavailable";
}

/** A caller stopped waiting; this is distinct from an upstream provider failure. */
export class SttCancelledError extends Error {
  constructor() {
    super("transcription was cancelled");
    this.name = "SttCancelledError";
  }
}

/** One operation's optional deadline and caller-cancellation lifecycle. */
export interface SttDeadline {
  /** The signal cooperative work should receive. */
  readonly signal: AbortSignal;
  /** Race work against this lifecycle without taking ownership of the work itself. */
  wait<T>(work: Promise<T>): Promise<T>;
  /** Throw the cancellation or deadline error that stopped this lifecycle. */
  throwIfAborted(): void;
  /** Release the timer and caller listener once the operation has settled. */
  close(): void;
}

/**
 * Bind caller cancellation and an optional deadline into one operation signal.
 *
 * `wait` observes its work even after the lifecycle wins. That matters for shared Codex token
 * acquisition: cancelling one caller must not cancel the broker's shared promise or leave a later
 * rejection unobserved.
 */
export function createSttDeadline(caller: AbortSignal | undefined, timeoutMs?: number): SttDeadline {
  const controller = new AbortController();
  let stopped: "caller" | "timeout" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stop = (reason: "caller" | "timeout") => {
    if (stopped !== null) return;
    stopped = reason;
    controller.abort();
  };
  const onCallerAbort = () => stop("caller");
  if (caller?.aborted) stop("caller");
  else caller?.addEventListener("abort", onCallerAbort, { once: true });
  if (stopped === null && timeoutMs !== undefined) {
    timer = setTimeout(() => stop("timeout"), timeoutMs);
  }

  const abortError = (): SttError | SttCancelledError =>
    stopped === "timeout" ? new SttError("timeout") : new SttCancelledError();
  const throwIfAborted = (): void => {
    if (stopped !== null) throw abortError();
  };

  return {
    signal: controller.signal,
    throwIfAborted,
    wait<T>(work: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (): boolean => {
          if (settled) return false;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          return true;
        };
        const onAbort = () => {
          if (finish()) reject(abortError());
        };

        // Attach both handlers before looking at cancellation so an already-rejected phase remains
        // observed even when the caller stopped at the phase boundary.
        void work.then(
          (value) => {
            if (!finish()) return undefined;
            try {
              throwIfAborted();
              resolve(value);
            } catch (err) {
              reject(err);
            }
            return undefined;
          },
          (err) => {
            if (!finish()) return undefined;
            try {
              throwIfAborted();
            } catch (abort) {
              reject(abort);
              return undefined;
            }
            reject(err);
            return undefined;
          },
        );
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}
