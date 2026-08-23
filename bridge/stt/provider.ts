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
  /** Transcribe one completed recording. Throws {@link SttError} on every failure. */
  transcribe(input: SttAudio): Promise<SttResult>;
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
