import { join } from "node:path";

import { accountAdapter, ACCOUNT_HARNESSES, selectText, type AccountAdapter, type AccountIdentity, type AccountStatus } from "./account-adapters.ts";
import { AccountIdentities, IDENTITY_SIGN_IN_MS, IDENTITY_TTL_MS, IDENTITY_WAIT_MS, settledWithin, type StatusRunner } from "./account-identity.ts";
import { accountStartLine, checkFolder, checkLabel, displayFolder, displayStartLine, isUnder, parseFolderPath, sameLabel, type FolderLook } from "./account-folder.ts";
import { inspectLinks, prepareSharedFolder, runLinkPass, type LinkDisk } from "./account-links.ts";
import { MAX_ACCOUNTS, type AccountRecord, type AccountStoreSurface } from "./accounts-store.ts";
import type { AuditLog } from "./audit.ts";
import { documentCarriesOurHooks } from "./beacon-io.ts";
import { apiError, type ApiErrorDetail, type ErrorCode } from "./error-codes.ts";
import type { HarnessProbe } from "./harness-launch.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { AccountHarness, AccountRow, AccountsBody, AccountWindow, AgentView, FoundFolder, PaneAccount } from "./types.ts";
import type { UsageSeen } from "./usage-seen.ts";
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
// WHO IS SIGNED IN (spec 04) is asked of the agent itself: its own status command (`claude auth
// status`), run through one injected seam (bridge/account-identity.ts holds the runner and its guards)
// and read by the adapter's parser, which keeps a sign-in flag, an email and a plan and drops the rest.
// Still no login file is opened. The command never runs for a folder the agent has not run in yet
// (none of the adapter's `status.needs` names exists there, checked by existence only), because it would
// create the agent's state file there first: that account reads "not signed in" with no run. A held
// identity is served at once and refreshed in the background after 60 s (5 s while its sign-in pane
// lives); only an account with none held waits, at most 1.5 s. The identity lives in memory only and is
// never written to disk, an audit line, a journal, a receipt, a trouble ping or a log line. It goes to
// the phone in the list.
//
// WINDOWS. The start line is `NAME='<folder>' <binary>`, a form Windows shells do not take, so on a
// Windows host there are no accounts in this milestone: the read answers `accounts.unavailable`, an add
// is refused the same way, and so is a launch that names an account.

/** A route's answer, for bridge/server.ts to send. */
export interface AccountsAnswer {
  status: number;
  body: JsonValue | AccountsBody | { ok: true; account: AccountRow } | { ok: true };
}

/** One reading of an account's windows: the live or last-seen reading the bridge holds, from memory. */
export type AccountReading = (harness: string, dir: string | undefined) => { windows: AccountWindow[]; at: number } | null;

/**
 * The seam's real source: the last reading of each (harness, folder) the bridge held
 * (bridge/usage-seen.ts). `dir` is the account's cleaned folder, undefined for Default; the store keys
 * the same way ("" for the default folder, else `join(dir, ".")`), so the folder an agent reported and
 * the folder an account holds meet. `at` is when the bridge held the reading, never the time of the ask.
 */
export function seenReading(seen: Pick<UsageSeen, "reading">, now: () => number): AccountReading {
  return (harness, dir) => {
    const reading = seen.reading(harness, dir, now());
    if (reading === null) return null;
    const windows = reading.windows.map((w): AccountWindow => {
      const out: AccountWindow = { window: w.window, usedPct: w.usedPct, resetsAt: w.resetsAt };
      if (w.label !== undefined) out.label = w.label;
      return out;
    });
    return { windows, at: reading.at };
  };
}

/** Where a session reported its config folder: raw string, `null` for the default, `undefined` unknown. */
export interface ReportedFolders {
  reportedConfigDir(pane: AgentView): string | null | undefined;
  reportedConfigDirs(): readonly { harness: string; dir: string }[];
}

