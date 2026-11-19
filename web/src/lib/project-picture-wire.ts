// THE PROJECT PICTURE ON THE WIRE (issue 811, ADR 0160). Shared by the bridge and the phone, so the two
// can never disagree about the shape of a version or the address of a picture.
//
// A pane's view carries `picture`: the version of the picture its project file names, the first 24
// hex (96 bits) of the sha256 of the bytes. The address of the picture carries that version and nothing else
// (`/api/project-picture/<version>`), so the client never names a file, a folder or a pane: the bridge
// serves only a picture it resolved itself from a `collie.toml`. A member's pane adds `?host=`, and the
// lead forwards the read to the member like a blob (CREW_PROTOCOL.md).

/** How many hex characters of the sha256 a version keeps: 96 bits, so no repository can aim at another's. */
export const PICTURE_VERSION_HEX = 24;
/** A picture's version: the first {@link PICTURE_VERSION_HEX} hex of the sha256 of its bytes. */
export const PICTURE_VERSION_RE = /^[0-9a-f]{24}$/;

/** The largest picture a project file may name. */
export const PROJECT_PICTURE_BYTES_MAX = 256 * 1024;
/** Each side of the picture, read from its header without decoding, is in this range. */
export const PROJECT_PICTURE_SIDE_MIN = 64;
export const PROJECT_PICTURE_SIDE_MAX = 1024;

/** Whether a wire value is a picture version. Anything else reads as "no picture". */
export function isPictureVersion(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && PICTURE_VERSION_RE.test(value);
}

/** The path of one picture, under `/api`, for this bridge or for a crew member by host. */
export function projectPicturePath(version: string, host?: string | null): string {
  const base = `/api/project-picture/${version}`;
  return host === undefined || host === null || host === "" ? base : `${base}?host=${encodeURIComponent(host)}`;
}

// ── The phone's own check before it decodes ─────────────────────────────────────────────────────────
//
// The phone does not hand a picture to the browser's decoder on the bridge's word alone (a crew member's
// bytes cross the lead, and a decoder is where a hostile picture does its harm). Before decoding it reads
// the type and the size from the header, with the bridge's limits: PNG, JPEG or WebP by the first bytes,
// at most {@link PROJECT_PICTURE_BYTES_MAX} bytes, each side {@link PROJECT_PICTURE_SIDE_MIN} to
// {@link PROJECT_PICTURE_SIDE_MAX} px. The same header grammar as the bridge's (bridge/hill/media.ts,
// `hillImageSize`); bridge/project-picture.test.ts holds the two to the same answers.

/** The three types a project picture may be. */
export type PictureMime = "image/png" | "image/jpeg" | "image/webp";

function at(b: Uint8Array, i: number): number {
  return b[i] ?? 0;
}

function asciiAt(b: Uint8Array, i: number, text: string): boolean {
  if (b.length < i + text.length) return false;
  for (let k = 0; k < text.length; k++) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
}

const u16be = (b: Uint8Array, i: number) => (at(b, i) << 8) | at(b, i + 1);
const u16le = (b: Uint8Array, i: number) => at(b, i) | (at(b, i + 1) << 8);
const u24le = (b: Uint8Array, i: number) => at(b, i) | (at(b, i + 1) << 8) | (at(b, i + 2) << 16);
const u32be = (b: Uint8Array, i: number) => ((at(b, i) << 24) | (at(b, i + 1) << 16) | (at(b, i + 2) << 8) | at(b, i + 3)) >>> 0;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type off the leading bytes, or null. */
export function pictureMime(b: Uint8Array): PictureMime | null {
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP")) return "image/webp";
  return null;
}

function sized(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  // Every step moves `i` forward by at least one byte, so the loop ends within the buffer.
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = at(b, i + 1);
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    // SOF0 to SOF15, without DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized(u16be(b, i + 7), u16be(b, i + 5));
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (asciiAt(b, 12, "VP8 ") && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  if (asciiAt(b, 12, "VP8L") && b.length >= 25 && b[20] === 0x2f) {
    const bits = (at(b, 21) | (at(b, 22) << 8) | (at(b, 23) << 16) | (at(b, 24) << 24)) >>> 0;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (asciiAt(b, 12, "VP8X") && b.length >= 30) return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

/** The type and the size off the header, or null when either cannot be read. */
export function pictureHeader(b: Uint8Array): { mime: PictureMime; width: number; height: number } | null {
  const mime = pictureMime(b);
  if (mime === null) return null;
  const size = mime === "image/png" ? (asciiAt(b, 12, "IHDR") && b.length >= 24 ? sized(u32be(b, 16), u32be(b, 20)) : null) : mime === "image/jpeg" ? jpegSize(b) : webpSize(b);
  return size === null ? null : { mime, ...size };
}

/**
 * Whether a PNG moves, or null when its chunks cannot be walked to the image data: an `acTL` chunk before
 * the first `IDAT` (the APNG rule). The bridge's own walk (bridge/project-picture.ts, `pngAnimated`).
 */
export function pngMoves(b: Uint8Array): boolean | null {
  let i = 8;
  while (i + 8 <= b.length) {
    const length = u32be(b, i);
    if (asciiAt(b, i + 4, "acTL")) return true;
    if (asciiAt(b, i + 4, "IDAT")) return false;
    const next = i + 12 + length;
    if (next <= i || next > b.length) return null;
    i = next;
  }
  return null;
}

/**
 * Whether a WebP moves, or null when its RIFF chunks cannot be walked: the VP8X animation flag, an `ANIM`
 * or an `ANMF` chunk. The bridge's own walk (bridge/project-picture.ts, `webpAnimated`).
 */
export function webpMoves(b: Uint8Array): boolean | null {
  if (!asciiAt(b, 0, "RIFF") || !asciiAt(b, 8, "WEBP")) return null;
  let i = 12;
  let chunks = 0;
  while (i + 8 <= b.length) {
    if (asciiAt(b, i, "ANIM") || asciiAt(b, i, "ANMF")) return true;
    if (asciiAt(b, i, "VP8X") && b.length > i + 8 && (at(b, i + 8) & 0x02) !== 0) return true;
    const size = (at(b, i + 4) | (at(b, i + 5) << 8) | (at(b, i + 6) << 16) | (at(b, i + 7) << 24)) >>> 0;
    const next = i + 8 + size + (size % 2);
    if (next <= i) return null;
    i = next;
    chunks += 1;
  }
  return chunks > 0 ? false : null;
}

/**
 * Whether bytes may go to the decoder: the size cap, a known type, both sides in range, and still (a
 * PNG or WebP that moves, or whose chunks cannot be walked, is refused, as the bridge refuses it).
 */
export function pictureHeaderFits(b: Uint8Array): boolean {
  if (b.length > PROJECT_PICTURE_BYTES_MAX) return false;
  const head = pictureHeader(b);
  const fits = (side: number) => side >= PROJECT_PICTURE_SIDE_MIN && side <= PROJECT_PICTURE_SIDE_MAX;
  if (head === null || !fits(head.width) || !fits(head.height)) return false;
  if (head.mime === "image/png") return pngMoves(b) === false;
  if (head.mime === "image/webp") return webpMoves(b) === false;
  return true;
}
