// One composer's microphone, as a plain controller (a port of web/src/hooks/use-stt-recorder.ts, ADR
// 0029). No component state: the phase and the elapsed time live in one store, and a component reads
// it with `useStore(handle, recorder.state)` so a tick wakes it through `scheduleUpdate` (REMIX3.md,
// rule 1). The recorder dies with the signal it was created on, which is the route's `handle.signal`.
//
// ONE CLIP AT A TIME, AND IT DIES WITH ITS VIEW. The microphone is armed state in the sense "Type into
// terminal" is: entered by a named tap, never persisted, never restored, and discarded, with no
// upload, the moment the thing it was armed against stops being true. The signal aborting (the pane
// was left, or the route keyed to another pane), a hidden page and `pagehide` all discard. Coming back
// gives you a microphone, never a clip.
//
// WHY DISCARD RATHER THAN FINISH THE UPLOAD. A transcript's only destination is the composer for the
// pane you were looking at. If that pane is gone, or the app was backgrounded (where a phone suspends
// the recorder mid-clip and hands back a truncated half-sentence), there is nothing honest to do with
// the words, and sending them would spend the operator's audio to produce text nobody can see.
//
// IDENTITY, NOT FLAGS. Every asynchronous continuation (the permission prompt resolving, the
// recorder's own `stop`, the transcription answering) first checks that the operation it belongs to
// is still the current one, so a cancelled clip cannot resurrect itself in a later callback.
//
// What the caller still owns (the web hook took them as options): whether to offer the mic at all
// (`sttCapability`), and the composer lock. A read-only device or the idle pause is the caller's
// `discard()`, called when that state turns true.
import { transcribeAudio, type SttResult } from "@web/lib/api";
import { t } from "@web/lib/i18n";

import {
  MAX_STT_AUDIO_BYTES,
  MAX_STT_DURATION_MS,
  pickRecordingMimeType,
  requestedRecordingBitrate,
  sttErrorMessage,
} from "../lib/stt";
import { createStore, type Store } from "../lib/store";

/** Where one clip is in its life. `requesting` is the browser's permission prompt. */
export type SttPhase = "idle" | "requesting" | "recording" | "transcribing";

export interface RecorderState {
  phase: SttPhase;
  /** Milliseconds since the recording started; ticks once a second while `recording`, else 0. */
  elapsedMs: number;
}

export interface Recorder {
  readonly state: Store<RecorderState>;
  /** Ask for the microphone and start. A no-op unless idle. */
  start(): void;
  /** Stop and transcribe. A no-op unless recording. */
  stopAndSend(): void;
  /** Throw the clip away: no upload, nothing kept. Safe in any phase. */
  discard(): void;
}

export interface RecorderOptions {
  /** A non-empty transcript, trimmed. Read at call time. */
  onTranscript: (text: string) => void;
  /** Operator-facing words for a failure. Read at call time. */
  onError: (message: string) => void;
}

