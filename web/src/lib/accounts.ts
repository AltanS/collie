import { useCallback, useEffect, useState } from "react";

import { apiErrorStatus, fetchAccounts } from "@/lib/api";
import { savedAtLabel, timeAgo } from "@/lib/format";
import { t, tn } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";

// ACCOUNTS (M101): a second login for an agent, kept as a folder the agent already understands. The
// bridge owns the list (`GET /api/accounts`); this module is the phone's half of that wire: the
// shapes, the one read hook, and the pure helpers the Settings pages and the New page share.
//
// OPT IN AND INVISIBLE. A bridge that answers 404 (older, Windows, or no account-capable agent
// installed) means "no feature": the hook says `unavailable` and every caller draws nothing. A
// failed read is not an error state either; it leaves the feature hidden until the next mount.
//
// NO CLOSED LIST OF AGENTS. Ids, labels, the selector text, the kinds on offer and the new-folder
// pattern all come from the bridge's answer (`AccountHarness`), so a harness the bridge learns later
// shows up here without a change.

/** What picks the folder, the kinds Add may offer for one agent, and where a new shared folder goes. */
export interface AccountHarness {
  /** A launch id of the bridge's table. */
  id: string;
  label: string;
  /** What picks the folder, as text: `CLAUDE_CONFIG_DIR`. */
  select: string;
  kinds: ("shared" | "own")[];
  /** Pattern of a new shared folder, `~/.claude-{slug}`. */
  newFolder: string;
  /** The command that starts the agent. Absent from an older bridge: the id stands in for it. */
  binary?: string;
  /** Present when a sign-in that ends well reaches the sessions that already run (Change login). */
  reachesRunningSessions?: true;
  /** The hosts of the agent's sign-in address the phone may open. Absent: none, the address is text to copy. */
  signInHosts?: string[];
}

/** One window of a reading. `usedPct` null: the window passed its reset time and was not read since. */
export interface AccountWindow {
  window: string;
  label?: string;
  usedPct: number | null;
  resetsAt: number | null;
}

export interface AccountRow {
  /** `<harness>:default` for the Default row, an opaque stable id for an added one. */
  id: string;
  harness: string;
  /** Default rows carry the empty string; the app writes its own word. */
  label: string;
  kind: "default" | "shared" | "own";
  /** For reading: `~/.claude-work` when under the home folder. */
  folder: string;
  /** What a desktop terminal needs: `CLAUDE_CONFIG_DIR=~/.claude-work claude`. */
  startLine: string;
  windows: AccountWindow[];
  /** Milliseconds of the reading in `windows`; null when never read. */
  seenAt: number | null;
  /** A pane of this account runs now. */
  live: boolean;
  /** How many agent panes of this account run now, a sign-in session left out. Absent: none, or an older bridge. */
  running?: number;
  /** Ids of the panes on this machine that run in this row's folder, a sign-in session left out. Absent: none, or an older bridge. */
  panes?: string[];
  /** Shared only: entries that should be links and are not. */
  unlinked?: string[];
  /** Only where the adapter can tell. */
  hooks?: "installed" | "missing";
  /** Who is signed in, from the agent's own status command. Absent: unknown, or an older bridge. */
  identity?: AccountIdentity;
}

/** Who is signed in on an account. The email stays on this page; the app stores it nowhere. */
export interface AccountIdentity {
  signedIn: boolean;
  email?: string;
  /** The plan as the agent names it, `max`. */
  plan?: string;
}

/** A folder in use that is not added yet. */
export interface FoundFolder {
  harness: string;
  folder: string;
  path: string;
  why: "reported" | "name";
}

export interface AccountsBody {
  harnesses: AccountHarness[];
  accounts: AccountRow[];
  found: FoundFolder[];
}

/** The body of POST /api/accounts. `path` is required for an `own` account. */
export interface AddAccountAsk {
  harness: string;
  label: string;
  kind: "shared" | "own";
  path?: string;
}

/** The lowest used percentage drawn hot. Same line as the dots above the belt. */
export const HOT_FROM = 80;

// ── The read ──────────────────────────────────────────────────────────────────────────────────────

export interface AccountsState {
  /** `loading` until the first answer. `unavailable`: a 404, so no feature. `failed`: any other failure. */
  status: "loading" | "ready" | "unavailable" | "failed";
  body: AccountsBody | null;
  /** The `host\u0000session` of the scope the answer belongs to; `null` before the first answer. */
  loadedFor: string | null;
}

const EMPTY: AccountsState = { status: "loading", body: null, loadedFor: null };

/** The key {@link AccountsState.loadedFor} is written with. */
export function accountsKey(scope: Scope | undefined): string {
  return `${scope?.host ?? ""}\u0000${scope?.session ?? ""}`;
}

