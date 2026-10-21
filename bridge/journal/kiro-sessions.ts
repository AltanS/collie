// Where Kiro V3 keeps its sessions, and how a session ID becomes its log.
//
// Each session is a folder <sessions>/<bucket>/<session-id>/ holding session.json, which describes
// it, and messages.jsonl, its rows (read by kiro.ts). Sessions started in one folder share a bucket.
// A sub-agent's own history sits in the session's sub-executions/ folder and is not read. Observed on
// kiro-cli 2.32.0 (fixtures/kiro/README.md).
//
// The lookup is grok.ts's, which has the same layout: list each root's buckets, take the first one
// that holds the session's log, and return that log's real path only when it is inside the root.

import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { containedRealpath, exists, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import type { AgentSessionRef, TranscriptSource } from "./types.ts";

// A session ID becomes a path component, so only a plain name is accepted. kiro-cli 2.32.0 names
// sessions `sess_<uuid>`; nothing here relies on that shape.
const KIRO_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether `name` may be a session ID: a plain name, safe as one path component. */
export function isKiroSessionId(name: string): boolean {
  return KIRO_SESSION_ID.test(name);
}

/** The parent log's name inside a session folder; the folder is named for the session ID. */
export const KIRO_LOG_NAME = "messages.jsonl";

/** The session ID a parent log path belongs to, or null when the path is not a parent log. */
export function kiroSessionIdOf(log: string): string | null {
  if (basename(log) !== KIRO_LOG_NAME) return null;
  const id = basename(dirname(log));
  return isKiroSessionId(id) ? id : null;
}

/** The Kiro journal's source: resolves a session ID to its log and reads it with the shared readers. */
export class KiroTranscriptSource implements TranscriptSource {
  // Session ID to the log resolve last found, with the root it was found under: a later containment
  // check is per root, as in grok.ts. A hit is contained again before it is returned.
  private readonly pathCache = new Map<string, { path: string; root: string }>();
  readonly roots: readonly string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isKiroSessionId(ref.value)) return null;
    const cached = this.pathCache.get(ref.value);
    if (cached !== undefined) {
      const real = await containedRealpath(cached.path, cached.root);
      if (real !== null) return real;
      this.pathCache.delete(ref.value);
    }
    for (const root of this.roots) {
      const hit = await findUnder(root, ref.value);
      if (hit === null) continue;
      this.pathCache.set(ref.value, { path: hit, root });
      return hit;
    }
    return null;
  }

  stat = statFile;
  load = loadTail;
  readSince = readSinceFile;
}

/** The real path of session `id`'s log in the first bucket under `root` that holds one. */
async function findUnder(root: string, id: string): Promise<string | null> {
  const buckets = await readdir(root).catch(() => null);
  if (buckets === null) return null;
  for (const bucket of buckets) {
    const candidate = join(root, bucket, id, KIRO_LOG_NAME);
    if (!(await exists(candidate))) continue;
    return containedRealpath(candidate, root);
  }
  return null;
}
