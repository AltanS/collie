/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import type { SttResult } from "@web/lib/api";
import { t } from "@web/lib/i18n";

import { MAX_STT_AUDIO_BYTES, MAX_STT_DURATION_MS } from "../lib/stt";
import { createRecorder, elapsedLabel, type RecorderDeps } from "./recorder";

class FakeTimers {
  now = 0;
  #next = 1;
  #queue = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.#next++;
    this.#queue.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: number): void => {
    this.#queue.delete(id);
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#queue].filter(([, e]) => e.at <= target).toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#queue.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
  }
}

class FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = "inactive";
  chunkBytes = 100;
  start(): void {
    this.state = "recording";
  }
  /** What the browser does on a timeslice. */
  emit(bytes: number): void {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([new Uint8Array(bytes)]) }));
  }
  stop(): void {
    this.state = "inactive";
    queueMicrotask(() => {
      this.emit(this.chunkBytes);
      this.dispatchEvent(new Event("stop"));
    });
  }
}

interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

const fakeTrack = (): FakeTrack => ({
  stopped: false,
  stop() {
    this.stopped = true;
  },
});

/** A browser object the test fakes with only the members the recorder touches. */
const browserFake = <T>(fake: Partial<T>): T =>
  // SAFETY: each caller passes a fake that has every member the recorder reads from `T`, and the
  // recorder reads nothing else.
  fake as T;

