// ── THE TWO CONTAINERS A PHONE ACTUALLY RECORDS ──────────────────────────────────────────────
//
// `silentWavBytes` (bridge/stt/codex.ts) is built byte by byte, because a PCM WAV header is short
// enough to read in review. Opus-in-WebM and AAC-in-MP4 are not: both need a real encoder, so both
// are shipped here as base64 of a file an encoder produced. They exist for one reason — the browser
// never sends WAV. `web/src/lib/stt.ts` records `audio/webm;codecs=opus` on Chrome, Android and
// Firefox and `audio/mp4` on Safari, and a provider that demuxes WAV can still refuse either
// (#148). `collie stt test` sends all three so that refusal is found at setup time.
//
// REGENERATE with ffmpeg, from anywhere, then base64 the result into the constants below:
//
//   ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=mono -t 0.2 -c:a libopus -b:a 24k probe.webm
//   ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=mono -t 0.2 -c:a aac -b:a 64k -movflags +faststart probe.m4a
//
// Both are 0.2 s of digital silence, one mono channel at 48 kHz. Decoded sizes: 641 bytes for the
// WebM, 949 bytes for the MP4. Keep them small — they are compiled into the binary, and a probe is
// not a sample. The base64 is split across lines and joined with `+`, so no runtime strips
// whitespace for us.

/** 0.2 s of silence, Opus in a WebM container. What Chrome, Android and Firefox record. */
const WEBM_OPUS_BASE64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAJREU2bdLpNu4tTq4QVSalmU6yBoU27i1Or" +
  "hBZUrmtTrIHYTbuMU6uEElTDZ1OsggFCTbuMU6uEHFO7a1OsggI77AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirX" +
  "sYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiEBqAAAAAAAAFlSua+WuAQAAAAAAAFzXgQFzxYi/ov2F" +
  "gs1p/5yBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQOdwAAAAAABiZIEQY6KTT3B1c0hlYWQB" +
  "ATgBgLsAAAAAABJUw2f9c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2Mi4xMi4xMDJzc9djwItjxYi/ov2Fgs1p/2fIokWj" +
  "h0VOQ09ERVJEh5VMYXZjNjIuMjguMTAyIGxpYm9wdXNnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjIwODAwMDAwMAAfQ7Z1" +
  "8ueBAKOHgQAAgPj//qOHgQAVgPj//qOHgQApgPj//qOHgQA9gPj//qOHgQBRgPj//qOHgQBlgPj//qOHgQB5gPj//qOHgQCN" +
  "gPj//qOHgQChgPj//qOHgQC1gPj//qCToYeBAMkA+P/+m4EHdaKEAM3+YBxTu2uRu4+zgQC3iveBAfGCAcTwgQM=";

/** 0.2 s of silence, AAC in an MP4 container. What Safari and iOS record. */
const MP4_AAC_BASE64 =
  "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAA0xtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAyAABAAABAAAA" +
  "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC" +
  "AAACUXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAyAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAA" +
  "AAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAMgAAAQAAAEAAAAAAcltZGlh" +
  "AAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAApgFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFu" +
  "ZGxlcgAAAAF0bWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAE4c3Ri" +
  "bAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQAB" +
  "AASAgIAXQBUAAAAAAPoAAAAInAWAgIAFEYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAACgAABAAAAAABAAABgAAAABxz" +
  "dHNjAAAAAAAAAAEAAAABAAAACwAAAAEAAABAc3RzegAAAAAAAAAAAAAACwAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQA" +
  "AAAEAAAABAAAAAQAAAAEAAAAFHN0Y28AAAAAAAAAAQAAA3gAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAA" +
  "AHJvbGwAAAABAAAACwAAAAEAAACHdWR0YQAAAH9tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAA" +
  "AFJpbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMgAAACWpZW5jAAAAHWRhdGEAAAABAAAAAExhdmY2" +
  "Mi4xMi4xMDIAAAAIZnJlZQAAAEVtZGF03gIATGF2YzYyLjI4LjEwMgACMEAOARggBwEYIAcBGCAHARggBwEYIAcBGCAHARgg" +
  "BwEYIAcBGCAHARggBw==";

/**
 * The WebM/Opus probe clip. A fresh array each call: the caller wraps it in a `File` and hands it to
 * a provider, and a shared buffer would be one transcription able to observe another's.
 */
export function silentWebmOpusBytes(): Uint8Array<ArrayBuffer> {
  return decodeBase64(WEBM_OPUS_BASE64);
}

/** The MP4/AAC probe clip, on the same terms as {@link silentWebmOpusBytes}. */
export function silentMp4AacBytes(): Uint8Array<ArrayBuffer> {
  return decodeBase64(MP4_AAC_BASE64);
}

/** base64 → bytes, through the platform decoder. The input is a constant in this file, not a payload. */
function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