export interface AccountsDeps {
  store: AccountStoreSurface;
  /** Runs an agent's own status command (bridge/account-identity.ts). Absent: no row shows who is signed in. */
  status?: StatusRunner;
  /** The longest a list read waits for identities. {@link IDENTITY_WAIT_MS} unless a test sets it. */
  identityWaitMs?: number;
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
  | {
      ok: true;
      command: string;
      account?: AccountRecord;
      /** A sign-in start: the account it signs in, for {@link Accounts.noteSignIn} once the line is typed. */
      signInFor?: string;
    }
  | { ok: false; status: number; code: ErrorCode; detail?: ApiErrorDetail };

/** The key of an account's identity: the harness and the cleaned folder (the default one for Default). */
function identityKey(harness: string, folder: string): string {
  return `${harness}\u0000${folder}`;
}

/**
 * The bridge's environment for a status run: every set variable but the bridge's own settings (names that
 * start with `COLLIE_`, from the instance's config file), which the agent's status command never needs.
 */
export function withoutBridgeSettings(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("COLLIE_"));
  return Object.fromEntries(kept);
}

/** The id of a harness's Default row. */
export function defaultAccountId(harness: string): string {
  return `${harness}:default`;
}

/**
 * Which accounts have a pane running now, and how many: harnesses whose Default does, and added account
 * ids. A sign-in session is left out of the counts (Change login: "N sessions continue").
 */
