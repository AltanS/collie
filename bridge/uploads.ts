import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

// Uploaded images (server.ts uploadPane → `<stateDir>/uploads/`) are referenced by path in a
// message and then never needed again, so nothing deletes them. This sweep prunes anything older
// than the TTL. The decision — which names are stale — is a pure, tested function; the runner that
// stats the dir and unlinks takes an injectable fs surface so it too can be exercised without disk.

// Image upload limits. Herdr's socket only carries text/keys, so we can't paste an image into the
// terminal — instead we save it to a host file and the client references its path in the message
// (the agent reads images by path). See `uploadPane()` in bridge/server.ts.
//
// They live HERE, next to the sweep, rather than in server.ts, because two independent places now
// enforce them: the handler that writes the file, and the lead's upload forward, which rejects an
// oversize body BEFORE spending a phone's cellular uplink on a peer that would only reject it
// (PACK_PROTOCOL.md §13). One constant, two enforcers — a second copy would drift.

/** Largest image accepted, decoded. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
/**
 * Multipart wraps the file in a boundary + part headers, so a legitimately-sized image arrives a
 * little over {@link MAX_UPLOAD_BYTES} on the wire. Allow a small slack for a Content-Length
 * pre-check, which is always about the *encoded* body.
 */
export const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB

/**
 * Whether a declared `Content-Length` is already too big to be a legal upload. Pure, and shared by
 * both enforcement points so "too large" means the same number on the lead and on the peer. A
 * missing or unparseable length is NOT oversize here — the handler's own post-parse check is what
 * catches a lying client (and `maxRequestBodySize` catches the rest).
 */
export function uploadTooLarge(contentLength: string | null): boolean {
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD;
}

/** Uploads older than this are swept (Herdr already read them by path; they're single-use). */
export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
/** How often the runner re-sweeps after the startup pass. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

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
