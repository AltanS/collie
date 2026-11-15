import { join } from "node:path";

import { accountAdapter } from "./account-adapters.ts";
import { checkLabel, parseFolderPath, sameLabel } from "./account-folder.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { memoryAddedIo, stateFileIo, type AddedFileIo } from "./launchers-added.ts";
import { isRequestId } from "./worktree-receipts.ts";

// ── The added accounts of THIS machine (M101 README decision 15, ADR 0141) ──────────────────────
//
// A state file, not a config file: the bridge writes no operator TOML (ADR 0094). One file per
// machine, `<stateDir>/accounts.json`, `{ "version": 1, "rows": [...] }`, owner-only, written to a
// temp name and renamed, and re-read by mtime, on the pattern of `launchers-added.json`
// (bridge/launchers-added.ts, whose io this file reuses). A crew member's accounts are its own.
//
// EVERY ROW IS CHECKED AGAIN WHEN IT IS READ: the label rule, the folder rule (the folder is typed into
// a shell), a known harness. A row that fails is dropped alone. A file that is not JSON, not an object,
// or of another version reads as empty and REFUSES writes until the operator moves it away.
//
// The Default account of each harness is never stored: it is the agent's own folder with nothing set.
// Remove forgets the row only. The folder, its links and its login stay.

/** The file's name inside the state dir. */
export const ACCOUNTS_FILE = "accounts.json";
/** The file's schema version. Another number reads as empty and refuses writes. */
export const ACCOUNTS_VERSION = 1;
/** The most added accounts one machine keeps. */
export const MAX_ACCOUNTS = 12;

/** One added account. */
export interface AccountRecord {
  /** The add's request id, and the account's id from then on. */
  id: string;
  harness: string;
  label: string;
  kind: "shared" | "own";
  /** Absolute and cleaned (`join(dir, ".")`): the exact text typed after the variable. */
  dir: string;
  addedAt: number;
  /** The pairing label of the device that added it. */
  device: string;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** One row read off disk, or `null` when it is not one. The add-time rules, again. */
export function coerceAccountRow(raw: JsonValue | undefined): AccountRecord | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { id, harness, label, kind, dir, addedAt, device } = r;
  if (!isRequestId(id)) return null;
  if (typeof harness !== "string" || accountAdapter(harness) === undefined) return null;
  if (typeof label !== "string") return null;
  const name = checkLabel(label);
  if (!name.ok || name.label !== label) return null;
  if (kind !== "shared" && kind !== "own") return null;
  if (kind === "shared" && accountAdapter(harness)?.share === undefined) return null;
  // The home is not needed to judge a stored folder: it must already be absolute and cleaned, and a
  // `~` the rule would expand never matches the cleaned text it would give.
  if (typeof dir !== "string") return null;
  const parsed = parseFolderPath(dir, "/");
  if (!parsed.ok || parsed.dir !== dir) return null;
  if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return null;
  if (typeof device !== "string" || device === "") return null;
  return { id, harness, label: name.label, kind, dir, addedAt, device };
}

/** What a parsed file holds, or `null` when it is not a file this build may write over. */
export function coerceAccountsFile(raw: JsonValue): AccountRecord[] | null {
  const file = asRecord(raw);
  if (file === null || file.version !== ACCOUNTS_VERSION || !Array.isArray(file.rows)) return null;
  const out: AccountRecord[] = [];
  for (const entry of file.rows) {
    const row = coerceAccountRow(entry);
    if (row === null) continue;
    // One id, one label per harness and one folder, once each: the first wins, as it was added first.
    if (out.some((r) => r.id === row.id || r.dir === row.dir || (r.harness === row.harness && sameLabel(r.label, row.label)))) continue;
    out.push(row);
  }
  return out.slice(0, MAX_ACCOUNTS);
}

/** Parse a file's text: `[]` for no file, `null` for one that is not ours to write. */
export function parseAccountsText(text: string | null): AccountRecord[] | null {
  if (text === null) return [];
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `coerceAccountsFile` checks every field.
    return coerceAccountsFile(JSON.parse(text) as JsonValue);
  } catch {
    return null;
  }
}

/** The text a list of rows is written as. */
export function formatAccountsFile(rows: readonly AccountRecord[]): string {
  return `${JSON.stringify({ version: ACCOUNTS_VERSION, rows }, null, 2)}\n`;
}