interface LiveAccounts {
  defaults: Set<string>;
  ids: Set<string>;
  /** Agent panes per harness on its Default, sign-in sessions left out. */
  defaultCounts: Map<string, number>;
  /** Agent panes per added account id, sign-in sessions left out. */
  idCounts: Map<string, number>;
  /** The ids of the panes counted in `defaultCounts`, per harness. */
  defaultPanes: Map<string, string[]>;
  /** The ids of the panes counted in `idCounts`, per added account id. */
  idPanes: Map<string, string[]>;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The most pane ids one row lists. */
const MAX_ROW_PANES = 64;

function addPane(panes: Map<string, string[]>, key: string, paneId: string): void {
  const held = panes.get(key) ?? [];
  if (held.length < MAX_ROW_PANES) held.push(paneId);
  panes.set(key, held);
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
  /** Who is signed in, per account, in memory. Undefined without a status seam. */
  private readonly identities: AccountIdentities | undefined;
  /** The panes a sign-in start was typed into (`session\u0000paneId`), with the account's identity key. */
  private readonly signIns = new Map<string, string>();

  constructor(private readonly deps: AccountsDeps) {
    this.identities = deps.status === undefined ? undefined : new AccountIdentities({ run: deps.status, now: deps.now ?? Date.now });
  }

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

  /** The folder of the pane's added account, or undefined for the Default and an unknown folder. */
  folderOf(session: string, pane: AgentView): string | undefined {
    return this.accountOf(session, pane)?.dir;
  }

  /**
   * The environment the pane's agent runs under, as far as its account sets it: the bridge's own with
   * the account's variable laid over. For a scan that reads the agent's folder the way the agent does
   * (its skills and commands), so it reads the account's folder, not the default one.
   */
  envOf(session: string, pane: AgentView): AccountsDeps["env"] {
    const row = this.accountOf(session, pane);
    const adapter = row === undefined ? undefined : accountAdapter(row.harness);
    if (row === undefined || adapter === undefined) return this.deps.env;
    return { ...this.deps.env, [adapter.select.env]: row.dir };
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

  /**
   * Note that a sign-in start for an account was typed into `paneId`: its identity is dropped now, and
   * read again at a list read once it is 5 s old, for as long as that pane lives (decision 6). The pane
   * is the trigger because it is the one place a login changes from the phone; reading the screen for a
   * sign-in field would tie this to every harness's screen. When the pane goes, the identity is dropped
   * once more, so a sign-in finished just before it closed shows at the next read.
   */
  noteSignIn(session: string, paneId: string, signInFor: string): void {
    this.identities?.drop(signInFor);
    const key = `${session}\u0000${paneId}`;
    this.signIns.delete(key);
    this.signIns.set(key, signInFor);
    for (const old of this.signIns.keys()) {
      if (this.signIns.size <= MAX_NOTES) break;
      this.signIns.delete(old);
    }
  }

  /** Drop the notes of panes that are gone from `session`. */
  keep(session: string, paneIds: readonly string[]): void {
    const alive = new Set(paneIds);
    const prefix = `${session}\u0000`;
    for (const key of this.notes.keys()) {
      if (key.startsWith(prefix) && !alive.has(key.slice(prefix.length))) this.notes.delete(key);
    }
    for (const [key, signInFor] of this.signIns) {
      if (!key.startsWith(prefix) || alive.has(key.slice(prefix.length))) continue;
      this.signIns.delete(key);
      this.identities?.drop(signInFor);
    }
  }

  private liveSet(): LiveAccounts {
    const defaults = new Set<string>();
    const ids = new Set<string>();
    const defaultCounts = new Map<string, number>();
    const idCounts = new Map<string, number>();
    const defaultPanes = new Map<string, string[]>();
    const idPanes = new Map<string, string[]>();
    for (const { session, pane } of this.deps.panes?.() ?? []) {
      if (pane.kind === "shell" || accountAdapter(pane.agent) === undefined) continue;
      const row = this.accountOf(session, pane);
      const signIn = this.signIns.has(`${session}\u0000${pane.paneId}`);
      if (row !== undefined) {
        ids.add(row.id);
        if (!signIn) {
          bump(idCounts, row.id);
          addPane(idPanes, row.id, pane.paneId);
        }
      } else if (typeof this.deps.reported?.reportedConfigDir(pane) !== "string") {
        defaults.add(pane.agent);
        if (!signIn) {
          bump(defaultCounts, pane.agent);
          addPane(defaultPanes, pane.agent, pane.paneId);
        }
      }
    }
    return { defaults, ids, defaultCounts, idCounts, defaultPanes, idPanes };
  }

  // ── GET /api/accounts ─────────────────────────────────────────────────────────────────────

  private hooksOf(adapter: AccountAdapter, dir: string): "installed" | "missing" | undefined {
    if (adapter.hooksFile === undefined || this.deps.readText === undefined) return undefined;
    const text = this.deps.readText(adapter.hooksFile(dir));
    return text !== null && documentCarriesOurHooks(text) ? "installed" : "missing";
  }

  private windowsOf(harness: string, dir: string | undefined): Pick<AccountRow, "windows" | "seenAt"> {
    // The seam reads memory only (the last reading the bridge held, README decision 12), so an account
    // with no live pane shows its last reading with its age. Nothing here asks a vendor: that ask runs
    // only for a folder with a live pane (ADR 0118, README decision 5), in bridge/account-windows.ts.
    const reading = this.deps.reading?.(harness, dir) ?? null;
    return reading === null ? { windows: [], seenAt: null } : { windows: reading.windows, seenAt: reading.at };
  }

  /** The bridge's own environment less its own settings, with the account's variable laid over it as a start sets it. */
  private statusEnv(adapter: AccountAdapter, dir: string | undefined): Record<string, string> {
    const env = withoutBridgeSettings(this.deps.env);
    if (dir !== undefined) env[adapter.select.env] = dir;
    return env;
  }

  /**
   * Who is signed in on one account: `dir` is an added account's stored folder, undefined for Default.
   * Null is unknown: no status command for this agent, no seam, or an answer the parser cannot read.
   */
  private async identityOf(input: { harness: string; binary: string; adapter: AccountAdapter; dir: string | undefined; maxAge: number }): Promise<AccountIdentity | null> {
    const status = input.adapter.status;
    if (this.identities === undefined || status === undefined) return null;
    const folder = input.dir ?? this.defaultDir(input.adapter);
    // A missing folder, or one the agent has not run in yet, is not signed in, with no run (decision 5,
    // narrowed by the lead on 2026-11-16 to the adapter's `needs`).
    if (!(await this.agentHasRun(status, folder, input.dir === undefined))) return { signedIn: false };
    return this.identities.read({
      key: identityKey(input.harness, folder),
      binary: input.binary,
      args: status.args,
      env: this.statusEnv(input.adapter, input.dir),
      parse: status.parse,
      maxAge: input.maxAge,
    });
  }

  /** Whether one of the adapter's `needs` names exists in `folder` (or, for Default, at home). Existence only. */
  private async agentHasRun(status: AccountStatus, folder: string, isDefault: boolean): Promise<boolean> {
    const paths = [...status.needs.map((name) => join(folder, name)), ...(isDefault ? (status.needsAtHome ?? []).map((name) => join(this.deps.home, name)) : [])];
    for (const path of paths) {
      if ((await this.deps.disk.kindOf(path)) !== "missing") return true;
    }
    return false;
  }

  /** Every listed account's identity that is ready within the wait, by identity key. */
  private async who(listed: readonly { id: string; binary: string; adapter: AccountAdapter }[], rows: readonly AccountRecord[]): Promise<Map<string, AccountIdentity>> {
    const out = new Map<string, AccountIdentity>();
    if (this.identities === undefined) return out;
    const watched = new Set(this.signIns.values());
    const asks: { key: string; answer: Promise<AccountIdentity | null> }[] = [];
    for (const h of listed) {
      if (h.adapter.status === undefined) continue;
      const dirs: (string | undefined)[] = [undefined, ...rows.filter((r) => r.harness === h.id).map((r) => r.dir)];
      for (const dir of dirs) {
        const key = identityKey(h.id, dir ?? this.defaultDir(h.adapter));
        const maxAge = watched.has(key) ? IDENTITY_SIGN_IN_MS : IDENTITY_TTL_MS;
        asks.push({ key, answer: this.identityOf({ harness: h.id, binary: h.binary, adapter: h.adapter, dir, maxAge }) });
      }
    }
    const answers = await settledWithin(
      asks.map((a) => a.answer),
      this.deps.identityWaitMs ?? IDENTITY_WAIT_MS,
    );
    for (const [i, ask] of asks.entries()) {
      const identity = answers[i];
      if (identity !== undefined && identity !== null) out.set(ask.key, identity);
    }
    return out;
  }

  /** The body of the read, or null when this machine offers no accounts. */
  async body(): Promise<AccountsBody | null> {
    if (!this.offered()) return null;
    const listed = await this.listed();
    if (listed.length === 0) return null;
    const rows = await this.deps.store.list();
    const live = this.liveSet();
    const who = await this.who(listed, rows);
    const harnesses: AccountHarness[] = listed.map((h) => {
      const out: AccountHarness = {
        id: h.id,
        label: h.label,
        select: selectText(h.adapter.select),
        kinds: this.kinds(h.adapter),
        newFolder: h.adapter.newFolder,
        binary: h.binary,
      };
      if (h.adapter.reachesRunningSessions === true) out.reachesRunningSessions = true;
      if (h.adapter.signInHosts !== undefined && h.adapter.signInHosts.length > 0) out.signInHosts = [...h.adapter.signInHosts];
      return out;
    });
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
        ...this.windowsOf(h.id, undefined),
        live: isLive,
      };
      const defaultRunning = live.defaultCounts.get(h.id) ?? 0;
      if (defaultRunning > 0) defaultRow.running = defaultRunning;
      const defaultPaneIds = live.defaultPanes.get(h.id);
      if (defaultPaneIds !== undefined && defaultPaneIds.length > 0) defaultRow.panes = defaultPaneIds;
      const defaultHooks = this.hooksOf(h.adapter, defaultDir);
      if (defaultHooks !== undefined) defaultRow.hooks = defaultHooks;
      const defaultWho = who.get(identityKey(h.id, defaultDir));
      if (defaultWho !== undefined) defaultRow.identity = defaultWho;
      accounts.push(defaultRow);
      for (const r of rows.filter((row) => row.harness === h.id)) {
        const row = await this.rowWire(r, h.binary, h.adapter, live.ids.has(r.id), who.get(identityKey(r.harness, r.dir)));
        const running = live.idCounts.get(r.id) ?? 0;
        if (running > 0) row.running = running;
        const paneIds = live.idPanes.get(r.id);
        if (paneIds !== undefined && paneIds.length > 0) row.panes = paneIds;
        accounts.push(row);
      }
    }
    return { harnesses, accounts, found: await this.found(listed.map((h) => h.adapter), listed.map((h) => h.id), rows) };
  }

