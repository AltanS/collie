import { describe, expect, it } from "vitest";

import {
  PICTURE_VERSION_HEX,
  PROJECT_PICTURE_BYTES_MAX,
  isPictureVersion,
  pictureHeader,
  pictureHeaderFits,
  pictureMime,
  projectPicturePath,
} from "./project-picture-wire";

// THE PROJECT PICTURE'S WIRE RULES (issue 811, ADR 0160): the phone's own header check, before any decode.
// bridge/project-picture.test.ts holds the bridge's copy of this grammar to the same answers.

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A still PNG: the IHDR chunk, then an empty IDAT chunk (the animation walk stops there). */
function png(width: number, height: number, length = 45): Uint8Array {
  const out = new Uint8Array(Math.max(length, 0));
  out.set([...SIG, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52].slice(0, out.length));
  if (out.length >= 24) {
    const view = new DataView(out.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
  }
  if (out.length >= 45) out.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 33);
  return out;
}

/** A PNG with an `acTL` chunk before its IDAT: an APNG, which moves. */
function apng(width: number, height: number): Uint8Array {
  const out = png(width, height, 65);
  out.set([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c], 33);
  out.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 53);
  return out;
}

/** A JPEG: SOI, then the given marker segment (default SOF0) carrying the sides. */
function jpeg(width: number, height: number, marker = 0xc0): Uint8Array {
  const out = new Uint8Array(30);
  out.set([0xff, 0xd8, 0xff, marker, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]);
  return out;
}

/** A JPEG whose first segment is an APP0 of 16 bytes, then SOF0: the header is not at a fixed offset. */
function jpegAfterApp(width: number, height: number): Uint8Array {
  const out = new Uint8Array(40);
  out.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  out.set([0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3], 20);
  return out;
}