/**
 * Reactive read of one machine's accounts, forwarded on `?host=` like the launcher rows
 * (lib/launchers.ts). Read on mount and whenever the scope changes. `enabled` false reads nothing.
 */
export function useAccounts(scope?: Scope, enabled = true): AccountsState & { reload: () => void } {
  const host = scope?.host;
  const session = scope?.session;
  const [state, setState] = useState<AccountsState>(EMPTY);
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const loadedFor = accountsKey({ host, session });
      try {
        const body = await fetchAccounts(host === undefined && session === undefined ? undefined : { host, session });
        if (!cancelled) setState({ status: "ready", body, loadedFor });
      } catch (error) {
        if (cancelled) return;
        // A 404 is the bridge saying "no accounts here". Anything else is a failed read; both hide the feature.
        setState({ status: apiErrorStatus(error) === 404 ? "unavailable" : "failed", body: null, loadedFor });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, session, enabled, round]);

  return { ...state, reload };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────────

/** The rows an added account makes, for one agent: every row but its Default. */
export function addedOf(body: AccountsBody | null, harness: string): AccountRow[] {
  return (body?.accounts ?? []).filter((a) => a.harness === harness && a.kind !== "default");
}

/** How many accounts the person added, all agents together. */
export function addedCount(body: AccountsBody | null): number {
  return (body?.accounts ?? []).filter((a) => a.kind !== "default").length;
}

/** One agent with its rows, Default first, in the bridge's order. */
export interface AccountGroup {
  harness: string;
  /** The agent's label, else its id for an agent the bridge no longer lists. */
  label: string;
  rows: AccountRow[];
}

