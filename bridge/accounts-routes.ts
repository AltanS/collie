import { join } from "node:path";

import { accountAdapter, ACCOUNT_HARNESSES, selectText, type AccountAdapter } from "./account-adapters.ts";
import { accountStartLine, checkFolder, checkLabel, displayFolder, displayStartLine, isUnder, parseFolderPath, sameLabel, type FolderLook } from "./account-folder.ts";
import { inspectLinks, prepareSharedFolder, runLinkPass, type LinkDisk } from "./account-links.ts";
import { MAX_ACCOUNTS, type AccountRecord, type AccountStoreSurface } from "./accounts-store.ts";
import type { AuditLog } from "./audit.ts";
import { documentCarriesOurHooks } from "./beacon-io.ts";
import { apiError, type ApiErrorDetail, type ErrorCode } from "./error-codes.ts";
import type { HarnessProbe } from "./harness-launch.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { AccountHarness, AccountRow, AccountsBody, AccountWindow, AgentView, FoundFolder, PaneAccount } from "./types.ts";
import { isRequestId } from "./worktree-receipts.ts";

// ── Accounts: the routes, the found folders, the start line and a pane's tag (M101, ADR 0141) ──
//
// One service, built once in bridge/index.ts and handed to the server. Every route here is pure in the
// sense the launcher routes are: it takes the parsed body and answers a status and a body, and
// bridge/server.ts owns the gate, the `?host=` forward and the JSON response.
//
// WHAT THE BRIDGE NEVER DOES HERE: open a login file, copy one, move one, or store one. The found
// folders are found by NAMES and existence only. `hooks` reads the agent's settings file, which holds
// no login. The usage windows come from one injected seam, so this file asks no vendor anything.
//
// WINDOWS. The start line is `NAME='<folder>' <binary>`, a form Windows shells do not take, so on a
// Windows host there are no accounts in this milestone: the read answers `accounts.unavailable`, an add
// is refused the same way, and so is a launch that names an account.

/** A route's answer, for bridge/server.ts to send. */
export interface AccountsAnswer {
  status: number;
  body: JsonValue | AccountsBody | { ok: true; account: AccountRow } | { ok: true };
}

/** One reading of an account's windows: the seam spec 02 fills with its own source. */
export type AccountReading = (harness: string, dir: string | undefined) => { windows: AccountWindow[]; at: number } | null;

/** Where a session reported its config folder: raw string, `null` for the default, `undefined` unknown. */
export interface ReportedFolders {
  reportedConfigDir(pane: AgentView): string | null | undefined;
  reportedConfigDirs(): readonly { harness: string; dir: string }[];
}

export interface AccountsDeps {
  store: AccountStoreSurface;
  harnesses: Pick<HarnessProbe, "list" | "launch">;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  disk: LinkDisk;
  /** The usage windows. Absent: none. */
  reading?: AccountReading;
  /** The folders sessions reported. Absent: none, and only the launch note tags a pane. */
  reported?: ReportedFolders;
  /** Every agent pane on this machine now, with its mux session. Absent: nothing is live. */
  panes?: () => readonly { session: string; pane: AgentView }[];
  /** A settings file's text, or null. Absent: `hooks` is not reported. */
  readText?: (path: string) => string | null;
  now?: () => number;
}

/** Who is asking a write, and where its audit line goes. */
export interface AccountsCaller {
  device: string | null;
  audit: AuditLog;
  session?: string;
}

/** What a launch gets back from {@link Accounts.startLine}. */
export type AccountStart =
  | { ok: true; command: string; account?: AccountRecord }
  | { ok: false; status: number; code: ErrorCode; detail?: ApiErrorDetail };

/** The id of a harness's Default row. */
export function defaultAccountId(harness: string): string {
  return `${harness}:default`;
}

/** Which accounts have a pane running now: harnesses whose Default does, and added account ids. */
interface LiveAccounts {
  defaults: Set<string>;
  ids: Set<string>;
}

