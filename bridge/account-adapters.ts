import { isAbsolute, join } from "node:path";

import { asRecord, asText } from "./journal/cache-probe.ts";
import type { JsonValue } from "./json.ts";
import type { AccountIdentity } from "./types.ts";

export type { AccountIdentity } from "./types.ts";

// ── Accounts: what each agent needs to run under a second login (M101, ADR 0141) ────────────────
//
// An account is a label, a harness and a folder the agent already understands. The agent picks its
// folder from ONE variable (or, later, one flag) on its own command, and the person signs in inside
// the agent's own screen. So everything the bridge must know per agent is data, and it lives here:
// how the folder is selected, where the default folder is, how a new folder is named, how a folder is
// recognised by its entry names, where its journal sits, what a `shared` account may link, and the
// agent's own status command with a pure parser of its answer (who is signed in, M101 spec 04).
//
// Shared code reads this table and nothing else. A harness that is not a key here takes no account.
// `account-adapters.test.ts` fails when a key is not a launch id (`bridge/harness-launch.ts`).
//
// ── THE DEFAULT FOLDER IS NEVER SELECTED BY THE VARIABLE ────────────────────────────────────────
// On macOS Claude Code keys its Keychain item on the RAW text of `CLAUDE_CONFIG_DIR`, so typing the
// variable for the default folder would read as a new, signed-out login. The Default account is the
// plain binary with nothing set, and an added account always types the same cleaned absolute path.

/** How the agent is told which folder to use. Only the variable form is built today. */
export type AccountSelect = { env: string };

/** What a `shared` account links from the default folder (README decision 3). */
export interface AccountShare {
  /** Folders, each one absolute link. A folder the default lacks is created there empty first. */
  dirs: readonly string[];
  /** Files, each ONE link to the real file. A file the default lacks is skipped. */
  files: readonly string[];
}

/** One run of a status command: the exit code (null when it was killed) and both streams. */
export interface AccountStatusRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * How an agent says who is signed in: the words after its binary, and a parser of what they print to an
 * {@link AccountIdentity} (M101 spec 04). Nothing else of that output ever leaves the parser: no
 * organisation, no id, no token, no key fragment, no raw text.
 */
export interface AccountStatus {
  /** Fixed words after the binary. Data of this table; nothing from a request is ever added. */
  args: readonly string[];
  /**
   * Entry NAMES in the account's folder that show the agent has run there; at least one must exist, or
   * the account reads not signed in and nothing runs. Existence only: the entry is never opened. A
   * status call on a folder the agent never started in would write the agent's state file there first.
   */
  needs: readonly string[];
  /**
   * The same for the Default account, as names in the home folder: where the agent keeps that state with
   * no variable set. Either list counts for Default.
   */
  needsAtHome?: readonly string[];
  /** The identity, or null for an output it cannot read ("unknown"). Pure: no disk, no clock. */
  parse(run: AccountStatusRun): AccountIdentity | null;
}

/** One agent's account facts. */
export interface AccountAdapter {
  select: AccountSelect;
  /** The folder the agent uses with nothing set, as this bridge's environment says. */
  defaultDir(home: string, env: Readonly<Record<string, string | undefined>>): string;
  /** The folder name of a new account under home, from its label's slug. */
  newDirName(slug: string): string;
  /** The same as a pattern for the page, `~/.claude-{slug}`. */
  newFolder: string;
  /** Whether a folder's entry NAMES look like this agent's folder. Names only; nothing is opened. */
  looksLike(entries: readonly string[]): boolean;
  /** Where to look for folders in use, `~/<prefix>*` or `~/<folder>/*`. */
  nameGlobs: readonly string[];
  /** The journal root inside an account folder. */
  journalRoot(dir: string): string;
  /** Present when the agent takes a `shared` account. */
  share?: AccountShare;
  /** Words after the binary that open the sign-in. Absent: the plain start reaches it. */
  signInArgs?: readonly string[];
  /**
   * Words after the binary for a sign-in on a folder that reads signed in, so the agent opens its login
   * menu and not a plain session. Absent: the sign-in start is the same as for a signed-out folder.
   */
  signInAgainArgs?: readonly string[];
  /**
   * Whether a sign-in that ends well reaches the sessions of the folder that already run, with no
   * restart (Change login). True only where it is proven from the agent's own code; absent is "not
   * proven", and the phone then says that sessions started from now on use the new login.
   */
  reachesRunningSessions?: boolean;
  /**
   * The hosts of the sign-in address the agent prints, exact names, for the phone's "Open sign-in page"
   * button. An address on any other host, or not `https:`, is shown as text to copy. Absent: no button.
   */
  signInHosts?: readonly string[];
  /** The agent's own status command. Absent: the agent says nothing about who is signed in. */
  status?: AccountStatus;
  /** The settings file that holds Collie's hooks, where the bridge can tell. */
  hooksFile?(dir: string): string;
}

