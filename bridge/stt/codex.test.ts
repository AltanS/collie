import { describe, expect, test, vi } from "bun:test";

import type { CodexSttSettings } from "./config.ts";
import type { CodexAuthBroker } from "./codex-auth.ts";
import {
  CODEX_TIMEOUT_MS,
  CODEX_TRANSCRIBE_URL,
  accountIdFromJwt,
  createCodexSttProvider,
  probeCodexIdentity,
  silentWavBytes,
} from "./codex.ts";
import type { FetchFn } from "./openai.ts";
import { SttCancelledError, SttError, type SttAudio } from "./provider.ts";

// What this provider puts on the wire is the thing ADR 0029 is about, so it is asserted here header
// by header — including the header that must NOT be there. Everything is injected: no child is
// spawned, no socket is opened, and `chatgpt.com` is never dialled.

const HONEST: CodexSttSettings = { provider: "codex", codexBin: "codex", wireIdentity: "honest" };
const IMPERSONATING: CodexSttSettings = { ...HONEST, wireIdentity: "codex-cli" };

const CLIP: SttAudio = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/webm;codecs=opus",
  filename: "recording.webm",
};

/** A token whose payload carries the account id under the FLAT claim. */
function flatClaimToken(accountId: string): string {
  return token({ [`https://api.openai.com/auth.chatgpt_account_id`]: accountId });
}

/** A token whose payload carries it under the NESTED claim. Both shapes exist in the wild. */
function nestedClaimToken(accountId: string): string {
  return token({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function token(claims: Record<string, string | { chatgpt_account_id: string }>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

interface FakeBroker extends CodexAuthBroker {
  /** The `refresh` flag of every token request, in order. */
  readonly refreshes: boolean[];
  closed: boolean;
}

function fakeBroker(accessToken: string = flatClaimToken("acct-123")): FakeBroker {
  const broker: FakeBroker = {
    refreshes: [],
    closed: false,
    lastKnown: () => ({ available: true }),
    probe: async () => ({ available: true }),
    accessToken: async (refresh = false) => {
      broker.refreshes.push(refresh);
      return { accessToken };
    },
    close() {
      broker.closed = true;
    },
  };
  return broker;
}

/** Every request the provider made, as the headers and body a reviewer would want to see. */
interface Recorded {
  url: string;
  headers: Headers;
  body: FormData | null;
}

interface Recorder {
  fetch: FetchFn;
  calls: Recorded[];
}

function recorder(reply: (call: number) => Response): Recorder {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: input,
        headers: new Headers(init.headers),
        body: init.body instanceof FormData ? init.body : null,
      });
      return reply(calls.length);
    },
  };
}

