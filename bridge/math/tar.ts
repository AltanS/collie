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
//     segment, no absolute path, no backslash. The served paths are exactly these names;
//   • a header whose checksum is right. A torn or foreign archive is refused, not half read;
//   • at most {@link MAX_PACK_ENTRIES} entries and {@link MAX_PACK_BYTES} bytes of file content.
//
// The caller has already checked the compressed file's size and sha256 against the release
// manifest; these rules hold even so, because a pack is read once and served for months.

/** The most entries a pack may hold. The 1.28 pack holds 66 files in 3 folders. */
export const MAX_PACK_ENTRIES = 4096;

/** The most bytes the files of a pack may hold, inflated. The 1.28 pack is about 12 MB. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** One segment of a served name: what the web build emits, and nothing a path could misread. */
const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,127}$/;

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
  if (name !== "math" && !name.startsWith("math/")) return false;
  return name.split("/").every((segment) => SEGMENT.test(segment));
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

/** The `path` record of a pax header, or null when it names none. */
function paxPath(data: Uint8Array): string | null {
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    throw new PackRefusal("the math pack holds a name that is not text");
  }
  let path: string | null = null;
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space === -1) throw new PackRefusal("the math pack has a pax header that cannot be read");
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isFinite(length) || length <= space - at) throw new PackRefusal("the math pack has a pax header that cannot be read");
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

/** Every folder above `path`, and `path` itself when `self`, into `into`, parents first. */
function addFolders(path: string, into: Set<string>, self: boolean): void {
  const parts = path.split("/");
  const upto = self ? parts.length : parts.length - 1;
  for (let i = 1; i <= upto; i++) into.add(parts.slice(0, i).join("/"));
}

/**
 * The pack's files, from its inflated bytes. Throws {@link PackRefusal} on anything outside the rules
 * in the header above: the caller then keeps nothing.
 */
export function readPackTar(bytes: Uint8Array): PackContents {
  const files: PackFile[] = [];
  const folders = new Set<string>();
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
      addFolders(folder, folders, true);
      continue;
    }
    if (type !== "0" && type !== "\0") throw new PackRefusal("the math pack holds a link or a special file");
    if (!isPackPath(name) || name === "math") throw new PackRefusal("the math pack holds a file outside math/");
    if (seen.has(name)) throw new PackRefusal("the math pack holds the same file twice");
    seen.add(name);
    total += size;
    if (total > MAX_PACK_BYTES) throw new PackRefusal(`the math pack holds more than ${MAX_PACK_BYTES} bytes`);
    addFolders(name, folders, false);
    files.push({ path: name, data });
  }
  if (files.length === 0) throw new PackRefusal("the math pack holds no files");
  // A folder that is also a file's name would make the extraction fail half way: refuse it here.
  for (const folder of folders) if (seen.has(folder)) throw new PackRefusal("the math pack holds a file where a folder must be");
  return { files, folders: [...folders].toSorted((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)) };
}
