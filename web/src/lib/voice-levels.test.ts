import { describe, expect, it } from "vitest";

import { BAR_DECAY, BAR_HIGH_HZ, BAR_LOW_HZ, decayBars, fillBars, hasSignal, rmsOfBytes } from "./voice-levels";

describe("rmsOfBytes", () => {
  it("is 0 for silence (all 128) and for an empty read", () => {
    expect(rmsOfBytes(new Uint8Array(512).fill(128))).toBe(0);
    expect(rmsOfBytes(new Uint8Array(0))).toBe(0);
  });

  it("is 1 for a full-scale square wave", () => {
    const wave = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0 : 255));
    expect(rmsOfBytes(wave)).toBeGreaterThan(0.99);
  });

  it("is amplitude over root two for a sine", () => {
    const sine = Uint8Array.from({ length: 4096 }, (_, i) => Math.round(128 + 64 * Math.sin((i / 64) * 2 * Math.PI)));
    expect(rmsOfBytes(sine)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});

describe("hasSignal", () => {
  it("is false for digital silence and for an empty read", () => {
    expect(hasSignal(new Float32Array(512))).toBe(false);
    expect(hasSignal(new Float32Array(0))).toBe(false);
  });

  it("is true for any sample, however quiet, so a still room still counts as audio", () => {
    const hiss = new Float32Array(512);
    hiss[300] = 0.0004;
    expect(hasSignal(hiss)).toBe(true);
    hiss[300] = -0.0004;
    expect(hasSignal(hiss)).toBe(true);
  });
});

describe("fillBars", () => {
  const SAMPLE_RATE = 48_000;
  const BINS = 512;
  const hzPerBin = SAMPLE_RATE / 2 / BINS;

  it("leaves a quiet spectrum at zero", () => {
    const bars = new Float32Array(36);
    fillBars(new Uint8Array(BINS).fill(20), bars, SAMPLE_RATE);
    expect([...bars].every((v) => v === 0)).toBe(true);
  });

  it("raises the bar that covers a tone, and only the bars near it", () => {
    const spectrum = new Uint8Array(BINS);
    spectrum[Math.round(1000 / hzPerBin)] = 255;
    const bars = new Float32Array(36);
    fillBars(spectrum, bars, SAMPLE_RATE);
    const hot = bars.indexOf(Math.max(...bars));
    // 1 kHz sits at log(10)/log(50) = 59% of the way from 100 Hz to 5 kHz.
    const expected = Math.floor((Math.log(1000 / BAR_LOW_HZ) / Math.log(BAR_HIGH_HZ / BAR_LOW_HZ)) * 36);
    expect(Math.abs(hot - expected)).toBeLessThanOrEqual(1);
    expect(bars[hot]).toBe(1);
    expect(bars[0]).toBe(0);
    expect(bars[35]).toBe(0);
  });

  it("falls by the decay on the next read instead of dropping at once", () => {
    const bars = new Float32Array(8).fill(1);
    fillBars(new Uint8Array(BINS), bars, SAMPLE_RATE);
    expect(bars[0]).toBeCloseTo(BAR_DECAY, 6);
    decayBars(bars);
    expect(bars[0]).toBeCloseTo(BAR_DECAY * BAR_DECAY, 6);
  });

  it("does nothing for an empty spectrum or a zero sample rate", () => {
    const bars = new Float32Array(4).fill(0.5);
    fillBars(new Uint8Array(0), bars, SAMPLE_RATE);
    fillBars(new Uint8Array(BINS), bars, 0);
    expect([...bars]).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});
