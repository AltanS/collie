// What the lab needs to know about each harness it can run (M56 spec 10): which npm package holds the
// version, which file runs it, how it starts, and where its own config lives so the lab can move it.
//
// A harness with a profile in web/src/lib/surface/profiles/ runs the Surface and protocol legs: one probed
// send and one ask answer. A harness without one runs the walk, and the ledger row says `walk-only`.
//
// A start never reads the person's config. Claude gets `CLAUDE_CONFIG_DIR`. Every other harness gets a
// `HOME` of its own under the run directory, and its own config variables point there too. A harness
// that has to be signed in to make a model turn gets a login copy in that directory (seed.ts), and the
// copy goes with the directory when the run ends. OpenCode needs none: its default model is free.

import { dirname, join } from "node:path";

export interface RunDirs {
  /** The run directory, `<lab root>/<harness>-<version>`. Deleted when the run ends. */
  readonly root: string;
  /** The npm prefix the binary is installed under. */
  readonly bin: string;
  /** The `CLAUDE_CONFIG_DIR` of a Claude run. */
  readonly config: string;
  /** The `HOME` of every other harness. */
  readonly home: string;
  /** The folder the agent runs in: a fresh git repo. */
  readonly project: string;
  /** The send and ask request files. */
  readonly sends: string;
}

export function runDirs(root: string): RunDirs {
  return { root, bin: join(root, "bin"), config: join(root, "config"), home: join(root, "home"), project: join(root, "project"), sends: join(root, "sends") };
}

export interface HarnessSpec {
  readonly id: string;
  /** The npm package installed at the exact version. */
  readonly npm: string;
  /** The file under `<bin>/node_modules/.bin/`. */
  readonly binName: string;
  /** Flags after the binary for a throwaway start. Never a flag that reads or writes the person's config. */
  readonly startArgs: (dirs: RunDirs) => readonly string[];
  /** The environment the agent gets on top of the lab's short list. */
  readonly env: (dirs: RunDirs) => Readonly<Record<string, string>>;
  /** Which login the lab copies into the run directory (seed.ts). `none` copies nothing. */
  readonly login: LoginKind;
  /** The folders the harness needs before its first start. Newer Codex stops at once when `CODEX_HOME` is missing. */
  readonly folders: (dirs: RunDirs) => readonly string[];
  /** Config files written before the first start, path to text. Never a secret: a login goes through {@link HarnessSpec.login}. */
  readonly files: (dirs: RunDirs) => Readonly<Record<string, string>>;
  /** The label of the option that declines a permission dialog. The ask leg presses it. */
  readonly decline: RegExp;
  /** Model turns the lab may spend on this harness in one run. */
  readonly turnCap: number;
  /** Whether the phone leg runs for this harness (phone.ts). Claude only: the scenarios are Claude's. */
  readonly phone: boolean;
}

/** Which login a run copies: Claude's OAuth file, an OpenAI API key for Codex, or an OpenRouter key for omp. */
export type LoginKind = "claude" | "codex" | "openrouter" | "none";

/** A process environment the lab builds: names to values, nothing else. */
export interface EnvMap {
  [name: string]: string;
}

