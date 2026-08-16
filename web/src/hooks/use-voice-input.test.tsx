import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({ transcribeAudio: vi.fn() }));

import { transcribeAudio } from "@/lib/api";
import { MAX_VOICE_BYTES, MAX_VOICE_DURATION_MS } from "@/lib/voice-policy";

import { recordingMimeType, useVoiceInput } from "./use-voice-input";

class MockMediaRecorder {
  static supported = new Set(["audio/webm;codecs=opus"]);
  static instances: MockMediaRecorder[] = [];
  static constructionOptions: MediaRecorderOptions[] = [];
  static deferStop = false;
  static failWithBitrate = false;
  static failAllConstructions = false;
  static reportedAudioBitsPerSecond = 0;
  static isTypeSupported(type: string): boolean {
    return MockMediaRecorder.supported.has(type);
  }

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;

  readonly stream: MediaStream;
  readonly options?: MediaRecorderOptions;
  readonly audioBitsPerSecond: number;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    MockMediaRecorder.constructionOptions.push(options ?? {});
    if (
      MockMediaRecorder.failAllConstructions ||
      (MockMediaRecorder.failWithBitrate && options?.audioBitsPerSecond !== undefined)
    ) {
      throw new DOMException("unsupported options", "NotSupportedError");
    }
    this.stream = stream;
    this.options = options;
    this.audioBitsPerSecond = MockMediaRecorder.reportedAudioBitsPerSecond;
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    if (!MockMediaRecorder.deferStop) this.finishStop();
  }

  finishStop(): void {
    this.ondataavailable?.({ data: new Blob(["recording"], { type: this.options?.mimeType }) } as BlobEvent);
    this.onstop?.(new Event("stop"));
  }
}

function streamWithTrack() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function VoiceHarness({ enabled = true, session }: { enabled?: boolean; session?: string }) {
  const voice = useVoiceInput({
    enabled,
    paneId: "w1:p1",
    session,
    onTranscript: (text) => {
      document.body.dataset.transcript = text;
    },
    onError: (message) => {
      document.body.dataset.error = message;
    },
  });
  return (
    <>
      <output>{voice.phase}</output>
      <button onClick={() => void voice.startRecording()}>start</button>
      <button onClick={voice.stopRecording}>stop</button>
      <button onClick={voice.cancel}>cancel</button>
    </>
  );
}

