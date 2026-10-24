// The account's 5-hour and 7-day windows, asked of the vendor with the operator's OWN harness login
// (.adr/0118). The dots beside the model tag draw them (bridge/usage.ts joins them onto each pane).
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
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { HOST } from "./host.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { AgentStatus, AgentView } from "./types.ts";
import { asPercent, USAGE_WINDOWS, type UsageLimit, type UsageWindow } from "./usage.ts";

/** The one host the token is ever sent to. */
export const CLAUDE_USAGE_HOST = "api.anthropic.com";
export const CLAUDE_USAGE_URL = `https://${CLAUDE_USAGE_HOST}/api/oauth/usage`;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

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
} as const;

/** The largest login file or Keychain answer this build reads. Claude Code's is well under 2 KiB. */
const CREDENTIAL_MAX_BYTES = 64 * 1024;
/** The largest usage answer this build reads. */
const BODY_MAX_BYTES = 256 * 1024;
/** A bearer token is printable ASCII with no space, and short. */
const BEARER_TOKEN = /^[\x21-\x7e]{1,4095}$/;

// ── The answer ──────────────────────────────────────────────────────────────────────────────────

/**
 * A model-scoped weekly window (`weekly_scoped`). Parsed and kept for a later build; the phone draws
 * two gauges today, so these never reach {@link AccountWindows.limits}.
 */
export interface ScopedWindow {
  /** The model's display name as the vendor wrote it, trimmed and stripped of control characters. */
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

// ── The login ───────────────────────────────────────────────────────────────────────────────────

/** Why no token was read. Words for one log line; none of them carries the file's content. */
export type CredentialRefusal = "missing" | "not a regular file" | "readable by others" | "unreadable" | "malformed" | "expired";

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
 * Read the operator's Claude login on this machine. The file first; on macOS, when the file is absent,
 * the Keychain item Claude Code keeps there. On POSIX a file whose mode lets group or other read it is
 * refused (0600 and 0400 pass). On Windows the file sits under `%USERPROFILE%\.claude` and its access
 * list is not judged here.
 */
export async function readClaudeLogin(seams: CredentialSeams): Promise<CredentialRead> {
  const path = claudeCredentialsPath(seams.env, seams.home);
  const info = await seams.stat(path);
  if (info === null) {
    if (seams.platform !== "darwin") return { ok: false, reason: "missing" };
    const text = await seams.keychain();
    return text === null ? { ok: false, reason: "missing" } : claudeTokenFrom(text.trim(), seams.now());
  }
  if (!info.file) return { ok: false, reason: "not a regular file" };
  if (seams.platform !== "win32" && (info.mode & 0o077) !== 0) return { ok: false, reason: "readable by others" };
  if (info.size > CREDENTIAL_MAX_BYTES) return { ok: false, reason: "malformed" };
  const text = await seams.read(path);
  return text === null ? { ok: false, reason: "unreadable" } : claudeTokenFrom(text, seams.now());
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
    now: () => Date.now(),
  };
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

/** One harness's road to its account windows. Only `claude` has one today. */
export interface AccountSource {
  readonly harness: string;
  readonly url: string;
  /** The login, read fresh for each ask. */
  login(): Promise<CredentialRead>;
  /** The headers of the one ask, built around the token. */
  headers(token: string): Record<string, string>;
}

export function claudeAccountSource(seams: CredentialSeams): AccountSource {
  return {
    harness: "claude",
    url: CLAUDE_USAGE_URL,
    login: () => readClaudeLogin(seams),
    headers: (token) => ({
      Authorization: `Bearer ${token}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      Accept: "application/json",
    }),
  };
}

/** The transport. Only `status` and `text()` of the answer are read. */
export type AccountFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal; redirect: "error" },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface AccountWindowsOptions {
  /** False with `COLLIE_ACCOUNT_WINDOWS=0`: nothing is read and nothing is asked. */
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
    const reading = parseAccountUsage(body);
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

/** The doctor's sentence for one setting: what is read and where it asks. */
export function accountWindowsDoctorLine(
  enabled: boolean,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
): string {
  if (!enabled) return "off";
  const profile = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  const shown = profile === "" ? "~/.claude/.credentials.json" : claudeCredentialsPath(env, home);
  const keychain = platform === "darwin" ? " or the Keychain" : "";
  return `on (claude: read ${shown}${keychain}, asks ${CLAUDE_USAGE_HOST})`;
}
