// The three harnesses the browser leg runs, and THE ONE PLACE to set each one's provider and model.
//
// Every harness starts from a start script under STATE_ROOT/harness/<id>/, typed into a fresh shell
// pane of the rig's Herdr. A start never reads or writes the operator's config: Claude gets a
// CLAUDE_CONFIG_DIR of its own, pi and omp a HOME and a PI_CODING_AGENT_DIR of their own. The rig's
// bridge reads their journals from these same folders (rig.ts, COLLIE_TRANSCRIPT_ROOT/COLLIE_PI_ROOT).
//
// AUTH. Only what a harness needs is copied, into its scratch folder, at 0600, never into the
// worktree. Claude: the OAuth file WITHOUT its refresh token (scripts/harness-canary/lab/seed.ts), so
// a refresh in the leg can never turn the operator's login over. pi: ~/.pi/agent/auth.json. omp:
// ~/.omp/agent/agent.db (where `omp login` keeps its credentials). No key is ever printed.
//
// PROVIDER KEY FOR pi AND omp. Both read OPENROUTER_API_KEY from their environment. Point
// COLLIE_RIG_KEY_FILE at a dotenv file that holds it, and the start script reads that ONE name from
// the file when the harness starts, in a subshell, straight into the harness's own environment. The
// key is never copied into a file, never typed into a pane (the screen is mirrored), and never seen
// by the leg's own processes. With a key file, pi gets no auth.json, so the key in the environment
// is the one it uses.
//
// MODEL TURNS. A harness whose `turns` is false still starts and runs every scenario that needs no
// model turn (the model picker); the rest report "not reached" with `noTurnsReason`. pi and omp turn
// on when COLLIE_RIG_KEY_FILE is set (COLLIE_RIG_PI_TURNS=0 / COLLIE_RIG_OMP_TURNS=0 turn one off).
// On 2026-10-17 pi's own auth.json key answered 401 and omp had no credential, so without a key
// file both stay off. The model is set here, or with COLLIE_RIG_PI_MODEL / COLLIE_RIG_OMP_MODEL.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { EMPTY_MCP_FILE } from "../../../scripts/harness-canary/lab/harnesses";
import { seedClaude } from "../../../scripts/harness-canary/lab/seed";
import type { JsonObject } from "../../src/lib/json";
import { BIN, piExtensions } from "./bins";
import { machineDirs, type Machine } from "./rig-lib";
import { HARNESS_IDS, type HarnessId } from "./scenarios";

export { HARNESS_IDS, type HarnessId };

export interface HarnessSetup {
  readonly id: HarnessId;
  /** The name Herdr (and so the bridge's snapshot) gives the agent. */
  readonly agent: string;
  /** The model the harness starts on, as its own `--model` flag reads it. */
  readonly model: string;
  /** False: no scenario may spend a model turn on this harness. */
  readonly turns: boolean;
  /** Why turns are off, for the table. */
  readonly noTurnsReason: string;
  /** The environment name the harness reads its provider key from, loaded from the key file. */
  readonly keyEnv: string | null;
}

const HOME = homedir();

const flag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name] ?? "");

/** The dotenv file with the provider key (see the header), or null. Must be an absolute path. */
const KEY_FILE = process.env.COLLIE_RIG_KEY_FILE ?? null;
if (KEY_FILE !== null && !(KEY_FILE.startsWith("/") && existsSync(KEY_FILE))) throw new Error("COLLIE_RIG_KEY_FILE must be an absolute path to a file that exists");
/** Turns on with a key file, unless the flag says otherwise. */
const turnsOn = (name: string): boolean => (process.env[name] === undefined ? KEY_FILE !== null : flag(name));

