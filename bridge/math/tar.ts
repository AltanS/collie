// ── THE MATH PACK'S ARCHIVE, READ IN THE PROCESS (ADR 0132 Decision 6) ─────────────────────
//
// The pack is a tar archive the release job writes (`collie-math-<version>.tar.gz`). The bridge spawns
// no child for content, so it never runs `tar`: this reader takes the inflated bytes and answers with
// the files, or refuses the whole archive. What it takes, and nothing else:
//
//   • regular files (`0`, or NUL from an old writer) and folders (`5`);
//   • the two ways a long name is written: a pax header (`x`, its `path` record) and a GNU long name
//     (`L`). A global pax header (`g`) is read past. Every other entry, a hard or symbolic link, a
//     device, a FIFO, a sparse file, refuses the archive;
//   • a name under `math/`, made of plain segments ({@link SEGMENT}): no `..`, no `.`, no empty
//     segment, no absolute path, no backslash, no Windows device name (`con`, `nul`, `com1`, …), at
//     most {@link MAX_NAME_BYTES} bytes and {@link MAX_NAME_SEGMENTS} segments. The served paths are
//     exactly these names. Two names that differ only in case are refused too: on Windows and macOS
//     they are one file;
//   • a header whose checksum is right. A torn or foreign archive is refused, not half read;
//   • at most {@link MAX_PACK_ENTRIES} entries and {@link MAX_PACK_BYTES} bytes of file content.
//
// The caller has already checked the compressed file's size and sha256 against the release
// manifest; these rules hold even so, because a pack is read once and served for months.

/** The most entries a pack may hold. The 1.28 pack holds 66 files in 3 folders. */
export const MAX_PACK_ENTRIES = 4096;

/** The most bytes the files of a pack may hold, inflated. The 1.28 pack is about 12 MB. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** The longest name a pack may hold. The 1.28 pack's longest is 51 bytes. */
export const MAX_NAME_BYTES = 255;

/** The deepest name a pack may hold, `math` counted. The 1.28 pack's deepest is 3. */
export const MAX_NAME_SEGMENTS = 8;

/** One segment of a served name: what the web build emits, and nothing a path could misread. */
const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,127}$/;

/** A Windows device name, with or without an extension: `nul.js` is the device too. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** A refusal whose message is Collie's own sentence: safe to log, never a path from the archive. */
export class PackRefusal extends Error {}

export interface PackFile {
  /** The name under the pack's root, `math/…`, as served. */
  path: string;
  data: Uint8Array;
}

export interface PackContents {
  files: PackFile[];
  /** Every folder the files need, parents first: `math`, `math/katex`, … */
  folders: string[];
}

/** Whether `name` is a path the pack may hold: `math` itself or under it, plain segments only. */
export function isPackPath(name: string): boolean {
  // Length first, so a name built to be expensive is refused before it is split. Every byte a
  // segment may hold is ASCII, so the string's length is its byte length.
  if (name.length > MAX_NAME_BYTES) return false;
  if (name !== "math" && !name.startsWith("math/")) return false;
  const segments = name.split("/");
  if (segments.length > MAX_NAME_SEGMENTS) return false;
  return segments.every((segment) => SEGMENT.test(segment) && !DEVICE.test(segment));
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A NUL-terminated field. Throws on bytes that are not UTF-8. */
function field(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  try {
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  } catch {
    throw new PackRefusal("the math pack holds a name that is not text");
  }
}

/** An octal number field. Base-256 (a leading 0x80) is refused: no entry in a pack is that large. */
function octal(block: Uint8Array, start: number, length: number): number {
  if ((block[start]! & 0x80) !== 0) throw new PackRefusal("the math pack holds an entry too large to read");
  const text = field(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new PackRefusal("the math pack has a header that is not a tar header");
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** The header checksum: every byte, the checksum field counted as eight spaces. */
function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum === octal(block, 148, 8);
}

/**
 * The `path` record of a pax header, or null when it names none. Each record is
 * `<length> <key>=<value>\n`, its length counted in BYTES, so the records are cut on the bytes and
 * only then decoded.
 */
function paxPath(data: Uint8Array): string | null {
  const unreadable = () => new PackRefusal("the math pack has a pax header that cannot be read");
  let path: string | null = null;
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1 || space - at > 7) throw unreadable();
    const digits = String.fromCharCode(...data.subarray(at, space));
    if (!/^[1-9][0-9]*$/.test(digits)) throw unreadable();
    const length = Number.parseInt(digits, 10);
    const end = at + length;
    if (length <= space - at + 1 || end > data.length || data[end - 1] !== 0x0a) throw unreadable();
    let record: string;
    try {
      record = decoder.decode(data.subarray(space + 1, end - 1));
    } catch {
      throw new PackRefusal("the math pack holds a name that is not text");
    }
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at = end;
  }
  return path;
}

