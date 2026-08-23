import { describe, expect, test } from "bun:test";

import type { OpenAiSttSettings } from "./config.ts";
import { MAX_PROVIDER_RESPONSE_BYTES, createOpenAiSttProvider, type FetchFn } from "./openai.ts";
import { SttError, type SttAudio, type SttResult } from "./provider.ts";

// The provider talks to one operator-configured endpoint over plain `fetch`, and `fetch` is a
// parameter — so every bound it claims (the redirect refusal, the deadline, the response cap, the
// keyless header) is asserted here rather than only against a live service.

const SETTINGS: OpenAiSttSettings = {
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:9000/v1",
  model: "gpt-4o-transcribe",
};

const AUDIO: SttAudio = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/webm;codecs=opus",
  filename: "recording.webm",
};

/** A `fetch` that records what it was asked and answers `response`. */
function spyFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { fetchFn, calls };
}

/** The thrown {@link SttError}'s kind, or a describing string if the call did not throw one. */
async function kindOf(run: () => Promise<SttResult>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof SttError) return err.kind;
    return `not-an-SttError: ${String(err)}`;
  }
  return "did-not-throw";
}

describe("openai-compatible provider — the happy path", () => {
  test("posts multipart audio to <baseUrl>/audio/transcriptions and returns the text", async () => {
    const { fetchFn, calls } = spyFetch(() => Response.json({ text: "hello herd" }));
    const provider = createOpenAiSttProvider(SETTINGS, { fetch: fetchFn });

    expect(await provider.transcribe(AUDIO)).toEqual({ text: "hello herd" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9000/v1/audio/transcriptions");
    expect(calls[0]!.init.method).toBe("POST");

    const form = calls[0]!.init.body;
    expect(form).toBeInstanceOf(FormData);
    // SAFETY: asserted to be a FormData on the line above — the provider builds one unconditionally.
    const fields = form as FormData;
    expect(fields.get("model")).toBe("gpt-4o-transcribe");
    expect(fields.get("response_format")).toBe("json");
    const file = fields.get("file");
    expect(file).toBeInstanceOf(File);
    // SAFETY: asserted to be a File on the line above.
    const audio = file as File;
    expect(audio.name).toBe("recording.webm");
    expect(audio.type).toBe("audio/webm;codecs=opus");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a configured provider reports itself available without dialling anything", async () => {
    const { fetchFn, calls } = spyFetch(() => Response.json({ text: "" }));
    const provider = createOpenAiSttProvider(SETTINGS, { fetch: fetchFn });

    expect(await provider.status()).toEqual({ available: true });
    expect(provider.id).toBe("openai-compatible");
    expect(calls).toHaveLength(0);
  });
});

describe("openai-compatible provider — the credential", () => {
  test("a key becomes one bearer header", async () => {
    const { fetchFn, calls } = spyFetch(() => Response.json({ text: "ok" }));
    const provider = createOpenAiSttProvider({ ...SETTINGS, apiKey: "sk-secret" }, { fetch: fetchFn });

    await provider.transcribe(AUDIO);
    expect(calls[0]!.init.headers).toEqual({ authorization: "Bearer sk-secret" });
  });

  test("keyless sends NO Authorization header at all, not an empty one", async () => {
    const { fetchFn, calls } = spyFetch(() => Response.json({ text: "ok" }));
    const provider = createOpenAiSttProvider(SETTINGS, { fetch: fetchFn });

    await provider.transcribe(AUDIO);
    expect(calls[0]!.init.headers).toEqual({});
    expect(new Headers(calls[0]!.init.headers).has("authorization")).toBe(false);
  });
});

describe("openai-compatible provider — the bounds", () => {
  test("redirects are refused, so audio and a credential cannot be moved to another host", async () => {
    const { fetchFn, calls } = spyFetch(() => Response.json({ text: "ok" }));
    const provider = createOpenAiSttProvider(SETTINGS, { fetch: fetchFn });

    await provider.transcribe(AUDIO);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  test("a fetch that rejects on a redirect surfaces as `unavailable`, never as a transcript", async () => {
    const provider = createOpenAiSttProvider(SETTINGS, {
      fetch: async () => {
        throw new TypeError("unexpected redirect");
      },
    });

    expect(await kindOf(() => provider.transcribe(AUDIO))).toBe("unavailable");
  });

  test("a non-200 is `refused`, and the upstream body is not reflected", async () => {
    const provider = createOpenAiSttProvider(SETTINGS, {
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "org org-SECRET has no quota" } }), { status: 429 }),
    });

    try {
      await provider.transcribe(AUDIO);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(SttError);
      // SAFETY: asserted to be an SttError on the line above.
      const failure = err as SttError;
      expect(failure.kind).toBe("refused");
      expect(failure.message).toBe("the transcription service answered 429");
      expect(failure.message).not.toContain("org-SECRET");
    }
  });

  test("a response past 256 KiB is cut off mid-stream rather than buffered", async () => {
    const oversized = "x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1);
    const provider = createOpenAiSttProvider(SETTINGS, {
      fetch: async () => new Response(oversized),
    });

    expect(await kindOf(() => provider.transcribe(AUDIO))).toBe("oversized");
  });

  test("a response just under the cap still parses", async () => {
    const padding = "y".repeat(MAX_PROVIDER_RESPONSE_BYTES - 64);
    const provider = createOpenAiSttProvider(SETTINGS, {
      fetch: async () => Response.json({ text: padding }),
    });

    expect((await provider.transcribe(AUDIO)).text).toBe(padding);
  });

  test("a provider that never answers becomes a `timeout`, and the request is aborted", async () => {
    let aborted = false;
    const provider = createOpenAiSttProvider(SETTINGS, {
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    expect(await kindOf(() => provider.transcribe(AUDIO))).toBe("timeout");
    expect(aborted).toBe(true);
  });

  test("exactly one request is made — a failure is never retried with the same audio", async () => {
    const { fetchFn, calls } = spyFetch(() => new Response("nope", { status: 500 }));
    const provider = createOpenAiSttProvider(SETTINGS, { fetch: fetchFn });

    await kindOf(() => provider.transcribe(AUDIO));
    expect(calls).toHaveLength(1);
  });
});

describe("openai-compatible provider — a body that is not a transcript", () => {
  test("non-JSON is `refused`", async () => {
    const provider = createOpenAiSttProvider(SETTINGS, {
      fetch: async () => new Response("<html>gateway</html>"),
    });

    expect(await kindOf(() => provider.transcribe(AUDIO))).toBe("refused");
  });

  test("JSON without a string `text` is `refused`", async () => {
    for (const body of [{}, { text: 42 }, [1, 2], "plain", null]) {
      const provider = createOpenAiSttProvider(SETTINGS, {
        fetch: async () => Response.json(body),
      });
      expect(await kindOf(() => provider.transcribe(AUDIO))).toBe("refused");
    }
  });

  test("an empty transcript is a legitimate answer — silence is not a failure", async () => {
    const provider = createOpenAiSttProvider(SETTINGS, {
      fetch: async () => Response.json({ text: "" }),
    });

    expect(await provider.transcribe(AUDIO)).toEqual({ text: "" });
  });
});
