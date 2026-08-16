import {
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_MS,
  MIN_EFFECTIVE_UPLINK_BITS_PER_SECOND,
  MULTIPART_ALLOWANCE_BYTES,
  PARSE_SCHEDULING_RESPONSE_MARGIN_MS,
  PROVIDER_ALLOWANCE_MS,
  RECORDING_MIME_TYPES,
  requestedRecordingBitrate,
  transcriptionDeadlineMs,
} from "./voice-policy";

describe("voice recording policy", () => {
  it("owns the accepted recording envelope and MIME-aware best-effort bitrates", () => {
    expect(MAX_VOICE_DURATION_MS).toBe(5 * 60 * 1000);
    expect(MAX_VOICE_BYTES).toBe(8 * 1024 * 1024);
    expect(RECORDING_MIME_TYPES).toEqual(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
    expect(requestedRecordingBitrate("audio/webm;codecs=opus")).toBe(24_000);
    expect(requestedRecordingBitrate("audio/webm")).toBe(24_000);
    expect(requestedRecordingBitrate("audio/mp4")).toBe(64_000);
  });

  it("derives the bounded total deadline from known Blob bytes", () => {
    expect(MIN_EFFECTIVE_UPLINK_BITS_PER_SECOND).toBe(256_000);
    expect(MULTIPART_ALLOWANCE_BYTES).toBe(65_536);
    expect(PROVIDER_ALLOWANCE_MS).toBe(60_000);
    expect(PARSE_SCHEDULING_RESPONSE_MARGIN_MS).toBe(20_000);
    expect(transcriptionDeadlineMs(0)).toBe(82_048);
    expect(transcriptionDeadlineMs(1)).toBe(82_049);
    expect(transcriptionDeadlineMs(MAX_VOICE_BYTES)).toBe(344_192);
  });

  it("rejects non-integer or out-of-envelope byte counts instead of clamping them", () => {
    for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, MAX_VOICE_BYTES + 1]) {
      expect(() => transcriptionDeadlineMs(bytes)).toThrow(RangeError);
    }
  });
});
