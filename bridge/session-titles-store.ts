// The last names the title tracker knew, kept across a bridge restart (session-titles.ts).
//
// A name probe reads a bounded window of a log (a 128 KB tail, a 4 KB head). A long turn can push the
// rows that name a session out of the tail, and the tracker then keeps the last name it read. That
// memory used to die with the bridge, so after a restart a `/rename` name fell back to the agent's own
// title until the harness wrote the row again. The tracker now seeds a session it has not read yet
// from this file, and a read that names something still wins.
//
// Bounded: at most {@link SESSION_TITLES_MAX} sessions, the newest by the time they were last named.
// Atomic and owner-only: a fresh temp file (mode 0600), then a rename over the target. With
// `COLLIE_REDACT` on, only the person's name is kept: the agent's title is agent text, and the mask
// keeps agent text off disk where it can.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { normalizeTitle, type SessionTitles } from "./session-title.ts";

export const SESSION_TITLES_FILE = "session-titles.json";
export const SESSION_TITLES_MAX = 512;
const SESSION_TITLES_VERSION = 1;

/** One session's names as kept, with the time they were last set. */
export interface RememberedTitles {
  titles: SessionTitles;
  at: number;
}

/** The file's sessions, each name cleaned again; a row that is not one is dropped. Pure. */
export function coerceSessionTitles(raw: JsonValue): Map<string, RememberedTitles> {
  const out = new Map<string, RememberedTitles>();
  const sessions = asJsonObject(asJsonObject(raw)?.sessions);
  if (sessions === undefined) return out;
  for (const [id, value] of Object.entries(sessions)) {
    const row = asJsonObject(value);
    if (row === undefined || id === "") continue;
    const at = asJsonNumber(row.at);
    if (at === undefined || !Number.isFinite(at)) continue;
    const titles: SessionTitles = {};
    const person = normalizeTitle(asJsonString(row.person));
    const agent = normalizeTitle(asJsonString(row.agent));
    if (person !== undefined) titles.person = person;
    if (agent !== undefined) titles.agent = agent;
    if (titles.person === undefined && titles.agent === undefined) continue;
    out.set(id, { titles, at });
  }
  return out;
}

/** Where the tracker keeps its memory: the instance's state folder. */
export class SessionTitleStore {
  private readonly file: string;

  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: { stateDir: string; redact?: boolean }) {
    this.file = join(cfg.stateDir, SESSION_TITLES_FILE);
  }

  /** The kept names, or none when there is no file or it cannot be read. Never throws. */
  async load(): Promise<Map<string, RememberedTitles>> {
    try {
      // SAFETY: `json()` output is a JsonValue by construction; `coerceSessionTitles` checks every field.
      return coerceSessionTitles((await Bun.file(this.file).json()) as JsonValue);
    } catch {
      return new Map();
    }
  }

  /** Write the newest {@link SESSION_TITLES_MAX} sessions. Writes run one after the other. Never throws. */
  save(all: ReadonlyMap<string, RememberedTitles>): Promise<void> {
    const body = this.bodyOf(all);
    this.writing = this.writing.then(() => this.write(body)).catch(() => {});
    return this.writing;
  }

  private bodyOf(all: ReadonlyMap<string, RememberedTitles>): string {
    const newest = [...all].toSorted((a, b) => b[1].at - a[1].at).slice(0, SESSION_TITLES_MAX);
    const sessions: JsonObject = {};
    for (const [id, { titles, at }] of newest) {
      const row: JsonObject = { at };
      if (titles.person !== undefined) row.person = titles.person;
      if (titles.agent !== undefined && this.cfg.redact !== true) row.agent = titles.agent;
      if (row.person === undefined && row.agent === undefined) continue;
      sessions[id] = row;
    }
    return JSON.stringify({ version: SESSION_TITLES_VERSION, sessions });
  }

  private async write(body: string): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
