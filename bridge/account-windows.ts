// The account's 5-hour and 7-day windows, asked of the vendor with the operator's OWN harness login
// (.adr/0118). The dots beside the model tag draw them (bridge/usage.ts joins them onto each pane).
//
// Four harnesses have a source, one table ({@link defaultAccountSources}), one lifecycle, one off
// switch. Claude is the one proven live (2026-10-24). Codex, OpenCode Go and Grok take their shape
// from third-party readers (CodexBar, oh-my-pi) and are unverified live: every field of their answers
// is optional, and a body that does not parse costs the reading, never the pane. Codex needs no login
// at all (its own session files carry the numbers); OpenCode Go and Grok ask their vendor with the
// login their CLI keeps, under the same rules as Claude's below.
//
// ── WHERE THE NUMBERS COME FROM ───────────────────────────────────────────────────────────────────
//
// The windows belong to the account, not to a session, and hooks never carry them. Claude Code learns
// them from one call, the same one its `/usage` screen makes:
//
//   GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <the login's access token>
//   anthropic-beta: oauth-2025-04-20
//
// Collie makes that call on this machine with the login Claude Code already keeps here
// (`~/.claude/.credentials.json`, or `$CLAUDE_CONFIG_DIR/.credentials.json`; the Keychain on a Mac
// whose file is absent). It holds no key of its own.
//
// ── WHAT THE TOKEN MAY DO ─────────────────────────────────────────────────────────────────────────
//
// It is read for one request and lives in a local variable for that request only: never a field,
// never a log line, never an error message, never a receipt, never a file. It goes to
// `api.anthropic.com` and nowhere else. Collie never refreshes it and never reads the refresh token:
// an expired token is refused, and Claude Code refreshes it on its own next call. A login file that
// group or other may read is refused too, because a file in that state is not the one Claude Code
// wrote.
//
// ── WHEN IT ASKS ──────────────────────────────────────────────────────────────────────────────────
//
// Only while this bridge has at least one pane of the harness: once when there is no reading yet, once
// after a turn ends (at most once a minute), and every five minutes. A refusal or a failure backs off
// ({@link BACKOFF}); a reading older than {@link STALE_AFTER_MS} is not drawn. The endpoint is
// undocumented and changed its shape once, so the parser takes both shapes, and a body it cannot read
// costs the reading, never the pane.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import {
  ACCOUNT_WINDOW_HARNESSES,
  ACCOUNT_WINDOWS_DEFAULT,
  ACCOUNT_WINDOWS_UNVERIFIED,
  accountWindowsProblem,
  type AccountWindowsSetting,
} from "./account-windows-setting.ts";
import { HOST } from "./host.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { AgentStatus, AgentView } from "./types.ts";
import { asPercent, USAGE_WINDOWS, type UsageLimit, type UsageWindow } from "./usage.ts";

/** The one host the token is ever sent to. */
export const CLAUDE_USAGE_HOST = "api.anthropic.com";
export const CLAUDE_USAGE_URL = `https://${CLAUDE_USAGE_HOST}/api/oauth/usage`;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

/** OpenCode Go's usage endpoint (the account endpoint stays on Zen, beside the inference one). */
export const OPENCODE_USAGE_HOST = "opencode.ai";
export const OPENCODE_USAGE_URL = `https://${OPENCODE_USAGE_HOST}/zen/go/v1/usage`;
/** The entry of OpenCode's auth store that holds the Go key. */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** Grok's CLI-proxy billing endpoint, the one `grok` itself reads credits from. */
export const GROK_USAGE_HOST = "cli-chat-proxy.grok.com";
export const GROK_USAGE_URL = `https://${GROK_USAGE_HOST}/v1/billing?format=credits`;

/** Codex rollout files younger than this are read; an older session says nothing about now. */
export const CODEX_FRESH_MS = 2 * 60 * 60_000;
/** How much of the end of a rollout file is read. */
export const CODEX_TAIL_BYTES = 256 * 1024;
/** At most this many rollout files are read per refresh. */
export const CODEX_FILES_MAX = 3;

/** The Keychain item Claude Code keeps its login in on macOS. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** At most one ask per harness this often, however many turns end. */
export const POKE_EVERY_MS = 60_000;
/** The steady ask while a pane of the harness exists. */
export const ASK_EVERY_MS = 5 * 60_000;
/** A reading older than this is not drawn: stale windows are worse than none. */
export const STALE_AFTER_MS = 20 * 60_000;
/** How long one ask may take. */
export const FETCH_TIMEOUT_MS = 10_000;
/** How long the macOS Keychain read may take. */
export const KEYCHAIN_TIMEOUT_MS = 3_000;

/** How long to wait after each kind of failure before asking again. */
export const BACKOFF = {
  /** 401 or 403: the account may have logged out. The reading is dropped. */
  denied: 15 * 60_000,
  /** 429: the vendor asks us to slow down. The reading is kept. */
  limited: 15 * 60_000,
  /** No answer, a timeout, or a 5xx. The reading is kept. */
  network: 2 * 60_000,
  /** A body this build cannot read. The reading is kept. */
  unreadable: 5 * 60_000,
  /** The token has expired. Claude Code refreshes it at its next call, so look again soon. */
  expired: 60_000,
  /** No login, a login file others may read, or one that does not parse. */
  refused: 5 * 60_000,
  /** A local source (Codex's session files) had no window to show. Reading a few files is cheap. */
  none: 60_000,
} as const;