export type AccountAddOutcome =
  | { ok: true; row: AccountRecord; replayed: boolean }
  | { ok: false; reason: "full" | "label_taken" | "folder_taken" | "unwritable" };

/** What the routes and the start need of the store. */
export interface AccountStoreSurface {
  /** The rows on disk now. A missing or bad file is an empty list. */
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | undefined>;
  add(row: AccountRecord): Promise<AccountAddOutcome>;
  /** `null` when there is no such row. */
  remove(id: string): Promise<AccountRecord | null | "unwritable">;
  /** The rows of the last read, from memory. For the journal roots, which are read synchronously. */
  cached(): readonly AccountRecord[];
}

/** The real io over `<stateDir>/accounts.json`. */
export function accountsFileIo(stateDir: string): AddedFileIo {
  return stateFileIo(stateDir, join(stateDir, ACCOUNTS_FILE));
}

/** The file-backed store `bridge/index.ts` builds once. */
export class AccountStore implements AccountStoreSurface {
  private cache: { mtime: number | null; rows: AccountRecord[] | null } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly io: AddedFileIo,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** Call `listener` after the rows change, by this process or by a hand edit seen on a read. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private async load(): Promise<AccountRecord[] | null> {
    const mtime = await this.io.mtime();
    if (this.cache !== null && this.cache.mtime === mtime && mtime !== null) return this.cache.rows;
    let rows: AccountRecord[] | null;
    try {
      rows = parseAccountsText(await this.io.read());
    } catch (err) {
      this.warn(`[accounts] could not read ${ACCOUNTS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
      rows = null;
    }
    if (rows === null && (this.cache === null || this.cache.mtime !== mtime)) {
      this.warn(`[accounts] ${ACCOUNTS_FILE} is not a version ${ACCOUNTS_VERSION} file: no added accounts, and none can be added until it is moved away`);
    }
    const before = JSON.stringify(this.cache?.rows ?? []);
    this.cache = { mtime, rows };
    if (JSON.stringify(rows ?? []) !== before) for (const listener of this.listeners) listener();
    return rows;
  }

  async list(): Promise<AccountRecord[]> {
    return [...((await this.load()) ?? [])];
  }

  async get(id: string): Promise<AccountRecord | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }

  cached(): readonly AccountRecord[] {
    return this.cache?.rows ?? [];
  }

  private change<T>(edit: (rows: AccountRecord[]) => { rows: AccountRecord[] | null; answer: T }, unwritable: T): Promise<T> {
    const run = this.queue.then(async () => {
      // Always the disk: another process or a hand edit may have written since the last look.
      this.cache = this.cache === null ? null : { mtime: Number.NaN, rows: this.cache.rows };
      const rows = await this.load();
      if (rows === null) return unwritable;
      const out = edit(rows);
      if (out.rows !== null) {
        await this.io.write(formatAccountsFile(out.rows));
        await this.load();
      }
      return out.answer;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  add(row: AccountRecord): Promise<AccountAddOutcome> {
    return this.change<AccountAddOutcome>((rows) => {
      const same = rows.find((r) => r.id === row.id);
      if (same !== undefined) return { rows: null, answer: { ok: true, row: same, replayed: true } };
      if (rows.some((r) => r.harness === row.harness && sameLabel(r.label, row.label))) return { rows: null, answer: { ok: false, reason: "label_taken" } };
      if (rows.some((r) => r.dir === row.dir)) return { rows: null, answer: { ok: false, reason: "folder_taken" } };
      if (rows.length >= MAX_ACCOUNTS) return { rows: null, answer: { ok: false, reason: "full" } };
      return { rows: [...rows, row], answer: { ok: true, row, replayed: false } };
    }, { ok: false, reason: "unwritable" });
  }

  remove(id: string): Promise<AccountRecord | null | "unwritable"> {
    return this.change<AccountRecord | null | "unwritable">((rows) => {
      const gone = rows.find((r) => r.id === id);
      if (gone === undefined) return { rows: null, answer: null };
      return { rows: rows.filter((r) => r.id !== id), answer: gone };
    }, "unwritable");
  }
}

/** A store over an in-memory file: the default for a server built without a state dir. */
export function memoryAccountStore(initial: string | null = null): AccountStore {
  return new AccountStore(memoryAddedIo(initial), () => {});
}