/** How many launch notes are kept at most; the oldest go first. */
const MAX_NOTES = 256;
/** The most found folders listed. */
const MAX_FOUND = 12;

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function refusal(status: number, code: ErrorCode, detail?: ApiErrorDetail): AccountsAnswer {
  return { status, body: { ok: false, ...apiError(code, detail) } };
}

export class Accounts {
  private readonly notes = new Map<string, { harness: string; id: string }>();

  constructor(private readonly deps: AccountsDeps) {}

  /** Whether this machine offers accounts at all: not on Windows (README decision 16). */
  offered(): boolean {
    return this.deps.platform !== "win32";
  }

  private defaultDir(adapter: AccountAdapter): string {
    return join(adapter.defaultDir(this.deps.home, this.deps.env), ".");
  }

  private look(): FolderLook {
    const disk = this.deps.disk;
    return {
      exists: async (p) => (await disk.kindOf(p)) !== "missing",
      realpath: (p) => disk.realpath(p),
    };
  }

  /** The account-capable harnesses whose binary is on this machine, in table order. */
  private async listed(): Promise<{ id: string; label: string; binary: string; adapter: AccountAdapter }[]> {
    const found = new Set((await this.deps.harnesses.list()).filter((h) => h.found).map((h) => h.id));
    const out: { id: string; label: string; binary: string; adapter: AccountAdapter }[] = [];
    for (const id of ACCOUNT_HARNESSES) {
      const adapter = accountAdapter(id);
      const launch = this.deps.harnesses.launch(id);
      if (adapter === undefined || launch === undefined || !found.has(id)) continue;
      out.push({ id, label: launch.label, binary: launch.binary, adapter });
    }
    return out;
  }

  private kinds(adapter: AccountAdapter): ("shared" | "own")[] {
    return adapter.share !== undefined && this.offered() ? ["shared", "own"] : ["own"];
  }

  // ── A pane's account ──────────────────────────────────────────────────────────────────────

  /**
   * The added account a pane runs under, from memory. The folder the agent reported wins; the launch
   * note counts only until the agent reports, and only while the pane runs the harness it was started
   * with. A reported folder no account names, or the default, is no account.
   */
  accountOf(session: string, pane: AgentView): AccountRecord | undefined {
    if (pane.kind === "shell" || accountAdapter(pane.agent) === undefined) return undefined;
    const rows = this.deps.store.cached();
    const reported = this.deps.reported?.reportedConfigDir(pane);
    if (typeof reported === "string") {
      const dir = join(reported, ".");
      return rows.find((r) => r.harness === pane.agent && r.dir === dir);
    }
    if (reported === null) return undefined;
    const key = `${session}\u0000${pane.paneId}`;
    const note = this.notes.get(key);
    if (note === undefined) return undefined;
    if (note.harness !== pane.agent) {
      this.notes.delete(key);
      return undefined;
    }
    return rows.find((r) => r.id === note.id);
  }

  /** The tag `PaneWire.account` carries, or undefined. */
  paneAccount(session: string, pane: AgentView): PaneAccount | undefined {
    const row = this.accountOf(session, pane);
    return row === undefined ? undefined : { id: row.id, label: row.label };
  }

  /** Note that this bridge just started `paneId` with an account. */
  noteLaunch(session: string, paneId: string, harness: string, id: string): void {
    const key = `${session}\u0000${paneId}`;
    this.notes.delete(key);
    this.notes.set(key, { harness, id });
    for (const old of this.notes.keys()) {
      if (this.notes.size <= MAX_NOTES) break;
      this.notes.delete(old);
    }
  }

  /** Drop the notes of panes that are gone from `session`. */
  keep(session: string, paneIds: readonly string[]): void {
    const alive = new Set(paneIds);
    const prefix = `${session}\u0000`;
    for (const key of this.notes.keys()) {
      if (key.startsWith(prefix) && !alive.has(key.slice(prefix.length))) this.notes.delete(key);
    }
  }

