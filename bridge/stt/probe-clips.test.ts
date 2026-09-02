import { describe, expect, test } from "bun:test";

import { silentMp4AacBytes, silentWebmOpusBytes } from "./probe-clips.ts";

// The clips are base64 constants, so the only thing that can rot is the base64 itself: a truncated
// or re-wrapped literal decodes to bytes no demuxer recognises. Pinning the magic catches that,
// which is all a fixture check can honestly claim.

const magic = (bytes: Uint8Array, at: number, length: number): number[] =>
  [...bytes.subarray(at, at + length)];

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

describe("stt probe clips", () => {
  test("the WebM clip decodes to an EBML header", () => {
    const bytes = silentWebmOpusBytes();
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(magic(bytes, 0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  test("the MP4 clip decodes to an ftyp box", () => {
    const bytes = silentMp4AacBytes();
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(ascii(bytes, 4, 4)).toBe("ftyp");
  });

  test("each call hands out its own buffer, so one upload cannot see another's", () => {
    const first = silentWebmOpusBytes();
    const second = silentWebmOpusBytes();
    expect(first).not.toBe(second);
    expect(first.buffer).not.toBe(second.buffer);
  });
});
