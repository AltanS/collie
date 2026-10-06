// The phone's half of speech-to-text (ADR 0029), without React: a port of web/src/lib/stt.ts. That
// file imports hooks and web's React operator-config, so it cannot be reused; the policy, the
// support probe, the error words and the one persisted setting are restated here, and the two
// shells agree on the same wire contract and the same localStorage key.
//
// TWO THINGS DECIDE WHETHER A MICROPHONE EXISTS HERE, and they are independent:
//
//  1. The bridge published a provider. `/api/config` carries `stt` only when the operator ran
//     `collie stt setup`; absent is the feature being off (also what an older bridge sends), and it
//     draws NO button. `available: false` is a provider that exists and cannot serve right now: that
//     DOES draw a disabled button carrying the bridge's own `reason`.
//  2. This browser can record. A `MediaRecorder`, a `getUserMedia` and a secure context. Over plain
//     HTTP `navigator.mediaDevices` is simply absent, and a control that provably cannot work is
//     worse than no control, so this hides the button entirely.
import type { SttResult } from "@web/lib/api";
import { isApiErrorCode } from "@web/lib/api-error-codes";
import { describeApiError } from "@web/lib/api-error-message";
import { t } from "@web/lib/i18n";
import type { BridgeConfig, SttCapability } from "@web/lib/types";

import { createStore, type Store } from "./store";

/** The refusal half of one transcription attempt: the only shape `sttErrorMessage` has words for. */
type SttFailure = Extract<SttResult, { ok: false }>;

/** Mirrors MAX_STT_AUDIO_BYTES in bridge/stt/http.ts. The bridge enforces; this stops a refused upload. */
export const MAX_STT_AUDIO_BYTES = 8 * 1024 * 1024;

/** Hard stop on one clip. A recording still running at five minutes is a pocket, not a reply. */
export const MAX_STT_DURATION_MS = 5 * 60 * 1000;

/** Containers a browser's MediaRecorder produces, best first (Chrome and Firefox webm, Safari mp4). */
export const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

/** A best-effort encoder hint: 24 kbps Opus keeps a five-minute clip far under the 8 MiB ceiling. */
export function requestedRecordingBitrate(mimeType: string): number {
  return mimeType.startsWith("audio/mp4") ? 64_000 : 24_000;
}

/** The container this browser will record, or `null` when it will record none of them. */
export function pickRecordingMimeType(): string | null {
  if (!("MediaRecorder" in globalThis)) return null;
  for (const type of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

/**
 * Whether this browser can record at all. `isSecureContext` is checked explicitly: on an insecure
 * origin the whole `mediaDevices` object is absent, so the failure would arrive as a TypeError at
 * the tap instead of as a button that was never drawn.
 */
export function sttRecordingSupported(): boolean {
  if (!globalThis.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return pickRecordingMimeType() !== null;
}

/**
 * The bridge's speech-to-text block, or `null` when this phone must draw no record button: no
 * provider is configured, or this browser cannot record. One predicate, so the composer's button and
 * the Settings row cannot disagree about whether the feature exists. `canRecord` is the browser half,
 * a parameter only so a test can state it.
 */
export function sttCapability(
  cfg: BridgeConfig | undefined,
  canRecord: boolean = sttRecordingSupported(),
): SttCapability | null {
  const stt = cfg?.stt;
  if (stt === undefined || !canRecord) return null;
  return stt;
}

/**
 * Operator-facing words for a failed transcription. The code first: a refusal from any current
 * bridge carries the stable `code` this app has a translated sentence for (`apiError.stt.*`), and the
 * code says what the status cannot ("the recording is empty" and "could not be read" are both 400).
 * The status ladder is what remains for a bridge OLDER than the catalogue, which sends no code.
 */
export function sttErrorMessage(failure: SttFailure): string {
  if (isApiErrorCode(failure.code)) {
    return describeApiError({ error: failure.error ?? undefined, code: failure.code, detail: failure.detail });
  }
  const { status, error: serverError } = failure;
  if (status === 429) return t("stt.error.busy");
  if (status === 413) return t("stt.error.tooLong");
  if (status === 415) return t("stt.error.badFormat");
  if (status === 503) return t("stt.error.unconfigured");
  if (status === 504) return t("stt.error.timeout");
  if (status === 502) return t("stt.error.unreachable");
  return serverError ?? t("stt.error.generic");
}

// ── HANDS-FREE ────────────────────────────────────────────────────────────────────────────────────
//
// OFF by default, and a deliberate act: with it on, a transcript is SENT rather than dropped in the
// box, through the same guarded reply path a typed message takes, never around it. The composer owns
// the two refusals this setting cannot express (a draft in the box, a password prompt on screen).
// Per DEVICE, because "send what I say without showing me first" is a statement about who is holding
// the phone. Same key and "1"/"0" shape as web/src/lib/stt.ts; like web/, no cross-tab sync.

export const HANDS_FREE_KEY = "collie:stt-hands-free:v1";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked or partitioned storage
  }
}

function loadHandsFree(): boolean {
  try {
    return storage()?.getItem(HANDS_FREE_KEY) === "1";
  } catch {
    return false; // the default is the safe answer anyway
  }
}

const handsFreeStore = createStore<boolean>(loadHandsFree());

/** The hands-free setting. `set` writes through to storage; a refused write keeps the value in memory. */
export const handsFree: Store<boolean> = {
  ...handsFreeStore,
  set(next) {
    try {
      storage()?.setItem(HANDS_FREE_KEY, next ? "1" : "0");
    } catch {
      // Quota or storage disabled: the in-memory value still applies for this session.
    }
    handsFreeStore.set(next);
  },
  update: (change) => handsFree.set(change(handsFreeStore.get())),
};
