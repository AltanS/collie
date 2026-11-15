import { isAbsolute, join } from "node:path";

// ── Accounts: what each agent needs to run under a second login (M101, ADR 0141) ────────────────
//
// An account is a label, a harness and a folder the agent already understands. The agent picks its
// folder from ONE variable (or, later, one flag) on its own command, and the person signs in inside
// the agent's own screen. So everything the bridge must know per agent is data, and it lives here:
// how the folder is selected, where the default folder is, how a new folder is named, how a folder is
// recognised by its entry names, where its journal sits, and what a `shared` account may link.
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
