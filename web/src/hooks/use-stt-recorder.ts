import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import { t } from "@/lib/i18n";
import {
  MAX_STT_AUDIO_BYTES,
  MAX_STT_DURATION_MS,
  pickRecordingMimeType,
  requestedRecordingBitrate,
  sttErrorMessage,
} from "@/lib/stt";

/** Where one clip is in its life. `requesting` is the browser's permission prompt. */
export type SttPhase = "idle" | "requesting" | "recording" | "transcribing";

/** One composer's microphone. Everything the button and the strip above it need. */
export interface SttRecorder {
  phase: SttPhase;
  /** `m:ss` since the recording started — the elapsed readout on the armed strip. */
  elapsedLabel: string;
  /** True for every phase but `idle`: a clip is being recorded or is in flight. */
  busy: boolean;
  /** Ask for the microphone and start. A no-op unless idle. */
  start: () => void;
  /** Stop and transcribe. A no-op unless recording. */
  stopAndSend: () => void;
  /** Throw the clip away — no upload, nothing kept. Safe in any phase. */
  discard: () => void;
}

interface SttRecorderOptions {
  /** False when there is no provider, no microphone, or the composer can't accept a transcript. */
  enabled: boolean;
  /**
   * Which pane+session the clip belongs to. A CHANGE discards mid-recording, the same way the
   * composer's other armed state dies with the pane it was armed on — a transcript is a reply, and a
   * reply dictated at one pane must never land at another.
   */
  paneKey: string;
  /** True while the view the recording belongs to has stopped being live: a gone pane, a read-only
   *  device, the idle pause. Arming survives none of them. */
  suspended: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * ONE CLIP AT A TIME, AND IT DIES WITH ITS VIEW.
 *
 * The microphone is armed state in exactly the sense "Type into terminal" is (hooks/use-direct-typing.ts,
 * ADR 0029): entered by a named tap, never persisted, never restored, and discarded — with no upload
 * — the moment the thing it was armed against stops being true. A pane switch, a composer lock, a
 * hidden page and an unmount all discard. Coming back gives you a microphone, never a clip.
 *
 * WHY DISCARD RATHER THAN FINISH THE UPLOAD. A transcript's only destination is the composer for the
 * pane you were looking at. If that pane is gone, or the device has lost write access, or the app was
 * backgrounded (where a phone will suspend the recorder mid-clip anyway and hand back a truncated
 * half-sentence), there is nothing honest to do with the words. Sending them anyway would spend the
 * operator's audio on a provider to produce text nobody can see.
 *
 * IDENTITY, NOT FLAGS. Every asynchronous continuation — the permission prompt resolving, the
 * recorder's own `stop` event, the transcription answering — first checks that the operation it
 * belongs to is still the current one. A cancelled clip therefore cannot resurrect itself in a later
 * callback, which is the failure mode a boolean `cancelled` ref always eventually loses to.
 */
export function useSttRecorder({
  enabled,
  paneKey,
  suspended,
  onTranscript,
  onError,
}: SttRecorderOptions): SttRecorder {
  const [phase, setPhase] = useState<SttPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  // The live phase for the async continuations below, which run between renders and must not read a
  // value that is one render behind.
  const phaseRef = useRef<SttPhase>("idle");
  const operationRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hardStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Latest-value refs for the two callbacks: they are re-created every render by the composer, and
  // naming them as effect dependencies would tear down the lifecycle listeners on every poll.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  function setPhaseNow(next: SttPhase): void {
    phaseRef.current = next;
    setPhase(next);
  }

  function isCurrent(operation: AbortController): boolean {
    return operation === operationRef.current;
  }

  function clearTimers(): void {
    if (tickRef.current !== null) clearInterval(tickRef.current);
    if (hardStopRef.current !== null) clearTimeout(hardStopRef.current);
    tickRef.current = null;
    hardStopRef.current = null;
  }

  function releaseWakeLock(): void {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    void lock?.release().catch(() => {});
  }

  // Screen wake lock, FOREGROUND ONLY and best-effort. A phone that sleeps mid-sentence stops the
  // recorder, so holding the screen awake is the difference between a five-second clip and the reply
  // you were dictating. Never requested while hidden — a hidden page discards anyway, so a lock
  // taken there would only be an app holding a phone awake for a recording it has already thrown out.
  async function acquireWakeLock(operation: AbortController): Promise<void> {
    if (!navigator.wakeLock || document.visibilityState !== "visible") return;
    let lock: WakeLockSentinel;
    try {
      lock = await navigator.wakeLock.request("screen");
    } catch {
      // A refused lock changes nothing about the recording; it is a comfort, not a dependency.
      return;
    }
    // The request is asynchronous, so the clip it was taken for may already be over.
    if (!isCurrent(operation) || phaseRef.current !== "recording") {
      void lock.release().catch(() => {});
      return;
    }
    wakeLockRef.current = lock;
  }

  function stopTracks(): void {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }

