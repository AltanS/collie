import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SttResult } from "@/lib/api";
import type { AudioMeter } from "@/lib/audio-meter";
import { FakeMediaRecorder, installFakeMediaRecorder, uninstallFakeMediaRecorder } from "@/test/media-recorder";

import { useSttRecorder } from "./use-stt-recorder";

// The recorder's contract the voice takeover leans on: the bin stays live while transcribing and
// ABORTS the request, a late answer is dropped, and the level meter is born in the tap and closed on
// every path that ends the clip.

interface TranscribeCall {
  signal: AbortSignal | undefined;
  resolve: (result: SttResult) => void;
}
const transcribe = vi.hoisted(() => ({ calls: new Array<TranscribeCall>() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  transcribeAudio: (_clip: Blob, signal?: AbortSignal) =>
    new Promise<SttResult>((resolve, reject) => {
      transcribe.calls.push({ signal, resolve });
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
}));

interface FakeMeter extends AudioMeter {
  attached: MediaStream[];
  closed: number;
}
const meters = vi.hoisted(() => ({ made: new Array<FakeMeter>(), available: true, heard: false }));
vi.mock("@/lib/audio-meter", () => ({
  createAudioMeter: (): AudioMeter | null => {
    if (!meters.available) return null;
    const meter: FakeMeter = {
      attached: [],
      closed: 0,
      read: () => 0,
      heard: () => meters.heard,
      attach(stream) {
        this.attached.push(stream);
      },
      close() {
        this.closed += 1;
      },
    };
    meters.made.push(meter);
    return meter;
  },
}));

function setup(initial: { paneKey?: string } = {}) {
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(
    (props: { paneKey: string }) =>
      useSttRecorder({ enabled: true, paneKey: props.paneKey, suspended: false, onTranscript, onError }),
    { initialProps: { paneKey: initial.paneKey ?? "a" } },
  );
  return { ...hook, onTranscript, onError };
}

/** Tap the mic, wait for the recorder the tap created. */
async function begin(result: { current: ReturnType<typeof useSttRecorder> }) {
  act(() => result.current.start());
  await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
  await waitFor(() => expect(result.current.phase).toBe("recording"));
  return FakeMediaRecorder.instances[0]!;
}

beforeEach(() => {
  installFakeMediaRecorder();
  transcribe.calls = [];
  meters.made = [];
  meters.available = true;
  meters.heard = false;
});
afterEach(() => {
  uninstallFakeMediaRecorder();
});

describe("useSttRecorder — discard while transcribing", () => {
  it("aborts the request in flight, drops the answer, and says nothing", async () => {
    const { result, onTranscript, onError } = setup();
    const recorder = await begin(result);
    act(() => recorder.finish());
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));
    expect(transcribe.calls).toHaveLength(1);
    expect(transcribe.calls[0]?.signal?.aborted).toBe(false);

    act(() => result.current.discard());

    expect(transcribe.calls[0]?.signal?.aborted).toBe(true);
    expect(result.current.phase).toBe("idle");
    // The aborted fetch rejects; that must not surface as a "network failure" message.
    await act(async () => {});
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("drops a transcript that arrives after the discard anyway", async () => {
    const { result, onTranscript, onError } = setup();
    const recorder = await begin(result);
    act(() => recorder.finish());
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));
    act(() => result.current.discard());
    await act(async () => transcribe.calls[0]?.resolve({ ok: true, text: "too late" }));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("lets the next clip start cleanly afterwards", async () => {
    const { result, onTranscript } = setup();
    const first = await begin(result);
    act(() => first.finish());
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));
    act(() => result.current.discard());
    act(() => result.current.start());
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(2));
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => FakeMediaRecorder.instances[1]?.finish());
    await waitFor(() => expect(transcribe.calls).toHaveLength(2));
    await act(async () => transcribe.calls[1]?.resolve({ ok: true, text: "second" }));
    expect(onTranscript).toHaveBeenCalledWith("second");
  });
});

