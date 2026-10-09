import { homedir } from "node:os";
import { basename } from "node:path";

import { HOST, type Host } from "./host.ts";
import { MUX_AGENT_NAMES } from "./mux/agents.ts";
import { envGet, findTool } from "./tools.ts";
import type { HarnessInfo } from "./types.ts";

// ── The agents the New sheet can start, by id, per machine (ADR 0091) ────────────────────────────
//
// The phone holds no list of harness names. It asks the machine a start would go to
// (`GET /api/launchers`, forwarded on `?host=` like the operator's rows), and that machine answers
// with the harnesses Collie knows and whether each binary is there. The phone then names one by its
// id, and the bridge, never the phone, turns the id into the line that is typed. So a phone cannot
// start a binary nobody listed, exactly as it cannot run a command line `launchers.toml` does not hold.
//
// ── WHICH NAMES ─────────────────────────────────────────────────────────────────────────────────
// The ids are agent names the mux contract already accepts (`bridge/mux/agents.ts`): the name a pane
// reports once the agent runs is the name it was started by, so the started pane reads with its own
// harness straight away. `harness-launch.test.ts` fails when a contract name is neither here nor in
// {@link NOT_STARTED}. The binary is the same word: Herdr names an agent by its process, which is
// what made these the contract's names in the first place.
//
// ── FOUND, WITH THE LOGIN SHELL'S PATH ──────────────────────────────────────────────────────────
// A bridge under systemd or Herdr has a short PATH. The operator's shell, the one the new pane runs,
// sources a profile, and that is where `~/.opencode/bin` or an nvm folder is added (on bluefin both
// `opencode` and `pi` live there). So the search runs over the login shell's PATH, asked once per
// process with argv only and a short cap, and falls back to the bridge's own PATH when the shell
// cannot be asked. `findTool` then adds its fixed folders (`bridge/tools.ts`). A found result is kept
// for {@link FOUND_TTL_MS}, so a phone that opens the sheet twice in a row costs one look.

/** One agent Collie can start. */
export interface HarnessLaunch {
  /** The id the phone sends, and the agent name the pane will report. */
  id: string;
  /** The harness's own name for itself. Its own word, never translated. */
  label: string;
  /** The program looked for, and the line typed into the new shell. */
  binary: string;
}

/** Every agent the New sheet may start, in the order the sheet lists them. */
export const HARNESS_LAUNCHES: readonly HarnessLaunch[] = [
  { id: "claude", label: "Claude Code", binary: "claude" },
  { id: "codex", label: "Codex", binary: "codex" },
  { id: "opencode", label: "opencode", binary: "opencode" },
  { id: "pi", label: "pi", binary: "pi" },
  { id: "omp", label: "omp", binary: "omp" },
  { id: "grok", label: "Grok", binary: "grok" },
  { id: "hermes", label: "Hermes", binary: "hermes" },
  { id: "muse", label: "Muse", binary: "muse" },
  { id: "agy", label: "Antigravity", binary: "agy" },
];

/**
 * Contract names the sheet does not offer, each with its reason. `antigravity` is the desktop app's
 * name; the agent that runs in a terminal is `agy`, listed above.
 */
export const NOT_STARTED = {
  antigravity: "the desktop app; its terminal agent is agy",
} as const satisfies Readonly<Record<string, string>>;

/** The launch for `id`, or `undefined` for a name Collie does not start. Exact match only. */
export function harnessLaunch(id: string): HarnessLaunch | undefined {
  return HARNESS_LAUNCHES.find((h) => h.id === id);
}

/** Whether every launch id is a contract name. `harness-launch.test.ts` reads it. */
export function launchIdsAreContractNames(): boolean {
  return HARNESS_LAUNCHES.every((h) => MUX_AGENT_NAMES.includes(h.id));
}

/** How long a found result is kept. */
export const FOUND_TTL_MS = 60_000;
/** The login shell is given this long to print its PATH. */
export const LOGIN_PATH_TIMEOUT_MS = 3_000;
/** A PATH past this is not one a shell printed. */
const LOGIN_PATH_MAX_BYTES = 64 * 1024;

/** Asks a login shell for its PATH. `null` when it cannot be asked or does not answer in time. */
export type LoginPathAsk = (shell: string) => Promise<string | null>;

/**
 * The real thing: `<shell> -lc 'printf %s "$PATH"'`, argv only, no stdin, killed at the cap. `-l`
 * sources the login profile, which is where a profile adds tool folders. A shell that prints more
 * than one line (a profile that echoes) is read as its LAST line.
 */
export const askLoginPath: LoginPathAsk = async (shell) => {
  try {
    const proc = Bun.spawn([shell, "-lc", 'printf %s "$PATH"'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), LOGIN_PATH_TIMEOUT_MS);
    try {
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0 || out.length > LOGIN_PATH_MAX_BYTES) return null;
      const last = out.split("\n").at(-1)?.trim() ?? "";
      return last === "" ? null : last;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};

/** Shells whose `-lc` takes a POSIX-quoted script. Another shell is not asked. */
const POSIX_LOGIN_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]);

export interface HarnessProbeDeps {
  env?: Record<string, string | undefined>;
  home?: string;
  host?: Host;
  askPath?: LoginPathAsk;
  /** Whether a binary is found on a PATH. Defaults to {@link findTool}. */
  find?: (binary: string, path: string | undefined) => boolean;
  now?: () => number;
}

/** What the routes need: this machine's harnesses with their found flag. */
export interface HarnessProbe {
  list(): Promise<HarnessInfo[]>;
  /** Whether `id` is a harness Collie starts here, found or not. */
  launch(id: string): HarnessLaunch | undefined;
}

/**
 * The probe `bridge/index.ts` builds once. The login PATH is asked at most once per process (a
 * profile does not change under a running bridge often enough to pay a shell per sheet), and the
 * found flags are kept for {@link FOUND_TTL_MS}.
 */
export function createHarnessProbe(deps: HarnessProbeDeps = {}): HarnessProbe {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const host = deps.host ?? HOST;
  const askPath = deps.askPath ?? askLoginPath;
  const now = deps.now ?? (() => Date.now());
  const find =
    deps.find ?? ((binary: string, path: string | undefined) => findTool(binary, { ...env, PATH: path }, home, host) !== null);

  let loginPath: Promise<string | undefined> | null = null;
  const pathForSearch = (): Promise<string | undefined> => {
    if (loginPath !== null) return loginPath;
    const own = envGet(env, "PATH", host);
    const shell = envGet(env, "SHELL", host);
    // Windows has no login shell to ask, and an unknown shell may not read `-lc` as a script.
    if (host.platform === "win32" || shell === undefined || !POSIX_LOGIN_SHELLS.has(basename(shell))) {
      loginPath = Promise.resolve(own);
      return loginPath;
    }
    loginPath = askPath(shell).then((asked) => asked ?? own);
    return loginPath;
  };

  let cached: { at: number; list: HarnessInfo[] } | null = null;
  return {
    async list() {
      // A copy each time, so a caller that edits the answer never edits the cache.
      if (cached !== null && now() - cached.at < FOUND_TTL_MS) return structuredClone(cached.list);
      const path = await pathForSearch();
      const list = HARNESS_LAUNCHES.map((h) => ({ id: h.id, label: h.label, found: find(h.binary, path) }));
      cached = { at: now(), list };
      return structuredClone(list);
    },
    launch: harnessLaunch,
  };
}