/** The variable's value when it names an absolute folder, else undefined. */
function envDir(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim() ?? "";
  return value !== "" && isAbsolute(value) ? join(value, ".") : undefined;
}

function hasAny(entries: readonly string[], markers: readonly string[]): boolean {
  return markers.some((m) => entries.includes(m));
}

/** The longest email kept, RFC 5321's path limit. */
const MAX_EMAIL_CHARS = 254;
/** An address with one `@`, no space and no control or bidi character. Anything else is not shown. */
const EMAIL_RULE = /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+$/u;
/** A plan word as an agent names it: `max`, `pro`, `team`, `enterprise`. */
const PLAN_RULE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;

/**
 * `claude auth status` (Claude Code 2.1.325, probe of 2026-11-16): JSON on stdout by default. Signed in
 * is exit 0 with `loggedIn: true`, `email` and `subscriptionType`; not signed in is exit 1 with
 * `loggedIn: false`. Only those three fields are read. `orgName` can hold the address too and is never
 * read. A killed run, a code other than 0 or 1, or output that is not that object is unknown.
 */
export function parseClaudeAuthStatus(run: AccountStatusRun): AccountIdentity | null {
  if (run.code !== 0 && run.code !== 1) return null;
  let doc: JsonValue;
  try {
    // SAFETY: `JSON.parse` answers a JSON value by construction; every field read below is checked.
    doc = JSON.parse(run.stdout.trim()) as JsonValue;
  } catch {
    return null;
  }
  // The field readers of bridge/journal/cache-probe.ts: the narrowing of a third-party JSON document.
  const fields = asRecord(doc);
  if (fields === null) return null;
  if (fields.loggedIn === false) return { signedIn: false };
  if (fields.loggedIn !== true || run.code !== 0) return null;
  const out: AccountIdentity = { signedIn: true };
  const email = asText(fields.email);
  if (email !== undefined && email.length <= MAX_EMAIL_CHARS && EMAIL_RULE.test(email)) out.email = email;
  const plan = asText(fields.subscriptionType);
  if (plan !== undefined && PLAN_RULE.test(plan)) out.plan = plan;
  return out;
}

/**
 * The agents that take accounts. Lab facts for Claude Code 2.1.325 (2026-11-15): with
 * `CLAUDE_CONFIG_DIR` set the state file is `<dir>/.claude.json`; the settings writer reads one link
 * level and renames onto its target, so a one-level file link survives; `history.jsonl` is appended in
 * place; on an EMPTY folder the plain start shows the theme step and then the login method menu, and
 * `claude /login` shows the same two screens, so the plain start is the sign-in line.
 */
