// A QR encoder in plain TypeScript: one string in, a matrix of dark modules out. No DOM, no network,
// no dependency. The pairing screen draws its code from this (components/qr-code.tsx, ADR 0139).
//
// WHY NOT THE CLI'S ENCODER. `collie pair` draws its code with `qrcode-terminal` (scripts/qr.ts), a
// root dependency the web bundle does not have, written as CommonJS that reaches for Node's module
// loader. Pulling it into the app would add a package to the phone's bundle for a few hundred lines of
// arithmetic, so this file is the arithmetic. `scripts/qr-web.test.ts` holds it to that encoder: for
// the same text, error level, version and mask, every module matches, and a real decoder (jsQR) reads
// every code this file chooses back to its text.
//
// SCOPE. Byte mode only (a URL), versions 1 to 40, all four error levels, the eight masks and the
// standard penalty rule to pick one. No kanji, numeric or alphanumeric segments: a pairing link is a
// few dozen bytes, and byte mode is always correct for it.
//
// The construction follows ISO/IEC 18004 in the order Project Nayuki's reference encoder lays it out
// (MIT), which is also the order a reader can check it against the standard.

/** The four error correction levels. `M` restores about 15% of the symbol. */
export type QrErrorLevel = "L" | "M" | "Q" | "H";

/** One encoded symbol: `modules[y][x]` is true for a dark module. No quiet zone; the drawer adds it. */
export interface QrSymbol {
  readonly version: number;
  readonly mask: number;
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

/** The format-information bits of each level (the standard's table, not the order of the letters). */
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 } as const satisfies Record<QrErrorLevel, number>;
const LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 } as const satisfies Record<QrErrorLevel, number>;

// Error correction codewords per block, and the number of blocks, by level then version (index 0 unused).
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules that carry data or error correction bits in a symbol of `version`. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (bytes) a symbol of `version` holds at `level`. */
function dataCodewords(version: number, level: QrErrorLevel): number {
  const l = LEVEL_INDEX[level];
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[l]![version]! * BLOCKS[l]![version]!;
}

/** Bits of the byte-mode character count at `version`. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ── Reed-Solomon over GF(256), reducing by x^8 + x^4 + x^3 + x^2 + 1 ───────────────────────────

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = Array.from({ length: degree }, (_, i) => (i === degree - 1 ? 1 : 0));
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/** Split the data into blocks, add each block's error correction, and interleave the lot. */
function withErrorCorrection(data: readonly number[], version: number, level: QrErrorLevel): number[] {
  const l = LEVEL_INDEX[level];
  const numBlocks = BLOCKS[l]![version]!;
  const eccLen = ECC_PER_BLOCK[l]![version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(block, divisor);
    // A short block gets a placeholder so every block has the same length for the interleave.
    if (i < numShort) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]!);
    });
  }
  return out;
}

// ── The data codewords ───────────────────────────────────────────────────────────────────────

/** The smallest version from 1 to 40 whose byte mode holds `length` bytes at `level`, or null. */
function smallestVersion(length: number, level: QrErrorLevel): number | null {
  for (let v = 1; v <= 40; v++) {
    if (4 + countBits(v) + 8 * length <= dataCodewords(v, level) * 8) return v;
  }
  return null;
}

/** Mode, count, bytes, terminator and padding, as the codewords of a `version` symbol. */
function dataBytes(bytes: Uint8Array, version: number, level: QrErrorLevel): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version, level) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return out;
}

// ── The matrix ───────────────────────────────────────────────────────────────────────────────

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    this.isFunction = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormatBits(grid: Grid, level: QrErrorLevel, mask: number): void {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  const size = grid.size;
  for (let i = 0; i <= 5; i++) grid.setFunction(8, i, bit(i));
  grid.setFunction(8, 7, bit(6));
  grid.setFunction(8, 8, bit(7));
  grid.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) grid.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) grid.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) grid.setFunction(8, size - 15 + i, bit(i));
  // The one module that is always dark.
  grid.setFunction(8, size - 8, true);
}

function drawFunctionPatterns(grid: Grid, version: number, level: QrErrorLevel): void {
  const size = grid.size;
  for (let i = 0; i < size; i++) {
    grid.setFunction(6, i, i % 2 === 0);
    grid.setFunction(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) grid.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // The three corners hold finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) grid.setFunction(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Reserve the format area with a placeholder mask; the real bits are drawn once the mask is chosen.
  drawFormatBits(grid, level, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      grid.setFunction(a, b, dark);
      grid.setFunction(b, a, dark);
    }
  }
}

function drawCodewords(grid: Grid, data: readonly number[]): void {
  const size = grid.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!grid.isFunction[y]![x] && i < data.length * 8) {
          grid.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function maskHits(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** XOR the mask over every non-function module. Applying it twice undoes it. */
function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.isFunction[y]![x] && maskHits(mask, x, y)) grid.modules[y]![x] = !grid.modules[y]![x];
    }
  }
}

/** Finder-like patterns (1:1:3:1:1 with light on a side) at the end of a run history. */
function countPatterns(h: readonly number[]): number {
  const n = h[1]!;
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
  return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0);
}

/** The standard's penalty score: runs, 2x2 blocks, finder-like patterns and the dark balance. */
function penalty(grid: Grid): number {
  const size = grid.size;
  const m = grid.modules;
  let result = 0;
  const addHistory = (length: number, history: number[]): void => {
    if (history[0] === 0) length += size;
    history.pop();
    history.unshift(length);
  };
  const terminate = (color: boolean, length: number, history: number[]): number => {
    if (color) {
      addHistory(length, history);
      length = 0;
    }
    addHistory(length + size, history);
    return countPatterns(history);
  };
  for (const byRow of [true, false]) {
    for (let a = 0; a < size; a++) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const dark = byRow ? m[a]![b]! : m[b]![a]!;
        if (dark === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!color) result += countPatterns(history) * 40;
          color = dark;
          run = 1;
        }
      }
      result += terminate(color, run, history) * 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/**
 * Encode `text` (UTF-8, byte mode) at `level`, in the smallest version that holds it. `mask` forces one
 * of the eight masks; without it the one with the lowest penalty is chosen, the standard's rule.
 * `version` forces a version (it must hold the text). Throws when the text does not fit version 40.
 */
export function encodeQr(text: string, level: QrErrorLevel = "M", force: { mask?: number; version?: number } = {}): QrSymbol {
  const bytes = new TextEncoder().encode(text);
  const smallest = smallestVersion(bytes.length, level);
  if (smallest === null) throw new Error(`qr: ${bytes.length} bytes do not fit a QR code at level ${level}`);
  const version = force.version ?? smallest;
  if (version < smallest || version > 40) throw new Error(`qr: version ${version} cannot hold ${bytes.length} bytes`);
  const size = version * 4 + 17;
  const grid = new Grid(size);
  drawFunctionPatterns(grid, version, level);
  drawCodewords(grid, withErrorCorrection(dataBytes(bytes, version, level), version, level));
  let mask = force.mask ?? -1;
  if (mask < 0 || mask > 7) {
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(grid, candidate);
      drawFormatBits(grid, level, candidate);
      const score = penalty(grid);
      if (score < best) {
        best = score;
        mask = candidate;
      }
      applyMask(grid, candidate);
    }
  }
  applyMask(grid, mask);
  drawFormatBits(grid, level, mask);
  return { version, mask, size, modules: grid.modules };
}