/** The largest login file or Keychain answer this build reads. Claude Code's is well under 2 KiB. */
const CREDENTIAL_MAX_BYTES = 64 * 1024;
/** The largest usage answer this build reads. */
const BODY_MAX_BYTES = 256 * 1024;
/** A bearer token is printable ASCII with no space, and short. */
const BEARER_TOKEN = /^[\x21-\x7e]{1,4095}$/;

// ── The answer ──────────────────────────────────────────────────────────────────────────────────

/**
 * A window the phone does not draw: a model-scoped weekly window (Claude's `weekly_scoped`), or a
 * window that is not 5 hours or 7 days (a monthly OpenCode Go or Grok period, an odd Codex window).
 * Parsed and kept for a later build; the phone draws two gauges today, so these never reach
 * {@link AccountWindows.limits}.
 */
export interface ScopedWindow {
  /** The model's display name or the window's length (`30d`), trimmed and stripped of control characters. */
  label: string;
  used: number;
  resetsAt?: number;
}

/** What one good answer said. */
export interface AccountReading {
  /** The 5-hour and 7-day windows, in {@link USAGE_WINDOWS} order. Empty for an account without them. */
  limits: UsageLimit[];
  scoped: ScopedWindow[];
}

function asResetMs(value: JsonValue | undefined): number | undefined {
  const text = asJsonString(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function limitOf(window: UsageWindow, used: number | undefined, resetsAt: number | undefined): UsageLimit | undefined {
  if (used === undefined) return undefined;
  return resetsAt === undefined ? { window, used } : { window, used, resetsAt };
}

function cleanLabel(value: JsonValue | undefined): string | undefined {
  const text = asJsonString(value);
  if (text === undefined) return undefined;
  // SAFETY: the class is control characters on purpose; a label from the wire must not carry them.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return clean === "" ? undefined : clean;
}

/**
 * The windows in a usage answer, or null when the body is not one this build reads. Two shapes: the
 * newer `limits[]` (`kind: "session" | "weekly_all" | "weekly_scoped"`, `percent`, `resets_at`), and
 * the older flat `five_hour` / `seven_day` (`utilization`, `resets_at`). A window `limits[]` names wins;
 * a window it does not name falls back to the flat field. A body with neither shape is unreadable; a
 * body whose windows are all `null` is an account without windows.
 */
export function parseAccountUsage(text: string): AccountReading | null {
  if (text.length > BODY_MAX_BYTES) return null;
  const root = parseJsonObject(text);
  if (root === undefined) return null;
  const rows = Array.isArray(root.limits) ? root.limits : undefined;
  if (rows === undefined && !("five_hour" in root) && !("seven_day" in root)) return null;

  const found = new Map<UsageWindow, UsageLimit>();
  const scoped: ScopedWindow[] = [];
  for (const row of (rows ?? []).map(asJsonObject)) {
    if (row === undefined) continue;
    const kind = asJsonString(row.kind);
    const used = asPercent(row.percent);
    const resetsAt = asResetMs(row.resets_at);
    if (kind === "session" || kind === "weekly_all") {
      const window: UsageWindow = kind === "session" ? "5h" : "7d";
      const limit = limitOf(window, used, resetsAt);
      if (limit !== undefined && !found.has(window)) found.set(window, limit);
    } else if (kind === "weekly_scoped" && used !== undefined) {
      const label = cleanLabel(asJsonObject(asJsonObject(row.scope)?.model)?.display_name);
      if (label !== undefined) scoped.push(resetsAt === undefined ? { label, used } : { label, used, resetsAt });
    }
  }
  const flat = {
    "5h": asJsonObject(root.five_hour),
    "7d": asJsonObject(root.seven_day),
  } satisfies Record<UsageWindow, JsonObject | undefined>;
  for (const window of USAGE_WINDOWS) {
    if (found.has(window)) continue;
    const entry = flat[window];
    const limit = limitOf(window, asPercent(entry?.utilization), asResetMs(entry?.resets_at));
    if (limit !== undefined) found.set(window, limit);
  }
  const limits = USAGE_WINDOWS.flatMap((window) => {
    const limit = found.get(window);
    return limit === undefined ? [] : [limit];
  });
  return { limits, scoped: scoped.slice(0, 8) };
}

/** An epoch in seconds or milliseconds (a value above 1e12 is milliseconds), as epoch ms. */
function asEpochAnyMs(value: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(value);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
}

function scopedOf(label: string, used: number, resetsAt: number | undefined): ScopedWindow {
  return resetsAt === undefined ? { label, used } : { label, used, resetsAt };
}

/** An account whose answer names no window to draw. */
function emptyReading(): AccountReading {
  return { limits: [], scoped: [] };
}

function inUsageOrder(found: Map<UsageWindow, UsageLimit>): UsageLimit[] {
  return USAGE_WINDOWS.flatMap((window) => {
    const limit = found.get(window);
    return limit === undefined ? [] : [limit];
  });
}

/** A window's length as a short label: `5h`, `30d`, `90m`. */
function minutesLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${String(minutes / 1440)}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${String(minutes / 60)}h`;
  return `${String(Math.round(minutes))}m`;
}

/**
 * The windows in Codex's `rate_limits` object (a `token_count` event of a rollout file): `primary` and
 * `secondary`, each `{ used_percent, window_minutes, resets_at }` on a ChatGPT login, `null` on an API
 * key. 300 minutes is the 5-hour window and 10080 the 7-day one; any other length is kept as scoped.
 * Null when the object holds no window at all. Shape from third-party readers (CodexBar), unverified
 * live on 2026-10-24.
 */
export function parseCodexRateLimits(value: JsonValue | undefined): AccountReading | null {
  const root = asJsonObject(value);
  if (root === undefined) return null;
  const found = new Map<UsageWindow, UsageLimit>();
  const scoped: ScopedWindow[] = [];
  for (const entry of [asJsonObject(root.primary), asJsonObject(root.secondary)]) {
    if (entry === undefined) continue;
    const used = asPercent(entry.used_percent);
    const minutes = asJsonNumber(entry.window_minutes);
    if (used === undefined || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) continue;
    const resetsAt = asEpochAnyMs(entry.resets_at);
    const window: UsageWindow | undefined = minutes === 300 ? "5h" : minutes === 10_080 ? "7d" : undefined;
    if (window === undefined) {
      scoped.push(scopedOf(minutesLabel(minutes), used, resetsAt));
      continue;
    }
    const limit = limitOf(window, used, resetsAt);
    if (limit !== undefined && !found.has(window)) found.set(window, limit);
  }
  const limits = inUsageOrder(found);
  return limits.length === 0 && scoped.length === 0 ? null : { limits, scoped: scoped.slice(0, 8) };
}

/**
 * The newest usable `rate_limits` in the tail of a Codex rollout file, walking lines from the end.
 * Only `event_msg` lines whose payload is a `token_count` are parsed, and only those that carry a
 * window count. A cut first line fails to parse and is skipped like any other bad line.
 */
export function codexReadingFromTail(text: string): AccountReading | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (!line.includes("token_count")) continue;
    const root = parseJsonObject(line);
    if (root === undefined || asJsonString(root.type) !== "event_msg") continue;
    const payload = asJsonObject(root.payload);
    if (payload === undefined || asJsonString(payload.type) !== "token_count") continue;
    const reading = parseCodexRateLimits(payload.rate_limits);
    if (reading !== null) return reading;
  }
  return null;
}

/**
 * OpenCode Go's usage answer: `rolling`, `weekly` and `monthly`, each `{ status, percent, resetsAt }`
 * with `resetsAt` ISO 8601. Rolling is the 5-hour window and weekly the 7-day one; the monthly window
 * (anchored on the subscription's anniversary) is kept as scoped, labelled `30d`. Every field is
 * optional. A body with none of the three names is unreadable. Shape from third-party readers
 * (oh-my-pi), unverified live on 2026-10-24.
 */
export function parseOpencodeGoUsage(text: string): AccountReading | null {
  if (text.length > BODY_MAX_BYTES) return null;
  const root = parseJsonObject(text);
  if (root === undefined) return null;
  if (!("rolling" in root) && !("weekly" in root) && !("monthly" in root)) return null;
  const found = new Map<UsageWindow, UsageLimit>();
  const read = (value: JsonValue | undefined): { used: number; resetsAt: number | undefined } | undefined => {
    const entry = asJsonObject(value);
    const used = asPercent(entry?.percent);
    return used === undefined ? undefined : { used, resetsAt: asResetMs(entry?.resetsAt) };
  };
  const rolling = read(root.rolling);
  if (rolling !== undefined) found.set("5h", limitOf("5h", rolling.used, rolling.resetsAt) ?? { window: "5h", used: rolling.used });
  const weekly = read(root.weekly);
  if (weekly !== undefined) found.set("7d", limitOf("7d", weekly.used, weekly.resetsAt) ?? { window: "7d", used: weekly.used });
  const monthly = read(root.monthly);
  return { limits: inUsageOrder(found), scoped: monthly === undefined ? [] : [scopedOf("30d", monthly.used, monthly.resetsAt)] };
}

const GROK_WEEK_MAX_MS = 8 * 86_400_000;

/**
 * Grok's CLI-proxy credits answer: `creditUsagePercent` and `currentPeriod: { start, end }` (ISO),
 * at the top or under `config`. The period is a billing cycle: a span of 8 days or less is the 7-day
 * window, a longer one is kept as scoped (`30d`), an unknown span is kept as scoped (`credits`). When
 * the percent is missing but `onDemandUsed.val` and `onDemandCap.val` are there, their ratio stands
 * in. A body with none of these names is unreadable; one with a period and no percent is an account
 * without windows. Shape from a third-party reader (CodexBar), unverified live on 2026-10-24.
 */
export function parseGrokBilling(text: string): AccountReading | null {
  if (text.length > BODY_MAX_BYTES) return null;
  const root = parseJsonObject(text);
  if (root === undefined) return null;
  const config = asJsonObject(root.config) ?? root;
  const period = asJsonObject(config.currentPeriod);
  if (period === undefined && !("creditUsagePercent" in config) && !("onDemandUsed" in config)) return null;
  let used = asPercent(config.creditUsagePercent);
  if (used === undefined) {
    const spent = asJsonNumber(asJsonObject(config.onDemandUsed)?.val);
    const cap = asJsonNumber(asJsonObject(config.onDemandCap)?.val);
    if (spent !== undefined && cap !== undefined && Number.isFinite(spent) && Number.isFinite(cap) && cap > 0) used = asPercent((spent / cap) * 100);
  }
  if (used === undefined) return emptyReading();
  const start = asResetMs(period?.start);
  const end = asResetMs(period?.end);
  const span = start !== undefined && end !== undefined && end > start ? end - start : undefined;
  if (span !== undefined && span <= GROK_WEEK_MAX_MS) return { limits: [limitOf("7d", used, end) ?? { window: "7d", used }], scoped: [] };
  return { limits: [], scoped: [scopedOf(span === undefined ? "credits" : "30d", used, end)] };
}

// ── The login ───────────────────────────────────────────────────────────────────────────────────

/** Why no token was read. Words for one log line; none of them carries the file's content. */
export type CredentialRefusal =
  | "missing"
  | "not a regular file"
  | "readable by others"
  | "unreadable"
  | "malformed"
  | "expired"
  | "no Go key";

export type CredentialRead = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: CredentialRefusal };

/** The machine, as the login read needs it. Seams, so every refusal is testable with no real file. */
export interface CredentialSeams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The file's kind and permission bits, following links, or null when it is not there. */
  stat(path: string): Promise<{ readonly file: boolean; readonly mode: number; readonly size: number } | null>;
  read(path: string): Promise<string | null>;
  /** The Keychain item's text (macOS only), or null. Called only when the file is absent. */
  keychain(): Promise<string | null>;
  /** The plain files of a folder with their mtimes (links are not followed), or [] when it is not there. */
  list(path: string): Promise<ReadonlyArray<{ readonly name: string; readonly file: boolean; readonly mtimeMs: number }>>;
  /** The last `maxBytes` of a plain file, or null. */
  tail(path: string, maxBytes: number): Promise<string | null>;
  now(): number;
}

/** `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`. */
export function claudeCredentialsPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const dir = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  return join(dir === "" ? join(home, ".claude") : dir, ".credentials.json");
}

/**
 * The access token in Claude Code's login text, or the reason there is none. Reads
 * `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt` and nothing else: the refresh token is
 * never touched.
 */
export function claudeTokenFrom(text: string, now: number): CredentialRead {
  if (text.length > CREDENTIAL_MAX_BYTES) return { ok: false, reason: "malformed" };
  const oauth = asJsonObject(parseJsonObject(text)?.claudeAiOauth);
  const token = asJsonString(oauth?.accessToken);
  const expiresAt = asJsonNumber(oauth?.expiresAt);
  if (token === undefined || !BEARER_TOKEN.test(token) || expiresAt === undefined || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, token };
}

/**
 * The text of a login file the way every source reads one: a plain file, and on POSIX one that group
 * and other cannot read (0600 and 0400 pass; on Windows the access list is not judged here). The file
 * is not read at all when it is refused.
 */
export async function readLoginFile(
  seams: CredentialSeams,
  path: string,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: CredentialRefusal }> {
  const info = await seams.stat(path);
  if (info === null) return { ok: false, reason: "missing" };
  if (!info.file) return { ok: false, reason: "not a regular file" };
  if (seams.platform !== "win32" && (info.mode & 0o077) !== 0) return { ok: false, reason: "readable by others" };
  if (info.size > CREDENTIAL_MAX_BYTES) return { ok: false, reason: "malformed" };
  const text = await seams.read(path);
  return text === null ? { ok: false, reason: "unreadable" } : { ok: true, text };
}

/**
 * Read the operator's Claude login on this machine. The file first; on macOS, when the file is absent,
 * the Keychain item Claude Code keeps there. A file others may read is refused ({@link readLoginFile}).
 */
export async function readClaudeLogin(seams: CredentialSeams): Promise<CredentialRead> {
  const file = await readLoginFile(seams, claudeCredentialsPath(seams.env, seams.home));
  if (file.ok) return claudeTokenFrom(file.text, seams.now());
  if (file.reason !== "missing" || seams.platform !== "darwin") return file;
  const text = await seams.keychain();
  return text === null ? { ok: false, reason: "missing" } : claudeTokenFrom(text.trim(), seams.now());
}

function envDir(env: Readonly<Record<string, string | undefined>>, name: string, fallback: string): string {
  const set = (env[name] ?? "").trim();
  return set === "" ? fallback : set;
}

/** `$XDG_DATA_HOME/opencode/auth.json`, else `~/.local/share/opencode/auth.json`. */
export function opencodeAuthPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(envDir(env, "XDG_DATA_HOME", join(home, ".local", "share")), "opencode", "auth.json");
}

/** Whether OpenCode's auth store has an entry for the Go plan (the key itself is not looked at). */
export function hasOpencodeGoEntry(text: string): boolean {
  return asJsonObject(parseJsonObject(text)?.[OPENCODE_GO_PROVIDER]) !== undefined;
}

/**
 * The Go key in OpenCode's auth store: the `opencode-go` entry's `key` (an api entry) or `access` (an
 * oauth-shaped one, judged by its `expires` when it has one). Nothing else in the store is read.
 */
export function opencodeGoKeyFrom(text: string, now: number): CredentialRead {
  if (text.length > CREDENTIAL_MAX_BYTES) return { ok: false, reason: "malformed" };
  const entry = asJsonObject(parseJsonObject(text)?.[OPENCODE_GO_PROVIDER]);
  if (entry === undefined) return { ok: false, reason: "no Go key" };
  const token = asJsonString(entry.key) ?? asJsonString(entry.access);
  if (token === undefined || !BEARER_TOKEN.test(token)) return { ok: false, reason: "malformed" };
  const expires = asEpochAnyMs(entry.expires);
  if (expires !== undefined && expires <= now) return { ok: false, reason: "expired" };
  return { ok: true, token };
}

export async function readOpencodeGoKey(seams: CredentialSeams): Promise<CredentialRead> {
  const file = await readLoginFile(seams, opencodeAuthPath(seams.env, seams.home));
  return file.ok ? opencodeGoKeyFrom(file.text, seams.now()) : file;
}

/** `$GROK_HOME/auth.json`, else `~/.grok/auth.json`. */
export function grokAuthPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(envDir(env, "GROK_HOME", join(home, ".grok")), "auth.json");
}

/** Where Grok keeps the SuperGrok login first, then the older session one. Top-level keys of its store. */
const GROK_ENTRY_PREFIXES = ["https://auth.x.ai::", "https://accounts.x.ai/sign-in"] as const;
const GROK_TOKEN_FIELDS = ["key", "token", "accessToken", "access_token"] as const;

/** An `expires_at` as epoch ms: ISO text, or epoch seconds or ms as a number or numeric text. */
function expiryMs(value: JsonValue | undefined): number | undefined {
  const text = asJsonString(value);
  if (text === undefined) return asEpochAnyMs(value);
  return Number.isNaN(Number(text)) ? asResetMs(text) : asEpochAnyMs(Number(text));
}

/**
 * The bearer token in Grok's login store. Its top-level keys are OIDC scope URLs; an entry under
 * `https://auth.x.ai::<client>` wins over `https://accounts.x.ai/sign-in`, and a store that is one flat
 * entry is read too. The token is the entry's `key`, else `token`, `accessToken` or `access_token`;
 * `expires_at` (ISO, or epoch seconds or ms) is judged when it parses. Nothing else is read.
 */
export function grokTokenFrom(text: string, now: number): CredentialRead {
  if (text.length > CREDENTIAL_MAX_BYTES) return { ok: false, reason: "malformed" };
  const root = parseJsonObject(text);
  if (root === undefined) return { ok: false, reason: "malformed" };
  const names = Object.keys(root);
  const entries: JsonObject[] = [];
  for (const prefix of GROK_ENTRY_PREFIXES) {
    for (const name of names) {
      const entry = name.startsWith(prefix) ? asJsonObject(root[name]) : undefined;
      if (entry !== undefined) entries.push(entry);
    }
  }
  entries.push(root);
  let expired = false;
  for (const entry of entries) {
    const token = GROK_TOKEN_FIELDS.map((field) => asJsonString(entry[field])).find((value) => value !== undefined);
    if (token === undefined || !BEARER_TOKEN.test(token)) continue;
    const expires = expiryMs(entry.expires_at);
    if (expires !== undefined && expires <= now) {
      expired = true;
      continue;
    }
    return { ok: true, token };
  }
  return { ok: false, reason: expired ? "expired" : "malformed" };
}

export async function readGrokLogin(seams: CredentialSeams): Promise<CredentialRead> {
  const file = await readLoginFile(seams, grokAuthPath(seams.env, seams.home));
  return file.ok ? grokTokenFrom(file.text, seams.now()) : file;
}

/** The Keychain read, with its timeout. Its answer is the login JSON; it is never logged. */
function keychainRead(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: CREDENTIAL_MAX_BYTES, encoding: "utf8" },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });
}