/** A promise the test resolves at the exact point a lifecycle must stop waiting for it. */
function held<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("the codex provider — the identity on the wire", () => {
  test("honest sends Collie's own User-Agent and NO originator header", async () => {
    const { fetch, calls } = recorder(() => Response.json({ text: "hello" }));
    const provider = createCodexSttProvider(HONEST, {
      broker: fakeBroker(),
      fetch,
      prime: false,
      version: "1.2.3",
    });

    expect(await provider.transcribe(CLIP)).toEqual({ text: "hello" });
    const headers = calls[0]!.headers;
    expect(headers.get("user-agent")).toBe("Collie/1.2.3");
    expect(headers.has("originator")).toBe(false);
    expect(headers.get("originator")).toBeNull();
  });

  test("codex-cli sends the CLI's headers verbatim", async () => {
    const { fetch, calls } = recorder(() => Response.json({ text: "hello" }));
    const provider = createCodexSttProvider(IMPERSONATING, {
      broker: fakeBroker(),
      fetch,
      prime: false,
      version: "1.2.3",
    });

    await provider.transcribe(CLIP);
    const headers = calls[0]!.headers;
    expect(headers.get("user-agent")).toBe("codex_cli_rs/0.0.0 (Collie)");
    expect(headers.get("originator")).toBe("codex_cli_rs");
  });

  test("the credential, the account and the clip go out in the one shape the endpoint takes", async () => {
    const bearer = flatClaimToken("acct-123");
    const { fetch, calls } = recorder(() => Response.json({ text: "hello" }));
    const provider = createCodexSttProvider(HONEST, {
      broker: fakeBroker(bearer),
      fetch,
      prime: false,
      version: "1.2.3",
    });

    await provider.transcribe(CLIP);
    const call = calls[0]!;
    expect(call.url).toBe(CODEX_TRANSCRIBE_URL);
    expect(call.headers.get("authorization")).toBe(`Bearer ${bearer}`);
    expect(call.headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(call.headers.get("accept")).toBe("application/json");

    const file = call.body?.get("file");
    expect(file).toBeInstanceOf(File);
    expect(file instanceof File ? file.name : null).toBe("recording.webm");
    expect(file instanceof File ? file.type : null).toBe("audio/webm;codecs=opus");
    expect(file instanceof File ? file.size : null).toBe(3);
  });
});

describe("the codex provider — the account id in the token", () => {
  test("the flat claim is read", () => {
    expect(accountIdFromJwt(flatClaimToken("acct-flat"))).toBe("acct-flat");
  });

  test("the nested claim is read", () => {
    expect(accountIdFromJwt(nestedClaimToken("acct-nested"))).toBe("acct-nested");
  });

  test("the flat claim wins when a token somehow carries both", () => {
    const both = token({
      "https://api.openai.com/auth.chatgpt_account_id": "acct-flat",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
    });
    expect(accountIdFromJwt(both)).toBe("acct-flat");
  });

  test("a token with no account id is unavailable, not a request with an empty header", () => {
    expect(() => accountIdFromJwt(token({ sub: "nobody" }))).toThrow(SttError);
    expect(() => accountIdFromJwt("not-a-jwt")).toThrow("names no ChatGPT account");
    expect(() => accountIdFromJwt("header..signature")).toThrow("names no ChatGPT account");
  });
});

describe("the codex provider — a lapsed session", () => {
  test("a 401 refreshes ONCE and re-uploads exactly once", async () => {
    const broker = fakeBroker();
    const { fetch, calls } = recorder((call) =>
      call === 1 ? new Response("expired", { status: 401 }) : Response.json({ text: "second time" }),
    );
    const provider = createCodexSttProvider(HONEST, { broker, fetch, prime: false, version: "1.2.3" });

    expect(await provider.transcribe(CLIP)).toEqual({ text: "second time" });
    expect(broker.refreshes).toEqual([false, true]);
    expect(calls).toHaveLength(2);
  });

  test("a second 401 is a real refusal — the retry is once, not a loop", async () => {
    const broker = fakeBroker();
    const { fetch, calls } = recorder(() => new Response("expired", { status: 401 }));
    const provider = createCodexSttProvider(HONEST, { broker, fetch, prime: false, version: "1.2.3" });

    await expect(provider.transcribe(CLIP)).rejects.toThrow("401");
    expect(calls).toHaveLength(2);
    expect(broker.refreshes).toEqual([false, true]);
  });

  test("a caller that cancels during the one 401 refresh never uploads the clip again", async () => {
    const broker = fakeBroker();
    const renewed = held<{ accessToken: string }>();
    broker.accessToken = async (refresh = false) => {
      broker.refreshes.push(refresh);
      return refresh ? renewed.promise : { accessToken: flatClaimToken("acct-123") };
    };
    const { fetch, calls } = recorder(() => new Response("expired", { status: 401 }));
    const provider = createCodexSttProvider(HONEST, { broker, fetch, prime: false, version: "1.2.3" });
    const controller = new AbortController();
    const transcription = provider.transcribe(CLIP, controller.signal);

    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(broker.refreshes).toEqual([false, true]);
    controller.abort();

    await expect(transcription).rejects.toBeInstanceOf(SttCancelledError);
    renewed.resolve({ accessToken: flatClaimToken("acct-123") });
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);
  });
});