describe("useVoiceInput", () => {
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");

  beforeEach(() => {
    MockMediaRecorder.instances = [];
    MockMediaRecorder.constructionOptions = [];
    MockMediaRecorder.supported = new Set(["audio/webm;codecs=opus"]);
    MockMediaRecorder.deferStop = false;
    MockMediaRecorder.failWithBitrate = false;
    MockMediaRecorder.failAllConstructions = false;
    MockMediaRecorder.reportedAudioBitsPerSecond = 0;
    document.body.dataset.transcript = "";
    document.body.dataset.error = "";
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: MockMediaRecorder,
    });
    vi.mocked(transcribeAudio).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
    else delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
    else delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  });

  it("prefers browser-supported WebM and rejects a browser with neither accepted container", () => {
    expect(recordingMimeType()).toBe("audio/webm;codecs=opus");
    MockMediaRecorder.supported.clear();
    expect(recordingMimeType()).toBeNull();
  });

  it("retries recorder construction once without a rejected bitrate request", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    MockMediaRecorder.failWithBitrate = true;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");

    expect(MockMediaRecorder.constructionOptions).toEqual([
      { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 24_000 },
      { mimeType: "audio/webm;codecs=opus" },
    ]);
    expect(MockMediaRecorder.instances).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("uses the AAC request for an MP4 recorder", async () => {
    const user = userEvent.setup();
    const { stream } = streamWithTrack();
    MockMediaRecorder.supported = new Set(["audio/mp4"]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    expect(MockMediaRecorder.instances[0]?.options).toEqual({
      mimeType: "audio/mp4",
      audioBitsPerSecond: 64_000,
    });
  });

  it("stops at five minutes and transcribes the bounded recording once", async () => {
    vi.useFakeTimers();
    const { stream, track } = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.mocked(transcribeAudio).mockResolvedValue({ ok: true, text: "five minute clip" });
    const wakeLock = { release: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn().mockResolvedValue(wakeLock) },
    });
    render(<VoiceHarness />);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
      await Promise.resolve();
    });
    expect(screen.getByText("recording")).toBeInTheDocument();
    const recorder = MockMediaRecorder.instances[0]!;
    const stop = vi.spyOn(recorder, "stop");

    act(() => vi.advanceTimersByTime(MAX_VOICE_DURATION_MS - 1));
    expect(stop).not.toHaveBeenCalled();
    expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeAudio).mock.calls[0]?.[2]).toBe(MAX_VOICE_DURATION_MS);
    expect(document.body.dataset.transcript).toBe("five minute clip");
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("moves from finalizing to coarse processing only after the recorder finalizes", async () => {
    const user = userEvent.setup();
    const { stream } = streamWithTrack();
    MockMediaRecorder.deferStop = true;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    let resolveTranscription!: (value: { ok: true; text: string }) => void;
    vi.mocked(transcribeAudio).mockReturnValue(
      new Promise((resolve) => {
        resolveTranscription = resolve;
      }),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      render(<VoiceHarness />);
      await user.click(screen.getByRole("button", { name: "start" }));
      await screen.findByText("recording");
      now.mockReturnValue(1);

      await user.click(screen.getByRole("button", { name: "stop" }));
      expect(screen.getByText("finalizing")).toBeInTheDocument();
      expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();

      act(() => MockMediaRecorder.instances[0]!.finishStop());
      await screen.findByText("processing");
      expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(1);

      resolveTranscription({ ok: true, text: "done" });
      await screen.findByText("idle");
    } finally {
      now.mockRestore();
    }
  });

  it("rejects an onstop delayed beyond five minutes instead of submitting a clamped duration", async () => {
    vi.useFakeTimers();
    const { stream } = streamWithTrack();
    MockMediaRecorder.deferStop = true;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    render(<VoiceHarness />);

    await act(async () => {
      screen.getByRole("button", { name: "start" }).click();
      await Promise.resolve();
    });
    const recorder = MockMediaRecorder.instances[0]!;
    act(() => vi.advanceTimersByTime(MAX_VOICE_DURATION_MS - 1));
    act(() => screen.getByRole("button", { name: "stop" }).click());
    expect(screen.getByText("finalizing")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2));
    act(() => recorder.finishStop());

    expect(document.body.dataset.error).toBe("Voice recording exceeded 5 minutes");
    expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("tears down an oversized chunk without submitting it", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    const recorder = MockMediaRecorder.instances[0]!;
    act(() => {
      recorder.ondataavailable?.({
        data: new Blob([new Uint8Array(MAX_VOICE_BYTES + 1)], { type: "audio/webm" }),
      } as BlobEvent);
    });

    expect(recorder.state).toBe("inactive");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(document.body.dataset.error).toBe("Voice recording exceeded 8 MiB");
    expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("releases a late permission stream after cancellation without recording or submitting", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    let resolveStream!: (value: MediaStream) => void;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockReturnValue(
          new Promise<MediaStream>((resolve) => {
            resolveStream = resolve;
          }),
        ),
      },
    });
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    expect(screen.getByText("requesting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByText("idle")).toBeInTheDocument();

    await act(async () => {
      resolveStream(stream);
      await Promise.resolve();
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances).toHaveLength(0);
    expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
    expect(document.body.dataset.transcript).toBe("");
  });

  it("records when the browser ignores the requested bitrate and hands only editable text back", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    MockMediaRecorder.reportedAudioBitsPerSecond = 96_000;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.mocked(transcribeAudio).mockResolvedValue({ ok: true, text: "review this first" });
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    expect(MockMediaRecorder.instances[0]?.options).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 24_000,
    });

    await user.click(screen.getByRole("button", { name: "stop" }));
    await waitFor(() => expect(document.body.dataset.transcript).toBe("review this first"));
    expect(MockMediaRecorder.instances[0]?.audioBitsPerSecond).toBe(96_000);
    expect(MockMediaRecorder.constructionOptions).toHaveLength(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(1);
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("requests a screen wake lock only while recording and releases it before transcription", async () => {
    const user = userEvent.setup();
    const { stream } = streamWithTrack();
    const wakeLock = { release: vi.fn().mockResolvedValue(undefined) };
    const request = vi.fn().mockResolvedValue(wakeLock);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request },
    });
    vi.mocked(transcribeAudio).mockReturnValue(new Promise(() => {}));
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    expect(wakeLock.release).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "stop" }));
    await screen.findByText("processing");
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
  });

  it("keeps unsupported and rejected wake lock requests nonfatal", async () => {
    const user = userEvent.setup();
    const first = streamWithTrack();
    const second = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream),
      },
    });
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    const view = render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    expect(document.body.dataset.error).toBe("");
    await user.click(screen.getByRole("button", { name: "cancel" }));

    const request = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    await act(async () => {
      await Promise.resolve();
    });

    expect(request).toHaveBeenCalledWith("screen");
    expect(document.body.dataset.error).toBe("");
    expect(screen.getByText("recording")).toBeInTheDocument();
    view.unmount();
  });

  it("releases a wake lock that resolves after cancellation", async () => {
    const user = userEvent.setup();
    const { stream } = streamWithTrack();
    const wakeLock = { release: vi.fn().mockResolvedValue(undefined) };
    let resolveWakeLock!: (value: typeof wakeLock) => void;
    const request = vi.fn().mockReturnValue(
      new Promise<typeof wakeLock>((resolve) => {
        resolveWakeLock = resolve;
      }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request },
    });
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    expect(request).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "cancel" }));

    await act(async () => {
      resolveWakeLock(wakeLock);
      await Promise.resolve();
    });

    expect(wakeLock.release).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight transcription, aborts its request, and ignores a late response", async () => {
    const user = userEvent.setup();
    const { stream } = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    let resolve!: (value: { ok: true; text: string }) => void;
    vi.mocked(transcribeAudio).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    await user.click(screen.getByRole("button", { name: "stop" }));
    await screen.findByText("processing");
    const signal = vi.mocked(transcribeAudio).mock.calls[0]?.[4];
    expect(signal).toBeInstanceOf(AbortSignal);

    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(signal?.aborted).toBe(true);
    resolve({ ok: true, text: "late text" });
    await Promise.resolve();
    expect(document.body.dataset.transcript).toBe("");
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("cancels the old StrictMode session lifecycle before recording in the new one", async () => {
    const user = userEvent.setup();
    const first = streamWithTrack();
    const second = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream),
      },
    });
    let resolveOld!: (value: { ok: true; text: string }) => void;
    vi.mocked(transcribeAudio)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolveOld = done;
        }),
      )
      .mockResolvedValueOnce({ ok: true, text: "new session text" });
    const view = render(
      <StrictMode>
        <VoiceHarness session="old" />
      </StrictMode>,
    );

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    await user.click(screen.getByRole("button", { name: "stop" }));
    await screen.findByText("processing");
    const oldSignal = vi.mocked(transcribeAudio).mock.calls[0]?.[4];
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    expect(first.track.stop).toHaveBeenCalledTimes(1);

    view.rerender(
      <StrictMode>
        <VoiceHarness session="new" />
      </StrictMode>,
    );
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.getByText("idle")).toBeInTheDocument();
    resolveOld({ ok: true, text: "old session text" });
    await Promise.resolve();
    expect(document.body.dataset.transcript).toBe("");

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    await user.click(screen.getByRole("button", { name: "stop" }));
    await waitFor(() => expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(transcribeAudio).mock.calls[1]?.[0]).toBe("w1:p1");
    expect(vi.mocked(transcribeAudio).mock.calls[1]?.[3]).toBe("new");
    await waitFor(() => expect(document.body.dataset.transcript).toBe("new session text"));
  });

  it("cancels and releases microphone tracks when the page becomes hidden without uploading", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    const wakeLock = { release: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn().mockResolvedValue(wakeLock) },
    });
    const visibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      render(<VoiceHarness />);
      await user.click(screen.getByRole("button", { name: "start" }));
      await screen.findByText("recording");
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

      act(() => document.dispatchEvent(new Event("visibilitychange")));

      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(wakeLock.release).toHaveBeenCalledTimes(1);
      expect(MockMediaRecorder.instances[0]?.state).toBe("inactive");
      expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
      expect(screen.getByText("idle")).toBeInTheDocument();
    } finally {
      if (visibilityState) Object.defineProperty(document, "visibilityState", visibilityState);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("cleans up a failed transcription and reports it through the existing error callback", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.mocked(transcribeAudio).mockRejectedValue(new Error("provider unavailable"));
    render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    await user.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() => expect(document.body.dataset.error).toBe("Transcription failed — record again to retry."));
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("cancels recording and releases microphone tracks on unmount without uploading", async () => {
    const user = userEvent.setup();
    const { stream, track } = streamWithTrack();
    const wakeLock = { release: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn().mockResolvedValue(wakeLock) },
    });
    const view = render(<VoiceHarness />);

    await user.click(screen.getByRole("button", { name: "start" }));
    await screen.findByText("recording");
    view.unmount();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances[0]?.state).toBe("inactive");
    expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
  });
});