  /**
   * Drop the current operation and release everything it holds. `publish` is false only from the
   * unmount path, where a state update would be a no-op React warns about.
   *
   * The operation identity is cleared FIRST: the `recorder.stop()` below fires the recorder's own
   * events, and those must already be looking at a stale identity when they arrive.
   */
  function teardown(publish: boolean): void {
    const operation = operationRef.current;
    operationRef.current = null;
    operation?.abort();
    clearTimers();
    releaseWakeLock();
    // The audio itself goes here, and it goes on every path — a failure keeps nothing (ADR 0029).
    chunksRef.current = [];
    bytesRef.current = 0;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopping; releasing the tracks below is what actually frees the microphone.
      }
    }
    stopTracks();
    if (publish) {
      setElapsedMs(0);
      setPhaseNow("idle");
    }
  }

  const discard = useCallback(() => teardown(true), []);

  function fail(operation: AbortController, message: string): void {
    if (!isCurrent(operation)) return;
    teardown(true);
    onErrorRef.current(message);
  }

  async function transcribe(operation: AbortController, clip: Blob): Promise<void> {
    if (!isCurrent(operation)) return;
    setPhaseNow("transcribing");
    let result: api.SttResult;
    try {
      result = await api.transcribeAudio(clip, operation.signal);
    } catch {
      // A throw here is transport only — offline, or the request's own deadline. Every refusal the
      // bridge authored comes back as a value.
      fail(operation, t("stt.error.networkFailure"));
      return;
    }
    if (!isCurrent(operation)) return;
    if (!result.ok) {
      fail(operation, sttErrorMessage(result));
      return;
    }
    const text = result.text.trim();
    teardown(true);
    if (text === "") {
      onErrorRef.current(t("stt.error.noSpeechHeard"));
      return;
    }
    onTranscriptRef.current(text);
  }

  const stopAndSend = useCallback(() => {
    const operation = operationRef.current;
    if (phaseRef.current !== "recording" || operation === null) return;
    clearTimers();
    releaseWakeLock();
    const recorder = recorderRef.current;
    if (recorder === null) {
      fail(operation, t("stt.error.recordingFailed"));
      return;
    }
    // Move out of `recording` before the browser delivers its final events, so a second tap on the
    // mic cannot start a new clip on top of the one being finalised.
    setPhaseNow("transcribing");
    try {
      recorder.stop();
    } catch {
      fail(operation, t("stt.error.recordingFailed"));
    }
  }, []);

  const start = useCallback(() => {
    if (!enabled || phaseRef.current !== "idle") return;
    const mimeType = pickRecordingMimeType();
    if (mimeType === null || !navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current(t("stt.error.unsupportedBrowser"));
      return;
    }
    const operation = new AbortController();
    operationRef.current = operation;
    setElapsedMs(0);
    setPhaseNow("requesting");
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        fail(operation, t("stt.error.micRefused"));
        return;
      }
      if (!isCurrent(operation)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: requestedRecordingBitrate(mimeType),
        });
      } catch {
        // Some browsers accept the container but reject the bitrate hint. Retry once without it; a
        // second failure is a browser that cannot record what it said it supports.
        try {
          recorder = new MediaRecorder(stream, { mimeType });
        } catch {
          fail(operation, t("stt.error.unsupportedBrowser"));
          return;
        }
      }
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      recorder.addEventListener("dataavailable", (event) => {
        if (!isCurrent(operation) || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        bytesRef.current += event.data.size;
        // Refused HERE, mid-recording, rather than after the stop: the bridge would answer 413 and
        // the operator would have spent an 8 MiB upload to be told so.
        if (bytesRef.current > MAX_STT_AUDIO_BYTES) {
          fail(operation, t("stt.error.tooLong"));
        }
      });
      recorder.addEventListener("error", () =>
        fail(operation, t("stt.error.recordingFailed")),
      );
      recorder.addEventListener("stop", () => {
        if (!isCurrent(operation)) return;
        releaseWakeLock();
        clearTimers();
        recorderRef.current = null;
        stopTracks();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        bytesRef.current = 0;
        const clip = new Blob(chunks, { type: mimeType });
        if (clip.size === 0) {
          fail(operation, t("stt.error.nothingRecorded"));
          return;
        }
        if (clip.size > MAX_STT_AUDIO_BYTES) {
          fail(operation, t("stt.error.tooLong"));
          return;
        }
        void transcribe(operation, clip);
      });
      startedAtRef.current = Date.now();
      // A timeslice, so `bytesRef` grows during the recording and the size refusal above can fire
      // before five minutes of audio exist rather than after.
      recorder.start(1000);
      setPhaseNow("recording");
      void acquireWakeLock(operation);
      tickRef.current = setInterval(() => {
        if (isCurrent(operation)) setElapsedMs(Date.now() - startedAtRef.current);
      }, 1000);
      hardStopRef.current = setTimeout(() => stopAndSend(), MAX_STT_DURATION_MS);
    })();
  }, [enabled, stopAndSend]);

  // The three effects below are LIFECYCLE handlers, not reactive computations. `discard` is stable
  // (useCallback with no dependencies), so each fires on its own condition and nothing else.

  // The pane moved, or the composer stopped accepting writes, or the feature went away. Same rule
  // the armed typing mode follows: the view this was armed against is gone, so the clip goes too.
  useEffect(() => {
    if (phaseRef.current === "idle") return;
    discard();
  }, [paneKey, suspended, enabled, discard]);

  // A hidden page discards outright, with no message: a phone suspends the recorder when it
  // backgrounds, so what would come back is a truncated clip the operator never chose to send.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden" && phaseRef.current !== "idle") discard();
    };
    const onPageHide = () => discard();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [discard]);

  // Unmount: release the microphone without publishing state into a component that is gone.
  useEffect(() => () => teardown(false), []);

  return {
    phase,
    elapsedLabel: elapsedLabel(elapsedMs),
    busy: phase !== "idle",
    start,
    stopAndSend,
    discard,
  };
}