  private liveSet(): LiveAccounts {
    const defaults = new Set<string>();
    const ids = new Set<string>();
    for (const { session, pane } of this.deps.panes?.() ?? []) {
      if (pane.kind === "shell" || accountAdapter(pane.agent) === undefined) continue;
      const row = this.accountOf(session, pane);
      if (row !== undefined) ids.add(row.id);
      else if (typeof this.deps.reported?.reportedConfigDir(pane) !== "string") defaults.add(pane.agent);
    }
    return { defaults, ids };
  }

  // ── GET /api/accounts ─────────────────────────────────────────────────────────────────────

  private hooksOf(adapter: AccountAdapter, dir: string): "installed" | "missing" | undefined {
    if (adapter.hooksFile === undefined || this.deps.readText === undefined) return undefined;
    const text = this.deps.readText(adapter.hooksFile(dir));
    return text !== null && documentCarriesOurHooks(text) ? "installed" : "missing";
  }

  private windowsOf(harness: string, dir: string | undefined, live: boolean): Pick<AccountRow, "windows" | "seenAt"> {
    // Only a live account is read: the usage read asks the vendor with the login of a folder that has
    // a live pane, and nothing else (ADR 0118, README decision 5). Spec 02 keeps a last-seen store.
    const reading = live ? (this.deps.reading?.(harness, dir) ?? null) : null;
    return reading === null ? { windows: [], seenAt: null } : { windows: reading.windows, seenAt: reading.at };
  }

  /** The body of the read, or null when this machine offers no accounts. */
  async body(): Promise<AccountsBody | null> {
    if (!this.offered()) return null;
    const listed = await this.listed();
    if (listed.length === 0) return null;
    const rows = await this.deps.store.list();
    const live = this.liveSet();
    const harnesses: AccountHarness[] = listed.map((h) => ({
      id: h.id,
      label: h.label,
      select: selectText(h.adapter.select),
      kinds: this.kinds(h.adapter),
      newFolder: h.adapter.newFolder,
    }));
    const accounts: AccountRow[] = [];
    for (const h of listed) {
      const defaultDir = this.defaultDir(h.adapter);
      const isLive = live.defaults.has(h.id);
      const defaultRow: AccountRow = {
        id: defaultAccountId(h.id),
        harness: h.id,
        label: "",
        kind: "default",
        folder: displayFolder(defaultDir, this.deps.home),
        startLine: h.binary,
        ...this.windowsOf(h.id, undefined, isLive),
        live: isLive,
      };
      const defaultHooks = this.hooksOf(h.adapter, defaultDir);
      if (defaultHooks !== undefined) defaultRow.hooks = defaultHooks;
      accounts.push(defaultRow);
      for (const r of rows.filter((row) => row.harness === h.id)) accounts.push(await this.rowWire(r, h.binary, h.adapter, live.ids.has(r.id)));
    }
    return { harnesses, accounts, found: await this.found(listed.map((h) => h.adapter), listed.map((h) => h.id), rows) };
  }

  private async rowWire(r: AccountRecord, binary: string, adapter: AccountAdapter, live: boolean): Promise<AccountRow> {
    const row: AccountRow = {
      id: r.id,
      harness: r.harness,
      label: r.label,
      kind: r.kind,
      folder: displayFolder(r.dir, this.deps.home),
      startLine: displayStartLine(adapter, r.dir, binary, this.deps.home),
      ...this.windowsOf(r.harness, r.dir, live),
      live,
    };
    if (r.kind === "shared" && adapter.share !== undefined) {
      row.unlinked = (await inspectLinks(this.deps.disk, this.defaultDir(adapter), r.dir, adapter.share)).unlinked;
    }
    const hooks = this.hooksOf(adapter, r.dir);
    if (hooks !== undefined) row.hooks = hooks;
    return row;
  }

