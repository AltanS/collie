import OpenAI from "openai";

import type { TranscriptionConfig } from "./config.ts";

/** One completed audio upload sent to the configured provider; Collie does not intentionally persist it. */
export interface Transcriber {
  transcribe(file: File, signal: AbortSignal): Promise<string>;
}

type TranscriptionFailureKind = "timeout" | "client-aborted" | "unavailable";

/** A deliberately body-free provider failure safe to map onto the browser response. */
export class TranscriptionProviderError extends Error {
  constructor(readonly kind: TranscriptionFailureKind) {
    super(
      kind === "timeout"
        ? "transcription timed out"
        : kind === "client-aborted"
          ? "transcription cancelled"
          : "transcription unavailable",
    );
  }
}

export const TRANSCRIPTION_TIMEOUT_MS = 60_000;
/** Maximum decoded provider response body retained by the SDK, for successes and errors alike. */
export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

// The SDK requires a credential at construction time even when an explicitly configured local
// OpenAI-compatible endpoint is unauthenticated. `Authorization: null` below removes the header;
// this value must never reach a request.
const NO_AUTH_API_KEY = "collie-no-auth";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CreateTranscriberOptions {
  fetch?: FetchFn;
}

function isDataUrl(input: RequestInfo | URL): boolean {
  if (typeof input === "string") return input.startsWith("data:");
  if (input instanceof URL) return input.protocol === "data:";
  return input.url.startsWith("data:");
}

/**
 * Re-expose one provider response with a decoded-byte ceiling. The SDK owns parsing, so this keeps
 * its API/error behaviour while preventing a configured endpoint from buffering an unbounded body.
 */
function limitProviderResponseBody(response: Response): Response {
  if (response.body === null) return response;

  let received = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_PROVIDER_RESPONSE_BYTES) {
          throw new Error("transcription provider response exceeds 256 KiB");
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * The SDK-compatible fetch boundary: one underlying call, no redirect follow, and bounded decoded
 * response streams. It deliberately leaves the SDK's harmless `data:` FormData probe untouched.
 */
function providerFetch(underlyingFetch: FetchFn): FetchFn {
  return async (input, init) => {
    const response = await underlyingFetch(input, { ...init, redirect: "error" });
    return isDataUrl(input) ? response : limitProviderResponseBody(response);
  };
}

/**
 * Construct the official SDK without inheriting the process's unrelated OPENAI_* configuration.
 * Every environment-backed constructor option is passed explicitly; OPENAI_CUSTOM_HEADERS has no
 * option-level opt-out in this SDK release, so it is hidden only for the synchronous construction.
 */
function makeClient(config: TranscriptionConfig, options: CreateTranscriberOptions): OpenAI {
  const customHeaders = process.env.OPENAI_CUSTOM_HEADERS;
  try {
    delete process.env.OPENAI_CUSTOM_HEADERS;
    return new OpenAI({
      apiKey: config.apiKey ?? NO_AUTH_API_KEY,
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: config.baseURL,
      defaultHeaders: config.apiKey ? undefined : { Authorization: null },
      maxRetries: 0,
      // The SDK's timeout ends once fetch receives headers. `transcribe` owns the full provider
      // deadline so it also covers the response body the SDK parses afterwards.
      logLevel: "off",
      fetch: providerFetch(options.fetch ?? globalThis.fetch),
    });
  } finally {
    if (customHeaders === undefined) delete process.env.OPENAI_CUSTOM_HEADERS;
    else process.env.OPENAI_CUSTOM_HEADERS = customHeaders;
  }
}

/**
 * The one provider contract Collie owns: one configured OpenAI-compatible endpoint, completed
 * multipart audio in, final plain text out. It does not expose provider errors, retry uploads, or
 * retain the audio beyond the call.
 */
export function createTranscriber(
  config: TranscriptionConfig,
  options: CreateTranscriberOptions = {},
): Transcriber {
  const client = makeClient(config, options);
  return {
    async transcribe(file, signal) {
      const controller = new AbortController();
      let abortOwner: "timeout" | "client-aborted" | null = null;
      const abortForCaller = () => {
        if (controller.signal.aborted) return;
        abortOwner = "client-aborted";
        controller.abort(signal.reason);
      };
      if (signal.aborted) abortForCaller();
      else signal.addEventListener("abort", abortForCaller, { once: true });

      const timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        abortOwner = "timeout";
        controller.abort(new DOMException("Transcription timed out", "TimeoutError"));
      }, TRANSCRIPTION_TIMEOUT_MS);

      try {
        const transcription = await client.audio.transcriptions.create(
          { file, model: config.model, response_format: "json" },
          { signal: controller.signal },
        );
        // The caller may have disconnected while the SDK was consuming the final response bytes.
        if (abortOwner !== null || controller.signal.aborted) throw new Error("transcription aborted");
        return transcription.text;
      } catch {
        throw new TranscriptionProviderError(abortOwner ?? "unavailable");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abortForCaller);
      }
    },
  };
}
