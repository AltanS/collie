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
// MODEL TURNS. A harness whose `turns` is false still starts and runs every scenario that needs no
// model turn (the model picker); the rest report "not reached" with `noTurnsReason`. On 2026-10-17
// pi's only provider key (OpenRouter) answered 401 and omp had no credential at all, so both are off
// by default. When a working provider exists, set it here (or with the env names in the README):
//
//   COLLIE_RIG_PI_MODEL=openrouter/anthropic/claude-haiku-5.5 COLLIE_RIG_PI_TURNS=1
//   COLLIE_RIG_OMP_MODEL=openrouter/anthropic/claude-haiku-5.5 COLLIE_RIG_OMP_TURNS=1
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EMPTY_MCP_FILE } from "../../../scripts/harness-canary/lab/harnesses";
import { seedClaude } from "../../../scripts/harness-canary/lab/seed";
import type { JsonObject } from "../../src/lib/json";
import { P } from "./rig-lib";

export type HarnessId = "claude" | "pi" | "omp";
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "pi", "omp"];

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
}

const HOME = homedir();
/** The binaries, by absolute path. `claude` on PATH is a shell function and a cgroup shim here. */
const BIN = {
  claude: process.env.COLLIE_RIG_CLAUDE_BIN ?? join(HOME, ".local", "bin", "claude"),
  pi: process.env.COLLIE_RIG_PI_BIN ?? join(HOME, ".config", "nvm", "versions", "node", "v24.8.0", "bin", "pi"),
  omp: process.env.COLLIE_RIG_OMP_BIN ?? join(HOME, ".bun", "bin", "omp"),
} as const;

const flag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name] ?? "");

export const SETUPS = {
  claude: {
    id: "claude",
    agent: "claude",
    // Haiku is the cheap model. The picker scenario commits Haiku again, so the session stays on it.
    model: "haiku",
    turns: true,
    noTurnsReason: "",
  },
  pi: {
    id: "pi",
    agent: "pi",
    model: process.env.COLLIE_RIG_PI_MODEL ?? "openrouter/anthropic/claude-haiku-5.5",
    turns: flag("COLLIE_RIG_PI_TURNS"),
    noTurnsReason: "pi auth dead (OpenRouter 401)",
  },
  omp: {
    id: "omp",
    agent: "omp",
    model: process.env.COLLIE_RIG_OMP_MODEL ?? "openrouter/anthropic/claude-haiku-5.5",
    turns: flag("COLLIE_RIG_OMP_TURNS"),
    noTurnsReason: "no omp auth on this host",
  },
} satisfies Readonly<Record<HarnessId, HarnessSetup>>;

/** The folders of one harness under STATE_ROOT/harness/<id>/. */
export function harnessDirs(id: HarnessId) {
  const root = join(P.harness, id);
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

/** The line to type into a fresh shell pane, and the harness's project folder. */
export interface PreparedHarness {
  readonly line: string;
  readonly project: string;
}

/**
 * Write the harness's scratch config and start script, and return the line to type into a fresh
 * shell pane. Each call starts a NEW session: the project folder stays, the agent's history of it
 * is the agent's own business.
 */
export function prepareHarness(id: HarnessId): PreparedHarness {
  const d = harnessDirs(id);
  for (const dir of [d.root, d.project]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(d.project, "README.md"), "Scratch project of the Collie browser leg. Nothing here matters.\n");
  const env: string[] = [];
  let argv: string[];
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
    writeFileSync(join(d.config, "settings.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, { mode: 0o600 });
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
      copySecret(join(realAgent, "auth.json"), join(d.agent, "auth.json"));
      const [provider, ...rest] = SETUPS.pi.model.split("/");
      writeFileSync(
        join(d.agent, "settings.json"),
        `${JSON.stringify({ defaultProvider: provider, defaultModel: rest.join("/"), defaultThinkingLevel: "off", theme: "dark", quietStartup: true }, null, 2)}\n`,
      );
      // The model catalog, so a start does not wait on a catalog download. No secret in it.
      if (existsSync(join(realAgent, "models-store.json"))) copyFileSync(join(realAgent, "models-store.json"), join(d.agent, "models-store.json"));
      // Two of pi's stock example extensions, the screens Collie's pi reader lifts (ASK_NOTES.md):
      // `question` (a pick-one question tool) and `permission-gate` (asks before `rm -rf`, `sudo`).
      const examples = join(BIN.pi, "..", "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions");
      const extensions = ["question.ts", "permission-gate.ts"].map((file) => join(examples, file)).filter((path) => existsSync(path));
      // `--approve` trusts the scratch project for this run, so no trust question comes first.
      argv = [BIN.pi, "--thinking", "off", "--offline", "--approve", ...extensions.flatMap((path) => ["-e", path])];
    } else {
      copySecret(join(realAgent, "agent.db"), join(d.agent, "agent.db"));
      writeFileSync(join(d.agent, "config.yml"), `setupVersion: 2\nmodelRoles:\n  default: ${SETUPS.omp.model}\n`);
      argv = [BIN.omp];
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
  const unset = UNSET.map((name) => `-u ${name}`).join(" ");
  writeFileSync(d.start, `#!/bin/sh\ncd ${sq(d.project)} || exit 1\nexec env ${unset} ${env.join(" ")} ${argv.map(sq).join(" ")}\n`, { mode: 0o700 });
  chmodSync(d.start, 0o700);
  return { line: `exec ${sq(d.start)}`, project: d.project };
}