  /** Folders in use that are not added yet: reported by a session, or matching a name glob and layout. */
  private async found(adapters: AccountAdapter[], ids: string[], rows: readonly AccountRecord[]): Promise<FoundFolder[]> {
    const disk = this.deps.disk;
    const out: FoundFolder[] = [];
    const seen = new Set<string>();
    const excluded = new Map<string, Set<string>>();
    for (const [i, id] of ids.entries()) {
      const adapter = adapters[i];
      if (adapter === undefined) continue;
      const dirs = [this.defaultDir(adapter), ...rows.map((r) => r.dir)];
      const reals = await Promise.all(dirs.map((d) => disk.realpath(d)));
      excluded.set(id, new Set([...dirs, ...reals.filter((d): d is string => d !== null)]));
    }
    const consider = async (harness: string, dir: string, why: FoundFolder["why"]): Promise<void> => {
      if (out.length >= MAX_FOUND || seen.has(`${harness}\u0000${dir}`)) return;
      seen.add(`${harness}\u0000${dir}`);
      if ((await disk.resolvedKind(dir)) !== "dir") return;
      const skip = excluded.get(harness);
      const real = await disk.realpath(dir);
      if (skip === undefined || skip.has(dir) || (real !== null && skip.has(real))) return;
      // A path a session reported is offered only if the folder rule would take it back.
      const parsed = parseFolderPath(dir, this.deps.home);
      if (!parsed.ok || parsed.dir !== dir) return;
      out.push({ harness, folder: displayFolder(dir, this.deps.home), path: dir, why });
    };
    for (const { harness, dir } of this.deps.reported?.reportedConfigDirs() ?? []) {
      if (!ids.includes(harness)) continue;
      await consider(harness, join(dir, "."), "reported");
    }
    for (const [i, id] of ids.entries()) {
      const adapter = adapters[i];
      if (adapter === undefined) continue;
      for (const glob of adapter.nameGlobs) {
        for (const dir of await this.globDirs(glob)) {
          const names = await disk.readdir(dir).catch(() => []);
          if (adapter.looksLike(names)) await consider(id, dir, "name");
        }
      }
    }
    return out;
  }

  /** The folders a `~/<prefix>*` or `~/<folder>/*` glob names, by listing one folder. */
  private async globDirs(glob: string): Promise<string[]> {
    if (!glob.startsWith("~/")) return [];
    const rest = glob.slice(2);
    const at = rest.lastIndexOf("/");
    const parent = at === -1 ? this.deps.home : join(this.deps.home, rest.slice(0, at));
    const pattern = at === -1 ? rest : rest.slice(at + 1);
    const star = pattern.indexOf("*");
    if (star === -1) return [];
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    const names = await this.deps.disk.readdir(parent).catch(() => []);
    return names
      .filter((n) => n.length > prefix.length + suffix.length && n.startsWith(prefix) && n.endsWith(suffix))
      .toSorted()
      .map((n) => join(parent, n));
  }

  // ── POST /api/accounts ────────────────────────────────────────────────────────────────────

