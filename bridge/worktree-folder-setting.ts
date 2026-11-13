import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import { MAX_PARENT_CHARS } from "./worktree-folder.ts";

// ── "Worktree folder": where this machine's new worktrees go by default (ADR 0093, note of 2026-11-13) ──
//
// One parent directory per machine, set from Settings. Unset is today's rule: Herdr's `[worktrees]
// directory`, else `~/.herdr/worktrees`. Set, the default target becomes `<dir>/<repo folder name>/<slug>`
// on every multiplexer (bridge/worktree-folder.ts, `resolveSetFolderTarget`).
//
// ── ONE FILE IN THE STATE DIR ────────────────────────────────────────────────────
// `worktree-folder.json` beside `worktree-choices.json`: `{ "version": 1, "dir": "~/trees" }`. It belongs
// to the MACHINE (a directory exists on one disk), so each member of a crew keeps its own, and the sheet
// for a member's repo reads the member's value because the plan is answered where the repo is.
//
// ── A STRING, NEVER A PATH ───────────────────────────────────────────────────────
// The value is stored as the string that passed the folder rule when it was saved (a leading `~` kept),
// and the rule runs on it again at every plan and every create. Nothing is cached: a folder that
// became a link, or moved, is refused the next time it is used, not remembered as good.
//
// ── WRITTEN BY ONE EVENT ─────────────────────────────────────────────────────────
// A person saving or clearing the setting. A bridge nobody sets it on writes no file.

/** The file's name inside the state dir. */
export const FOLDER_SETTING_FILE = "worktree-folder.json";
/** The file's schema version. Another number reads as unset. */
export const FOLDER_SETTING_VERSION = 1;

/** What the routes need of the store. */
export interface WorktreeFolderSettingSurface {
  /** The stored string, or `undefined` when the setting is unset. */
  get(): string | undefined;
  /** Save the string, or clear the setting with `null`. `false` when the write failed: nothing changed. */
  set(dir: string | null): Promise<boolean>;
}

/** Whether `value` is a string this setting may hold: not empty, bounded, no control character. */
export function isStorableFolder(value: JsonValue | undefined): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_PARENT_CHARS) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The value a parsed file holds, or `undefined` for a foreign version or any broken shape. */
export function coerceFolderSetting(raw: JsonValue): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (raw.version !== FOLDER_SETTING_VERSION) return undefined;
  return isStorableFolder(raw.dir) ? raw.dir.trim() : undefined;
}

/** The file-backed store `bridge/index.ts` builds once. */
export class WorktreeFolderSettingStore implements WorktreeFolderSettingSurface {
  private dir: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.file = join(stateDir, FOLDER_SETTING_FILE);
  }

  /** Read once at start. A missing or broken file is unset, and nothing is written. */
  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; coerceFolderSetting checks every field.
      this.dir = coerceFolderSetting((await Bun.file(this.file).json()) as JsonValue);
    } catch {
      /* nothing set yet */
    }
  }

  get(): string | undefined {
    return this.dir;
  }

  async set(dir: string | null): Promise<boolean> {
    const value = dir === null ? undefined : dir.trim();
    const run = this.queue.then(() => this.write(value));
    this.queue = run.catch(() => {});
    try {
      await run;
    } catch (err) {
      this.warn(`[worktree] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.dir = value;
    return true;
  }

  private async write(dir: string | undefined): Promise<void> {
    if (dir === undefined) {
      await rm(this.file, { force: true });
      return;
    }
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: FOLDER_SETTING_VERSION, dir }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/** A store with no file, for a server built without one. */
export function memoryWorktreeFolderSetting(initial?: string): WorktreeFolderSettingSurface {
  let dir = initial;
  return {
    get: () => dir,
    set: (next) => {
      dir = next === null ? undefined : next.trim();
      return Promise.resolve(true);
    },
  };
}
