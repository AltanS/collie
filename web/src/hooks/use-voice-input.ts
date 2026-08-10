import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import * as api from "@/lib/api";

export const MAX_VOICE_DURATION_MS = 5 * 60 * 1000;
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;

export type VoicePhase = "idle" | "requesting" | "recording" | "transcribing";

/** One pane's active voice lifecycle, shared by the pane write boundary and its composer controls. */
export interface VoiceInput {
  phase: VoicePhase;
  elapsedLabel: string;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  cancel: () => void;
}

interface UseVoiceInputOptions {
  enabled: boolean;
  paneId: string;
  session?: string;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

interface VoiceScope {
  paneId: string;
  session?: string;
}

/** The only containers Collie records and the bridge accepts. */
export function recordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Native microphone lifecycle for one completed clip. Audio exists only as MediaRecorder chunks and
 * a final Blob/File until the one abortable request settles; cancellation discards both immediately.
 */
export function useVoiceInput({
  enabled,
  paneId,
  session,
  onTranscript,
  onError,
}: UseVoiceInputOptions): VoiceInput {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const phaseRef = useRef<VoicePhase>("idle");
  const operationRef = useRef<AbortController | null>(null);
  const scopeRef = useRef<VoiceScope>({ paneId, session });
  const operationScopeRef = useRef<VoiceScope | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const startedAtRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  const isCurrentOperation = (controller: AbortController, scope: VoiceScope) =>
    controller === operationRef.current && scope === scopeRef.current;

  const setVoicePhase = (next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const clearRecordingTimers = () => {
    if (elapsedTimerRef.current !== null) clearInterval(elapsedTimerRef.current);
    if (stopTimerRef.current !== null) clearTimeout(stopTimerRef.current);
    elapsedTimerRef.current = null;
    stopTimerRef.current = null;
  };

  const stopTracks = () => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  };

  /** Invalidate before aborting so synchronous recorder callbacks are stale before teardown. */
  const invalidateOperation = () => {
    const controller = operationRef.current;
    operationRef.current = null;
    operationScopeRef.current = null;
    controller?.abort();
  };

  /** Release every imperative voice resource after invalidating its operation. */
  const teardownResources = (publish: boolean) => {
    clearRecordingTimers();
    chunksRef.current = [];
    bytesRef.current = 0;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The recorder may already be stopping; tracks below still release the microphone.
      }
    }
    stopTracks();
    if (publish) {
      setElapsedMs(0);
      setVoicePhase("idle");
    }
  };

  const cancelOperation = (publish = true) => {
    invalidateOperation();
    teardownResources(publish);
  };

  const cancel = useCallback(() => {
    // A late permission prompt, recorder stop event, or provider response cannot resurrect a
    // cancelled clip or overwrite a newly typed draft after this identity is cleared.
    cancelOperation();
  }, []);

  const failOperation = (controller: AbortController, scope: VoiceScope, message: string) => {
    if (!isCurrentOperation(controller, scope)) return;
    cancelOperation();
    onErrorRef.current(message);
  };

  const transcribe = async (
    controller: AbortController,
    scope: VoiceScope,
    blob: Blob,
    mime: string,
    reportedDurationMs: number,
  ) => {
    if (!isCurrentOperation(controller, scope)) return;
    setVoicePhase("transcribing");
    const extension = mime.startsWith("audio/mp4") ? "mp4" : "webm";
    const file = new File([blob], `recording.${extension}`, { type: mime });
    try {
      const response = await api.transcribeAudio(
        scope.paneId,
        file,
        reportedDurationMs,
        scope.session,
        controller.signal,
      );
      if (!isCurrentOperation(controller, scope)) return;
      operationRef.current = null;
      operationScopeRef.current = null;
      setElapsedMs(0);
      setVoicePhase("idle");
      onTranscriptRef.current(response.text);
    } catch {
      if (!isCurrentOperation(controller, scope)) return;
      // The bridge deliberately maps provider bodies to a fixed message; network failures get the
      // same safe local wording rather than exposing any transport implementation detail.
      failOperation(controller, scope, "Transcription failed — record again to retry.");
    }
  };

  const stopRecording = useCallback(() => {
    const controller = operationRef.current;
    const scope = operationScopeRef.current;
    if (phaseRef.current !== "recording" || !controller || !scope || !isCurrentOperation(controller, scope)) return;
    clearRecordingTimers();
    const recorder = recorderRef.current;
    if (!recorder) {
      failOperation(controller, scope, "Voice recording failed");
      return;
    }
    // Switch UI immediately so no draft/edit action can race the completed recording while the
    // browser delivers its final dataavailable/stop events.
    setVoicePhase("transcribing");
    try {
      recorder.stop();
    } catch {
      failOperation(controller, scope, "Voice recording failed");
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!enabled || phaseRef.current !== "idle") return;
    const mime = recordingMimeType();
    if (!mime) {
      onErrorRef.current("This browser cannot record WebM or MP4 audio");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current("Microphone access is unavailable");
      return;
    }

    const scope = scopeRef.current;
    const controller = new AbortController();
    operationRef.current = controller;
    operationScopeRef.current = scope;
    setElapsedMs(0);
    setVoicePhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrentOperation(controller, scope)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      recorder.ondataavailable = (event) => {
        if (!isCurrentOperation(controller, scope) || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        bytesRef.current += event.data.size;
        if (bytesRef.current > MAX_VOICE_BYTES) {
          failOperation(controller, scope, "Voice recording exceeded 8 MiB");
        }
      };
      recorder.onerror = () => failOperation(controller, scope, "Voice recording failed");
      recorder.onstop = () => {
        if (!isCurrentOperation(controller, scope)) return;
        recorderRef.current = null;
        clearRecordingTimers();
        stopTracks();
        const reportedDurationMs = Math.min(Date.now() - startedAtRef.current, MAX_VOICE_DURATION_MS);
        const chunks = chunksRef.current;
        chunksRef.current = [];
        bytesRef.current = 0;
        if (reportedDurationMs < 1 || chunks.length === 0) {
          failOperation(controller, scope, "Voice recording was empty");
          return;
        }
        const blob = new Blob(chunks, { type: mime });
        if (blob.size > MAX_VOICE_BYTES) {
          failOperation(controller, scope, "Voice recording exceeded 8 MiB");
          return;
        }
        void transcribe(controller, scope, blob, mime, reportedDurationMs);
      };
      startedAtRef.current = Date.now();
      recorder.start(1000);
      setVoicePhase("recording");
      elapsedTimerRef.current = setInterval(() => {
        if (isCurrentOperation(controller, scope)) {
          setElapsedMs(Math.min(Date.now() - startedAtRef.current, MAX_VOICE_DURATION_MS));
        }
      }, 1000);
      stopTimerRef.current = setTimeout(() => stopRecording(), MAX_VOICE_DURATION_MS);
    } catch {
      failOperation(controller, scope, "Microphone access was unavailable");
    }
  }, [enabled, stopRecording]);

  // Publish the committed scope before passive effects run, then release an outgoing operation.
  // This makes old callbacks stale synchronously when a caller changes pane/session props in place.
  useLayoutEffect(() => {
    const previousScope = scopeRef.current;
    scopeRef.current = { paneId, session };
    if (operationScopeRef.current === previousScope && operationRef.current !== null) cancel();
  }, [paneId, session, cancel]);

  useEffect(() => {
    if (!enabled && phaseRef.current !== "idle") cancel();
  }, [enabled, cancel]);

  useEffect(() => {
    const onPageHide = () => cancel();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelOperation(false);
    };
  }, [cancel]);

  return {
    phase,
    elapsedLabel: elapsedLabel(elapsedMs),
    startRecording,
    stopRecording,
    cancel,
  };
}
