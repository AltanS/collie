import { afterEach, describe, expect, test, vi } from "bun:test";

import {
  createTranscriber,
  MAX_PROVIDER_RESPONSE_BYTES,
  TranscriptionProviderError,
  TRANSCRIPTION_TIMEOUT_MS,
} from "./transcription.ts";

const config = (overrides: Partial<{ model: string; baseURL: string; apiKey?: string }> = {}) => ({
  model: "local-whisper",
  baseURL: "http://127.0.0.1:8000/v1",
  ...overrides,
});

function recording(): File {
  return new File(["audio bytes"], "recording.webm", { type: "audio/webm" });
}

function responseFetch(
  inspect: (request: Request) => Promise<void> | void,
  response: Response = new Response(JSON.stringify({ text: "hello from the recording" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // The SDK's FormData probe is not the configured provider upload and must pass through untouched.
    if (request.url.startsWith("data:")) return new Response();
    await inspect(request);
    return response;
  };
}

function stalledBody(signal: AbortSignal, onRead: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
      pull() {
        onRead();
      },
    },
    { highWaterMark: 0 },
  );
}

describe("createTranscriber", () => {
  afterEach(() => vi.useRealTimers());

  test("sends one configured multipart request with redirect refusal and no Authorization header for a keyless local endpoint", async () => {
    let request: Request | undefined;
    const transcriber = createTranscriber(
      config(),
      { fetch: responseFetch((seen) => { request = seen; }) },
    );

    await expect(transcriber.transcribe(recording(), new AbortController().signal)).resolves.toBe(
      "hello from the recording",
    );

    expect(request?.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(request?.redirect).toBe("error");
    expect(request?.headers.get("authorization")).toBeNull();
    const form = await request!.formData();
    expect(form.get("model")).toBe("local-whisper");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("file")).toBeInstanceOf(File);
  });

  test("uses only the configured key and ignores unrelated OpenAI environment settings", async () => {
    const saved = {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      admin: process.env.OPENAI_ADMIN_KEY,
      organization: process.env.OPENAI_ORG_ID,
      project: process.env.OPENAI_PROJECT_ID,
      webhook: process.env.OPENAI_WEBHOOK_SECRET,
      log: process.env.OPENAI_LOG,
      headers: process.env.OPENAI_CUSTOM_HEADERS,
    };
    try {
      process.env.OPENAI_API_KEY = "ambient-key";
      process.env.OPENAI_BASE_URL = "https://ambient.invalid/v1";
      process.env.OPENAI_ADMIN_KEY = "ambient-admin";
      process.env.OPENAI_ORG_ID = "ambient-org";
      process.env.OPENAI_PROJECT_ID = "ambient-project";
      process.env.OPENAI_WEBHOOK_SECRET = "ambient-webhook";
      process.env.OPENAI_LOG = "debug";
      process.env.OPENAI_CUSTOM_HEADERS = "X-Ambient: must-not-send";
      let request: Request | undefined;
      const transcriber = createTranscriber(
        config({ baseURL: "https://configured.invalid/v1", apiKey: "configured-key" }),
        { fetch: responseFetch((seen) => { request = seen; }) },
      );

      await transcriber.transcribe(recording(), new AbortController().signal);
      expect(request?.url).toBe("https://configured.invalid/v1/audio/transcriptions");
      expect(request?.headers.get("authorization")).toBe("Bearer configured-key");
      expect(request?.headers.get("x-ambient")).toBeNull();
    } finally {
      const entries = Object.entries(saved) as Array<[keyof typeof saved, string | undefined]>;
      const names: Record<keyof typeof saved, string> = {
        apiKey: "OPENAI_API_KEY",
        baseURL: "OPENAI_BASE_URL",
        admin: "OPENAI_ADMIN_KEY",
        organization: "OPENAI_ORG_ID",
        project: "OPENAI_PROJECT_ID",
        webhook: "OPENAI_WEBHOOK_SECRET",
        log: "OPENAI_LOG",
        headers: "OPENAI_CUSTOM_HEADERS",
      };
      for (const [key, value] of entries) {
        if (value === undefined) delete process.env[names[key]];
        else process.env[names[key]] = value;
      }
    }
  });

  test("refuses a provider redirect without uploading audio to its target", async () => {
    let sourceUploads = 0;
    let targetUploads = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/audio/transcriptions") targetUploads += 1;
        return new Response(JSON.stringify({ text: "must not arrive" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/audio/transcriptions") sourceUploads += 1;
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${target.port}/audio/transcriptions` },
        });
      },
    });

    try {
      const transcriber = createTranscriber(config({ baseURL: `http://127.0.0.1:${source.port}/v1` }));
      await expect(transcriber.transcribe(recording(), new AbortController().signal)).rejects.toMatchObject({
        kind: "unavailable",
      });
      expect(sourceUploads).toBe(1);
      expect(targetUploads).toBe(0);
    } finally {
      await source.stop(true);
      await target.stop(true);
    }
  });

  test("accepts a provider response at the exact decoded body limit", async () => {
    const empty = JSON.stringify({ text: "" });
    const text = "x".repeat(MAX_PROVIDER_RESPONSE_BYTES - new TextEncoder().encode(empty).byteLength);
    const body = JSON.stringify({ text });
    expect(new TextEncoder().encode(body)).toHaveLength(MAX_PROVIDER_RESPONSE_BYTES);
    const transcriber = createTranscriber(config({ apiKey: "configured-key" }), {
      fetch: responseFetch(
        () => {},
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    });

    await expect(transcriber.transcribe(recording(), new AbortController().signal)).resolves.toHaveLength(text.length);
  });

  test("bounds one-byte-over successful and error provider response streams with the fixed cancellation reason", async () => {
    for (const status of [200, 500]) {
      let cancelled = 0;
      let cancellationReason: unknown;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1));
        },
        cancel(reason) {
          cancelled += 1;
          cancellationReason = reason;
        },
      });
      const transcriber = createTranscriber(config({ apiKey: "configured-key" }), {
        fetch: responseFetch(
          () => {},
          new Response(body, { status, headers: { "content-type": "application/json" } }),
        ),
      });

      const error = await transcriber.transcribe(recording(), new AbortController().signal).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TranscriptionProviderError);
      expect(error).toMatchObject({ kind: "unavailable" });
      expect(String(error)).not.toContain("private provider body");
      expect(cancelled).toBe(1);
      expect(cancellationReason).toBeInstanceOf(Error);
      expect((cancellationReason as Error).message).toBe("transcription provider response exceeds 256 KiB");
    }
  });

  test("sanitizes a provider source-stream error", async () => {
    const sourceError = new Error("private provider source error");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(sourceError);
      },
    });
    const transcriber = createTranscriber(config({ apiKey: "configured-key" }), {
      fetch: responseFetch(
        () => {},
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    });

    const error = await transcriber.transcribe(recording(), new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TranscriptionProviderError);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect(String(error)).not.toContain("private provider source error");
  });

  test("aborts and classifies a stalled provider response body at the total deadline", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    let startedBodyRead: () => void = () => {};
    const bodyReadStarted = new Promise<void>((resolve) => {
      startedBodyRead = resolve;
    });
    const transcriber = createTranscriber(config({ apiKey: "configured-key" }), {
      fetch: async (input, init) => {
        if (String(input).startsWith("data:")) return new Response();
        const signal = init?.signal;
        if (!signal) throw new Error("expected provider signal");
        providerSignal = signal;
        return new Response(stalledBody(signal, startedBodyRead), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const pending = transcriber.transcribe(recording(), new AbortController().signal).catch((error: unknown) => error);

    await bodyReadStarted;
    vi.advanceTimersByTime(TRANSCRIPTION_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ kind: "timeout" });
    expect(providerSignal?.aborted).toBe(true);
  });

  test("classifies a caller abort after provider headers as client-aborted", async () => {
    let providerSignal: AbortSignal | undefined;
    let startedBodyRead: () => void = () => {};
    const bodyReadStarted = new Promise<void>((resolve) => {
      startedBodyRead = resolve;
    });
    const transcriber = createTranscriber(config({ apiKey: "configured-key" }), {
      fetch: async (input, init) => {
        if (String(input).startsWith("data:")) return new Response();
        const signal = init?.signal;
        if (!signal) throw new Error("expected provider signal");
        providerSignal = signal;
        return new Response(stalledBody(signal, startedBodyRead), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const caller = new AbortController();
    const pending = transcriber.transcribe(recording(), caller.signal).catch((error: unknown) => error);

    await bodyReadStarted;
    caller.abort();

    await expect(pending).resolves.toMatchObject({ kind: "client-aborted" });
    expect(providerSignal?.aborted).toBe(true);
  });

  test("never retries a failed upload", async () => {
    let calls = 0;
    const transcriber = createTranscriber(config({ apiKey: "configured-key" }), {
      fetch: responseFetch(
        (request) => {
          if (request.url.includes("/audio/transcriptions")) calls += 1;
        },
        new Response(JSON.stringify({ error: { message: "private provider body" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    let error: unknown;
    try {
      await transcriber.transcribe(recording(), new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(TranscriptionProviderError);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect(String(error)).not.toContain("private provider body");
  });
});
