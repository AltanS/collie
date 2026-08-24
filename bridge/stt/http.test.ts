import { describe, expect, test } from "bun:test";

import {
  MAX_STT_AUDIO_BYTES,
  createSttAdmission,
  sttCapability,
  transcribeRequest,
  type SttTranscribeResponse,
} from "./http.ts";
import { SttError, type SttAudio, type SttProvider, type SttResult, type SttStatus } from "./provider.ts";

// `POST /api/stt`'s own rules, driven without `Bun.serve`: the caller here has already cleared the
// write gate, exactly as server.ts's dispatch guarantees, so nothing below is about authorisation.

/** A provider under the test's control: what it answers, and what it was handed. */
function fakeProvider(opts: {
  status?: SttStatus;
  answer?: (input: SttAudio) => SttResult;
  fail?: () => never;
}) {
  const received: SttAudio[] = [];
  const provider: SttProvider = {
    id: "openai-compatible",
    async status() {
      return opts.status ?? { available: true };
    },
    async transcribe(input) {
      received.push(input);
      if (opts.fail) opts.fail();
      return opts.answer?.(input) ?? { text: "spoken text" };
    },
  };
  return { provider, received };
}

function audioRequest(body: BodyInit, contentType = "audio/webm;codecs=opus", extra: HeadersInit = {}): Request {
  return new Request("http://localhost/api/stt", {
    method: "POST",
    headers: { "content-type": contentType, ...extra },
    body,
  });
}

async function bodyOf(response: Response): Promise<SttTranscribeResponse> {
  // SAFETY: every response this module builds is one of the two `SttTranscribeResponse` arms —
  // `jsonResponse` is its only constructor.
  return (await response.json()) as SttTranscribeResponse;
}

describe("POST /api/stt — the happy path", () => {
  test("raw audio bytes become one transcript", async () => {
    const { provider, received } = fakeProvider({});
    const { response, attempt } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1, 2, 3])),
      createSttAdmission(),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true, text: "spoken text" });
    expect(attempt).toEqual({ status: 200, outcome: "ok", bytes: 3 });
    expect(received).toHaveLength(1);
    expect(received[0]!.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(received[0]!.mimeType).toBe("audio/webm;codecs=opus");
  });

  test("the filename is server-generated from the container, never the caller's", async () => {
    const cases: [string, string][] = [
      ["audio/webm;codecs=opus", "recording.webm"],
      ["audio/mp4", "recording.mp4"],
      ["audio/ogg", "recording.ogg"],
      ["AUDIO/WEBM", "recording.webm"],
    ];
    for (const [contentType, filename] of cases) {
      const { provider, received } = fakeProvider({});
      await transcribeRequest(provider, audioRequest(new Uint8Array([1]), contentType), createSttAdmission());
      expect(received[0]!.filename).toBe(filename);
    }
  });
});

describe("POST /api/stt — refusals before a provider is ever called", () => {
  test("no provider configured is a 503 that says what to do", async () => {
    const { response, attempt } = await transcribeRequest(
      null,
      audioRequest(new Uint8Array([1])),
      createSttAdmission(),
    );

    expect(response.status).toBe(503);
    expect(attempt.outcome).toBe("unconfigured");
    expect(JSON.stringify(await bodyOf(response))).toContain("collie stt setup");
  });

  test("an honestly-declared oversized body is refused before it is read", async () => {
    const { provider, received } = fakeProvider({});
    const { response, attempt } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1]), "audio/webm", {
        "content-length": String(MAX_STT_AUDIO_BYTES + 1),
      }),
      createSttAdmission(),
    );

    expect(response.status).toBe(413);
    expect(attempt.outcome).toBe("invalid");
    expect(received).toEqual([]);
  });

  test("a body that lies about its length is still measured and refused", async () => {
    const { provider, received } = fakeProvider({});
    const { response } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array(MAX_STT_AUDIO_BYTES + 1), "audio/webm"),
      createSttAdmission(),
    );

    expect(response.status).toBe(413);
    expect(received).toEqual([]);
  });

  test("an unsupported container is a 415", async () => {
    const { provider, received } = fakeProvider({});
    const { response } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1]), "audio/aac"),
      createSttAdmission(),
    );

    expect(response.status).toBe(415);
    expect(received).toEqual([]);
  });

  test("a content-type that could reach Object.prototype is still just unsupported", async () => {
    const { provider } = fakeProvider({});
    const { response } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1]), "constructor"),
      createSttAdmission(),
    );

    expect(response.status).toBe(415);
  });

  test("an empty recording is a 400", async () => {
    const { provider, received } = fakeProvider({});
    const { response } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array(0), "audio/webm"),
      createSttAdmission(),
    );

    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });
});