  /**
   * Add one account. The body: `requestId` (a UUID, the account's id; a known one answers that row),
   * `harness`, `label`, `kind` (`shared` or `own`), `path` (required for `own`; for `shared` the
   * folder defaults to the adapter's new-folder name).
   */
  async add(raw: JsonValue, caller: AccountsCaller): Promise<AccountsAnswer> {
    const fields = asRecord(raw);
    if (fields === null || !isRequestId(fields.requestId)) return { status: 400, body: { ok: false, error: "bad body" } };
    const requestId = fields.requestId;
    const earlier = await this.deps.store.get(requestId);
    if (earlier !== undefined) return this.answerRow(earlier);
    if (!this.offered()) return refusal(404, "accounts.unavailable");
    if (caller.device === null || caller.device === "") return refusal(403, "launcher.no_device");

    const harness = typeof fields.harness === "string" ? fields.harness : "";
    const listed = (await this.listed()).find((h) => h.id === harness);
    if (listed === undefined) return refusal(400, "accounts.kind_unsupported");
    const kind = fields.kind;
    if ((kind !== "shared" && kind !== "own") || !this.kinds(listed.adapter).includes(kind)) return refusal(400, "accounts.kind_unsupported");

    const name = typeof fields.label === "string" ? checkLabel(fields.label) : ({ ok: false } as const);
    if (!name.ok) return refusal(400, "accounts.bad_label");
    const rows = await this.deps.store.list();
    if (rows.some((r) => r.harness === harness && sameLabel(r.label, name.label))) return refusal(409, "accounts.label_taken");
    if (rows.length >= MAX_ACCOUNTS) return refusal(409, "accounts.limit", { max: MAX_ACCOUNTS });

    const path = fields.path;
    if (path !== undefined && path !== null && typeof path !== "string") return refusal(400, "accounts.bad_folder", { reason: "not a folder path" });
    let raw0: string;
    if (typeof path === "string" && path !== "") raw0 = path;
    else if (kind === "own") return refusal(400, "accounts.bad_folder", { reason: "not a folder path" });
    else raw0 = `~/${listed.adapter.newDirName(name.slug)}`;
    const defaultDir = this.defaultDir(listed.adapter);
    const folder = await checkFolder({ raw: raw0, home: this.deps.home, defaultDir, taken: rows.map((r) => r.dir), look: this.look() });
    if (!folder.ok) return folder.code === "accounts.folder_taken" ? refusal(409, "accounts.folder_taken") : refusal(400, "accounts.bad_folder", { reason: folder.problem });

    const made = await this.makeFolder(kind, folder.dir, folder.exists, defaultDir, listed.adapter);
    if (made !== null) return made;

    const row: AccountRecord = {
      id: requestId,
      harness,
      label: name.label,
      kind,
      dir: folder.dir,
      addedAt: (this.deps.now ?? Date.now)(),
      device: caller.device,
    };
    const outcome = await this.deps.store.add(row);
    if (!outcome.ok) {
      if (outcome.reason === "label_taken") return refusal(409, "accounts.label_taken");
      if (outcome.reason === "folder_taken") return refusal(409, "accounts.folder_taken");
      if (outcome.reason === "full") return refusal(409, "accounts.limit", { max: MAX_ACCOUNTS });
      return refusal(503, "accounts.store_unreadable");
    }
    if (!outcome.replayed) {
      caller.audit.record({
        action: "account.add",
        session: caller.session,
        device: caller.device,
        detail: { requestId, harness, kind, label: row.label, folder: displayFolder(row.dir, this.deps.home) },
      });
    }
    return this.answerRow(outcome.row);
  }

