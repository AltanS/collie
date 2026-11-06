// A level meter on the stream the recorder already opened (voice takeover).
//
// ONE MICROPHONE, TWO READERS. `getUserMedia` is asked once, by hooks/use-stt-recorder.ts, and that
// stream feeds the MediaRecorder. This taps the SAME stream with an AnalyserNode, so there is no
// second permission prompt and no second capture. The analyser is never connected to the
// destination: nothing is played back, so there is no feedback to hear.
//
// THE CONTEXT IS MADE IN THE TAP, THE STREAM ARRIVES LATER. Safari and every iOS browser start an
// AudioContext suspended and resume it only from inside a user gesture. The stream arrives after an
// awaited permission prompt, by which time the gesture is spent. So `createAudioMeter` runs
// synchronously in the click handler (the recorder's `start`), creates and resumes the context
// there, and `attach` connects the stream when it exists.
//
// EVERY EXIT CLOSES IT. The recorder's teardown calls `close`, which is what stop, discard, an
// error, a pane switch, a hidden page and an unmount all pass through. A context left open keeps the
// phone's audio session claimed.

import { decayBars, fillBars, hasSignal, rmsOfBytes } from "@/lib/voice-levels";

/** What the takeover reads, per animation frame. Also what the states playground fakes. */
export interface LevelSource {
  /** Fill `bars` (0 to 1) and return the loudness (RMS, 0 to 1) of the latest audio. */
  read: (bars: Float32Array) => number;
}

export interface AudioMeter extends LevelSource {
  /** Connect the recorder's stream. Idempotent per meter; a no-op once closed. */
  attach: (stream: MediaStream) => void;
  /**
   * True once the analyser has seen a sample that is not digital silence: the first proof that audio
   * flows from the microphone, which `MediaRecorder.start()` returning is not (#709). False before
   * `attach`, after `close`, and while the audio stack has delivered nothing.
   */
  heard: () => boolean;
  /** Disconnect and close the context. Safe to call twice. */
  close: () => void;
}

declare global {
  interface Window {
    /** Safari's legacy name for the same constructor; lib.dom does not declare it. */
    webkitAudioContext?: typeof AudioContext;
  }
}

/** Window.AudioContext, or Safari's older prefixed name. */
function audioContextClass(): typeof AudioContext | null {
  return window.AudioContext ?? window.webkitAudioContext ?? null;
}

const FFT_SIZE = 1024;

/**
 * Make the meter. Call it from the click that starts the clip. Returns `null` when the browser has
 * no Web Audio or refuses a context: the takeover then draws resting bars and never auto-finishes,
 * and recording is unaffected.
 */
export function createAudioMeter(): AudioMeter | null {
  const Context = audioContextClass();
  if (Context === null) return null;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return null;
  }
  // Resumed inside the gesture. A rejection changes nothing but the bars, so it is swallowed.
  void context.resume().catch(() => {});
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.4;
  const timeBytes = new Uint8Array(analyser.fftSize);
  const freqBytes = new Uint8Array(analyser.frequencyBinCount);
  // Floats, not the bytes `read` uses: a byte rounds a quiet room's hiss to the silence value.
  const floats = new Float32Array(analyser.fftSize);
  let source: MediaStreamAudioSourceNode | null = null;
  let closed = false;

  return {
    attach(stream) {
      if (closed || source !== null) return;
      try {
        source = context.createMediaStreamSource(stream);
        source.connect(analyser);
      } catch {
        source = null;
      }
    },
    read(bars) {
      if (closed || source === null) {
        decayBars(bars);
        return 0;
      }
      analyser.getByteTimeDomainData(timeBytes);
      analyser.getByteFrequencyData(freqBytes);
      fillBars(freqBytes, bars, context.sampleRate);
      return rmsOfBytes(timeBytes);
    },
    heard() {
      if (closed || source === null) return false;
      analyser.getFloatTimeDomainData(floats);
      return hasSignal(floats);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        source?.disconnect();
      } catch {
        // Already disconnected; closing the context below is what releases the audio session.
      }
      source = null;
      void context.close().catch(() => {});
    },
  };
}
