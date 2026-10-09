import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { MAX_PARENT_CHARS, type WorktreeFolderKind } from "./worktree-folder.ts";

// ── The New sheet's last branch choices, per repo, on this machine (M48, ADR 0093) ───────────────
//
// When the operator makes a branch from a repo, the sheet opens next time with the same starting
// point, the same folder kind and the same parent folder. That memory belongs to the MACHINE (a
// parent folder exists on one disk) and to the REPO (two repos are set up differently), so it lives
// here, in this bridge's state dir beside `folders.json`, keyed by the repo's real main folder. It is
// never keyed on a pane id: a pane is gone in an hour and the repo is not.
//
// ── WRITTEN BY ONE EVENT ─────────────────────────────────────────────────────────
// A branch create that the multiplexer said yes to. Never by a read, never by a refusal, so a bridge
// that never makes a branch writes no `worktree-choices.json` (solo-baseline.test.ts).
//
// ── STRINGS, NEVER PATHS ─────────────────────────────────────────────────────────
// The parent folder is stored as the string that passed the folder rule, and handed back to the
// phone as a suggestion. The next create runs the whole rule on it again.
//
// ── BOUNDED ──────────────────────────────────────────────────────────────────────
// At most {@link MAX_CHOICES} repos; the oldest `at` goes first.

/** The most repos remembered. */
export const MAX_CHOICES = 100;
/** The file's name inside the state dir. */
export const CHOICES_FILE = "worktree-choices.json";
/** The file's schema version. Another number reads as empty. */
export const CHOICES_VERSION = 1;

/** Where the last branch of a repo started: its default branch, or the branch the folder was on. */
export type BaseKind = "default" | "current";

/** What the sheet remembers for one repo. */
export interface WorktreeChoice {
  base: BaseKind;
  folder: WorktreeFolderKind;
  /** The parent folder of the last "Other folder" create, kept when the kind went back to default. */
  parent?: string;
  /** Epoch ms of the create that wrote it. */
  at: number;
}

/** What the routes need of the store. */
export interface WorktreeChoiceSurface {
  get(repoRoot: string): WorktreeChoice | undefined;
  /** Remember one repo's choices. Never throws: a failed write costs the memory, never the create. */
  record(repoRoot: string, choice: WorktreeChoice): Promise<void>;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** One entry read off disk, or `null` when it is not one. */
export function coerceChoice(raw: JsonValue | undefined): WorktreeChoice | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { base, folder, parent, at } = r;
  if (base !== "default" && base !== "current") return null;
  if (folder !== "default" && folder !== "parent") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (parent !== undefined && (typeof parent !== "string" || parent === "" || parent.length > MAX_PARENT_CHARS)) return null;
  return parent === undefined ? { base, folder, at } : { base, folder, parent, at };
}

/** The map a parsed file holds, capped; a foreign version or a broken entry costs only itself. */
export function coerceChoices(raw: JsonValue): Record<string, WorktreeChoice> {
  const file = asRecord(raw);
  if (file === null || file.version !== CHOICES_VERSION) return {};
  const map = asRecord(file.repos);
  if (map === null) return {};
  const out: Record<string, WorktreeChoice> = {};
  for (const [repo, entry] of Object.entries(map)) {
    const choice = coerceChoice(entry);
    if (repo !== "" && repo !== "__proto__" && choice !== null) out[repo] = choice;
  }
  return capChoices(out);
}

/** `choices` with the oldest dropped past {@link MAX_CHOICES}. */
export function capChoices(choices: Record<string, WorktreeChoice>): Record<string, WorktreeChoice> {
  const entries = Object.entries(choices);
  if (entries.length <= MAX_CHOICES) return choices;
  entries.sort((a, b) => a[1].at - b[1].at);
  return Object.fromEntries(entries.slice(entries.length - MAX_CHOICES));
}

/** The file-backed store `bridge/index.ts` builds once. */
export class WorktreeChoiceStore implements WorktreeChoiceSurface {
  private choices: Record<string, WorktreeChoice> = {};
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.file = join(stateDir, CHOICES_FILE);
  }

  /** Read once at start. A missing or broken file is an empty map, and nothing is written. */
  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; coerceChoices checks every field.
      this.choices = coerceChoices((await Bun.file(this.file).json()) as JsonValue);
    } catch {
      /* nothing recorded yet */
    }
  }

  get(repoRoot: string): WorktreeChoice | undefined {
    const choice = Object.hasOwn(this.choices, repoRoot) ? this.choices[repoRoot] : undefined;
    return choice === undefined ? undefined : { ...choice };
  }

  async record(repoRoot: string, choice: WorktreeChoice): Promise<void> {
    if (repoRoot === "" || repoRoot === "__proto__") return;
    // A create on the default folder keeps the parent the operator used before, so switching back to
    // "Other folder" next time still offers it.
    const before = this.get(repoRoot);
    const kept = choice.parent ?? before?.parent;
    this.choices = capChoices({ ...this.choices, [repoRoot]: kept === undefined ? choice : { ...choice, parent: kept } });
    try {
      await this.save();
    } catch (err) {
      this.warn(`[worktree] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(): Promise<void> {
    const run = this.queue.then(() => this.write());
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: CHOICES_VERSION, repos: this.choices }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/** A store with no file, for a server built without one. */
export function memoryWorktreeChoices(): WorktreeChoiceSurface {
  const choices = new Map<string, WorktreeChoice>();
  return {
    get: (repoRoot) => {
      const c = choices.get(repoRoot);
      return c === undefined ? undefined : { ...c };
    },
    record: (repoRoot, choice) => {
      const kept = choice.parent ?? choices.get(repoRoot)?.parent;
      choices.set(repoRoot, kept === undefined ? choice : { ...choice, parent: kept });
      return Promise.resolve();
    },
  };
}
