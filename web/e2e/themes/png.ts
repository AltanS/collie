import { inflateSync } from "node:zlib";

// A PNG READER FOR THE SCREENSHOTS OF THIS SET, and nothing more. Playwright hands back a PNG and R5 reads its
// pixels, so the set needs a decoder; the repository has none and this tier adds no package. It reads exactly what
// Chromium writes for a screenshot: 8 bits a channel, colour type 2 (RGB) or 6 (RGBA), no interlace. Anything else
// throws, so a change in the engine's output fails loudly instead of reading as wrong colours.

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, row by row. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(png: Buffer): Pixels {
  if (!SIGNATURE.every((byte, i) => png[i] === byte)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${String(depth)}, colour type ${String(colour)}, interlace ${String(interlace)}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  if (width === 0 || channels === 0) throw new Error("a PNG with no header");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x += 1) {
      const byte = raw[start + 1 + x] ?? 0;
      const left = x >= channels ? (line[x - channels] ?? 0) : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= channels ? (prev[x - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + left;
          break;
        case 2:
          value = byte + up;
          break;
        case 3:
          value = byte + ((left + up) >> 1);
          break;
        case 4:
          value = byte + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`PNG filter ${String(filter)} on line ${String(y)}`);
      }
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels] ?? 0;
      out[o + 1] = line[x * channels + 1] ?? 0;
      out[o + 2] = line[x * channels + 2] ?? 0;
      out[o + 3] = channels === 4 ? (line[x * channels + 3] ?? 255) : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
}