describe("the codex provider — the bounds", () => {
  test("a redirect is refused, never followed with the token attached", async () => {
    const { fetch } = recorder(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }),
    );
    const provider = createCodexSttProvider(HONEST, {
      broker: fakeBroker(),
      fetch,
      prime: false,
      version: "1.2.3",
    });

    await expect(provider.transcribe(CLIP)).rejects.toThrow("redirect");
  });

  test("the request is made with redirect: manual, so a 3xx comes back to be refused", async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    const provider = createCodexSttProvider(HONEST, {
      broker: fakeBroker(),
      prime: false,
      version: "1.2.3",
      fetch: async (_input, init) => {
        seen.push(init.redirect);
        return Response.json({ text: "hi" });
      },
    });

    await provider.transcribe(CLIP);
    expect(seen).toEqual(["manual"]);
  });

  test("an error body is NEVER reflected — only the status reaches the caller", async () => {
    const secret = "user bob@example.com plan pro internal-request-id 42";
    const { fetch } = recorder(() => new Response(secret, { status: 500 }));
    const provider = createCodexSttProvider(HONEST, {
      broker: fakeBroker(),
      fetch,
      prime: false,
      version: "1.2.3",
    });

    const error = await provider.transcribe(CLIP).then(
      () => null,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(SttError);
    expect(error?.message).toContain("500");
    expect(error?.message).not.toContain("bob@example.com");
    expect(error?.message).not.toContain("internal-request-id");
  });

  test("a rate limit and a forbidden each get their own sentence", async () => {
    for (const [status, phrase] of [
      [403, "refused"],
      [429, "rate limited"],
    ] as const) {
      const { fetch } = recorder(() => new Response("nope", { status }));
      const provider = createCodexSttProvider(HONEST, {
        broker: fakeBroker(),
        fetch,
        prime: false,
        version: "1.2.3",
      });
      await expect(provider.transcribe(CLIP)).rejects.toThrow(phrase);
    }
  });

  test("keeps its provider-local 120-second policy", () => {
    expect(CODEX_TIMEOUT_MS).toBe(120_000);
  });

  test("the deadline is a timeout, not an unavailable", async () => {
    const controller = new AbortController();
    let transcription: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      let started = false;
      const provider = createCodexSttProvider(HONEST, {
        broker: fakeBroker(),
        prime: false,
        version: "1.2.3",
        timeoutMs: 5,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            started = true;
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });

      transcription = provider.transcribe(CLIP, controller.signal);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(started).toBe(true);
      vi.advanceTimersByTime(5);

      const error = await transcription.then(
        () => null,
        (err: Error) => err,
      );
      expect(error instanceof SttError ? error.kind : null).toBe("timeout");
    } finally {
      controller.abort();
      if (transcription !== undefined) await transcription.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test("the deadline includes waiting for a token before a request starts", async () => {
    const pendingToken = held<{ accessToken: string }>();
    const controller = new AbortController();
    let transcription: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      const broker = fakeBroker();
      broker.accessToken = async (refresh = false) => {
        broker.refreshes.push(refresh);
        return pendingToken.promise;
      };
      const { fetch, calls } = recorder(() => Response.json({ text: "late" }));
      const provider = createCodexSttProvider(HONEST, {
        broker,
        fetch,
        prime: false,
        version: "1.2.3",
        timeoutMs: 5,
      });

      transcription = provider.transcribe(CLIP, controller.signal);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(broker.refreshes).toEqual([false]);
      vi.advanceTimersByTime(5);

      const error = await transcription.then(
        () => null,
        (err: Error) => err,
      );
      expect(error instanceof SttError ? error.kind : null).toBe("timeout");
      expect(calls).toHaveLength(0);
    } finally {
      controller.abort();
      pendingToken.resolve({ accessToken: flatClaimToken("acct-123") });
      if (transcription !== undefined) await transcription.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test("the deadline includes a response body that stalls after headers", async () => {
    const controller = new AbortController();
    let transcription: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() {
          // Response construction pulls once; the second pull proves `readCapped` is now waiting.
          pulls += 1;
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      });
      const provider = createCodexSttProvider(HONEST, {
        broker: fakeBroker(),
        prime: false,
        version: "1.2.3",
        timeoutMs: 5,
        fetch: async () => new Response(body),
      });

      transcription = provider.transcribe(CLIP, controller.signal);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(pulls >= 2).toBe(true);
      vi.advanceTimersByTime(5);

      const error = await transcription.then(
        () => null,
        (err: Error) => err,
      );
      expect(error instanceof SttError ? error.kind : null).toBe("timeout");
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(cancelled).toBe(true);
    } finally {
      controller.abort();
      if (transcription !== undefined) await transcription.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test("a cancelled caller stops waiting for shared token work without cancelling it", async () => {
    const broker = fakeBroker();
    const sharedToken = held<{ accessToken: string }>();
    broker.accessToken = async (refresh = false) => {
      broker.refreshes.push(refresh);
      return sharedToken.promise;
    };
    const { fetch, calls } = recorder(() => Response.json({ text: "second caller" }));
    const provider = createCodexSttProvider(HONEST, { broker, fetch, prime: false, version: "1.2.3" });
    const controller = new AbortController();
    const first = provider.transcribe(CLIP, controller.signal);

    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(SttCancelledError);

    const second = provider.transcribe(CLIP);
    sharedToken.resolve({ accessToken: flatClaimToken("acct-123") });
    expect(await second).toEqual({ text: "second caller" });
    expect(calls).toHaveLength(1);
    expect(broker.refreshes).toEqual([false, false]);
  });

  test("time spent in the first attempt reduces the one retry's remaining budget", async () => {
    const firstResponse = held<Response>();
    const controller = new AbortController();
    let transcription: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      const broker = fakeBroker();
      const signals: AbortSignal[] = [];
      let calls = 0;
      const provider = createCodexSttProvider(HONEST, {
        broker,
        prime: false,
        version: "1.2.3",
        timeoutMs: 120,
        fetch: (_input, init) => {
          const signal = init.signal;
          if (signal === null || signal === undefined) throw new Error("missing lifecycle signal");
          signals.push(signal);
          calls += 1;
          if (calls === 1) return firstResponse.promise;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          });
        },
      });

      transcription = provider.transcribe(CLIP, controller.signal);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(calls).toBe(1);

      vi.advanceTimersByTime(80);
      firstResponse.resolve(new Response("expired", { status: 401 }));
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(calls).toBe(2);
      expect(signals[1]).toBe(signals[0]);

      let settled = false;
      void transcription.then(
        () => {
          settled = true;
          return undefined;
        },
        () => {
          settled = true;
          return undefined;
        },
      );
      vi.advanceTimersByTime(39);
      await Promise.resolve();
      expect(signals[1]!.aborted).toBe(false);
      expect(settled).toBe(false);

      vi.advanceTimersByTime(1);
      const error = await transcription.then(
        () => null,
        (err: Error) => err,
      );
      expect(signals[1]!.aborted).toBe(true);
      expect(error instanceof SttError ? error.kind : null).toBe("timeout");
      expect(calls).toBe(2);
      expect(broker.refreshes).toEqual([false, true]);
    } finally {
      controller.abort();
      firstResponse.resolve(new Response("expired", { status: 401 }));
      if (transcription !== undefined) await transcription.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test("a body that is not a transcript is refused rather than surfaced", async () => {
    const { fetch } = recorder(() => new Response("<html>maintenance</html>", { status: 200 }));
    const provider = createCodexSttProvider(HONEST, {
      broker: fakeBroker(),
      fetch,
      prime: false,
      version: "1.2.3",
    });

    await expect(provider.transcribe(CLIP)).rejects.toThrow("not JSON");
  });
});

describe("the codex provider — what the snapshot poll may ask", () => {
  test("status answers the broker's last known state, and warms it at most once", async () => {
    const broker = fakeBroker();
    let probes = 0;
    broker.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const provider = createCodexSttProvider(HONEST, { broker, version: "1.2.3" });

    expect(await provider.status()).toEqual({ available: true });
    expect(await provider.status()).toEqual({ available: true });
    expect(await provider.status()).toEqual({ available: true });
    expect(probes).toBe(1);
  });

  test("with warming off, status is purely the last known state and asks nothing", async () => {
    const broker = fakeBroker();
    broker.lastKnown = () => ({ available: false, reason: "not checked yet" });
    let probes = 0;
    broker.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const provider = createCodexSttProvider(HONEST, { broker, prime: false, version: "1.2.3" });

    expect(await provider.status()).toEqual({ available: false, reason: "not checked yet" });
    expect(probes).toBe(0);
  });

  test("close hands the shutdown down to the broker", () => {
    const broker = fakeBroker();
    const provider = createCodexSttProvider(HONEST, { broker, prime: false, version: "1.2.3" });

    provider.close?.();
    expect(broker.closed).toBe(true);
  });
});

describe("probeCodexIdentity — honest first, always", () => {
  test("an endpoint that accepts the honest identity settles on honest, in one request", async () => {
    const { fetch, calls } = recorder(() => Response.json({ text: "" }));

    expect(await probeCodexIdentity(HONEST, { broker: fakeBroker(), fetch, version: "1.2.3" })).toBe(
      "honest",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has("originator")).toBe(false);
  });

  test("an endpoint that refuses the honest identity falls back, and says which one it used", async () => {
    const { fetch, calls } = recorder((call) =>
      call === 1 ? new Response("no", { status: 403 }) : Response.json({ text: "" }),
    );

    expect(await probeCodexIdentity(HONEST, { broker: fakeBroker(), fetch, version: "1.2.3" })).toBe(
      "codex-cli",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.has("originator")).toBe(false);
    expect(calls[1]!.headers.get("originator")).toBe("codex_cli_rs");
  });

  test("a 401 that survives its refresh is an identity verdict too", async () => {
    // honest, honest-after-refresh, then codex-cli: the refresh retry belongs to the request, and
    // only a refusal that outlives it counts against the identity.
    const { fetch, calls } = recorder((call) =>
      call <= 2 ? new Response("no", { status: 401 }) : Response.json({ text: "" }),
    );

    expect(await probeCodexIdentity(HONEST, { broker: fakeBroker(), fetch, version: "1.2.3" })).toBe(
      "codex-cli",
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]!.headers.get("originator")).toBe("codex_cli_rs");
  });

  test("an endpoint that refuses both throws, naming what each identity got", async () => {
    const { fetch } = recorder(() => new Response("no", { status: 403 }));

    const error = await probeCodexIdentity(HONEST, {
      broker: fakeBroker(),
      fetch,
      version: "1.2.3",
    }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(SttError);
    expect(error?.message).toContain("honest");
    expect(error?.message).toContain("codex-cli");
    expect(error?.message).toContain("403");
  });

  test("a sign-in problem is re-thrown as itself, never reported as an identity verdict", async () => {
    const broker = fakeBroker();
    broker.accessToken = async () => {
      throw new SttError("unavailable", "Codex is not signed in — run `codex login`");
    };
    const { fetch, calls } = recorder(() => Response.json({ text: "" }));

    await expect(probeCodexIdentity(HONEST, { broker, fetch, version: "1.2.3" })).rejects.toThrow(
      "not signed in",
    );
    expect(calls).toHaveLength(0);
  });

  test("one probe lifecycle bounds body disposal before it can fall back", async () => {
    let probe: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      });
      const { fetch, calls } = recorder(() => new Response(body, { status: 403 }));

      probe = probeCodexIdentity(HONEST, {
        broker: fakeBroker(),
        fetch,
        version: "1.2.3",
        timeoutMs: 5,
      });
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(calls).toHaveLength(1);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(cancelled).toBe(true);
      vi.advanceTimersByTime(5);

      const error = await probe.then(
        () => null,
        (err: Error) => err,
      );
      expect(error instanceof SttError ? error.kind : null).toBe("timeout");
      expect(calls).toHaveLength(1);
    } finally {
      if (probe !== undefined) {
        vi.runAllTimers();
        await probe.catch(() => undefined);
      }
      vi.useRealTimers();
    }
  });

  test("a broker the caller handed in is NOT closed by the probe; one the probe made is", async () => {
    const broker = fakeBroker();
    const { fetch } = recorder(() => Response.json({ text: "" }));

    await probeCodexIdentity(HONEST, { broker, fetch, version: "1.2.3" });
    expect(broker.closed).toBe(false);
  });

  test("the probe clip is a readable WAV of silence, not a binary fixture", () => {
    const wav = silentWavBytes(200, 8_000);
    const header = new TextDecoder().decode(wav.subarray(0, 4));
    expect(header).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + 8_000 * 0.2 * 2);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
  });
});