export const SETUPS = {
  claude: {
    id: "claude",
    agent: "claude",
    // Haiku is the cheap model. The picker scenario commits Haiku again, so the session stays on it.
    model: "haiku",
    turns: true,
    noTurnsReason: "",
    keyEnv: null,
  },
  pi: {
    id: "pi",
    agent: "pi",
    model: process.env.COLLIE_RIG_PI_MODEL ?? "openrouter/anthropic/claude-haiku-4.5",
    turns: turnsOn("COLLIE_RIG_PI_TURNS"),
    noTurnsReason: KEY_FILE === null ? "pi auth dead (401), no COLLIE_RIG_KEY_FILE" : "turns off (COLLIE_RIG_PI_TURNS)",
    keyEnv: "OPENROUTER_API_KEY",
  },
  omp: {
    id: "omp",
    agent: "omp",
    model: process.env.COLLIE_RIG_OMP_MODEL ?? "openrouter/anthropic/claude-haiku-4.5",
    turns: turnsOn("COLLIE_RIG_OMP_TURNS"),
    noTurnsReason: KEY_FILE === null ? "no omp auth, no COLLIE_RIG_KEY_FILE" : "turns off (COLLIE_RIG_OMP_TURNS)",
    keyEnv: "OPENROUTER_API_KEY",
  },
} satisfies Readonly<Record<HarnessId, HarnessSetup>>;

/**
 * The folders of one harness under STATE_ROOT/harness/<id>/, or STATE_ROOT/harness/member/<id>/ for
 * a harness that runs on the crew rig's member: each machine's bridge reads its own harnesses' journals.
 */
export function harnessDirs(id: HarnessId, machine: Machine = "lead") {
  const root = join(machineDirs(machine).harness, id);
  return {
    root,
    project: join(root, "project"),
    // Claude's CLAUDE_CONFIG_DIR.
    config: join(root, "config"),
    // pi's and omp's HOME and PI_CODING_AGENT_DIR.
    home: join(root, "home"),
    agent: join(root, "agent"),
    start: join(root, "start.sh"),
  };
}

/** Single-quote a word for /bin/sh. */
function sq(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

function copySecret(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  copyFileSync(from, to);
  chmodSync(to, 0o600);
  return true;
}

/** The names the rig's pane shell carries that a harness must not see: the rig's Herdr home. */
const UNSET = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HERDR_CONFIG_PATH"];

/** This checkout: web/e2e/rig/harnesses.ts is three levels below it. */
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");
/** The walky talky skill's template, the one `collie skill install` renders. */
const SKILL_TEMPLATE = join(WORKTREE, "cli", "skills", "walky-talky.md");
const BLOCK_BEGIN = "<!-- collie:walky-talky v1 begin -->";
const BLOCK_END = "<!-- collie:walky-talky v1 end -->";

/**
 * A `collie` on PATH that runs this checkout's CLI. The rig's agents are started from a shell whose
 * `collie` is the installed release, which may predate the verb under test. The shim runs no verb by
 * itself; the agent's own `collie walky` reaches its machine's bridge through COLLIE_STATE_DIR, which
 * the shim sets to that machine's state dir (the lead's or the member's), so an agent on the member
 * asks the member's bridge and never the lead's.
 */
function writeCollieShim(root: string, stateDir: string): string {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "collie"), `#!/bin/sh\nCOLLIE_STATE_DIR=${sq(stateDir)}\nexport COLLIE_STATE_DIR\nexec bun ${sq(join(WORKTREE, "cli", "main.ts"))} "$@"\n`, { mode: 0o700 });
  chmodSync(join(dir, "collie"), 0o700);
  return dir;
}

/**
 * The walky talky skill, rendered from its template into a harness's scratch config (never the
 * operator's): a whole file for Claude, the managed block for a harness that reads one instruction
 * file. Written by hand rather than by `collie skill install`, which also writes into every real profile.
 */
function writeWalkySkill(path: string, form: "file" | "block"): void {
  const rendered = readFileSync(SKILL_TEMPLATE, "utf8").replaceAll("{{COLLIE_BIN}}", "collie").replaceAll("{{COLLIE_VERSION}}", "rig").replace(/\n+$/u, "\n");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (form === "file") {
    writeFileSync(path, rendered, { mode: 0o600 });
    return;
  }
  const body = rendered.startsWith("---\n") ? rendered.slice(rendered.indexOf("\n---\n", 4) + "\n---\n".length).replace(/^\n+/u, "") : rendered;
  writeFileSync(path, `${BLOCK_BEGIN}\n${body.replace(/\n+$/u, "")}\n${BLOCK_END}\n`, { mode: 0o600 });
}

