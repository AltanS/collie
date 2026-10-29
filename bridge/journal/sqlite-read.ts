// One read-only look at an agent's SQLite file, with the closed-WAL fallback.
//
// ── WHY A FALLBACK AT ALL ────────────────────────────────────────────────────
// Antigravity CLI (and Hermes) keep their databases in WAL mode. On a clean close the agent removes
// the `-wal` and `-shm` files but leaves the header saying WAL (bytes 18 and 19 are 2, 2). Opening
// such a file read-only asks SQLite for a `-shm`, and in a folder this user may not write, or on a
// read-only mount, that open fails (SQLITE_CANTOPEN, SQLITE_READONLY, an SHM I/O error). The bytes
// are all in the main file then, so a copy in memory with the header set back to rollback mode
// (1, 1) reads the same rows.
//
// ── WHY IT IS SAFE ───────────────────────────────────────────────────────────
// Only when no `-wal` and no `-shm` exists on disk: a WAL that is still there may hold committed
// frames the main file does not, and reading the main file alone would silently drop them. Only for
// a file of at most 64 MiB, since the copy is held in memory whole. Only for the open errors above,
// and only for a header that says WAL; anything else answers null like any other failed read.
//
// One module for the adapter (bridge/journal/agy.ts) and the probe (scripts/journal-probe.ts), which
// each kept a copy in PR 619. bridge/journal/hermes.ts keeps its own plain read for now.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";

/** The largest file the fallback copies into memory. */
export const MAX_DESERIALIZE_BYTES = 64 * 1024 * 1024;

const CLOSED_WAL_OPEN_ERROR =
  /\b(?:SQLITE_CANTOPEN(?:_\w+)?|SQLITE_READONLY(?:_\w+)?|SQLITE_IOERR_SHM\w*)\b|unable to open database file|attempt to write a readonly database|disk I\/O error/i;

/** Whether `err`, from a read-only open or read of `dbPath`, is the closed-WAL case the copy may serve. */
export function canDeserializeClosedWal(dbPath: string, err: Error & { readonly code?: string }): boolean {
  if (!CLOSED_WAL_OPEN_ERROR.test(`${err.code ?? ""} ${err.message}`)) return false;
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) return false;
  try {
    return statSync(dbPath).size <= MAX_DESERIALIZE_BYTES;
  } catch {
    return false;
  }
}

/** The file's bytes with a WAL header (2, 2) set back to rollback mode (1, 1), or null. */
function rollbackCopy(dbPath: string): Uint8Array | null {
  const buf = new Uint8Array(readFileSync(dbPath));
  if (buf.length < 20 || buf[18] !== 2 || buf[19] !== 2) return null;
  buf[18] = 1;
  buf[19] = 1;
  return buf;
}

/**
 * Run `read` against `dbPath` opened read-only, or against an in-memory copy when the file is a
 * closed WAL database the open refused (see the header). Null for a missing file and for any
 * failure: a caller reads null as "nothing here", never as an error.
 */
export function readSqlite<T>(dbPath: string, read: (db: Database) => T): T | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    return read(db);
  } catch (err) {
    if (!(err instanceof Error) || !canDeserializeClosedWal(dbPath, err)) return null;
    try {
      const copy = rollbackCopy(dbPath);
      if (copy === null) return null;
      const mem = Database.deserialize(copy, { readonly: true });
      try {
        return read(mem);
      } finally {
        mem.close();
      }
    } catch {
      return null;
    }
  } finally {
    db?.close();
  }
}