/** The rows grouped by agent, in the order the bridge lists its agents; an unlisted agent follows. */
export function groupAccounts(body: AccountsBody): AccountGroup[] {
  const groups: AccountGroup[] = body.harnesses.map((h) => ({ harness: h.id, label: h.label, rows: [] }));
  for (const row of body.accounts) {
    let group = groups.find((g) => g.harness === row.harness);
    if (group === undefined) {
      group = { harness: row.harness, label: row.harness, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups.filter((g) => g.rows.length > 0);
}

/** The name the person reads: the label, and the app's own word for a Default row. */
export function accountName(row: AccountRow): string {
  return row.kind === "default" ? t("accounts.default") : row.label;
}

/** The label of an agent in a body, else its id. */
export function harnessLabel(body: AccountsBody | null, id: string): string {
  return body?.harnesses.find((h) => h.id === id)?.label ?? id;
}

// ── Who is signed in ──────────────────────────────────────────────────────────────────────────────

/** A plan in plain words: `max` reads "Max", `team_plus` reads "Team Plus". */
export function planWords(plan: string): string {
  return plan
    .split(/[_-]+/u)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The details row's value: the email, then the plan when known. Null when there is nothing to say. */
export function signedInText(identity: AccountIdentity): string | null {
  const plan = identity.plan === undefined ? undefined : planWords(identity.plan);
  if (identity.email !== undefined && plan !== undefined && plan !== "") return t("accounts.identity.withPlan", { email: identity.email, plan });
  if (identity.email !== undefined) return identity.email;
  return plan === undefined || plan === "" ? null : plan;
}

/**
 * The first OTHER profile of the same agent that is signed in with the same email, else undefined. The
 * emails compare in any letter case. A row that is not signed in, or whose agent named no email, has none.
 */
export function sameLoginAs(rows: readonly AccountRow[], row: AccountRow): AccountRow | undefined {
  const email = row.identity?.signedIn === true ? row.identity.email?.toLowerCase() : undefined;
  if (email === undefined) return undefined;
  return rows.find(
    (other) => other.id !== row.id && other.harness === row.harness && other.identity?.signedIn === true && other.identity.email?.toLowerCase() === email,
  );
}

/** "Same login as Work.", naming the first other profile that shares the login; null when none does. */
export function sameLoginLine(rows: readonly AccountRow[], row: AccountRow): string | null {
  const other = sameLoginAs(rows, row);
  return other === undefined ? null : t("accounts.sameLogin", { name: accountName(other) });
}

// ── Windows ───────────────────────────────────────────────────────────────────────────────────────

/** The app's own word for a window key it knows by name and that carries no label of its own, else null. */
export function knownWindowName(key: string): string | null {
  if (key === "spend") return t("accounts.window.spend");
  if (key === "credits") return t("accounts.window.credits");
  return null;
}

/**
 * The words for a window. `5h` is 5 hours, `7d` is Week, `7d:<scope>` is Week plus the scope. `spend`
 * and `credits` have words of their own. Any other key reads its label, else the key; a label the
 * agent sent always wins over the app's word.
 */
export function windowName(w: AccountWindow): string {
  if (w.window === "5h") return t("accounts.window.session");
  if (w.window === "7d") return t("accounts.window.week");
  if (w.window.startsWith("7d:")) return t("accounts.window.weekScope", { scope: w.label ?? w.window.slice(3) });
  return w.label ?? knownWindowName(w.window) ?? w.window;
}

/** Whether a reading is drawn hot. Never for a window that passed its reset. */
export function isHot(w: AccountWindow): boolean {
  return w.usedPct !== null && w.usedPct >= HOT_FROM;
}

/** The figure at the end of a bar. */
export function windowFigure(w: AccountWindow): string {
  return w.usedPct === null ? t("accounts.window.reset") : t("accounts.window.used", { pct: Math.round(w.usedPct) });
}

/** The line under a window's name in the long form: when it resets, or that it is over and not read since. */
export function windowDetail(w: AccountWindow, now: number = Date.now()): string {
  if (w.usedPct === null) return t("accounts.window.over");
  if (w.resetsAt === null) return "";
  return t("accounts.window.resets", { when: savedAtLabel(w.resetsAt, now) });
}

/** "In use now" while a pane runs, else the age of the last reading, else nothing. */
export function seenLine(row: AccountRow, now: number = Date.now()): string | null {
  if (row.live) return t("accounts.seen.live");
  if (row.seenAt === null) return null;
  return t("accounts.seen.ago", { when: timeAgo(row.seenAt, now) });
}

/**
 * The list row's first foot word: how many sessions run in the profile ("2 sessions"), else
 * {@link seenLine}. A profile that is live with no counted session (only a sign-in session runs) keeps
 * "In use now", as one the bridge does not count for.
 */
export function listSeenLine(row: AccountRow, now: number = Date.now()): string | null {
  if (row.running !== undefined && row.running > 0) return tn("accounts.sessions", row.running);
  return seenLine(row, now);
}

// ── Add ───────────────────────────────────────────────────────────────────────────────────────────

/** A label as the bridge slugs it for a folder name: lower case, `[a-z0-9-]`, spaces to `-`. */
export function slugOf(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

/** Where a new shared folder goes, for reading. An empty slug shows the word `name`. */
export function newFolderFor(harness: AccountHarness, label: string): string {
  return harness.newFolder.replace("{slug}", slugOf(label) || "name");
}

/** The line that starts an account from a desktop terminal, for a folder not made yet. */
export function startLineFor(harness: AccountHarness, folder: string): string {
  // A selector written like a variable name is set before the command; anything else is a flag.
  const asVariable = /^[A-Z_][A-Z0-9_]*$/u.test(harness.select);
  const command = harness.binary ?? harness.id;
  return asVariable ? `${harness.select}=${folder} ${command}` : `${command} ${harness.select} ${folder}`;
}

/** The longest folder, in code points. Mirrors `MAX_FOLDER_CHARS` in bridge/account-folder.ts. */
const MAX_FOLDER_CHARS = 200;

/**
 * Whether a typed folder already fails the character rules the bridge enforces (bridge/account-folder.ts):
 * a control or bidi character, a quote, a backslash, a backtick, `$`, or more than 200 characters. The
 * bridge's answer on submit says why; this only lets the page stop drawing a line that cannot work.
 */
export function folderTextInvalid(text: string): boolean {
  if ([...text].length > MAX_FOLDER_CHARS) return true;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isForbiddenCode(code) || "'\"\\`$".includes(ch)) return true;
  }
  return false;
}

/** Control and bidi code points, as `isForbiddenCodePoint` in bridge/launcher-recipes.ts. */
function isForbiddenCode(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0x200e || code === 0x200f || code === 0x061c;
}

const MAX_LABEL = 24;

/**
 * A first name for a found folder: its last part, without the leading dot and the agent's own word,
 * with a capital. `~/.claude-work` for `claude` reads `Work`. Empty when nothing is left.
 */
export function nameFromFolder(folder: string, harness: string): string {
  const parts = folder.split(/[\\/]/u).filter((p) => p !== "");
  let name = (parts[parts.length - 1] ?? "").replace(/^\.+/u, "");
  const lead = `${harness}-`;
  if (name.toLowerCase().startsWith(lead)) name = name.slice(lead.length);
  name = name.replace(/[-_]+/gu, " ").trim().slice(0, MAX_LABEL).trim();
  return name === "" ? "" : name.charAt(0).toUpperCase() + name.slice(1);
}

// ── A start that failed after the account was made ────────────────────────────────────────────────

const startErrors = new Map<string, string>();

/** Keep why the sign-in start failed, for the account's page to say once when it opens. */
export function rememberStartError(id: string, message: string): void {
  startErrors.set(id, message);
}

/** The kept reason for an account, once; a second read answers nothing. */
export function takeStartError(id: string): string | null {
  const message = startErrors.get(id) ?? null;
  startErrors.delete(id);
  return message;
}
