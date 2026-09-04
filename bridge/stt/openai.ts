import type { OpenAiSttSettings } from "./config.ts";
import {
  createSttDeadline,
  SttCancelledError,
  SttError,
  type SttAudio,
  type SttProvider,
  type SttResult,
  type SttStatus,
} from "./provider.ts";
import { MAX_PROVIDER_RESPONSE_BYTES, parseTranscript, readCapped } from "./transcript.ts";

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

/** Re-exported so a reader of this provider sees the cap it claims above without a second hop. */
export { MAX_PROVIDER_RESPONSE_BYTES };

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

    async transcribe(input: SttAudio, signal?: AbortSignal): Promise<SttResult> {
      // One lifecycle owns both headers and the capped response body, under OpenAI's existing policy.
      const deadline = createSttDeadline(signal, timeoutMs);
      try {
        deadline.throwIfAborted();
        const form = new FormData();
        form.append("file", new File([input.audio], input.filename, { type: input.mimeType }));
        form.append("model", settings.model);
        form.append("response_format", "json");
        // Sent only when the operator named one. An ABSENT field is auto-detect, which is the right
        // default for somebody who mixes two languages in a sentence; a present one is the fix for the
        // opposite complaint — a short clip in an accented voice coming back in a language nobody spoke.
        if (settings.language !== undefined) form.append("language", settings.language);

        const response = await deadline.wait(
          doFetch(endpoint, {
            method: "POST",
            body: form,
            // No credential means NO HEADER, not an empty one: an endpoint that takes no
            // authentication must see a request that carries none.
            headers: settings.apiKey === undefined ? {} : { authorization: `Bearer ${settings.apiKey}` },
            // A redirect would re-send the audio — and the bearer token — somewhere the operator did
            // not configure. Refuse rather than follow.
            redirect: "error",
            signal: deadline.signal,
          }),
        );
        const body = await deadline.wait(readCapped(response, deadline.signal));
        if (!response.ok) {
          // The status is worth logging locally; the BODY is not, and never reaches the browser —
          // an upstream error can name an account, a model or an internal host.
          //
          // The CONTAINER is named because the refusal is very often about the container and nothing
          // else: a model that demuxes WAV can answer 400 to the WebM or MP4 a phone records (#148).
          // Echoing it is safe — this is the client's own content type, already matched against the
          // allow-list in `bridge/stt/http.ts` before any of these bytes were read, so it is one of
          // nine known strings and never free text from the caller.
          const container = input.mimeType.split(";", 1)[0]!.trim().toLowerCase();
          throw new SttError(
            "refused",
            `the transcription service answered ${response.status} for ${container}`,
          );
        }
        return { text: parseTranscript(body) };
      } catch (err) {
        // Fetch and stream reads reject with generic abort errors. The owned lifecycle retains the
        // caller-cancellation versus timeout distinction before any generic classification.
        deadline.throwIfAborted();
        if (err instanceof SttError || err instanceof SttCancelledError) throw err;
        // Everything else — DNS, TLS, a refused redirect, a socket reset — is one answer. The cause
        // is deliberately not attached: it is a string built from an operator-configured URL.
        throw new SttError("unavailable");
      } finally {
        deadline.close();
      }
    },
  };
}