const riff = (fourcc: string): Uint8Array => {
  const out = new Uint8Array(40);
  out.set([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WEBP" + fourcc, (c) => c.charCodeAt(0))]);
  return out;
};

function webpX(width: number, height: number): Uint8Array {
  const out = riff("VP8X");
  const w = width - 1;
  const h = height - 1;
  out.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return out;
}

function webpLossy(width: number, height: number): Uint8Array {
  const out = riff("VP8 ");
  out.set([0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8], 23);
  return out;
}

function webpLossless(width: number, height: number): Uint8Array {
  const out = riff("VP8L");
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  out.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 20);
  return out;
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("isPictureVersion and projectPicturePath", () => {
  it("keeps exactly 24 lowercase hex", () => {
    expect(PICTURE_VERSION_HEX).toBe(24);
    expect(isPictureVersion("0123456789abcdef01234567")).toBe(true);
    expect(isPictureVersion("0123456789ab")).toBe(false);
    expect(isPictureVersion("0123456789abcdef012345678")).toBe(false);
    expect(isPictureVersion("0123456789ABCDEF01234567")).toBe(false);
    expect(isPictureVersion(null)).toBe(false);
    expect(isPictureVersion(undefined)).toBe(false);
  });

  it("names the machine of a member's picture and leaves the lead's bare", () => {
    const v = "0123456789abcdef01234567";
    expect(projectPicturePath(v)).toBe(`/api/project-picture/${v}`);
    expect(projectPicturePath(v, null)).toBe(`/api/project-picture/${v}`);
    expect(projectPicturePath(v, "")).toBe(`/api/project-picture/${v}`);
    expect(projectPicturePath(v, "box 2")).toBe(`/api/project-picture/${v}?host=box%202`);
  });
});

describe("pictureMime", () => {
  it.each([
    ["a PNG signature", Uint8Array.from(SIG), "image/png"],
    ["a JPEG start", bytes(0xff, 0xd8, 0xff), "image/jpeg"],
    ["a RIFF WebP", riff("VP8X"), "image/webp"],
    ["a GIF", bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0), null],
    ["a RIFF that is not WebP", Uint8Array.from([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WAVE", (c) => c.charCodeAt(0))]), null],
    ["a truncated PNG signature", Uint8Array.from(SIG.slice(0, 7)), null],
    ["a truncated JPEG start", bytes(0xff, 0xd8), null],
    ["an SVG", Uint8Array.from(Array.from("<svg xmlns", (c) => c.charCodeAt(0))), null],
    ["nothing", new Uint8Array(0), null],
  ])("reads %s as %s", (_name, input, expected) => {
    expect(pictureMime(input)).toBe(expected);
  });
});

describe("pictureHeader", () => {
  it.each([
    ["a PNG", png(256, 128), { mime: "image/png", width: 256, height: 128 }],
    ["a PNG with a side out of range (the size is still read)", png(8, 5000), { mime: "image/png", width: 8, height: 5000 }],
    ["a JPEG (SOF0)", jpeg(300, 200), { mime: "image/jpeg", width: 300, height: 200 }],
    ["a progressive JPEG (SOF2)", jpeg(640, 480, 0xc2), { mime: "image/jpeg", width: 640, height: 480 }],
    ["a JPEG whose frame header follows an APP0 segment", jpegAfterApp(120, 90), { mime: "image/jpeg", width: 120, height: 90 }],
    ["a WebP (VP8X)", webpX(512, 128), { mime: "image/webp", width: 512, height: 128 }],
    ["a lossy WebP (VP8 )", webpLossy(200, 100), { mime: "image/webp", width: 200, height: 100 }],
    ["a lossless WebP (VP8L)", webpLossless(300, 150), { mime: "image/webp", width: 300, height: 150 }],
  ])("reads the type and the size of %s", (_name, input, expected) => {
    expect(pictureHeader(input)).toEqual(expected);
  });

  it.each([
    ["a PNG cut before its sides", png(256, 256, 20)],
    ["a PNG whose first chunk is not IHDR", Uint8Array.from([...png(256, 256)].map((v, i) => (i === 12 ? 0x58 : v)))],
    ["a PNG with a zero side", png(0, 256)],
    ["a JPEG with no frame header", bytes(0xff, 0xd8, 0xff, 0xda, 0, 8, 0, 0, 0, 0, 0, 0)],
    ["a JPEG whose DHT marker is no frame header", jpeg(300, 200, 0xc4)],
    ["a JPEG with a segment of length 1", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 1, 0, 0, 0, 0, 0, 0)],
    ["a WebP cut before its sides", riff("VP8X").subarray(0, 28)],
    ["a WebP of an unknown kind", riff("ABCD")],
    ["a GIF", bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0)],
    ["nothing", new Uint8Array(0)],
  ])("reads %s as null", (_name, input) => {
    expect(pictureHeader(input)).toBeNull();
  });
});

describe("pictureHeaderFits", () => {
  it.each([
    ["a PNG", png(256, 256)],
    ["a PNG at the smallest sides", png(64, 64)],
    ["a PNG at the largest sides", png(1024, 1024)],
    ["a wide PNG", png(1024, 64)],
    ["a JPEG (SOF0)", jpeg(300, 200)],
    ["a WebP (VP8X)", webpX(512, 128)],
    ["a lossless WebP", webpLossless(300, 150)],
  ])("lets %s through", (_name, input) => {
    expect(pictureHeaderFits(input)).toBe(true);
  });

  it.each([
    ["a PNG 63 px wide", png(63, 256)],
    ["a PNG 63 px tall", png(256, 63)],
    ["a PNG 1025 px wide", png(1025, 256)],
    ["a PNG 1025 px tall", png(256, 1025)],
    ["a PNG with a zero side", png(0, 0)],
    ["a JPEG 1025 px wide", jpeg(1025, 200)],
    ["a WebP 63 px tall", webpX(512, 63)],
    ["a truncated PNG header", png(256, 256, 20)],
    ["a GIF", bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...Array.from({ length: 30 }, () => 0))],
    ["an SVG", Uint8Array.from(Array.from('<svg width="100" height="100"></svg>', (c) => c.charCodeAt(0)))],
    ["nothing", new Uint8Array(0)],
  ])("refuses %s", (_name, input) => {
    expect(pictureHeaderFits(input)).toBe(false);
  });

  it("refuses a valid picture over the size cap, and accepts one exactly at it", () => {
    expect(PROJECT_PICTURE_BYTES_MAX).toBe(256 * 1024);
    expect(pictureHeaderFits(png(256, 256, PROJECT_PICTURE_BYTES_MAX))).toBe(true);
    expect(pictureHeaderFits(png(256, 256, PROJECT_PICTURE_BYTES_MAX + 1))).toBe(false);
  });
});

describe("pictureHeaderFits refuses a picture that moves (R7)", () => {
  it("refuses an APNG", () => {
    expect(pictureHeaderFits(png(256, 256))).toBe(true);
    expect(pictureHeaderFits(apng(256, 256))).toBe(false);
  });

  it("refuses a PNG whose chunks cannot be walked to its image data", () => {
    expect(pictureHeaderFits(png(256, 256, 33))).toBe(false);
  });

  it("refuses a WebP with the animation flag, an ANIM or an ANMF chunk", () => {
    expect(pictureHeaderFits(webpX(256, 256))).toBe(true);
    const flagged = webpX(256, 256);
    flagged[20] = 0x02;
    expect(pictureHeaderFits(flagged)).toBe(false);
    for (const fourcc of ["ANIM", "ANMF"]) {
      const out = new Uint8Array(48);
      out.set(webpX(256, 256));
      // The VP8X chunk is 10 bytes long, so the next chunk starts at 30.
      out.set([10, 0, 0, 0], 16);
      out.set(Array.from(fourcc, (c) => c.charCodeAt(0)), 30);
      expect(pictureHeaderFits(out)).toBe(false);
    }
  });
});
