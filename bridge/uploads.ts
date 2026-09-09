import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

// Uploaded attachments (server.ts uploadPane → `<stateDir>/uploads/`) are referenced by path in a
// message and then never needed again, so nothing deletes them. This sweep prunes anything older
// than the TTL. The decision — which names are stale — is a pure, tested function; the runner that
// stats the dir and unlinks takes an injectable fs surface so it too can be exercised without disk.

// Upload limits. Herdr's socket only carries text/keys, so we can't paste a file into the terminal
// — instead we save it to a host file and the client references its path in the message (the agent
// reads images and text files by path). See `uploadPane()` in bridge/server.ts.
//
// The limit lives HERE, next to the sweep, rather than in server.ts, because two independent places
// enforce it: the handler that writes the file, and the lead's upload forward, which rejects an
// oversize body BEFORE spending a phone's cellular uplink on a peer that would only reject it
// (CREW_PROTOCOL.md §13). One rule, two enforcers — a second copy would drift.
//
// The number itself is per install (`COLLIE_MAX_UPLOAD_MB`), so it is no longer a constant: both
// enforcers take it as an argument. In a crew the two ends can therefore disagree, and the PEER's
// number is the one that decides — the lead's pre-check only saves an uplink. Keep the crew's
// members on the same number, or a member with a smaller cap refuses what its lead let through.

/** Largest attachment accepted, decoded, when the operator sets nothing. */
export const DEFAULT_MAX_UPLOAD_MB = 10;
/** {@link DEFAULT_MAX_UPLOAD_MB} in bytes — the fallback `bridge/config.ts` resolves to. */
export const DEFAULT_MAX_UPLOAD_BYTES = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
/**
 * Multipart wraps the file in a boundary + part headers, so a legitimately-sized file arrives a
 * little over the cap on the wire. Allow a small slack for a Content-Length pre-check, which is
 * always about the *encoded* body.
 */
export const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB

/**
 * Whether a declared `Content-Length` is already too big to be a legal upload. Pure, and shared by
 * both enforcement points so "too large" means the same number on one machine. A missing or
 * unparseable length is NOT oversize here — the handler's own post-parse check is what catches a
 * lying client (and `maxRequestBodySize` catches the rest).
 */
export function uploadTooLarge(contentLength: string | null, maxBytes: number): boolean {
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > maxBytes + MAX_UPLOAD_OVERHEAD;
}

/** Uploads older than this are swept (Herdr already read them by path; they're single-use). */
export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
/** How often the runner re-sweeps after the startup pass. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * How many leading bytes {@link imageExtFromBytes} needs. The longest signature we check is WebP's,
 * which is "RIFF" at 0 plus "WEBP" at 8 — twelve bytes.
 */
export const SNIFF_BYTES = 12;

/**
 * The upload allow-list, keyed by what the file IS rather than by what the client SAID it is.
 *
 * This used to be a lookup on the multipart part's Content-Type, which the client writes.
 * `IMAGE_EXT["__proto__"]` is Object.prototype and `IMAGE_EXT["constructor"]` is Object; both are
 * truthy, so both passed the check. Sniffing removes the lookup entirely.
 *
 * SVG is absent on purpose and must stay absent — it is script-bearing markup, not a raster image.
 */
/** The image formats Collie takes, as bare lowercase extensions. Published on `/api/config`. */
export const IMAGE_EXTS: readonly string[] = ["png", "jpg", "gif", "webp"];