describe("useSttRecorder — live means audio flows (#709)", () => {
  /** Tap the mic and wait until the recorder was told to start, with no audio delivered yet. */
  async function beginSilent(result: { current: ReturnType<typeof useSttRecorder> }) {
    FakeMediaRecorder.firstAudioOnStart = false;
    act(() => result.current.start());
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    const recorder = FakeMediaRecorder.instances[0]!;
    await waitFor(() => expect(recorder.state).toBe("recording"));
    return recorder;
  }

  it("is not recording when the recorder was told to start and no audio has arrived", async () => {
    const { result } = setup();
    await beginSilent(result);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(result.current.phase).toBe("requesting");
    expect(result.current.elapsedLabel).toBe("0:00");
  });

  it("goes live on the first frame the meter hears", async () => {
    const { result } = setup();
    await beginSilent(result);
    expect(result.current.phase).toBe("requesting");
    meters.heard = true;
    await waitFor(() => expect(result.current.phase).toBe("recording"));
  });

  it("goes live on the first chunk with bytes when there is no meter", async () => {
    meters.available = false;
    const { result } = setup();
    const recorder = await beginSilent(result);
    expect(result.current.phase).toBe("requesting");
    act(() => recorder.emit(0));
    expect(result.current.phase).toBe("requesting");
    act(() => recorder.emit(512));
    expect(result.current.phase).toBe("recording");
  });

  it("keeps the clip that was recorded once it is live", async () => {
    const { result } = setup();
    const recorder = await beginSilent(result);
    meters.heard = true;
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => recorder.finish());
    await waitFor(() => expect(transcribe.calls).toHaveLength(1));
  });

  it("cleans up when the clip is thrown away before any audio", async () => {
    const { result, onError, onTranscript } = setup();
    const recorder = await beginSilent(result);
    act(() => result.current.discard());
    expect(result.current.phase).toBe("idle");
    expect(recorder.state).toBe("inactive");
    expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1);
    expect(result.current.meter).toBeNull();
    // A late sign of audio finds a stale operation and does nothing.
    meters.heard = true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(result.current.phase).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("does not stop a clip that is not live yet", async () => {
    const { result } = setup();
    const recorder = await beginSilent(result);
    act(() => result.current.stopAndSend());
    expect(recorder.state).toBe("recording");
    expect(result.current.phase).toBe("requesting");
  });
});

describe("useSttRecorder — the level meter", () => {
  it("is made inside the tap, before the permission prompt has answered", () => {
    const { result } = setup();
    act(() => result.current.start());
    // Synchronously after start(): the meter exists and the recorder is still `requesting`.
    expect(meters.made).toHaveLength(1);
    expect(result.current.phase).toBe("requesting");
    expect(result.current.meter).toBe(meters.made[0]);
  });

  it("is attached to the SAME stream the recorder records", async () => {
    const { result } = setup();
    await begin(result);
    expect(meters.made[0]?.attached).toHaveLength(1);
  });

  it("is closed when the clip stops for transcription", async () => {
    const { result } = setup();
    const recorder = await begin(result);
    expect(meters.made[0]?.closed).toBe(0);
    act(() => recorder.finish());
    await waitFor(() => expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1));
    expect(result.current.meter).toBeNull();
  });

  it("is closed on discard while recording", async () => {
    const { result } = setup();
    await begin(result);
    act(() => result.current.discard());
    expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1);
    expect(result.current.meter).toBeNull();
  });

  it("is closed when the pane changes mid-recording", async () => {
    const { result, rerender } = setup();
    await begin(result);
    rerender({ paneKey: "b" });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1);
  });

  it("is closed when the page is hidden", async () => {
    const { result } = setup();
    await begin(result);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Reflect.deleteProperty(document, "visibilityState");
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1);
  });

  it("is closed when the composer unmounts mid-clip", async () => {
    const { result, unmount } = setup();
    await begin(result);
    unmount();
    expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1);
  });

  it("is closed when the permission is refused, and never attached", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new Error("denied")) },
    });
    const { result, onError } = setup();
    act(() => result.current.start());
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(meters.made[0]?.attached).toHaveLength(0);
    expect(meters.made[0]?.closed).toBeGreaterThanOrEqual(1);
  });

  it("is simply absent in a browser with no Web Audio, and recording still works", async () => {
    meters.available = false;
    const { result, onTranscript } = setup();
    const recorder = await begin(result);
    expect(result.current.meter).toBeNull();
    act(() => recorder.finish());
    await waitFor(() => expect(transcribe.calls).toHaveLength(1));
    await act(async () => transcribe.calls[0]?.resolve({ ok: true, text: "hello" }));
    expect(onTranscript).toHaveBeenCalledWith("hello");
  });
});
