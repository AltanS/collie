/** Browser-owned recording limits; the bridge enforces the matching submitted-file envelope. */
export const MAX_VOICE_DURATION_MS = 5 * 60 * 1000;
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;

/** Ordered by preferred browser recording container. */
export const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

/** A best-effort encoder request, not an acceptance or telemetry signal. */
export function requestedRecordingBitrate(mimeType: string): number {
  return mimeType === "audio/mp4" ? 64_000 : 24_000;
}

// A completed recording has a known byte count, so its one-shot request can use one coherent wall
// clock budget. These deliberately match the bridge's 64 KiB multipart declaration allowance and
// its independently bounded 60-second provider call; neither is a retry allowance.
export const MIN_EFFECTIVE_UPLINK_BITS_PER_SECOND = 256_000;
export const MULTIPART_ALLOWANCE_BYTES = 64 * 1024;
export const PROVIDER_ALLOWANCE_MS = 60_000;
export const PARSE_SCHEDULING_RESPONSE_MARGIN_MS = 20_000;

/**
 * Total browser deadline for a completed audio Blob of known size. Do not clamp: an out-of-envelope
 * input must fail before its request starts rather than receive a deadline that under-budgets it.
 */
export function transcriptionDeadlineMs(bytes: number): number {
  if (!Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes < 0 || bytes > MAX_VOICE_BYTES) {
    throw new RangeError("voice recording bytes must be an integer from 0 through 8 MiB");
  }
  const uploadMs = Math.ceil(
    ((bytes + MULTIPART_ALLOWANCE_BYTES) * 8 * 1000) / MIN_EFFECTIVE_UPLINK_BITS_PER_SECOND,
  );
  return uploadMs + PROVIDER_ALLOWANCE_MS + PARSE_SCHEDULING_RESPONSE_MARGIN_MS;
}