/** The browser and network doors the recorder uses, so a test can stand in for all of them. */
export interface RecorderDeps {
  transcribe(clip: Blob, signal: AbortSignal): Promise<SttResult>;
  pickMimeType(): string | null;
  /** False when there is no `getUserMedia` (an insecure origin). */
  canCapture(): boolean;
  getUserMedia(): Promise<MediaStream>;
  newRecorder(stream: MediaStream, mimeType: string, bitsPerSecond: number | undefined): MediaRecorder;
  wakeLock(): { request(type: "screen"): Promise<WakeLockSentinel> } | undefined;
  doc: Pick<Document, "visibilityState" | "addEventListener">;
  win: Pick<Window, "addEventListener">;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

function browserDeps(): RecorderDeps {
  return {
    transcribe: transcribeAudio,
    pickMimeType: pickRecordingMimeType,
    canCapture: () => navigator.mediaDevices?.getUserMedia !== undefined,
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    newRecorder: (stream, mimeType, bitsPerSecond) =>
      new MediaRecorder(
        stream,
        bitsPerSecond === undefined ? { mimeType } : { mimeType, audioBitsPerSecond: bitsPerSecond },
      ),
    wakeLock: () => navigator.wakeLock,
    // Read off globalThis so a bare runtime (a unit test) can load this module and inject its own.
    doc: globalThis.document,
    win: globalThis.window,
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

/** `m:ss` for the strip's readout. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const TICK_MS = 1000;

export function createRecorder(
  opts: RecorderOptions,
  signal: AbortSignal,
  deps: Partial<RecorderDeps> = {},
): Recorder {
  const env: RecorderDeps = { ...browserDeps(), ...deps };
  const state = createStore<RecorderState>(
    { phase: "idle", elapsedMs: 0 },
    (a, b) => a.phase === b.phase && a.elapsedMs === b.elapsedMs,
  );

  let operation: AbortController | null = null;
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let bytes = 0;
  let startedAt = 0;
  let tickTimer: number | null = null;
  let hardStopTimer: number | null = null;
  let wakeLock: WakeLockSentinel | null = null;

  const phase = (): SttPhase => state.get().phase;
  const setPhase = (next: SttPhase): void => state.update((s) => ({ ...s, phase: next }));
  const isCurrent = (op: AbortController): boolean => op === operation;

  function clearTimers(): void {
    if (tickTimer !== null) env.clearTimeout(tickTimer);
    if (hardStopTimer !== null) env.clearTimeout(hardStopTimer);
    tickTimer = null;
    hardStopTimer = null;
  }

  function releaseWakeLock(): void {
    const lock = wakeLock;
    wakeLock = null;
    void lock?.release().catch(() => {});
  }

  // Screen wake lock, FOREGROUND ONLY and best-effort. A phone that sleeps mid-sentence stops the
  // recorder. Never requested while hidden: a hidden page discards anyway.
  async function acquireWakeLock(op: AbortController): Promise<void> {
    const api = env.wakeLock();
    if (api === undefined || env.doc.visibilityState !== "visible") return;
    let lock: WakeLockSentinel;
    try {
      lock = await api.request("screen");
    } catch {
      return; // a refused lock changes nothing about the recording
    }
    // The request is asynchronous, so the clip it was taken for may already be over.
    if (!isCurrent(op) || phase() !== "recording") {
      void lock.release().catch(() => {});
      return;
    }
    wakeLock = lock;
  }

  function stopTracks(): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  /**
   * Drop the current operation and release everything it holds. The operation identity is cleared
   * FIRST: `recorder.stop()` fires the recorder's own events, and those must already be looking at a
   * stale identity when they arrive. The audio goes here on every path; a failure keeps nothing.
   */
  function teardown(): void {
    const op = operation;
    operation = null;
    op?.abort();
    clearTimers();
    releaseWakeLock();
    chunks = [];
    bytes = 0;
    const live = recorder;
    recorder = null;
    if (live && live.state !== "inactive") {
      try {
        live.stop();
      } catch {
        // Already stopping; releasing the tracks below is what frees the microphone.
      }
    }
    stopTracks();
    state.set({ phase: "idle", elapsedMs: 0 });
  }

  function fail(op: AbortController, message: string): void {
    if (!isCurrent(op)) return;
    teardown();
    opts.onError(message);
  }

  async function transcribe(op: AbortController, clip: Blob): Promise<void> {
    if (!isCurrent(op)) return;
    setPhase("transcribing");
    let result: SttResult;
    try {
      result = await env.transcribe(clip, op.signal);
    } catch {
      // A throw is transport only (offline, or the request's own deadline); every refusal the bridge
      // authored comes back as a value.
      fail(op, t("stt.error.networkFailure"));
      return;
    }
    if (!isCurrent(op)) return;
    if (!result.ok) {
      fail(op, sttErrorMessage(result));
      return;
    }
    const text = result.text.trim();
    teardown();
    if (text === "") {
      opts.onError(t("stt.error.noSpeechHeard"));
      return;
    }
    opts.onTranscript(text);
  }

  function stopAndSend(): void {
    const op = operation;
    if (phase() !== "recording" || op === null) return;
    clearTimers();
    releaseWakeLock();
    if (recorder === null) {
      fail(op, t("stt.error.recordingFailed"));
      return;
    }
    // Leave `recording` before the browser delivers its final events, so a second tap on the mic
    // cannot start a new clip on top of the one being finalised.
    setPhase("transcribing");
    try {
      recorder.stop();
    } catch {
      fail(op, t("stt.error.recordingFailed"));
    }
  }

  function tick(op: AbortController): void {
    tickTimer = env.setTimeout(() => {
      if (!isCurrent(op) || phase() !== "recording") return;
      state.set({ phase: "recording", elapsedMs: env.now() - startedAt });
      tick(op);
    }, TICK_MS);
  }

  async function run(op: AbortController, mimeType: string): Promise<void> {
    let media: MediaStream;
    try {
      media = await env.getUserMedia();
    } catch {
      fail(op, t("stt.error.micRefused"));
      return;
    }
    if (!isCurrent(op)) {
      for (const track of media.getTracks()) track.stop();
      return;
    }
    stream = media;
    let live: MediaRecorder;
    try {
      live = env.newRecorder(media, mimeType, requestedRecordingBitrate(mimeType));
    } catch {
      // Some browsers accept the container but reject the bitrate hint. Retry once without it.
      try {
        live = env.newRecorder(media, mimeType, undefined);
      } catch {
        fail(op, t("stt.error.unsupportedBrowser"));
        return;
      }
    }
    recorder = live;
    chunks = [];
    bytes = 0;
    live.addEventListener("dataavailable", (event) => {
      if (!isCurrent(op) || event.data.size === 0) return;
      chunks.push(event.data);
      bytes += event.data.size;
      // Refused HERE, mid-recording: the bridge would answer 413 after an 8 MiB upload.
      if (bytes > MAX_STT_AUDIO_BYTES) fail(op, t("stt.error.tooLong"));
    });
    live.addEventListener("error", () => fail(op, t("stt.error.recordingFailed")));
    live.addEventListener("stop", () => {
      if (!isCurrent(op)) return;
      releaseWakeLock();
      clearTimers();
      recorder = null;
      stopTracks();
      const parts = chunks;
      chunks = [];
      bytes = 0;
      const clip = new Blob(parts, { type: mimeType });
      if (clip.size === 0) {
        fail(op, t("stt.error.nothingRecorded"));
        return;
      }
      if (clip.size > MAX_STT_AUDIO_BYTES) {
        fail(op, t("stt.error.tooLong"));
        return;
      }
      void transcribe(op, clip);
    });
    startedAt = env.now();
    try {
      // A timeslice, so `bytes` grows during the recording and the size refusal can fire before five
      // minutes of audio exist rather than after.
      live.start(1000);
    } catch {
      fail(op, t("stt.error.recordingFailed"));
      return;
    }
    state.set({ phase: "recording", elapsedMs: 0 });
    void acquireWakeLock(op);
    tick(op);
    hardStopTimer = env.setTimeout(stopAndSend, MAX_STT_DURATION_MS);
  }

  function start(): void {
    if (signal.aborted || phase() !== "idle") return;
    const mimeType = env.pickMimeType();
    if (mimeType === null || !env.canCapture()) {
      opts.onError(t("stt.error.unsupportedBrowser"));
      return;
    }
    const op = new AbortController();
    operation = op;
    state.set({ phase: "requesting", elapsedMs: 0 });
    void run(op, mimeType);
  }

  // A hidden page discards outright, with no message: a phone suspends the recorder when it
  // backgrounds, so what would come back is a truncated clip the operator never chose to send.
  env.doc.addEventListener(
    "visibilitychange",
    () => {
      if (env.doc.visibilityState === "hidden" && phase() !== "idle") teardown();
    },
    { signal },
  );
  env.win.addEventListener("pagehide", teardown, { signal });
  signal.addEventListener("abort", teardown, { once: true });

  return { state, start, stopAndSend, discard: teardown };
}