function homeEnv(dirs: RunDirs): EnvMap {
  return {
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_DATA_HOME: join(dirs.home, ".local", "share"),
    XDG_STATE_HOME: join(dirs.home, ".local", "state"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
  };
}

export interface HarnessTable {
  readonly [id: string]: HarnessSpec | undefined;
}

/** The MCP config a Claude run gets: no servers. The file sits in the run's config folder. */
export const EMPTY_MCP_FILE = "empty-mcp.json";

/** The model turns one run may spend: the send, the ask request, and what the harness does after a No. */
export const TURN_CAP = 4;
export const CLAUDE_TURN_CAP = TURN_CAP;

/** The scratch OpenCode config of a run: ask before a shell command and before an edit, so the ask leg meets a dialog. */
export const OPENCODE_ASK_FILE = "opencode-ask.json";
const OPENCODE_ASK = { $schema: "https://opencode.ai/config.json", permission: { bash: "ask", edit: "ask" } };

/**
 * omp's model for a lab run: the person's own default, through OpenRouter. omp asks a fresh install five
 * setup questions unless `setupVersion` is set, and signs in to a provider on the first of them. The
 * update check is off: its "Update Available" notice takes a row of the first screen.
 */
export const OMP_MODEL = "openrouter/openai/gpt-6-luna";
const OMP_CONFIG = "setupVersion: 2\nstartup:\n  checkUpdate: false\n";

/** Where a run's Codex keeps its login, its config and its sessions. */
export function codexHome(dirs: RunDirs): string {
  return join(dirs.home, ".codex");
}

/** The `config.toml` of a Codex run: the one project folder is trusted. A TOML basic string takes JSON's escapes. */
export function codexTrust(project: string): string {
  return `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`;
}

/**
 * The settings a Codex run starts with, as top-level keys of its throwaway `config.toml`: no update prompt,
 * low effort on the default model, and the person as reviewer. Not `-c`: from 0.166.0 any `-c` override
 * draws `⚠ 1 warning · f2 to view` in the footer (it needs Codex's embedded mode), a row a person's Codex
 * does not show.
 */
export const CODEX_SETTINGS = 'check_for_update_on_startup = false\nmodel_reasoning_effort = "low"\napprovals_reviewer = "user"\n';

/** The whole `config.toml` of a Codex run: {@link CODEX_SETTINGS}, then the trust table ({@link codexTrust}). Top-level keys go before the first table. */
export function codexConfig(project: string): string {
  return `${CODEX_SETTINGS}\n${codexTrust(project)}`;
}

/** Where a run's omp reads its `config.yml`. */
export function ompConfigFile(dirs: RunDirs): string {
  return join(dirs.home, ".omp", "agent", "config.yml");
}

/** The decline label of Claude's and Codex's permission dialogs: "No", "No, and tell Codex what to do differently". */
const DECLINE_NO = /^no\b/iu;

export const HARNESSES: Readonly<HarnessTable> = {
  claude: {
    id: "claude",
    npm: "@anthropic-ai/claude-code",
    binName: "claude",
    // Haiku is the cheap model. `default` asks before a shell command, which the ask leg needs.
    // `--strict-mcp-config` with an empty file: no MCP server of the person's runs inside the lab.
    startArgs: (dirs) => ["--model", "haiku", "--permission-mode", "default", "--strict-mcp-config", "--mcp-config", join(dirs.config, EMPTY_MCP_FILE)],
    env: (dirs) => ({ CLAUDE_CONFIG_DIR: dirs.config, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" }),
    login: "claude",
    folders: () => [],
    files: () => ({}),
    decline: DECLINE_NO,
    turnCap: TURN_CAP,
    phone: true,
  },
  codex: {
    id: "codex",
    npm: "@openai/codex",
    binName: "codex",
    // `-a on-request -s read-only`, so a shell command asks first; the rest of the canary's start (no update prompt,
    // low effort, the person as reviewer) is in the run's `config.toml` (codexConfig), never `-c`.
    startArgs: () => ["-a", "on-request", "-s", "read-only"],
    env: (dirs) => ({ ...homeEnv(dirs), CODEX_HOME: codexHome(dirs) }),
    login: "codex",
    folders: (dirs) => [codexHome(dirs)],
    // Codex 0.163.0 reads the trust of a folder from the config and does not ask. Without the trust table it asks first.
    files: (dirs) => ({ [join(codexHome(dirs), "config.toml")]: codexConfig(dirs.project) }),
    decline: DECLINE_NO,
    turnCap: TURN_CAP,
    phone: false,
  },
  pi: {
    id: "pi",
    npm: "@earendil-works/pi-coding-agent",
    binName: "pi",
    // `--approve`: since pi 1.2.0 the fresh project folder draws "Trust project folder?" before the box, and the
    // walk then reads a card, not a composer. The flag trusts the folder for this run only and saves nothing.
    startArgs: () => ["--approve", "--thinking", "off"],
    env: (dirs) => ({ ...homeEnv(dirs), PI_CODING_AGENT_DIR: join(dirs.home, ".pi") }),
    login: "none",
    folders: () => [],
    files: () => ({}),
    decline: DECLINE_NO,
    turnCap: 0,
    phone: false,
  },
  opencode: {
    id: "opencode",
    npm: "opencode-ai",
    binName: "opencode",
    startArgs: () => [],
    env: (dirs) => ({ ...homeEnv(dirs), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_CONFIG: join(dirs.root, OPENCODE_ASK_FILE) }),
    login: "none",
    folders: () => [],
    files: (dirs) => ({ [join(dirs.root, OPENCODE_ASK_FILE)]: `${JSON.stringify(OPENCODE_ASK, null, 2)}\n` }),
    // OpenCode's buttons read "Allow once", "Allow always" and "Reject".
    decline: /^reject$/iu,
    turnCap: TURN_CAP,
    phone: false,
  },
  omp: {
    id: "omp",
    npm: "@oh-my-pi/pi-coding-agent",
    binName: "omp",
    // `--approval-mode always-ask`: omp runs a shell command without asking by default. The model is named on
    // the line, so the run does not depend on a config file of the person's.
    startArgs: () => ["--thinking", "off", "--model", OMP_MODEL, "--approval-mode", "always-ask"],
    env: (dirs) => homeEnv(dirs),
    login: "openrouter",
    folders: (dirs) => [dirname(ompConfigFile(dirs))],
    files: (dirs) => ({ [ompConfigFile(dirs)]: OMP_CONFIG }),
    decline: /^deny\b/iu,
    turnCap: TURN_CAP,
    phone: false,
  },
};

export function harnessSpec(id: string): HarnessSpec {
  const spec = HARNESSES[id];
  if (spec === undefined) throw new Error(`the lab does not know a harness named "${id}" (known: ${Object.keys(HARNESSES).join(", ")})`);
  return spec;
}

/** The path of the installed binary. */
export function binaryPath(dirs: RunDirs, spec: HarnessSpec): string {
  return join(dirs.bin, "node_modules", ".bin", spec.binName);
}

/** What the lab runs for its install: the argument list and the whole environment of that one process. */
export interface NpmInstallCommand {
  readonly argv: readonly string[];
  readonly env: EnvMap;
}

/**
 * The command and the environment of the lab's one `npm install`.
 *
 * Decision by Altan, 2026-10-30: the lab installs a day-one agent version, so the install sets npm's
 * `min-release-age` to 0. The setting rides on this one call as `npm_config_min_release_age`, which beats
 * the `min-release-age=7` in the person's `~/.npmrc`. It never goes into that file, and it reaches no other
 * npm call: the install prefix is a throwaway under the run directory. Without it, a version younger than
 * seven days fails with ETARGET and the ledger keeps a permanent `failed` row for the pair.
 */
export function npmInstallCommand(spec: HarnessSpec, dirs: RunDirs, version: string, base: Readonly<Record<string, string>>): NpmInstallCommand {
  return {
    argv: ["npm", "install", "--prefix", dirs.bin, "--no-audit", "--no-fund", "--no-save", `${spec.npm}@${version}`],
    env: { ...base, npm_config_min_release_age: "0" },
  };
}

/** The environment a tmux server gets: a short list, never the whole environment of the caller. */
export const SERVER_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"] as const;

export function serverEnv(source: Readonly<Record<string, string | undefined>>): EnvMap {
  const out: EnvMap = { TERM: "xterm-256color" };
  for (const key of SERVER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