/**
 * Every folder above `path`, and `path` itself when `self`, into `into` (name → depth). A name has
 * passed {@link isPackPath}, so this is at most {@link MAX_NAME_SEGMENTS} short joins. Two folders
 * that differ only in case would be one folder on Windows and macOS: refused.
 */
function addFolders(path: string, into: Map<string, number>, folded: Map<string, string>, self: boolean): void {
  const parts = path.split("/");
  const upto = self ? parts.length : parts.length - 1;
  for (let i = 1; i <= upto; i++) {
    const folder = parts.slice(0, i).join("/");
    const key = folder.toLowerCase();
    const known = folded.get(key);
    if (known !== undefined && known !== folder) throw new PackRefusal("the math pack holds two names that differ only in case");
    folded.set(key, folder);
    into.set(folder, i);
  }
}

/**
 * The pack's files, from its inflated bytes. Throws {@link PackRefusal} on anything outside the rules
 * in the header above: the caller then keeps nothing.
 */
export function readPackTar(bytes: Uint8Array): PackContents {
  const files: PackFile[] = [];
  const folders = new Map<string, number>();
  // Folder names by their case-folded form, and file names case-folded: one file on Windows and macOS.
  const foldedFolders = new Map<string, string>();
  const seen = new Set<string>();
  let total = 0;
  let entries = 0;
  let longName: string | null = null;
  let at = 0;
  for (;;) {
    if (at + 512 > bytes.length) throw new PackRefusal("the math pack ends in the middle of an entry");
    const block = bytes.subarray(at, at + 512);
    // A zero block ends the archive (writers put two; one is enough to stop on).
    if (block.every((b) => b === 0)) break;
    if (!checksumOk(block)) throw new PackRefusal("the math pack has a header that is not a tar header");
    if (++entries > MAX_PACK_ENTRIES) throw new PackRefusal(`the math pack holds more than ${MAX_PACK_ENTRIES} entries`);
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156]!);
    const dataStart = at + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new PackRefusal("the math pack ends in the middle of an entry");
    const data = bytes.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "L") {
      if (size > 4096) throw new PackRefusal("the math pack has a name header that is too long");
      longName = type === "x" ? paxPath(data) : field(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;

    const magic = field(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(block, 345, 155) : "";
    let name = longName ?? (prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`);
    longName = null;
    if (name.startsWith("./")) name = name.slice(2);

    if (type === "5") {
      const folder = name.replace(/\/+$/, "");
      if (!isPackPath(folder)) throw new PackRefusal("the math pack holds a folder outside math/");
      addFolders(folder, folders, foldedFolders, true);
      continue;
    }
    if (type !== "0" && type !== "\0") throw new PackRefusal("the math pack holds a link or a special file");
    if (!isPackPath(name) || name === "math") throw new PackRefusal("the math pack holds a file outside math/");
    const key = name.toLowerCase();
    if (seen.has(key)) throw new PackRefusal("the math pack holds the same file twice, or two that differ only in case");
    seen.add(key);
    total += size;
    if (total > MAX_PACK_BYTES) throw new PackRefusal(`the math pack holds more than ${MAX_PACK_BYTES} bytes`);
    addFolders(name, folders, foldedFolders, false);
    files.push({ path: name, data });
  }
  if (files.length === 0) throw new PackRefusal("the math pack holds no files");
  // A folder that is also a file's name would make the extraction fail half way: refuse it here.
  for (const folder of folders.keys()) if (seen.has(folder.toLowerCase())) throw new PackRefusal("the math pack holds a file where a folder must be");
  // Parents first, on the depth each folder was stored with: no string is split again to sort.
  const ordered = [...folders].toSorted(([a, da], [b, db]) => da - db || (a < b ? -1 : a > b ? 1 : 0));
  return { files, folders: ordered.map(([folder]) => folder) };
}
