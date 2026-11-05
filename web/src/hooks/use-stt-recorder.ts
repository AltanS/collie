import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import { createAudioMeter, type AudioMeter } from "@/lib/audio-meter";
import { t } from "@/lib/i18n";
import {
  MAX_STT_AUDIO_BYTES,
  noteSttProbe,
  pickRecordingMimeType,
  recordingLimitMs,
  requestedRecordingBitrate,
  sttErrorMessage,
  transcribeOnPhone,
  type SttEngineChoice,
} from "@/lib/stt";
import { encodeWav16, toPcm16k } from "@/lib/stt-pcm";
import type { SttCapability } from "@/lib/types";

/**
 * Where one clip is in its life. `requesting` is everything from the tap until the first audio
 * arrives: the browser's permission prompt, then the phone's audio stack waking up (a host provider's
 * clip on Android can take a second or two after the recorder was told to start). `recording` is
 * audio flowing, and only that (#709). `failed` is only
 * the phone engine failing: the takeover stays open with the sentence, and the clip stays in memory
 * until the person sends it to the host or throws it away.
 */
export type SttPhase = "idle" | "requesting" | "recording" | "transcribing" | "failed";

/** One composer's microphone. Everything the button and the voice takeover need. */
export interface SttRecorder {
  phase: SttPhase;
  /** `m:ss` since the recording started — the elapsed readout on the voice takeover. */
  elapsedLabel: string;
  /** The engine this clip uses, fixed when the clip starts. */
  engine: SttEngineChoice;
  /** In the `failed` phase: why the phone could not transcribe the clip, in words. Otherwise `null`. */
  failure: string | null;
  /** True in the `failed` phase while the host has an available provider: "Send to host" may be offered. */
  canSendToHost: boolean;
  /**
   * Upload the clip the phone could not transcribe to the host, in the host's format (a 16 kHz WAV for
   * `whistle`, the original recording otherwise). One tap per clip, never automatic (ADR 0096
   * Decision 12). A no-op unless `failed` and the host can serve.
   */
  sendToHost: () => void;
  /** True for every phase but `idle`: a clip is being recorded or is in flight. */
  busy: boolean;
  /** Ask for the microphone and start. A no-op unless idle. */
  start: () => void;
  /** Stop and transcribe. A no-op unless recording. */
  stopAndSend: () => void;
  /**
   * Throw the clip away — no upload, nothing kept. Safe in any phase, and in `transcribing` it ABORTS
   * the request in flight and drops whatever it would have answered (the operation identity is
   * cleared first, so the answer finds a stale operation and is ignored).
   */
  discard: () => void;
  /**
   * The level meter on this clip's stream, for the takeover to read per frame; `null` when there is
   * no clip, no Web Audio, or the clip is over. Made inside the tap that called `start`
   * (lib/audio-meter.ts says why), closed on every path `teardown` covers.
   */
  meter: AudioMeter | null;
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
  /** Which engine the next clip uses. Read when the clip starts, so a change mid-clip does not move it. Default `host`. */
  engine?: SttEngineChoice;
  /** The host's provider, or `null` when there is none. Gives the upload format and the recording cap. */
  host?: SttCapability | null;
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
  engine = "host",
  host = null,
}: SttRecorderOptions): SttRecorder {
  const [phase, setPhase] = useState<SttPhase>("idle");
  const [clipEngine, setClipEngine] = useState<SttEngineChoice>("host");
  const [failure, setFailure] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [meter, setMeter] = useState<AudioMeter | null>(null);
  const meterRef = useRef<AudioMeter | null>(null);
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
  const audioWatchRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Latest-value refs for the two callbacks: they are re-created every render by the composer, and
  // naming them as effect dependencies would tear down the lifecycle listeners on every poll.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;
  const engineOptionRef = useRef(engine);
  const hostRef = useRef(host);
  engineOptionRef.current = engine;
  hostRef.current = host;
  // The engine the clip in flight started with, and — only in the `failed` phase — the clip itself.
  const engineRef = useRef<SttEngineChoice>("host");
  const clipRef = useRef<Blob | null>(null);
  const clipMsRef = useRef(0);

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
    if (audioWatchRef.current !== null) cancelAnimationFrame(audioWatchRef.current);
    tickRef.current = null;
    hardStopRef.current = null;
    audioWatchRef.current = null;
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

  // The meter shares the stream and the lifetime of the clip: closed wherever the tracks are.
  function closeMeter(publish: boolean): void {
    meterRef.current?.close();
    meterRef.current = null;
    if (publish) setMeter(null);
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
    // The audio itself goes here, and it goes on every path (ADR 0029). The one exception is the
    // `failed` phase, which holds the finished clip in memory so "Send to host" has something to send;
    // every way out of that phase passes through here.
    chunksRef.current = [];
    bytesRef.current = 0;
    clipRef.current = null;
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
    closeMeter(publish);
    if (publish) {
      setElapsedMs(0);
      setFailure(null);
      setPhaseNow("idle");
    }
  }

  const discard = useCallback(() => teardown(true), []);

  function fail(operation: AbortController, message: string): void {
    if (!isCurrent(operation)) return;
    teardown(true);
    onErrorRef.current(message);
  }

  /** The end of a clip that produced words: trim, hand over, or say nothing was heard. */
  function finishWith(rawText: string): void {
    const text = rawText.trim();
    teardown(true);
    if (text === "") {
      onErrorRef.current(t("stt.error.noSpeechHeard"));
      return;
    }
    onTranscriptRef.current(text);
  }

  async function transcribe(operation: AbortController, clip: Blob): Promise<void> {
    if (!isCurrent(operation)) return;
    setPhaseNow("transcribing");
    if (engineRef.current === "phone") await transcribeOnDevice(operation, clip);
    else await uploadToHost(operation, clip);
  }

  /** The phone engine: decode, transcribe in the worker, and never touch the network. */
  async function transcribeOnDevice(operation: AbortController, clip: Blob): Promise<void> {
    let pcm: Float32Array;
    try {
      pcm = await toPcm16k(clip);
    } catch {
      if (isCurrent(operation)) failOnPhone(operation, clip, t("stt.error.phone.undecodable"));
      return;
    }
    if (!isCurrent(operation)) return;
    const result = await transcribeOnPhone(pcm, operation.signal);
    if (!isCurrent(operation)) return;
    if (!result.ok) {
      failOnPhone(operation, clip, result.message);
      // After the sentence is up: noting a second crash can take the phone engine off the choices,
      // and the composer then reacts to it.
      if (result.probe !== undefined) noteSttProbe(result.probe);
      return;
    }
    finishWith(result.text);
  }

  /** Keep the takeover open with the sentence, and keep the clip for "Send to host". */
  function failOnPhone(operation: AbortController, clip: Blob, message: string): void {
    if (!isCurrent(operation)) return;
    clipRef.current = clip;
    setFailure(message);
    setPhaseNow("failed");
  }

  /** The host: the recording as the browser made it, or a 16 kHz WAV when the provider asks for one. */
  async function uploadToHost(operation: AbortController, clip: Blob): Promise<void> {
    let body = clip;
    const capability = hostRef.current;
    if (capability?.input === "wav-16k") {
      // A clip the phone engine recorded for up to five minutes may be longer than this provider takes.
      const cap = recordingLimitMs("host", capability);
      if (clipMsRef.current > cap + 1500) {
        fail(operation, t("stt.error.tooLong"));
        return;
      }
      try {
        body = encodeWav16(await toPcm16k(clip));
      } catch {
        fail(operation, t("stt.error.phone.undecodable"));
        return;
      }
      if (!isCurrent(operation)) return;
    }
    let result: api.SttResult;
    try {
      result = await api.transcribeAudio(body, operation.signal);
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
    finishWith(result.text);
  }

  const sendToHost = useCallback(() => {
    const operation = operationRef.current;
    const clip = clipRef.current;
    if (phaseRef.current !== "failed" || operation === null || clip === null) return;
    if (hostRef.current?.available !== true) return;
    // One tap, one upload: the clip leaves the `failed` slot as it goes.
    clipRef.current = null;
    engineRef.current = "host";
    setClipEngine("host");
    setFailure(null);
    setPhaseNow("transcribing");
    void uploadToHost(operation, clip);
  }, []);

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

  /**
   * The first audio arrived: the clip is `recording`. Everything that measures the clip starts here,
   * the clock, the length cap and the screen wake lock, so none of them counts the time the phone's
   * audio stack spent waking up. Called by whichever evidence comes first (see `start`); a second
   * call, or a call for a clip that is over, does nothing.
   */
  const goLive = useCallback((operation: AbortController, limitMs: number): void => {
    if (!isCurrent(operation) || phaseRef.current !== "requesting") return;
    if (audioWatchRef.current !== null) cancelAnimationFrame(audioWatchRef.current);
    audioWatchRef.current = null;
    startedAtRef.current = Date.now();
    setPhaseNow("recording");
    void acquireWakeLock(operation);
    tickRef.current = setInterval(() => {
      if (isCurrent(operation)) setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);
    hardStopRef.current = setTimeout(() => stopAndSend(), limitMs);
  }, [stopAndSend]);

  const start = useCallback(() => {
    if (!enabled || phaseRef.current !== "idle") return;
    const mimeType = pickRecordingMimeType();
    if (mimeType === null || !navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current(t("stt.error.unsupportedBrowser"));
      return;
    }
    const operation = new AbortController();
    operationRef.current = operation;
    const clipEngineNow = engineOptionRef.current;
    engineRef.current = clipEngineNow;
    setClipEngine(clipEngineNow);
    // Inside the tap, so the audio context can be resumed under the user's gesture.
    const levelMeter = createAudioMeter();
    meterRef.current = levelMeter;
    setMeter(levelMeter);
    setElapsedMs(0);
    setPhaseNow("requesting");
    void (async () => {
      let stream: MediaStream;
      try {
        // One channel: speech is mono, and a stereo stream would double the decode of a long clip.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      } catch {
        fail(operation, t("stt.error.micRefused"));
        return;
      }
      if (!isCurrent(operation)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      levelMeter?.attach(stream);
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
      const limitMs = recordingLimitMs(clipEngineNow, hostRef.current);
      recorder.addEventListener("dataavailable", (event) => {
        if (!isCurrent(operation) || event.data.size === 0) return;
        // A chunk with bytes is audio that exists: the evidence when there is no meter, or when the
        // meter hears nothing yet.
        goLive(operation, limitMs);
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
        closeMeter(true);
        const chunks = chunksRef.current;
        chunksRef.current = [];
        bytesRef.current = 0;
        clipMsRef.current = Date.now() - startedAtRef.current;
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
      // A timeslice, so `bytesRef` grows during the recording and the size refusal above can fire
      // before five minutes of audio exist rather than after.
      recorder.start(1000);
      // THE PHASE STAYS `requesting` UNTIL AUDIO FLOWS (#709). `start()` returning only means the
      // recorder was told; on Android the audio stack can take a second or two to deliver anything.
      // Two witnesses, whichever speaks first: the level meter's analyser seeing a sample (every
      // animation frame, so the lag shows as at most one frame) and the first non-empty chunk (the
      // `dataavailable` listener above, one timeslice in, for a browser with no Web Audio).
      const watch = () => {
        audioWatchRef.current = null;
        if (!isCurrent(operation) || phaseRef.current !== "requesting") return;
        if (levelMeter?.heard() === true) {
          goLive(operation, limitMs);
          return;
        }
        audioWatchRef.current = requestAnimationFrame(watch);
      };
      if (levelMeter !== null) audioWatchRef.current = requestAnimationFrame(watch);
    })();
  }, [enabled, goLive]);

  // The effects below are LIFECYCLE handlers, not reactive computations. `discard` is stable
  // (useCallback with no dependencies), so each fires on its own condition and nothing else.

  // The pane moved, or the composer stopped accepting writes. Same rule
  // the armed typing mode follows: the view this was armed against is gone, so the clip goes too.
  useEffect(() => {
    if (phaseRef.current === "idle") return;
    discard();
  }, [paneKey, suspended, discard]);

  // The feature went away. Not in the `failed` phase: a second phone crash takes the phone engine off
  // the choices, and that must not wipe the sentence that says so.
  useEffect(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "failed") return;
    discard();
  }, [enabled, discard]);

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
    engine: clipEngine,
    failure,
    canSendToHost: phase === "failed" && host?.available === true,
    sendToHost,
    busy: phase !== "idle",
    start,
    stopAndSend,
    discard,
    meter,
  };
}
