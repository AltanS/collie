/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { t } from "@web/lib/i18n";
import type { BridgeConfig, SttCapability } from "@web/lib/types";

import {
  HANDS_FREE_KEY,
  MAX_STT_AUDIO_BYTES,
  handsFree,
  requestedRecordingBitrate,
  sttCapability,
  sttErrorMessage,
} from "./stt";

/** The one part of the bridge config these tests read. */
interface SttConfigPart {
  stt?: SttCapability;
}

// `BridgeConfig` has many required fields this file never reads; the cast states that.
// SAFETY: `sttCapability` reads only `cfg.stt`, which `SttConfigPart` carries whole.
const config = (part: SttConfigPart): BridgeConfig => part as BridgeConfig;

describe("sttCapability: a microphone needs the bridge AND the browser", () => {
  const provider = { provider: "openai-compatible", available: true };

  test("no provider published means no button, even in a browser that can record", () => {
    expect(sttCapability(config({}), true)).toBeNull();
    expect(sttCapability(undefined, true)).toBeNull();
  });

  test("a provider in a browser that cannot record means no button", () => {
    expect(sttCapability(config({ stt: provider }), false)).toBeNull();
  });

  test("both gates open returns the bridge's own block", () => {
    expect(sttCapability(config({ stt: provider }), true)).toEqual(provider);
  });

  test("an unavailable provider still draws (disabled) and keeps its reason", () => {
    const down = { provider: "openai-compatible", available: false, reason: "key missing" };
    expect(sttCapability(config({ stt: down }), true)).toEqual(down);
  });

  test("bun has no microphone, so the default probe says no", () => {
    expect(sttCapability(config({ stt: provider }))).toBeNull();
  });
});

describe("sttErrorMessage", () => {
  const refusal = (status: number, rest: { error?: string | null; code?: string } = {}) => {
    const failure: Parameters<typeof sttErrorMessage>[0] = { ok: false, status, error: rest.error ?? null };
    if (rest.code) failure.code = rest.code;
    return failure;
  };

  test("the status ladder serves a bridge that sends no code", () => {
    expect(sttErrorMessage(refusal(429))).toBe(t("stt.error.busy"));
    expect(sttErrorMessage(refusal(413))).toBe(t("stt.error.tooLong"));
    expect(sttErrorMessage(refusal(415))).toBe(t("stt.error.badFormat"));
  });

  test("an unknown status falls back to the bridge's sentence, then the generic one", () => {
    expect(sttErrorMessage(refusal(500, { error: "provider exploded" }))).toBe("provider exploded");
    expect(sttErrorMessage(refusal(500))).toBe(t("stt.error.generic"));
  });

  test("a known code wins over the status", () => {
    // 400 has no rung on the ladder; the code is the only thing that can name it.
    expect(sttErrorMessage(refusal(400, { code: "stt.empty" }))).toBe(t("apiError.stt.empty"));
    expect(sttErrorMessage(refusal(400, { code: "stt.unreadable" }))).toBe(t("apiError.stt.unreadable"));
  });
});

describe("limits and hands-free", () => {
  test("the clip cap and the bitrate hint match web", () => {
    expect(MAX_STT_AUDIO_BYTES).toBe(8 * 1024 * 1024);
    expect(requestedRecordingBitrate("audio/mp4")).toBe(64_000);
    expect(requestedRecordingBitrate("audio/webm;codecs=opus")).toBe(24_000);
  });

  test("hands-free is off by default, keeps web's key, and wakes subscribers once per change", () => {
    expect(HANDS_FREE_KEY).toBe("collie:stt-hands-free:v1");
    expect(handsFree.get()).toBe(false);
    let woke = 0;
    handsFree.subscribe(() => woke++);
    handsFree.set(true);
    handsFree.set(true);
    expect(handsFree.get()).toBe(true);
    expect(woke).toBe(1);
    handsFree.update((on) => !on);
    expect(handsFree.get()).toBe(false);
  });
});
