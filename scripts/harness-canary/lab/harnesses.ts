// What the lab needs to know about each harness it can run (M56 spec 10): which npm package holds the
// version, which file runs it, how it starts, and where its own config lives so the lab can move it.
//
// Only Claude has a profile in web/src/lib/surface/profiles/, so only Claude runs the Surface and
// protocol legs. The others run the walk, and the ledger row says `walk-only`.
//
// A start never reads the person's config. Claude gets `CLAUDE_CONFIG_DIR`. Every other harness gets a
// `HOME` of its own under the run directory, and its own config variables point there too.

import { join } from "node:path";

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
  /** Whether the lab copies the person's login into the run directory. */
  readonly seedsLogin: boolean;
  /** Model turns the lab may spend on this harness in one run. */
  readonly turnCap: number;
  /** Whether the phone leg runs for this harness (phone.ts). Claude only: the scenarios are Claude's. */
  readonly phone: boolean;
}

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

/** The model turns one Claude run may spend: the send, the ask request, and what Claude does after a No. */
export const CLAUDE_TURN_CAP = 4;

export const HARNESSES: Readonly<HarnessTable> = {
  claude: {
    id: "claude",
    npm: "@anthropic-ai/claude-code",
    binName: "claude",
    // Haiku is the cheap model. `default` asks before a shell command, which the ask leg needs.
    // `--strict-mcp-config` with an empty file: no MCP server of the person's runs inside the lab.
    startArgs: (dirs) => ["--model", "haiku", "--permission-mode", "default", "--strict-mcp-config", "--mcp-config", join(dirs.config, EMPTY_MCP_FILE)],
    env: (dirs) => ({ CLAUDE_CONFIG_DIR: dirs.config, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" }),
    seedsLogin: true,
    turnCap: CLAUDE_TURN_CAP,
    phone: true,
  },
  codex: {
    id: "codex",
    npm: "@openai/codex",
    binName: "codex",
    startArgs: () => ["-c", "check_for_update_on_startup=false"],
    env: (dirs) => ({ ...homeEnv(dirs), CODEX_HOME: join(dirs.home, ".codex") }),
    seedsLogin: false,
    turnCap: 0,
    phone: false,
  },
  pi: {
    id: "pi",
    npm: "@earendil-works/pi-coding-agent",
    binName: "pi",
    startArgs: () => ["--thinking", "off"],
    env: (dirs) => ({ ...homeEnv(dirs), PI_CODING_AGENT_DIR: join(dirs.home, ".pi") }),
    seedsLogin: false,
    turnCap: 0,
    phone: false,
  },
  opencode: {
    id: "opencode",
    npm: "opencode-ai",
    binName: "opencode",
    startArgs: () => [],
    env: (dirs) => ({ ...homeEnv(dirs), OPENCODE_DISABLE_AUTOUPDATE: "1" }),
    seedsLogin: false,
    turnCap: 0,
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
