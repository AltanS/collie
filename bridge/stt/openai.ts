import type { JsonValue } from "../json.ts";
import type { OpenAiSttSettings } from "./config.ts";
import { jsonRecord, jsonStringField } from "./json.ts";
import { SttError, type SttAudio, type SttProvider, type SttResult, type SttStatus } from "./provider.ts";

// ── THE OPENAI-COMPATIBLE PROVIDER ───────────────────────────────────────────────────────────
//
// One request, to one configured endpoint: `POST {baseUrl}/audio/transcriptions`, multipart, the
// audio in a field called `file`. That request shape is the whole of the "OpenAI-compatible"
// contract, which is why this is plain `fetch` and not the `openai` npm package — the SDK buys
// nothing here but a dependency, and its keyless mode needs tricks (a placeholder key plus a
// header-deleting override) that plain `fetch` does not need at all: no credential simply means no
// `Authorization` header.
//
// Four bounds, all of them because the endpoint is operator-configured and may be anything:
//   • redirect: "error"  — a 302 must never move an upload with a credential on it to a new host.
//   • a 60 s deadline    — enforced over the whole call, body included, not just the headers.
//   • a 256 KiB response cap — a transcript is text; anything larger is a misconfigured endpoint
//                              or a hostile one, and it is refused mid-stream rather than buffered.
//   • no retries         — the audio is gone once the recording ends; a retry would re-upload the
//                          same bytes into the same failure, and the operator can simply speak again.
//
// `fetch` is a parameter so all of the above is reachable from `bun test` (CLAUDE.md: only
// Bun.serve / Bun.connect code stays unit-untested).

/** The whole-call deadline, headers and body together. */
export const STT_TIMEOUT_MS = 60_000;

/** How much of a provider response Collie will buffer. A transcript is text; this is generous. */
export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

/** The `fetch` this provider dials through. Injected so the unit tests never open a socket. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAiSttDeps {
  fetch?: FetchFn;
  /** The deadline, overridable so a test does not have to wait a minute to see one expire. */
  timeoutMs?: number;
}

/**
 * A provider over one OpenAI-compatible endpoint. Nothing is dialled at construction time — a
 * misconfigured endpoint is discovered by the first transcription, not by a probe at startup that
 * would delay the boot of a bridge whose operator may never press the microphone.
 */
export function createOpenAiSttProvider(
  settings: OpenAiSttSettings,
  deps: OpenAiSttDeps = {},
): SttProvider {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? STT_TIMEOUT_MS;
  const endpoint = `${settings.baseUrl}/audio/transcriptions`;

  return {
    id: settings.provider,

    // Configured IS available for this provider. There is no cheap liveness question to ask an
    // arbitrary compatible endpoint — a HEAD on a transcription route means nothing — and asking an
    // expensive one on every snapshot poll would be worse than the honest answer here.
    async status(): Promise<SttStatus> {
      return { available: true };
    },

    async transcribe(input: SttAudio): Promise<SttResult> {
      const form = new FormData();
      form.append("file", new File([input.audio], input.filename, { type: input.mimeType }));
      form.append("model", settings.model);
      form.append("response_format", "json");

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          body: form,
          // No credential means NO HEADER, not an empty one: an endpoint that takes no
          // authentication must see a request that carries none.
          headers: settings.apiKey === undefined ? {} : { authorization: `Bearer ${settings.apiKey}` },
          // A redirect would re-send the audio — and the bearer token — somewhere the operator did
          // not configure. Refuse rather than follow.
          redirect: "error",
          signal: controller.signal,
        });
        const body = await readCapped(response);
        if (!response.ok) {
          // The status is worth logging locally; the BODY is not, and never reaches the browser —
          // an upstream error can name an account, a model or an internal host.
          throw new SttError("refused", `the transcription service answered ${response.status}`);
        }
        return { text: parseTranscript(body) };
      } catch (err) {
        if (timedOut) throw new SttError("timeout");
        if (err instanceof SttError) throw err;
        // Everything else — DNS, TLS, a refused redirect, a socket reset — is one answer. The cause
        // is deliberately not attached: it is a string built from an operator-configured URL.
        throw new SttError("unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The response body as text, refused the moment it passes the cap.
 *
 * Read through the stream rather than `response.text()` so an endpoint that promises 40 bytes and
 * sends 4 GB is cut off at 256 KiB instead of being buffered whole and measured afterwards.
 */
async function readCapped(response: Response): Promise<string> {
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
 * The transcript inside a `{"text": "…"}` body.
 *
 * A body that is not that shape is a `refused`, not a crash: an endpoint claiming to be
 * OpenAI-compatible and answering something else has failed the contract, and saying so is more
 * useful than surfacing whatever it did send.
 */
function parseTranscript(body: string): string {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction, and `jsonStringField` is the only
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
