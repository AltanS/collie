import { useEffect, useRef, useState } from "react";

import { transcribeAudio } from "@/lib/api";

export type AudioRecorderState = "idle" | "requesting" | "recording" | "transcribing";

interface AudioRecorderOptions {
  onTranscript(text: string): void | Promise<void>;
  onError?(message: string): void;
  transcribe?: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>;
  maxDurationMs?: number;
  /** Cancels the current job when its owning pane/session identity changes. */
  scopeKey?: string;
}

const DEFAULT_MAX_DURATION_MS = 120_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

export function preferredRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function audioRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function useAudioRecorder(options: AudioRecorderOptions) {
  const [state, setState] = useState<AudioRecorderState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(options.onTranscript);
  const onErrorRef = useRef(options.onError);
  const transcribeRef = useRef(options.transcribe ?? transcribeAudio);
  const scopeRef = useRef(options.scopeKey);
  const jobScopeRef = useRef(options.scopeKey);
  scopeRef.current = options.scopeKey;
  onTranscriptRef.current = options.onTranscript;
  onErrorRef.current = options.onError;
  transcribeRef.current = options.transcribe ?? transcribeAudio;

  function clearTimer() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function releaseStream() {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }

  function settleIdle() {
    if (mountedRef.current) setState("idle");
  }

  function cancel() {
    cancelledRef.current = true;
    clearTimer();
    abortRef.current?.abort();
    abortRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      recorderRef.current = null;
      chunksRef.current = [];
      releaseStream();
    }
    settleIdle();
  }

  function stop() {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder?.state === "recording" || recorder?.state === "paused") recorder.stop();
  }

  async function start() {
    if (!audioRecordingSupported() || state !== "idle") return;
    cancelledRef.current = false;
    jobScopeRef.current = options.scopeKey;
    setState("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      settleIdle();
      onErrorRef.current?.("Microphone access was denied");
      return;
    }
    if (!mountedRef.current || cancelledRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = preferredRecordingMimeType();
    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => void finish(recorder.mimeType || mimeType);
      recorder.onerror = () => {
        onErrorRef.current?.("Audio recording failed");
        cancel();
      };
      recorder.start();
    } catch {
      recorderRef.current = null;
      chunksRef.current = [];
      releaseStream();
      settleIdle();
      onErrorRef.current?.("Could not start audio recording");
      return;
    }
    setState("recording");
    timerRef.current = setTimeout(stop, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  }

  async function finish(mimeType: string) {
    clearTimer();
    recorderRef.current = null;
    releaseStream();
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (cancelledRef.current || !mountedRef.current) return;

    const audio = new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" });
    if (audio.size === 0) {
      onErrorRef.current?.("No audio was recorded");
      settleIdle();
      return;
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      onErrorRef.current?.("Recording is larger than 25 MB");
      settleIdle();
      return;
    }

    setState("transcribing");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const result = await transcribeRef.current(audio, abort.signal);
      if (
        !cancelledRef.current &&
        mountedRef.current &&
        jobScopeRef.current === scopeRef.current
      ) {
        await onTranscriptRef.current(result.text);
      }
    } catch (error) {
      if (!abort.signal.aborted && mountedRef.current) {
        onErrorRef.current?.(error instanceof Error ? error.message : "Transcription failed");
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      settleIdle();
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, []);

  useEffect(() => {
    if (jobScopeRef.current !== options.scopeKey) cancel();
  }, [options.scopeKey]);

  return {
    state,
    supported: audioRecordingSupported(),
    start,
    stop,
    cancel,
  };
}