  private async rowWire(r: AccountRecord, binary: string, adapter: AccountAdapter, live: boolean, identity?: AccountIdentity): Promise<AccountRow> {
    const row: AccountRow = {
      id: r.id,
      harness: r.harness,
      label: r.label,
      kind: r.kind,
      folder: displayFolder(r.dir, this.deps.home),
      startLine: displayStartLine(adapter, r.dir, binary, this.deps.home),
      ...this.windowsOf(r.harness, r.dir),
      live,
    };
    if (r.kind === "shared" && adapter.share !== undefined) {
      row.unlinked = (await inspectLinks(this.deps.disk, this.defaultDir(adapter), r.dir, adapter.share)).unlinked;
    }
    const hooks = this.hooksOf(adapter, r.dir);
    if (hooks !== undefined) row.hooks = hooks;
    if (identity !== undefined) row.identity = identity;
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
    // The kept identity only: an add answers at once, and the list read that follows asks the agent.
    const kept = this.identities?.peek(identityKey(row.harness, row.dir)) ?? undefined;
    return { status: 200, body: { ok: true, account: await this.rowWire(row, launch.binary, adapter, this.liveSet().ids.has(row.id), kept) } };
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
   *
   * A sign-in on an account that reads signed in adds the adapter's `signInAgainArgs` (Claude: `/login`),
   * so the agent opens its login menu and not a plain session (decision 9). The bridge decides from the
   * identity it holds, never from the request; not signed in, unknown or none held starts as before.
   */
  async startLine(input: { harness: string; base: string; account: string | undefined; signIn: boolean }): Promise<AccountStart> {
    const adapter = accountAdapter(input.harness);
    if (input.account === undefined) return this.defaultStart(input, adapter);
    if (!this.offered()) return { ok: false, status: 404, code: "accounts.unavailable" };
    if (input.account === defaultAccountId(input.harness)) return this.defaultStart(input, adapter);
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
    const command = accountStartLine(adapter, row.dir, input.base, this.signInArgs(input, adapter, row.dir));
    const signInFor = this.signInFor(input, adapter, row.dir);
    return signInFor === undefined ? { ok: true, command, account: row } : { ok: true, command, account: row, signInFor };
  }

  /** The Default account's start: the base line, with the sign-in words when it is a sign-in. */
  private defaultStart(input: { harness: string; base: string; signIn: boolean }, adapter: AccountAdapter | undefined): AccountStart {
    if (adapter === undefined) return { ok: true, command: input.base };
    const folder = this.defaultDir(adapter);
    const command = [input.base, ...this.signInArgs(input, adapter, folder)].join(" ");
    const signInFor = this.signInFor(input, adapter, folder);
    return signInFor === undefined ? { ok: true, command } : { ok: true, command, signInFor };
  }

  /** The words after the line for a sign-in on `folder`: login-menu words while it reads signed in. */
  private signInArgs(input: { harness: string; signIn: boolean }, adapter: AccountAdapter, folder: string): readonly string[] {
    if (!input.signIn) return [];
    const again = adapter.signInAgainArgs;
    const signedIn = this.offered() && this.identities?.peek(identityKey(input.harness, folder))?.signedIn === true;
    if (again !== undefined && signedIn) return again;
    return adapter.signInArgs ?? [];
  }

  /** The identity key a sign-in start drops and watches, when this bridge reads identities at all. */
  private signInFor(input: { harness: string; signIn: boolean }, adapter: AccountAdapter, folder: string): string | undefined {
    if (!input.signIn || this.identities === undefined || adapter.status === undefined || !this.offered()) return undefined;
    return identityKey(input.harness, folder);
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