const SIGNATURES: { ext: string; bytes: number[]; at: number }[] = [
  { ext: "png", at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "jpg", at: 0, bytes: [0xff, 0xd8, 0xff] },
  { ext: "gif", at: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { ext: "webp", at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];

function matchesAt(head: Uint8Array, at: number, bytes: number[]): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((b, i) => head[at + i] === b);
}

/**
 * The file extension implied by a file's leading bytes, or null if they are not one of the four
 * image formats Collie accepts. Pure — the whole decision, unit-tested.
 */
export function imageExtFromBytes(head: Uint8Array): string | null {
  for (const ext of IMAGE_EXTS) {
    const rows = SIGNATURES.filter((s) => s.ext === ext);
    // `every` on an empty list is true, which would type EVERY file as the first ext whose rows
    // someone deleted. No signature, no match.
    if (rows.length > 0 && rows.every((r) => matchesAt(head, r.at, r.bytes))) return ext;
  }
  return null;
}

// ── Text attachments ─────────────────────────────────────────────────────────────────────────
//
// An image is identified by its BYTES, because every format we take has a signature and a lie about
// the type is a lie about the file. A text file has no signature at all, so the two halves of the
// decision are split: the NAME says which text format it claims to be, and the BYTES only have to
// agree that it is text and not a binary someone renamed. That is weaker than the image path on
// purpose, and it is enough — nothing here executes the file, the agent reads it as text by path.
//
// The list is the set of things Claude Code and Codex actually read off a path today. Extend it per
// install with `COLLIE_UPLOAD_EXTRA_TYPES` (bridge/config.ts) rather than by editing this line.

/** The text formats Collie takes by default, as bare lowercase extensions. */
export const TEXT_EXTS: readonly string[] = [
  "md", "markdown", "txt", "json", "jsonl", "yaml", "yml", "toml", "csv", "tsv", "log",
  "xml", "html", "htm", "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "go", "rs",
  "sh", "bash", "sql", "diff", "patch",
];

/**
 * How many leading bytes {@link looksLikeText} reads. A binary that survives four kilobytes without
 * a single stray control byte is not a file this check was ever going to catch, and reading more
 * buys nothing for a decision the extension already made.
 */
export const TEXT_SNIFF_BYTES = 4096;

// Control bytes a real text file DOES contain: tab, the three line/page breaks, and ESC — a `.log`
// with ANSI colour in it is still a log. Everything else below 0x20, plus DEL, means binary.
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);

/**
 * Whether a head of bytes is plausibly text rather than a binary wearing a `.md` name. Pure — the
 * whole decision, unit-tested. An empty file passes: nothing in it disagrees.
 */
export function looksLikeText(head: Uint8Array): boolean {
  for (const byte of head) {
    if (byte === 0x7f) return false;
    if (byte < 0x20 && !TEXT_CONTROLS.has(byte)) return false;
  }
  return true;
}

/**
 * The bare lowercase extension a filename claims, or null when it claims none. Pure. The last dot
 * wins, a leading dot is not an extension (`.gitignore` claims nothing), and anything that is not
 * plain alphanumerics is rejected before it can reach a path — the saved filename is built from
 * this string.
 */
export function extFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : null;
}

/**
 * THE WHOLE ACCEPT DECISION, in one pure function: the extension to save this upload under, or null
 * to refuse it. Bytes first (an image is what its signature says, whatever it is called), then the
 * name against the text allow-list with the bytes as a veto.
 *
 * `extraExts` is the operator's own additions, already normalised by `bridge/config.ts`. They join
 * the TEXT half only — an install cannot teach Collie a new *binary* format this way, because there
 * would be no signature to check it against.
 */
export function uploadExt(
  name: string,
  head: Uint8Array,
  extraExts: readonly string[] = [],
): string | null {
  const image = imageExtFromBytes(head);
  if (image !== null) return image;
  const claimed = extFromName(name);
  if (claimed === null) return null;
  if (!TEXT_EXTS.includes(claimed) && !extraExts.includes(claimed)) return null;
  return looksLikeText(head) ? claimed : null;
}

/** Names whose mtime is older than `ttlMs` before `now`. Pure — the whole decision, unit-tested. */
export function filesToPrune(
  entries: { name: string; mtimeMs: number }[],
  now: number,
  ttlMs: number,
): string[] {
  return entries.filter((e) => now - e.mtimeMs > ttlMs).map((e) => e.name);
}

/** The slice of node:fs the sweep needs — injectable so the runner is testable with a fake. */
export interface UploadFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  unlink(path: string): Promise<void>;
}

const realFs: UploadFs = { readdir, stat: (p) => stat(p), unlink };

/**
 * Stat `dir`, prune every file past the TTL, and return the names actually removed. Best-effort
 * throughout: a missing uploads dir (nothing uploaded yet) is not an error, and a file that vanishes
 * between readdir and stat/unlink (or a stat/unlink that fails) is skipped rather than aborting the
 * sweep. `now` and `fs` are injected for tests; the bridge calls it with the defaults.
 */
export async function sweepUploads(
  dir: string,
  ttlMs: number = UPLOAD_TTL_MS,
  now: number = Date.now(),
  fs: UploadFs = realFs,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // uploads dir doesn't exist yet — nothing to sweep
  }
  const entries: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const s = await fs.stat(join(dir, name));
      entries.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  const removed: string[] = [];
  for (const name of filesToPrune(entries, now, ttlMs)) {
    try {
      await fs.unlink(join(dir, name));
      removed.push(name);
    } catch {
      /* already gone / unlink failed — skip */
    }
  }
  return removed;
}
