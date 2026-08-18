import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { preferredRecordingMimeType, useAudioRecorder } from "./use-audio-recorder";

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus");
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  state: RecordingState = "inactive";
  readonly stream: MediaStream;
  readonly mimeType: string;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

describe("useAudioRecorder", () => {
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;

  beforeEach(() => {
    stopTrack.mockClear();
    FakeMediaRecorder.isTypeSupported.mockReset();
    FakeMediaRecorder.isTypeSupported.mockImplementation(
      (type) => type === "audio/webm;codecs=opus",
    );
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
  });

  test("prefers opus webm and falls back to mp4", () => {
    expect(preferredRecordingMimeType()).toBe("audio/webm;codecs=opus");
    FakeMediaRecorder.isTypeSupported.mockImplementation((type) => type === "audio/mp4");
    expect(preferredRecordingMimeType()).toBe("audio/mp4");
  });

  test("transcribes once after stop and releases the microphone", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const transcribe = vi.fn(async (_audio: Blob, _signal?: AbortSignal) => ({
      text: "hello from speech",
    }));
    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript, onError, transcribe }),
    );

    await act(() => result.current.start());
    expect(result.current.state).toBe("recording");
    act(() => result.current.stop());

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("hello from speech"));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0].type).toBe("audio/webm;codecs=opus");
    expect(onError).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  test("cancels recording on unmount without transcribing", async () => {
    const transcribe = vi.fn(async () => ({ text: "should not land" }));
    const { result, unmount } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), transcribe }),
    );

    await act(() => result.current.start());
    unmount();

    expect(stopTrack).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("drops an in-flight result when the owning pane changes", async () => {
    let resolveTranscription!: (result: { text: string }) => void;
    const transcribe = vi.fn(
      () => new Promise<{ text: string }>((resolve) => (resolveTranscription = resolve)),
    );
    const onTranscript = vi.fn();
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useAudioRecorder({ scopeKey, onTranscript, transcribe }),
      { initialProps: { scopeKey: "pane-a" } },
    );

    await act(() => result.current.start());
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe("transcribing"));
    rerender({ scopeKey: "pane-b" });
    resolveTranscription({ text: "belongs to pane A" });

    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  test("releases the microphone when MediaRecorder startup throws", async () => {
    class ThrowingMediaRecorder extends FakeMediaRecorder {
      start() {
        throw new Error("codec failed");
      }
    }
    vi.stubGlobal("MediaRecorder", ThrowingMediaRecorder);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await act(() => result.current.start());

    expect(result.current.state).toBe("idle");
    expect(stopTrack).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Could not start audio recording");
  });
});
