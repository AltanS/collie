import type { SttCapability } from "../types.ts";
import { SttError, type SttProvider } from "./provider.ts";

// ── THE ROUTE'S OWN RULES, AWAY FROM Bun.serve ───────────────────────────────────────────────
//
// `POST /api/stt` is write-gated in server.ts and then handed straight here. Everything the route
// decides — the size cap, the accepted containers, how many transcriptions may be in flight, and
// which status each failure earns — lives in this file so `bun test` can drive all of it; only the
// dispatch line and the gate stay inside `Bun.serve`, which the runner cannot stand up (CLAUDE.md).
//
// The body is RAW AUDIO BYTES, not multipart. The client has exactly one thing to send and the
// bridge has exactly one thing to read; wrapping it in a multipart envelope would only add a parse
// (and a second size to reconcile) for no field anyone needs.

/** The largest recording the bridge will accept. Well under `maxRequestBodySize` in server.ts. */
export const MAX_STT_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * How many transcriptions may be in flight at once, per process.
 *
 * Two, and the third caller is told so rather than queued. A transcription holds a whole recording
 * in memory for as long as an operator-configured endpoint takes to answer, so an unbounded route
 * turns a flaky endpoint into the bridge's memory ceiling. Refusing is honest and instant; queueing
 * would make the phone wait behind a request whose deadline it cannot see.
 */
export const MAX_CONCURRENT_STT = 2;

/**
 * The containers a browser's MediaRecorder actually produces, mapped to the extension the provider
 * needs in order to pick a demuxer. Anything else is refused BEFORE the body is read — an endpoint
 * should never be handed bytes Collie could not name.
 */
// A `Map`, not an object literal: the key is a request header, and a `Map` lookup cannot be steered
// into `Object.prototype` by a caller who sends `content-type: constructor`.
const AUDIO_EXTENSIONS = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["application/ogg", "ogg"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);

/** What `POST /api/stt` answers, in both directions. */
export type SttTranscribeResponse = { ok: true; text: string } | { ok: false; error: string };

/** A process-local, non-queued admission gate. `acquire` returns the release, or null when full. */
export interface SttAdmission {
  acquire(): (() => void) | null;
}

export function createSttAdmission(limit: number = MAX_CONCURRENT_STT): SttAdmission {
  let active = 0;
  return {
    acquire() {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      // Idempotent on purpose: the caller releases in a `finally`, and a double release would let
      // the gate drift below zero and quietly stop bounding anything.
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}

/** The capability block, or null when nothing is configured — which is the feature being off. */
export async function sttCapability(provider: SttProvider | null): Promise<SttCapability | null> {
  if (provider === null) return null;
  const status = await provider.status();
  const wire: SttCapability = { provider: provider.id, available: status.available };
  // Assigned, never spread in as `undefined`: an available provider carries NO `reason` key.
  if (status.reason !== undefined) wire.reason = status.reason;
  return wire;
}

/** The outcome of one attempt, for the audit line. Never the transcript, never the audio. */
export interface SttAttempt {
  status: number;
  outcome: "ok" | "busy" | "unconfigured" | "invalid" | SttError["kind"];
  /** Bytes of audio actually read. Absent when the attempt never got that far. */
  bytes?: number;
}

export interface SttAttemptResult {
  response: Response;
  attempt: SttAttempt;
}

/**
 * One `POST /api/stt`, from an already-gated caller.
 *
 * The caller has cleared `guard(…, "write")` — same-origin plus both device gates — so nothing
 * about authorisation happens here. What happens here is admission, validation, one provider call,
 * and one status code per failure kind.
 */
export async function transcribeRequest(
  provider: SttProvider | null,
  req: Request,
  admission: SttAdmission,
): Promise<SttAttemptResult> {
  if (provider === null) {
    return fail(
      503,
      "unconfigured",
      "speech-to-text is not configured on this collie — run `collie stt setup`",
    );
  }

  const declared = contentLength(req.headers.get("content-length"));
  if (declared !== null && declared > MAX_STT_AUDIO_BYTES) {
    return fail(413, "invalid", "the recording is larger than 8 MiB");
  }

  const mimeType = req.headers.get("content-type")?.trim() ?? "";
  const container = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = AUDIO_EXTENSIONS.get(container);
  if (extension === undefined) {
    return fail(415, "invalid", "that is not an audio format Collie sends on");
  }

  // Admission is taken AFTER the cheap refusals and BEFORE the body is read: a slow upload holds a
  // slot for exactly as long as it is really occupying memory, and a malformed request never
  // consumes one at all.
  const release = admission.acquire();
  if (release === null) {
    return fail(429, "busy", "two recordings are already being transcribed — try again in a moment");
  }

  try {
    let audio: Uint8Array<ArrayBuffer>;
    try {
      audio = new Uint8Array(await req.arrayBuffer());
    } catch {
      return fail(400, "invalid", "the recording could not be read");
    }
    if (audio.byteLength === 0) return fail(400, "invalid", "the recording is empty");
    // The declared length may have been absent or a lie; this is the measurement that counts.
    if (audio.byteLength > MAX_STT_AUDIO_BYTES) {
      return fail(413, "invalid", "the recording is larger than 8 MiB", audio.byteLength);
    }

    try {
      // The caller's own filename never travels: the provider needs an extension, not metadata.
      const result = await provider.transcribe({
        audio,
        mimeType,
        filename: `recording.${extension}`,
      });
      return {
        response: jsonResponse({ ok: true, text: result.text }, 200),
        attempt: { status: 200, outcome: "ok", bytes: audio.byteLength },
      };
    } catch (err) {
      const kind = err instanceof SttError ? err.kind : "unavailable";
      // A deadline is a 504 because the request is still honestly in progress somewhere; everything
      // else is a 502, the bridge reporting that its upstream did not deliver.
      const status = kind === "timeout" ? 504 : 502;
      const message = err instanceof SttError ? err.message : "transcription is unavailable";
      return fail(status, kind, message, audio.byteLength);
    }
  } finally {
    release();
  }
}

/** A declared `Content-Length`, or null when it is absent or not a plain byte count. */
function contentLength(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function fail(
  status: number,
  outcome: SttAttempt["outcome"],
  error: string,
  bytes?: number,
): SttAttemptResult {
  const attempt: SttAttempt = { status, outcome };
  if (bytes !== undefined) attempt.bytes = bytes;
  return { response: jsonResponse({ ok: false, error }, status), attempt };
}

function jsonResponse(body: SttTranscribeResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
