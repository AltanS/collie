import type { JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "./json.ts";
import { SttError } from "./provider.ts";

// ── READING A PROVIDER'S ANSWER, THE SAME WAY EVERY TIME ─────────────────────────────────────
//
// Both providers get back the same thing — a small JSON document with a `text` in it — from a
// service Collie does not run. So both read it through here rather than each growing its own copy
// of the cap and the parse, which is how two providers end up disagreeing about how much of a
// hostile response they will buffer.
//
// Nothing in this file knows a vendor, a URL or a credential; it is handed a `Response` and gives
// back a string.

/** How much of a provider response Collie will buffer. A transcript is text; this is generous. */
export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

/**
 * The response body as text, refused the moment it passes the cap.
 *
 * Read through the stream rather than `response.text()` so an endpoint that promises 40 bytes and
 * sends 4 GB is cut off at 256 KiB instead of being buffered whole and measured afterwards.
 */
export async function readCapped(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) throw new SttError("oversized");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
      /* the stream is already done or already errored — nothing left to release */
    });
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Let go of a body Collie is deliberately not reading.
 *
 * The identity probe cares about the status line and nothing else, and a `Response` whose body is
 * never read or cancelled holds its socket open until the runtime notices. One line, so no caller
 * has to remember the `.catch`.
 */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {
    /* already consumed or already errored */
  });
}

/**
 * The transcript inside a `{"text": "…"}` body.
 *
 * A body that is not that shape is a `refused`, not a crash: an endpoint claiming to serve
 * transcriptions and answering something else has failed the contract, and saying so is more useful
 * than surfacing whatever it did send.
 */
export function parseTranscript(body: string): string {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction, and `readTextField` is the only
    // reader of it below — the `text` field is checked before a byte of it is believed.
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    throw new SttError("refused", "the transcription service answered with something that is not JSON");
  }
  const text = readTextField(parsed);
  if (text === null) {
    throw new SttError("refused", "the transcription service answered without a transcript");
  }
  return text;
}

/** The `text` field of a parsed body, or null when the body has no usable one. */
function readTextField(parsed: JsonValue): string | null {
  const record = jsonRecord(parsed);
  if (record === null) return null;
  return jsonStringField(record.text);
}