export const ACCOUNT_ADAPTERS = {
  claude: {
    select: { env: "CLAUDE_CONFIG_DIR" },
    defaultDir: (home, env) => envDir(env, "CLAUDE_CONFIG_DIR") ?? join(home, ".claude"),
    newDirName: (slug) => `.claude-${slug}`,
    newFolder: "~/.claude-{slug}",
    looksLike: (entries) => hasAny(entries, ["projects", "settings.json", ".claude.json", "history.jsonl"]),
    nameGlobs: ["~/.claude-*", "~/.ccs/instances/*"],
    journalRoot: (dir) => join(dir, "projects"),
    share: {
      dirs: ["projects", "file-history", "todos", "tasks", "paste-cache", "skills", "agents", "commands", "hooks", "plugins"],
      files: ["settings.json", "CLAUDE.md", "history.jsonl"],
    },
    hooksFile: (dir) => join(dir, "settings.json"),
    // `claude /login` opens the login method menu on a signed-in folder too (lab of 2026-11-15).
    signInAgainArgs: ["/login"],
    // Claude Code 2.1.325 (read from its code, 2026-11-16): a running session checks the modification
    // time of `<config dir>/.credentials.json` before each main request and loads the login again when it
    // changed, so a `/login` that ends well in any process of the folder reaches every session of it.
    // The bridge never opens or stats that file; the agent does.
    reachesRunningSessions: true,
    // The two addresses `/login` prints (lab of 2026-11-15, claude--v2325-login-url and -console-url).
    signInHosts: ["claude.com", "platform.claude.com"],
    // `.claude.json` is the state file: `<dir>/.claude.json` with the variable set, `~/.claude.json`
    // without. A shared account that never started holds links only, so it has none.
    status: { args: ["auth", "status"], needs: [".claude.json"], needsAtHome: [".claude.json"], parse: parseClaudeAuthStatus },
  },
  codex: {
    select: { env: "CODEX_HOME" },
    defaultDir: (home, env) => envDir(env, "CODEX_HOME") ?? join(home, ".codex"),
    newDirName: (slug) => `.codex-${slug}`,
    newFolder: "~/.codex-{slug}",
    looksLike: (entries) => hasAny(entries, ["config.toml", "sessions", "history.jsonl"]),
    nameGlobs: ["~/.codex-*"],
    // bridge/config.ts: `join(CODEX_HOME ?? ~/.codex, "sessions")`.
    journalRoot: (dir) => join(dir, "sessions"),
  },
  pi: {
    select: { env: "PI_CODING_AGENT_DIR" },
    defaultDir: (home, env) => envDir(env, "PI_CODING_AGENT_DIR") ?? join(home, ".pi", "agent"),
    newDirName: (slug) => `.pi-${slug}`,
    newFolder: "~/.pi-{slug}",
    looksLike: (entries) => hasAny(entries, ["sessions", "settings.json", "models.json"]),
    nameGlobs: ["~/.pi-*"],
    // bridge/config.ts: `join(PI_CODING_AGENT_DIR, "sessions")`.
    journalRoot: (dir) => join(dir, "sessions"),
  },
  grok: {
    // Lab check on Grok Build 1.0.77 (2026-11-15), scratch HOME, empty `GROK_HOME`, no login: the first
    // start wrote `agent_id`, `config.toml`, `sessions/`, `installed-plugins/`, `logs/`, `docs/` and
    // its lock files under `GROK_HOME` only, nothing under `~/.grok`, and looks for its login at
    // `$GROK_HOME/auth.json`. The plain start shows the device sign-in screen.
    select: { env: "GROK_HOME" },
    defaultDir: (home, env) => envDir(env, "GROK_HOME") ?? join(home, ".grok"),
    newDirName: (slug) => `.grok-${slug}`,
    newFolder: "~/.grok-{slug}",
    looksLike: (entries) => hasAny(entries, ["agent_id", "installed-plugins", "config.toml", "sessions"]),
    nameGlobs: ["~/.grok-*"],
    // bridge/config.ts: `join(GROK_HOME ?? ~/.grok, "sessions")`.
    journalRoot: (dir) => join(dir, "sessions"),
  },
} as const satisfies Readonly<Record<string, AccountAdapter>>;

/** The adapter of `harness`, or undefined for an agent that takes no account. Own keys only. */
export function accountAdapter(harness: string): AccountAdapter | undefined {
  return BY_HARNESS.get(harness);
}

/** The table by id. A Map, so an inherited key (`toString`, `__proto__`) is never an adapter. */
const BY_HARNESS: ReadonlyMap<string, AccountAdapter> = new Map(Object.entries(ACCOUNT_ADAPTERS));

/** Every harness id that takes accounts, in table order. */
export const ACCOUNT_HARNESSES: readonly string[] = Object.keys(ACCOUNT_ADAPTERS);

/** What the selector is, as the page shows it: the variable name. */
export function selectText(select: AccountSelect): string {
  return select.env;
}
