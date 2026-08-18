import { describe, expect, test } from "bun:test";

import { MAX_STT_AUDIO_BYTES, sttStatusResponse, transcribeAudio } from "./http.ts";
import type { SttAudio, SttProvider, SttStatus } from "./provider.ts";

class FakeProvider implements SttProvider {
  readonly id = "codex";
  received: SttAudio | null = null;

  constructor(private readonly currentStatus: SttStatus = { available: true }) {}

  async status() {
    return this.currentStatus;
  }

  async transcribe(input: SttAudio) {
    this.received = input;
    return { text: "spoken text" };
  }

  close() {}
}

describe("STT HTTP contract", () => {
  test("reports provider availability without credentials", async () => {
    const response = await sttStatusResponse(
      new FakeProvider({ available: false, reason: "Codex is not signed in with ChatGPT" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "codex",
      available: false,
      reason: "Codex is not signed in with ChatGPT",
    });
  });

  test("accepts supported audio as a bounded binary body", async () => {
    const provider = new FakeProvider();
    const request = new Request("http://localhost/api/stt/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm;codecs=opus" },
      body: new Uint8Array([1, 2, 3]),
    });

    const response = await transcribeAudio(provider, request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "spoken text" });
    expect(provider.received).toEqual({
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm;codecs=opus",
      filename: "recording.webm",
    });
  });

  test("rejects oversized and unsupported audio before calling the provider", async () => {
    const provider = new FakeProvider();
    const oversized = new Request("http://localhost/api/stt/transcribe", {
      method: "POST",
      headers: {
        "content-type": "audio/webm",
        "content-length": String(MAX_STT_AUDIO_BYTES + 1),
      },
      body: new Uint8Array([1]),
    });
    const unsupported = new Request("http://localhost/api/stt/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/aac" },
      body: new Uint8Array([1]),
    });

    expect((await transcribeAudio(provider, oversized)).status).toBe(413);
    expect((await transcribeAudio(provider, unsupported)).status).toBe(415);
    expect(provider.received).toBeNull();
  });
});