  /** Make the folder an add needs. `null` when it is ready; a refusal otherwise. Nothing is stored yet. */
  private async makeFolder(kind: "shared" | "own", dir: string, exists: boolean, defaultDir: string, adapter: AccountAdapter): Promise<AccountsAnswer | null> {
    const disk = this.deps.disk;
    if (kind === "own") {
      if (exists) return (await disk.resolvedKind(dir)) === "dir" ? null : refusal(400, "accounts.bad_folder", { reason: "not a folder path" });
      try {
        await disk.mkdirp(dir);
        return null;
      } catch (err) {
        return refusal(500, "accounts.link_failed", { reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (adapter.share === undefined) return refusal(400, "accounts.kind_unsupported");
    const prepared = await prepareSharedFolder(disk, defaultDir, dir, adapter.share);
    if (!prepared.ok) {
      if (prepared.problem === "could not be made") return refusal(500, "accounts.link_failed", { reason: prepared.detail ?? prepared.problem });
      return refusal(400, "accounts.bad_folder", { reason: prepared.problem === "not empty" ? "not empty" : "not a folder path" });
    }
    try {
      await runLinkPass(disk, defaultDir, dir, adapter.share);
    } catch (err) {
      return refusal(500, "accounts.link_failed", { reason: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }

  private async answerRow(row: AccountRecord): Promise<AccountsAnswer> {
    const adapter = accountAdapter(row.harness);
    const launch = this.deps.harnesses.launch(row.harness);
    if (adapter === undefined || launch === undefined) return refusal(400, "accounts.unknown");
    return { status: 200, body: { ok: true, account: await this.rowWire(row, launch.binary, adapter, this.liveSet().ids.has(row.id)) } };
  }

  // ── POST /api/accounts/remove ─────────────────────────────────────────────────────────────

  /** Forget one added account. The folder, its links and its login stay (README decision 6). */
  async remove(raw: JsonValue, caller: AccountsCaller): Promise<AccountsAnswer> {
    const fields = asRecord(raw);
    const id = fields?.id;
    if (typeof id !== "string" || id === "") return { status: 400, body: { ok: false, error: "bad body" } };
    if (ACCOUNT_HARNESSES.some((h) => id === defaultAccountId(h))) return refusal(400, "accounts.default");
    if (!isRequestId(id)) return refusal(404, "accounts.unknown");
    const gone = await this.deps.store.remove(id);
    if (gone === "unwritable") return refusal(503, "accounts.store_unreadable");
    if (gone === null) return refusal(404, "accounts.unknown");
    caller.audit.record({
      action: "account.remove",
      session: caller.session,
      device: caller.device,
      detail: { requestId: gone.id, harness: gone.harness, label: gone.label, addedBy: gone.device },
    });
    return { status: 200, body: { ok: true } };
  }

  // ── The start ─────────────────────────────────────────────────────────────────────────────

  /**
   * The line a launch types for `harness` with `account` (an added account's id) and `signIn`.
   * `base` is the line without an account: the binary, or a recipe row's line. No account and no
   * sign-in is never asked here: the caller types `base` as it always did.
   */
  async startLine(input: { harness: string; base: string; account: string | undefined; signIn: boolean }): Promise<AccountStart> {
    const adapter = accountAdapter(input.harness);
    const args = input.signIn ? (adapter?.signInArgs ?? []) : [];
    if (input.account === undefined) return { ok: true, command: [input.base, ...args].join(" ") };
    if (!this.offered()) return { ok: false, status: 404, code: "accounts.unavailable" };
    if (input.account === defaultAccountId(input.harness)) return { ok: true, command: [input.base, ...args].join(" ") };
    const row = adapter === undefined ? undefined : await this.deps.store.get(input.account);
    if (adapter === undefined || row === undefined || row.harness !== input.harness) return { ok: false, status: 400, code: "accounts.unknown" };
    if (row.kind === "shared" && adapter.share !== undefined) {
      // A failed pass never blocks the start: what is not linked shows on the account's page.
      try {
        await runLinkPass(this.deps.disk, this.defaultDir(adapter), row.dir, adapter.share);
      } catch {
        /* reported by the page's own look */
      }
    }
    return { ok: true, command: accountStartLine(adapter, row.dir, input.base, args), account: row };
  }

}

/**
 * The journal roots the added `own` accounts add for `harness`, from the store's memory. A shared
 * account adds none: its `projects` is the default one, through the link (README decision 17).
 */
export function ownJournalRoots(store: Pick<AccountStoreSurface, "cached">, harness: string): string[] {
  const adapter = accountAdapter(harness);
  if (adapter === undefined) return [];
  return store
    .cached()
    .filter((r) => r.harness === harness && r.kind === "own")
    .map((r) => adapter.journalRoot(r.dir));
}

/** Whether `dir` is a folder under `home`, for a caller that shows a path. */
export function underHome(dir: string, home: string): boolean {
  return isUnder(dir, join(home, "."));
}
