// Turning an analyser's bytes into numbers the voice takeover can draw. Pure: typed arrays in,
// numbers out, no AudioContext, so the maths is testable without a microphone.

/** The lowest and highest pitch the bars cover: a voice lives here, hum and hiss do not. */
export const BAR_LOW_HZ = 100;
export const BAR_HIGH_HZ = 5000;

/** Where a bar starts to rise, as a fraction of full scale: the analyser's own noise under a quiet room draws nothing. */
const BAR_NOISE_FLOOR = 0.2;

/** How much of a bar's last height survives one read; the fall is slower than the rise so the bars read as a voice, not a flicker. */
export const BAR_DECAY = 0.8;

/** The shortest a bar is drawn, as a scale of its slot: a bar at rest is a dot, not nothing. */
export const BAR_REST = 0.08;

/**
 * Loudness of one time-domain read, 0 to 1. The analyser's byte format centres silence at 128, so
 * the RMS of the distance from 128 over 128 is the share of full scale.
 */
export function rmsOfBytes(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const byte of samples) {
    const centred = (byte - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Whether a time-domain read holds any audio at all: some sample that is not exactly zero. An
 * analyser fed by a stream that has delivered nothing reads all zeros; a live microphone, even in a
 * silent room, never does. It is the "first audio" test (#709), so it asks for presence, not loudness.
 */
export function hasSignal(samples: Float32Array): boolean {
  for (const sample of samples) {
    if (sample !== 0) return true;
  }
  return false;
}

/**
 * Fill `bars` (0 to 1 each) from one frequency read. The bars are log-spaced between
 * {@link BAR_LOW_HZ} and {@link BAR_HIGH_HZ}, because pitch is heard in ratios: a linear split puts
 * every bar of a voice in the first two. A bar takes the loudest bin it covers, rises at once and
 * falls by {@link BAR_DECAY} per read. `bars` is both the previous frame and the output, so one
 * array lives for the whole clip.
 */
export function fillBars(spectrum: Uint8Array, bars: Float32Array, sampleRate: number): void {
  const count = bars.length;
  const bins = spectrum.length;
  if (count === 0 || bins === 0 || sampleRate <= 0) return;
  const hzPerBin = sampleRate / 2 / bins;
  const ratio = BAR_HIGH_HZ / BAR_LOW_HZ;
  for (let i = 0; i < count; i += 1) {
    const from = BAR_LOW_HZ * ratio ** (i / count);
    const to = BAR_LOW_HZ * ratio ** ((i + 1) / count);
    const first = Math.min(bins - 1, Math.floor(from / hzPerBin));
    const last = Math.min(bins - 1, Math.max(first, Math.ceil(to / hzPerBin) - 1));
    let peak = 0;
    for (let bin = first; bin <= last; bin += 1) peak = Math.max(peak, spectrum[bin] ?? 0);
    const level = Math.min(1, Math.max(0, (peak / 255 - BAR_NOISE_FLOOR) / (1 - BAR_NOISE_FLOOR)));
    bars[i] = Math.max(level, (bars[i] ?? 0) * BAR_DECAY);
  }
}

/** Let every bar fall by one read's decay, for a read that found no signal. */
export function decayBars(bars: Float32Array): void {
  for (let i = 0; i < bars.length; i += 1) bars[i] = (bars[i] ?? 0) * BAR_DECAY;
}
