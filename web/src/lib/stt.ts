import { useEffect, useSyncExternalStore } from "react";

import { getSttCapability, loadOperatorCommands, subscribeOperatorConfig } from "@/lib/operator-config";
import type { SttCapability } from "@/lib/types";

// THE PHONE'S HALF OF SPEECH-TO-TEXT (ADR 0029) — the policy, the support probe, the error words,
// and the one persisted setting. The recorder mechanics live in hooks/use-stt-recorder.ts and the
// transport in lib/api.ts; this file is what both of them, the composer and Settings agree on.
//
// TWO THINGS DECIDE WHETHER A MICROPHONE EXISTS HERE, and they are independent:
//
//  1. **The bridge published a provider.** `/api/config` carries `stt` only when the operator ran
//     `collie stt setup`; absent is the feature being off, which is also what an older bridge sends.
//     Absent draws NO button — not a disabled one. `available: false` is the other case: a provider
//     that exists and cannot serve right now, which DOES draw a disabled button carrying the
//     bridge's own `reason`, because the operator can fix that and needs to be told what to fix.
//  2. **This browser can actually record.** A `MediaRecorder`, a `getUserMedia`, and a secure
//     context. Over plain HTTP (a tailnet URL without `tailscale serve`) `navigator.mediaDevices` is
//     simply not there, and #115 shipped without this check — the button rendered and did nothing.
//     A control that provably cannot work is worse than no control, so this hides the button
//     entirely rather than disabling it: there is no operator action on the phone that fixes it.

/** The largest clip the phone will upload. Mirrors MAX_STT_AUDIO_BYTES in bridge/stt/http.ts — the
 *  bridge is still the enforcer; this is what stops an 8 MiB body being sent to be refused. */
export const MAX_STT_AUDIO_BYTES = 8 * 1024 * 1024;

/** Hard stop on one clip. A recording still running at five minutes is a pocket, not a reply. */
export const MAX_STT_DURATION_MS = 5 * 60 * 1000;

/** Containers a browser's MediaRecorder actually produces, best first. Every one of them is in the
 *  bridge's accepted set; the first the browser admits to supporting wins (Chrome/Firefox take the
 *  webm line, Safari the mp4 one). */
export const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

/** A best-effort encoder hint. Speech at 24 kbps Opus is comfortably intelligible, and the point of
 *  asking is that a five-minute clip then lands nowhere near the 8 MiB ceiling. */
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
 * Whether this browser can record at all — the second of the two gates in the header.
 *
 * `isSecureContext` is checked explicitly rather than left to `getUserMedia` throwing: on an
 * insecure origin the whole `mediaDevices` object is absent, so the failure would arrive as a
 * TypeError at the moment of the tap instead of as a button that was never drawn.
 */
export function sttRecordingSupported(): boolean {
  if (!globalThis.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return pickRecordingMimeType() !== null;
}

/**
 * The bridge's speech-to-text block, or `null` when this phone must draw no record button — either
 * because no provider is configured or because this browser cannot record. One predicate so the
 * composer's button and the Settings row can never disagree about whether the feature exists.
 */
export function useSttCapability(): SttCapability | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  const capability = useSyncExternalStore(
    subscribeOperatorConfig,
    getSttCapability,
    getSttCapability,
  );
  // Evaluated per render rather than memoised: it reads browser globals that do not change within a
  // page, and a memo keyed on nothing would only hide that.
  return capability !== null && sttRecordingSupported() ? capability : null;
}

/**
 * Operator-facing words for a failed transcription.
 *
 * The bridge already sends prose in `{ok:false,error}` and it is good prose — but it is written for
 * a terminal, and the composer has one line. These are the short forms, keyed by the status the
 * route assigns each failure kind (bridge/stt/http.ts). The bridge's own text is the fallback, so a
 * status this list has not met still says something true.
 */
export function sttErrorMessage(status: number, serverError: string | null): string {
  if (status === 429) return "Busy — another recording is still transcribing. Try again in a moment.";
  if (status === 413) return "That recording is too long — record a shorter one.";
  if (status === 415) return "This browser recorded a format Collie can't send on.";
  if (status === 503) return "Speech-to-text isn't configured on this collie.";
  if (status === 504) return "The transcriber didn't answer in time — try again.";
  if (status === 502) return "The transcriber couldn't be reached — try again.";
  return serverError ?? "Transcription failed — record again to retry.";
}

// ── HANDS-FREE ──────────────────────────────────────────────────────────────────────────────────
//
// OFF by default, and it stays a deliberate act: with it on, a transcript is SENT rather than
// dropped in the box — through the same guarded reply path a typed message takes (ADR 0029), never
// around it. The composer owns the two refusals that setting can't express (a draft already in the
// box, a password prompt on screen); this store owns only the operator's answer to the question.
//
// Same shape as lib/haptics.ts: module state + subscribe + a useSyncExternalStore hook, persisted to
// localStorage. Per DEVICE, because "send what I say without showing me first" is a statement about
// where the phone is and who is holding it, not about the herd.

const HANDS_FREE_KEY = "collie:stt-hands-free:v1";

let handsFree = loadHandsFree();
const handsFreeListeners = new Set<() => void>();

function loadHandsFree(): boolean {
  try {
    return localStorage.getItem(HANDS_FREE_KEY) === "1";
  } catch {
    return false; // private mode / no storage — the default is the safe answer anyway
  }
}

export function handsFreeEnabled(): boolean {
  return handsFree;
}

export function setHandsFreeEnabled(on: boolean): void {
  handsFree = on;
  try {
    localStorage.setItem(HANDS_FREE_KEY, on ? "1" : "0");
  } catch {
    // Ignore quota / storage-disabled writes — the in-memory value still applies for this session.
  }
  for (const fn of handsFreeListeners) fn();
}

function subscribeHandsFree(cb: () => void): () => void {
  handsFreeListeners.add(cb);
  return () => handsFreeListeners.delete(cb);
}

export function useHandsFree(): boolean {
  return useSyncExternalStore(subscribeHandsFree, handsFreeEnabled, handsFreeEnabled);
}

/** Test helper — the setting is module state, so one case's toggle would outlive it. */
export function __resetHandsFree(): void {
  handsFree = false;
  handsFreeListeners.clear();
}