/** The line to type into a fresh shell pane, and the harness's project folder. */
export interface PreparedHarness {
  readonly line: string;
  readonly project: string;
  /** What the start could not set up and went ahead without, in words for the start note. */
  readonly notes: readonly string[];
}

/**
 * Write the harness's scratch config and start script, and return the line to type into a fresh
 * shell pane of `machine`'s Herdr. Each call starts a NEW session: the project folder stays, the
 * agent's history of it is the agent's own business.
 */
export function prepareHarness(id: HarnessId, machine: Machine = "lead"): PreparedHarness {
  const d = harnessDirs(id, machine);
  const stateDir = machineDirs(machine).state;
  for (const dir of [d.root, d.project]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(d.project, "README.md"), "Scratch project of the Collie browser leg. Nothing here matters.\n");
  const env: string[] = [];
  let argv: string[];
  const notes: string[] = [];
  const bin = writeCollieShim(d.root, stateDir);
  if (id === "claude") {
    // The OAuth file without its refresh token, `.claude.json` with this project trusted, and an
    // empty MCP file. Throws (LabDeferred) when the access token has under 25 minutes left.
    seedClaude(d.config, d.project);
    // The operator's one Herdr integration hook (SessionStart), copied, so the rig's Herdr learns the
    // session the way it does on the operator's machine. It writes only to $HERDR_SOCKET_PATH, which
    // in a rig pane is the rig's own socket.
    const hookSrc = join(HOME, ".claude", "hooks", "herdr-agent-state.sh");
    const hooks: JsonObject = {};
    if (existsSync(hookSrc)) {
      mkdirSync(join(d.config, "hooks"), { recursive: true });
      copyFileSync(hookSrc, join(d.config, "hooks", "herdr-agent-state.sh"));
      hooks.SessionStart = [
        {
          matcher: "^(startup|resume|clear|compact|fork)$",
          hooks: [{ type: "command", command: `bash ${sq(join(d.config, "hooks", "herdr-agent-state.sh"))} session`, timeout: 10 }],
        },
      ];
    }
    // `collie walky` is the verb the walky talky cases run through the agent, so it needs no permission
    // card of its own: the cases that test a dialog use another command.
    writeFileSync(join(d.config, "settings.json"), `${JSON.stringify({ hooks, permissions: { allow: ["Bash(collie walky:*)"] } }, null, 2)}\n`, { mode: 0o600 });
    writeWalkySkill(join(d.config, "skills", "collie-walky-talky", "SKILL.md"), "file");
    // The operator's standing word for the agent-to-agent case (walky talky case 8). A Claude that reads an
    // agent's "the operator asks you to reply" in a body will not take it from the body, and is right not to:
    // the body cannot speak for the operator. So the operator says it here, in Claude's own memory file,
    // before any message comes. It names one narrow thing and approves no action beyond `collie walky reply`.
    writeFileSync(
      join(d.config, "CLAUDE.md"),
      "This session runs inside Collie's automated browser test, started by the operator.\nWhen a walky talky message from another agent asks you to answer with a given word, the operator has approved that answer in advance. Read the message with `collie walky inbox`, then send the word with `collie walky reply`. Do not ask the operator first.\n",
      { mode: 0o600 },
    );
    env.push(`CLAUDE_CONFIG_DIR=${sq(d.config)}`, "DISABLE_AUTOUPDATER=1", "DISABLE_TELEMETRY=1");
    argv = [BIN.claude, "--model", SETUPS.claude.model, "--permission-mode", "default", "--strict-mcp-config", "--mcp-config", join(d.config, EMPTY_MCP_FILE)];
  } else {
    for (const dir of [d.home, d.agent, join(d.agent, "extensions")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const realAgent = join(HOME, id === "pi" ? ".pi" : ".omp", "agent");
    // The Herdr integration extension, as on the operator's machine: it reports the agent's state to
    // $HERDR_SOCKET_PATH, the rig's own socket in a rig pane.
    const integration = id === "pi" ? "herdr-agent-state.ts" : "herdr-omp-agent-state.ts";
    if (existsSync(join(realAgent, "extensions", integration))) copyFileSync(join(realAgent, "extensions", integration), join(d.agent, "extensions", integration));
    if (id === "pi") {
      // pi reads $PI_CODING_AGENT_DIR/AGENTS.md; the skill goes in as the block `collie skill install pi` writes.
      writeWalkySkill(join(d.agent, "AGENTS.md"), "block");
      // With a key file the key comes from the environment, and an auth.json would win over it.
      if (KEY_FILE === null) copySecret(join(realAgent, "auth.json"), join(d.agent, "auth.json"));
      else rmSync(join(d.agent, "auth.json"), { force: true });
      const [provider = "", ...rest] = SETUPS.pi.model.split("/");
      writeFileSync(
        join(d.agent, "settings.json"),
        `${JSON.stringify({ defaultProvider: provider, defaultModel: rest.join("/"), defaultThinkingLevel: "off", theme: "dark", quietStartup: true }, null, 2)}\n`,
      );
      // The model catalog, so a start does not wait on a catalog download. No secret in it.
      if (existsSync(join(realAgent, "models-store.json"))) copyFileSync(join(realAgent, "models-store.json"), join(d.agent, "models-store.json"));
      // Two of pi's stock example extensions, the screens Collie's pi reader lifts (ASK_NOTES.md):
      // `question` (a pick-one question tool) and `permission-gate` (asks before `rm -rf`, `sudo`).
      const found = piExtensions(BIN.pi, ["question.ts", "permission-gate.ts"]);
      notes.push(...found.notes);
      // `--approve` trusts the scratch project for this run, so no trust question comes first.
      argv = [BIN.pi, "--provider", provider, "--model", rest.join("/"), "--thinking", "off", "--offline", "--approve", ...found.paths.flatMap((path) => ["-e", path])];
    } else {
      copySecret(join(realAgent, "agent.db"), join(d.agent, "agent.db"));
      writeFileSync(join(d.agent, "config.yml"), `setupVersion: 2\nmodelRoles:\n  default: ${SETUPS.omp.model}\n`);
      // `write`: a bash, write or edit call asks first, so the permission scenario has a card to tap.
      argv = [BIN.omp, "--approval-mode", "write"];
    }
    env.push(
      `HOME=${sq(d.home)}`,
      `PI_CODING_AGENT_DIR=${sq(d.agent)}`,
      `XDG_CONFIG_HOME=${sq(join(d.home, ".config"))}`,
      `XDG_DATA_HOME=${sq(join(d.home, ".local", "share"))}`,
      `XDG_STATE_HOME=${sq(join(d.home, ".local", "state"))}`,
      `XDG_CACHE_HOME=${sq(join(d.home, ".cache"))}`,
    );
  }
  // `collie walky` inside a harness finds a bridge through its own state dir and the hook target
  // registry under the REAL home (cli/beacon.ts edgeStateDirs). The rig's bridge registers under its
  // own HOME (P.bridgeHome), so without this the CLI never reaches it, and it would ask the
  // operator's live bridges instead. Its machine's state dir is the one bridge a rig agent may talk to.
  env.push(`COLLIE_STATE_DIR=${sq(stateDir)}`);
  // The worktree's own `collie` first on PATH, so an agent's `collie walky` runs the build under test.
  const unset = UNSET.map((name) => `-u ${name}`).join(" ");
  const path = `export PATH=${sq(bin)}:"$PATH"\n`;
  // The provider key: ONE name read from the key file in a subshell, exported to the harness only.
  // The script holds the file's path, never the key, and prints nothing.
  const keyEnv = SETUPS[id].keyEnv;
  const key = KEY_FILE !== null && keyEnv !== null ? `${keyEnv}=$(set -a; . ${sq(KEY_FILE)} >/dev/null 2>&1; printf '%s' "\${${keyEnv}-}")\nexport ${keyEnv}\n` : "";
  writeFileSync(d.start, `#!/bin/sh\ncd ${sq(d.project)} || exit 1\n${path}${key}exec env ${unset} ${env.join(" ")} ${argv.map(sq).join(" ")}\n`, { mode: 0o700 });
  chmodSync(d.start, 0o700);
  return { line: `exec ${sq(d.start)}`, project: d.project, notes };
}