/** A stream the recorder only asks for its tracks. */
const fakeStream = (track: FakeTrack): MediaStream =>
  browserFake<MediaStream>({ getTracks: () => [browserFake<MediaStreamTrack>(track)] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function rig(overrides: Partial<RecorderDeps> = {}) {
  const timers = new FakeTimers();
  const doc = new FakeDoc();
  const win = new EventTarget();
  const media = new FakeMediaRecorder();
  const track = fakeTrack();
  const stream = fakeStream(track);
  const transcripts: string[] = [];
  const errors: string[] = [];
  const clips: Blob[] = [];
  const controller = new AbortController();
  const deps: Partial<RecorderDeps> = {
    transcribe: async (clip: Blob): Promise<SttResult> => {
      clips.push(clip);
      return { ok: true, text: "  hello there  " };
    },
    pickMimeType: () => "audio/webm",
    canCapture: () => true,
    getUserMedia: async () => stream,
    newRecorder: () => browserFake<MediaRecorder>(media),
    wakeLock: () => undefined,
    doc,
    win,
    now: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides,
  };
  const recorder = createRecorder(
    { onTranscript: (text) => transcripts.push(text), onError: (message) => errors.push(message) },
    controller.signal,
    deps,
  );
  return { recorder, timers, doc, win, media, track, transcripts, errors, clips, controller };
}

describe("one clip, start to transcript", () => {
  test("records, ticks, stops, transcribes, trims, and releases the microphone", async () => {
    const r = rig();
    expect(r.recorder.state.get()).toEqual({ phase: "idle", elapsedMs: 0 });
    r.recorder.start();
    expect(r.recorder.state.get().phase).toBe("requesting");
    await flush();
    expect(r.recorder.state.get().phase).toBe("recording");
    r.timers.advance(3000);
    expect(r.recorder.state.get()).toEqual({ phase: "recording", elapsedMs: 3000 });
    r.recorder.stopAndSend();
    expect(r.recorder.state.get().phase).toBe("transcribing");
    await flush();
    expect(r.transcripts).toEqual(["hello there"]);
    expect(r.errors).toEqual([]);
    expect(r.clips[0]?.type).toBe("audio/webm");
    expect(r.track.stopped).toBe(true);
    expect(r.recorder.state.get()).toEqual({ phase: "idle", elapsedMs: 0 });
  });

  test("a second start while a clip is live does nothing", async () => {
    const r = rig();
    r.recorder.start();
    r.recorder.start();
    await flush();
    r.recorder.start();
    expect(r.recorder.state.get().phase).toBe("recording");
  });

  test("an empty transcript says no speech was heard and sends nothing", async () => {
    const r = rig({ transcribe: async () => ({ ok: true, text: "   " }) });
    r.recorder.start();
    await flush();
    r.recorder.stopAndSend();
    await flush();
    expect(r.transcripts).toEqual([]);
    expect(r.errors).toEqual([t("stt.error.noSpeechHeard")]);
  });

  test("a refusal is worded by sttErrorMessage and leaves nothing running", async () => {
    const r = rig({ transcribe: async () => ({ ok: false, status: 429, error: null }) });
    r.recorder.start();
    await flush();
    r.recorder.stopAndSend();
    await flush();
    expect(r.errors).toEqual([t("stt.error.busy")]);
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("a thrown transport failure is the network sentence", async () => {
    const r = rig({
      transcribe: async () => {
        throw new TypeError("offline");
      },
    });
    r.recorder.start();
    await flush();
    r.recorder.stopAndSend();
    await flush();
    expect(r.errors).toEqual([t("stt.error.networkFailure")]);
  });
});

describe("a clip dies with its view and uploads nothing", () => {
  test("discard in recording", async () => {
    const r = rig();
    r.recorder.start();
    await flush();
    r.recorder.discard();
    await flush();
    expect(r.clips).toEqual([]);
    expect(r.track.stopped).toBe(true);
    expect(r.recorder.state.get().phase).toBe("idle");
    expect(r.errors).toEqual([]);
  });

  test("a hidden page discards without a message", async () => {
    const r = rig();
    r.recorder.start();
    await flush();
    r.doc.hide();
    await flush();
    expect(r.clips).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("pagehide discards", async () => {
    const r = rig();
    r.recorder.start();
    await flush();
    r.win.dispatchEvent(new Event("pagehide"));
    expect(r.recorder.state.get().phase).toBe("idle");
    expect(r.track.stopped).toBe(true);
  });

  test("the signal aborting discards, mid-transcription too, and the late answer is ignored", async () => {
    let answer: (r: SttResult) => void = () => {};
    const r = rig({ transcribe: () => new Promise<SttResult>((resolve) => (answer = resolve)) });
    r.recorder.start();
    await flush();
    r.recorder.stopAndSend();
    await flush();
    expect(r.recorder.state.get().phase).toBe("transcribing");
    r.controller.abort();
    answer({ ok: true, text: "too late" });
    await flush();
    expect(r.transcripts).toEqual([]);
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("an aborted recorder never starts", () => {
    const r = rig();
    r.controller.abort();
    r.recorder.start();
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("the permission prompt resolving after a discard stops the stream's tracks and records nothing", async () => {
    let grant: (s: MediaStream) => void = () => {};
    const track = fakeTrack();
    const r = rig({ getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)) });
    r.recorder.start();
    r.recorder.discard();
    grant(fakeStream(track));
    await flush();
    expect(track.stopped).toBe(true);
    expect(r.recorder.state.get().phase).toBe("idle");
    expect(r.media.state).toBe("inactive");
  });
});

describe("failures and limits", () => {
  test("a refused microphone is the mic sentence", async () => {
    const r = rig({
      getUserMedia: async () => {
        throw new DOMException("no", "NotAllowedError");
      },
    });
    r.recorder.start();
    await flush();
    expect(r.errors).toEqual([t("stt.error.micRefused")]);
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("a browser with no container support says so without arming", () => {
    const r = rig({ pickMimeType: () => null });
    r.recorder.start();
    expect(r.errors).toEqual([t("stt.error.unsupportedBrowser")]);
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("nothing recorded is its own sentence", async () => {
    const r = rig();
    r.media.chunkBytes = 0;
    r.recorder.start();
    await flush();
    r.recorder.stopAndSend();
    await flush();
    expect(r.errors).toEqual([t("stt.error.nothingRecorded")]);
  });

  test("a clip past the 8 MiB cap is refused mid-recording, before any upload", async () => {
    const r = rig();
    r.recorder.start();
    await flush();
    r.media.emit(MAX_STT_AUDIO_BYTES + 1);
    expect(r.errors).toEqual([t("stt.error.tooLong")]);
    expect(r.clips).toEqual([]);
    expect(r.recorder.state.get().phase).toBe("idle");
  });

  test("the five minute hard stop sends the clip", async () => {
    const r = rig();
    r.recorder.start();
    await flush();
    r.timers.advance(MAX_STT_DURATION_MS);
    await flush();
    expect(r.transcripts).toEqual(["hello there"]);
  });

  test("the elapsed label is m:ss", () => {
    expect(elapsedLabel(0)).toBe("0:00");
    expect(elapsedLabel(65_400)).toBe("1:05");
  });
});