describe("POST /api/stt — two at a time, and the third is told so", () => {
  test("the third concurrent transcription gets a 429 and never reaches the provider", async () => {
    let releaseProvider: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const { provider, received } = fakeProvider({});
    const slow: SttProvider = {
      ...provider,
      async transcribe(input) {
        await held;
        return provider.transcribe(input);
      },
    };
    const admission = createSttAdmission();

    const first = transcribeRequest(slow, audioRequest(new Uint8Array([1]), "audio/webm"), admission);
    const second = transcribeRequest(slow, audioRequest(new Uint8Array([2]), "audio/webm"), admission);
    // Let both in-flight requests take their slot before the third asks for one.
    await Bun.sleep(1);
    const third = await transcribeRequest(slow, audioRequest(new Uint8Array([3]), "audio/webm"), admission);

    expect(third.response.status).toBe(429);
    expect(third.attempt.outcome).toBe("busy");

    releaseProvider!();
    expect((await first).response.status).toBe(200);
    expect((await second).response.status).toBe(200);
    expect(received.map((r) => r.audio[0])).toEqual([1, 2]);

    // The slots are given back, so a later caller is admitted again.
    const fourth = await transcribeRequest(provider, audioRequest(new Uint8Array([4]), "audio/webm"), admission);
    expect(fourth.response.status).toBe(200);
  });

  test("a refused request never consumes a slot", async () => {
    const admission = createSttAdmission(1);
    const { provider } = fakeProvider({});

    await transcribeRequest(provider, audioRequest(new Uint8Array([1]), "audio/aac"), admission);
    await transcribeRequest(null, audioRequest(new Uint8Array([1]), "audio/webm"), admission);
    const ok = await transcribeRequest(provider, audioRequest(new Uint8Array([1]), "audio/webm"), admission);

    expect(ok.response.status).toBe(200);
  });

  test("a release is idempotent, so a double call cannot un-bound the gate", () => {
    const admission = createSttAdmission(1);
    const release = admission.acquire()!;
    release();
    release();

    expect(admission.acquire()).not.toBeNull();
    expect(admission.acquire()).toBeNull();
  });
});

describe("POST /api/stt — a provider failure earns one status each", () => {
  test("a deadline is a 504, everything else a 502, and the audio size is still audited", async () => {
    const cases: [SttError["kind"], number][] = [
      ["timeout", 504],
      ["refused", 502],
      ["oversized", 502],
      ["unavailable", 502],
    ];
    for (const [kind, status] of cases) {
      const { provider } = fakeProvider({
        fail: () => {
          throw new SttError(kind);
        },
      });
      const { response, attempt } = await transcribeRequest(
        provider,
        audioRequest(new Uint8Array([1, 2]), "audio/webm"),
        createSttAdmission(),
      );

      expect(response.status).toBe(status);
      expect(attempt).toEqual({ status, outcome: kind, bytes: 2 });
    }
  });

  test("a provider that throws something else is still a plain 502", async () => {
    const { provider } = fakeProvider({
      fail: () => {
        throw new Error("ECONNRESET at 10.0.0.4:9000");
      },
    });
    const { response, attempt } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1]), "audio/webm"),
      createSttAdmission(),
    );

    expect(response.status).toBe(502);
    expect(attempt.outcome).toBe("unavailable");
    // The thrown message could name an internal host; it must not be reflected.
    expect(JSON.stringify(await bodyOf(response))).not.toContain("10.0.0.4");
  });
});

describe("the /api/config capability — a label and a yes/no, nothing else", () => {
  test("no provider means NO capability key at all", async () => {
    expect(await sttCapability(null)).toBeNull();
  });

  test("an available provider reports its id with no `reason`", async () => {
    const { provider } = fakeProvider({ status: { available: true } });
    const wire = await sttCapability(provider);

    expect(wire).toEqual({ provider: "openai-compatible", available: true });
    expect("reason" in wire!).toBe(false);
  });

  test("an unavailable provider carries the operator-facing reason", async () => {
    const { provider } = fakeProvider({ status: { available: false, reason: "not signed in" } });

    expect(await sttCapability(provider)).toEqual({
      provider: "openai-compatible",
      available: false,
      reason: "not signed in",
    });
  });
});

describe("POST /api/stt — every refusal names a code, not just a status", () => {
  /** The `code` off a refusal, or `undefined` when the route answered `ok:true`. */
  async function codeOf(response: Response): Promise<string | undefined> {
    const body = await bodyOf(response);
    return body.ok ? undefined : body.code;
  }

  test("each refusal carries the code the phone translates against", async () => {
    const { provider } = fakeProvider({});
    const unconfigured = await transcribeRequest(null, audioRequest(new Uint8Array([1])), createSttAdmission());
    expect(await codeOf(unconfigured.response)).toBe("stt.unconfigured");

    const oversize = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1]), "audio/webm", {
        "content-length": String(MAX_STT_AUDIO_BYTES + 1),
      }),
      createSttAdmission(),
    );
    expect(await codeOf(oversize.response)).toBe("stt.too_large");

    const badFormat = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1]), "audio/aac"),
      createSttAdmission(),
    );
    expect(await codeOf(badFormat.response)).toBe("stt.bad_format");

    const empty = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array(0), "audio/webm"),
      createSttAdmission(),
    );
    expect(await codeOf(empty.response)).toBe("stt.empty");
  });

  test("the size cap travels as a number, so a translated sentence can name it", async () => {
    const { provider } = fakeProvider({});
    const { response } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array(MAX_STT_AUDIO_BYTES + 1), "audio/webm"),
      createSttAdmission(),
    );
    const body = await bodyOf(response);
    expect(body.ok).toBe(false);
    // "8 MiB" is prose the phone cannot re-derive; the byte count is the fact.
    expect(body.ok ? null : body.detail).toEqual({ maxBytes: MAX_STT_AUDIO_BYTES });
  });

  test("a provider failure keeps ITS OWN words as the sentence and adds the kind", async () => {
    const { provider } = fakeProvider({
      fail: () => {
        throw new SttError("refused", "the transcription service refused the recording");
      },
    });
    const { response } = await transcribeRequest(
      provider,
      audioRequest(new Uint8Array([1, 2]), "audio/webm"),
      createSttAdmission(),
    );
    expect(await bodyOf(response)).toEqual({
      ok: false,
      error: "the transcription service refused the recording",
      code: "stt.provider_failed",
      detail: { reason: "the transcription service refused the recording", kind: "refused" },
    });
  });
});
