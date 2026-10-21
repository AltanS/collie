import { homedir } from "node:os";

import { HOST } from "./host.ts";
import { createLoginPath, type LoginPathDeps } from "./login-path.ts";
import { MUX_AGENT_NAMES } from "./mux/agents.ts";
import { findTool } from "./tools.ts";
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
// what made these the contract's names in the first place. Kiro is the exception: its program is
// `kiro-cli`, which Herdr reports as `kiro`.
//
// ── FOUND, WITH THE LOGIN SHELL'S PATH ──────────────────────────────────────────────────────────
// A bridge under systemd or Herdr has a short PATH (on bluefin both `opencode` and `pi` live in a
// folder only the profile adds). So the search runs over the login shell's PATH (`bridge/login-path.ts`),
// and `findTool` then adds its fixed folders (`bridge/tools.ts`). A found result is kept for
// {@link FOUND_TTL_MS}, so a phone that opens the sheet twice in a row costs one look.

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
  // The engine (V2 or V3) is the operator's Kiro setting; Collie's Chat and approvals need V3.
  { id: "kiro", label: "Kiro", binary: "kiro-cli" },
  { id: "muse", label: "Muse", binary: "muse" },
  { id: "agy", label: "Antigravity", binary: "agy" },
];

/**
 * Contract names the sheet does not offer, each with its reason. `antigravity` is the desktop app's
 * name; the agent that runs in a terminal is `agy`, listed above. `openclaw` is read (its history,
 * #401) but not started: its TUI is a client of a gateway the operator runs, not one binary to call.
 * `cursor` has an input profile and no launch entry.
 */
export const NOT_STARTED = {
  antigravity: "the desktop app; its terminal agent is agy",
  openclaw: "its TUI is a client of the operator's gateway; Collie reads its history only",
  cursor: "Collie reads its input box through a profile only; the New sheet does not start the Cursor CLI (cursor-agent)",
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

export interface HarnessProbeDeps extends LoginPathDeps {
  home?: string;
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
  const now = deps.now ?? (() => Date.now());
  const find =
    deps.find ?? ((binary: string, path: string | undefined) => findTool(binary, { ...env, PATH: path }, home, host) !== null);
  const pathForSearch = createLoginPath(deps);

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