/** The real machine. */
export function diskCredentialSeams(env: Readonly<Record<string, string | undefined>> = process.env): CredentialSeams {
  return {
    env,
    home: homedir(),
    platform: HOST.platform,
    stat: async (path) => {
      try {
        const info = await stat(path);
        return { file: info.isFile(), mode: info.mode & 0o777, size: info.size };
      } catch {
        return null;
      }
    },
    read: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    keychain: keychainRead,
    list: async (path) => {
      try {
        const names = await readdir(path);
        const rows = await Promise.all(
          names.map(async (name) => {
            try {
              const info = await lstat(join(path, name));
              return { name, file: info.isFile(), mtimeMs: info.mtimeMs };
            } catch {
              return null;
            }
          }),
        );
        return rows.filter((row) => row !== null);
      } catch {
        return [];
      }
    },
    tail: async (path, maxBytes) => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(path, "r");
        const info = await handle.stat();
        if (!info.isFile()) return null;
        const length = Math.min(info.size, maxBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
        return buffer.toString("utf8", 0, bytesRead);
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    },
    now: () => Date.now(),
  };
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

/** A road that asks the vendor over HTTPS with the login the harness keeps. */
export interface HttpAccountSource {
  readonly kind: "http";
  readonly harness: string;
  readonly url: string;
  /** The login, read fresh for each ask. */
  login(): Promise<CredentialRead>;
  /** The headers of the one ask, built around the token. */
  headers(token: string): Record<string, string>;
  /** The windows in the vendor's answer, or null for a body this build cannot read. */
  parse(text: string): AccountReading | null;
}

/** A road that reads the harness's own files on this machine: no login, no request. */
export interface LocalAccountSource {
  readonly kind: "local";
  readonly harness: string;
  read(): Promise<{ readonly ok: true; readonly reading: AccountReading } | { readonly ok: false; readonly reason: string }>;
}

/** One harness's road to its account windows. */
export type AccountSource = HttpAccountSource | LocalAccountSource;

export function claudeAccountSource(seams: CredentialSeams): AccountSource {
  return {
    kind: "http",
    harness: "claude",
    url: CLAUDE_USAGE_URL,
    login: () => readClaudeLogin(seams),
    headers: (token) => ({
      Authorization: `Bearer ${token}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      Accept: "application/json",
    }),
    parse: parseAccountUsage,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The folders of today and yesterday under the sessions root, by local date and by UTC date. */
function codexDayFolders(now: number): string[] {
  const days = new Set<string>();
  for (const back of [0, 1]) {
    const date = new Date(now - back * 86_400_000);
    days.add(join(String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())));
    days.add(join(String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())));
  }
  return [...days];
}

/** `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export function codexSessionsDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(envDir(env, "CODEX_HOME", join(home, ".codex")), "sessions");
}

/**
 * Codex: no login and no request. On a ChatGPT login every `token_count` event in a rollout file
 * carries `rate_limits`; the newest one in the newest files is the account's windows as of the last
 * model response. An API-key login writes `null` there, so there is nothing to show.
 */
export function codexAccountSource(seams: CredentialSeams): AccountSource {
  return {
    kind: "local",
    harness: "codex",
    read: async () => {
      const now = seams.now();
      const root = codexSessionsDir(seams.env, seams.home);
      const files: Array<{ path: string; mtimeMs: number }> = [];
      for (const day of codexDayFolders(now)) {
        for (const entry of await seams.list(join(root, day))) {
          if (entry.file && /^rollout-.*\.jsonl$/.test(entry.name) && now - entry.mtimeMs <= CODEX_FRESH_MS) {
            files.push({ path: join(root, day, entry.name), mtimeMs: entry.mtimeMs });
          }
        }
      }
      if (files.length === 0) return { ok: false, reason: "no session file in the last 2 hours" };
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const file of files.slice(0, CODEX_FILES_MAX)) {
        const text = await seams.tail(file.path, CODEX_TAIL_BYTES);
        const reading = text === null ? null : codexReadingFromTail(text);
        if (reading !== null) return { ok: true, reading };
      }
      return { ok: false, reason: "no subscription limits in the newest session files" };
    },
  };
}

/** OpenCode Go: the Go key of OpenCode's own auth store, one GET to opencode.ai. */
export function opencodeAccountSource(seams: CredentialSeams): AccountSource {
  // Background polls outside any conversation are attributed with one id per bridge run.
  const session = randomUUID();
  return {
    kind: "http",
    harness: "opencode",
    url: OPENCODE_USAGE_URL,
    login: () => readOpencodeGoKey(seams),
    headers: (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/json", "x-opencode-session": session }),
    parse: parseOpencodeGoUsage,
  };
}

/** Grok: the login `grok login` keeps, one GET to the CLI proxy. */
export function grokAccountSource(seams: CredentialSeams): AccountSource {
  return {
    kind: "http",
    harness: "grok",
    url: GROK_USAGE_URL,
    login: () => readGrokLogin(seams),
    headers: (token) => ({ Authorization: `Bearer ${token}`, "x-xai-token-auth": "xai-grok-cli", Accept: "application/json" }),
    parse: parseGrokBilling,
  };
}

/** The one table of sources, keyed by the harness id a pane carries. Nothing else names a harness. */
const SOURCE_TABLE = {
  claude: claudeAccountSource,
  codex: codexAccountSource,
  opencode: opencodeAccountSource,
  grok: grokAccountSource,
} satisfies Record<string, (seams: CredentialSeams) => AccountSource>;

/**
 * The sources for the harnesses the setting turns on (ADR 0118). A harness left out has no source, so
 * the service never reads its login or its files and never asks its vendor. With no list, the
 * default set (`claude`, `codex`).
 */
export function defaultAccountSources(seams: CredentialSeams, harnesses: readonly string[] = ACCOUNT_WINDOWS_DEFAULT): AccountSource[] {
  return Object.entries(SOURCE_TABLE)
    .filter(([id]) => harnesses.includes(id))
    .map(([, build]) => build(seams));
}

/** The transport. Only `status` and `text()` of the answer are read. */
export type AccountFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal; redirect: "error" },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface AccountWindowsOptions {
  /** False with `COLLIE_ACCOUNT_WINDOWS=0` (no harness on): nothing is read and nothing is asked. */
  readonly enabled: boolean;
  readonly sources: readonly AccountSource[];
  readonly fetch: AccountFetch;
  readonly now: () => number;
  /** `collie/<version>`. */
  readonly userAgent: string;
  /** One line per change of state. Never the token, never a body. */
  readonly log?: (line: string) => void;
}

interface HarnessState {
  reading: (AccountReading & { at: number }) | undefined;
  lastAttempt: number;
  backoffUntil: number;
  inFlight: Promise<void> | null;
  /** The last state logged, so a repeated refusal is one line, not one a minute. */
  lastNote: string | null;
}

/** A pane's turn ended: it was working (or held at a prompt) and now waits for the person. */
export function isTurnEnd(from: AgentStatus, to: AgentStatus): boolean {
  return (from === "working" || from === "blocked") && (to === "idle" || to === "done");
}

/**
 * The account windows of each harness with a source, in memory. `observe` runs on every poll,
 * `poke` when a turn ends; `limits` is synchronous and reads memory only.
 */
export class AccountWindows {
  private readonly states = new Map<string, HarnessState>();
  private readonly sources = new Map<string, AccountSource>();
  /** The harnesses each mux session's last poll had panes of, so one session's poll forgets only its own. */
  private readonly scopes = new Map<string, Set<string>>();

  constructor(private readonly opts: AccountWindowsOptions) {
    for (const source of opts.sources) {
      this.sources.set(source.harness, source);
      this.states.set(source.harness, { reading: undefined, lastAttempt: -Infinity, backoffUntil: 0, inFlight: null, lastNote: null });
    }
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Whether any mux session's last poll had a pane of `harness`. */
  private present(harness: string): boolean {
    for (const harnesses of this.scopes.values()) if (harnesses.has(harness)) return true;
    return false;
  }

  /**
   * One mux session's poll: note which harnesses have panes, and ask for each that has none yet or
   * whose last ask is {@link ASK_EVERY_MS} old.
   */
  observe(panes: readonly AgentView[], scope = ""): void {
    if (!this.opts.enabled) return;
    const harnesses = new Set<string>();
    for (const pane of panes) if (pane.kind !== "shell" && this.sources.has(pane.agent)) harnesses.add(pane.agent);
    this.scopes.set(scope, harnesses);
    const now = this.opts.now();
    for (const [harness, state] of this.states) {
      if (!this.present(harness)) continue;
      if (state.reading === undefined || now - state.lastAttempt >= ASK_EVERY_MS) this.ask(harness, now);
    }
  }

  /** A turn of `harness` ended: ask, unless an ask started in the last {@link POKE_EVERY_MS}. */
  poke(harness: string): void {
    if (!this.opts.enabled) return;
    const state = this.states.get(harness);
    if (state === undefined || !this.present(harness)) return;
    const now = this.opts.now();
    if (now - state.lastAttempt < POKE_EVERY_MS) return;
    this.ask(harness, now);
  }

  /** The harness's 5-hour and 7-day windows now, or undefined when there is no fresh reading. */
  limits(harness: string): UsageLimit[] | undefined {
    const reading = this.fresh(harness);
    if (reading === undefined) return undefined;
    const now = this.opts.now();
    const limits = reading.limits.filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now);
    return limits.length > 0 ? limits : undefined;
  }

  /** The model-scoped weekly windows, kept for a later build. Not drawn. */
  scoped(harness: string): ScopedWindow[] | undefined {
    return this.fresh(harness)?.scoped;
  }

  /** Every ask in flight, settled. For the tests and for a clean stop. */
  async settled(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => state.inFlight));
  }

  private fresh(harness: string): (AccountReading & { at: number }) | undefined {
    if (!this.opts.enabled) return undefined;
    const reading = this.states.get(harness)?.reading;
    if (reading === undefined || this.opts.now() - reading.at > STALE_AFTER_MS) return undefined;
    return reading;
  }

  private ask(harness: string, now: number): void {
    const state = this.states.get(harness);
    const source = this.sources.get(harness);
    if (state === undefined || source === undefined || state.inFlight !== null || now < state.backoffUntil) return;
    state.lastAttempt = now;
    state.inFlight = this.run(source, state).finally(() => {
      state.inFlight = null;
    });
  }

  private note(state: HarnessState, harness: string, line: string | null): void {
    if (line === state.lastNote) return;
    state.lastNote = line;
    if (line !== null) this.opts.log?.(`[usage] account windows, ${harness}: ${line}`);
  }

  private back(state: HarnessState, ms: number): void {
    state.backoffUntil = this.opts.now() + ms;
  }

  private async run(source: AccountSource, state: HarnessState): Promise<void> {
    if (source.kind === "local") return this.runLocal(source, state);
    return this.runHttp(source, state);
  }

  /** A local source: files read, nothing asked. A miss keeps the last reading until it goes stale. */
  private async runLocal(source: LocalAccountSource, state: HarnessState): Promise<void> {
    let answer: Awaited<ReturnType<LocalAccountSource["read"]>>;
    try {
      answer = await source.read();
    } catch {
      answer = { ok: false, reason: "unreadable" };
    }
    if (!answer.ok) {
      this.note(state, source.harness, `no windows read (${answer.reason})`);
      this.back(state, BACKOFF.none);
      return;
    }
    state.reading = { ...answer.reading, at: this.opts.now() };
    state.backoffUntil = 0;
    this.note(state, source.harness, null);
  }

  private async runHttp(source: HttpAccountSource, state: HarnessState): Promise<void> {
    const harness = source.harness;
    let login: CredentialRead;
    try {
      login = await source.login();
    } catch {
      login = { ok: false, reason: "unreadable" };
    }
    if (!login.ok) {
      this.note(state, harness, `no login read (${login.reason})`);
      this.back(state, login.reason === "expired" ? BACKOFF.expired : BACKOFF.refused);
      return;
    }
    let status: number;
    let body: string;
    try {
      const answer = await this.opts.fetch(source.url, {
        method: "GET",
        headers: { ...source.headers(login.token), "User-Agent": this.opts.userAgent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      status = answer.status;
      body = status === 200 ? await answer.text() : "";
    } catch {
      // The error is not logged: a transport's message is not ours to vouch for.
      this.note(state, harness, "no answer, asking again in 2 min");
      this.back(state, BACKOFF.network);
      return;
    }
    if (status === 401 || status === 403) {
      state.reading = undefined;
      this.note(state, harness, `HTTP ${String(status)}, reading dropped, asking again in 15 min`);
      this.back(state, BACKOFF.denied);
      return;
    }
    if (status === 429) {
      this.note(state, harness, "HTTP 429, asking again in 15 min");
      this.back(state, BACKOFF.limited);
      return;
    }
    if (status !== 200) {
      this.note(state, harness, `HTTP ${String(status)}, asking again in 2 min`);
      this.back(state, BACKOFF.network);
      return;
    }
    const reading = source.parse(body);
    if (reading === null) {
      this.note(state, harness, "an answer this build cannot read, asking again in 5 min");
      this.back(state, BACKOFF.unreadable);
      return;
    }
    state.reading = { ...reading, at: this.opts.now() };
    state.backoffUntil = 0;
    this.note(state, harness, null);
  }
}

/** What the doctor can tell about the logins without asking anyone. */
export interface AccountDoctorFacts {
  /** OpenCode's auth store has an `opencode-go` entry. */
  readonly opencodeGoKey: boolean;
  /** Grok's login file exists. */
  readonly grokLogin: boolean;
}

/**
 * The doctor's sentence for one setting: every source with its state, what it reads and where it asks.
 * Names files and hosts, never anything in a file. `setting` is what {@link parseAccountWindowsSetting}
 * made of the operator's text.
 */
export function accountWindowsDoctorLine(
  setting: AccountWindowsSetting,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
  facts: AccountDoctorFacts = { opencodeGoKey: false, grokLogin: false },
): string {
  const refused = accountWindowsProblem(setting);
  const note = refused === null ? "" : `. COLLIE_ACCOUNT_WINDOWS: ${refused}`;
  if (setting.harnesses.length === 0) {
    return `off, every source is turned off by COLLIE_ACCOUNT_WINDOWS: no login or session file is read and nothing is asked${note}`;
  }
  const named = (name: string, tilde: string, path: string): string => ((env[name] ?? "").trim() === "" ? tilde : path);
  const keychain = platform === "darwin" ? " or the Keychain" : "";
  const where = {
    claude: `reads ${named("CLAUDE_CONFIG_DIR", "~/.claude/.credentials.json", claudeCredentialsPath(env, home))}${keychain}, asks ${CLAUDE_USAGE_HOST}`,
    codex: `reads ${named("CODEX_HOME", "~/.codex/sessions", codexSessionsDir(env, home))}`,
    opencode: facts.opencodeGoKey
      ? `reads ${named("XDG_DATA_HOME", "~/.local/share/opencode/auth.json", opencodeAuthPath(env, home))}, asks ${OPENCODE_USAGE_HOST}`
      : "no Go key",
    grok: facts.grokLogin
      ? `reads ${named("GROK_HOME", "~/.grok/auth.json", grokAuthPath(env, home))}, asks ${GROK_USAGE_HOST}`
      : "no login",
  } satisfies Record<(typeof ACCOUNT_WINDOW_HARNESSES)[number], string>;
  const rows = ACCOUNT_WINDOW_HARNESSES.map((id) => {
    const unverified = ACCOUNT_WINDOWS_UNVERIFIED.includes(id);
    if (setting.harnesses.includes(id)) return `${id}: on${unverified ? ", unverified" : ""} (${where[id]})`;
    if (setting.form === "list") return `${id}: off (not in your list)`;
    return `${id}: off by default, unverified (COLLIE_ACCOUNT_WINDOWS=all)`;
  });
  return `${rows.join("; ")}${note}`;
}
