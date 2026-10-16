// The real hands of a lab run (M56 spec 10): npm, git, a throwaway tmux, the walk, the protocol.
// run.ts holds the order of the steps. This file does the work, so a test of the order needs none of it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTmuxBinary } from "../../../bridge/mux/tmux/exec";
import { gateFor } from "../../../bridge/surface/key-gate";
import { profileFor } from "../../../web/src/lib/surface/profile";
import { loadSlashLists } from "../slash-commands";
import { binaryPath, serverEnv, type HarnessSpec, type RunDirs } from "./harnesses";
import { LabCounters, labProfile, runAskLeg, runSendLeg, TmuxPane, type LegEnv } from "./legs";
import { openIssue, publishPass } from "./publish";
import type { LabPorts, SessionFacts } from "./run";
import { LabDeferred, LabInfraError, seedClaude, type SeedSource } from "./seed";
import { LabTmux, paneCommand } from "./tmux";
import { SETTLED_OUTCOMES, type AskFact, type ScreenFact, type SendFact } from "./verdict";
import { runWalk } from "./walk";

const INSTALL_TIMEOUT_MS = 6 * 60_000;
const START_TIMEOUT_MS = 45_000;
const VERSION_IN_TEXT = /\d+\.\d+\.\d+/u;

/** The project folder: a fresh git repo with one commit, so an agent starts in an ordinary project. */
export function makeProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# lab\n");
  const git = (args: readonly string[]): void => {
    const done = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=lab", "-c", "user.email=lab@localhost", ...args], { stdout: "pipe", stderr: "pipe" });
    if (done.exitCode !== 0) throw new LabInfraError(`git ${args.join(" ")} failed: ${done.stderr.toString().trim()}`);
  };
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "init"]);
}

export interface RealOptions {
  readonly seedSource?: SeedSource;
  readonly minLoginMinutes?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

async function run(argv: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: `${out}\n${err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll until the first screen holds still, or the bound passes. */
async function waitStarted(pane: TmuxPane, log: (line: string) => void): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let hash = "";
  let same = 0;
  while (Date.now() < deadline) {
    const view = await pane.read();
    const filled = view.plain.filter((row) => row.trim().length > 0).length >= 3;
    same = filled && view.hash === hash ? same + 1 : 0;
    hash = view.hash;
    if (same >= 3) return;
    await pane.sleep(700);
  }
  log("the first screen did not hold still in time; the walk reads what is there");
}

export function realPorts(options: RealOptions = {}): LabPorts {
  const env = options.env ?? process.env;
  return {
    async preflight(spec: HarnessSpec, dirs: RunDirs): Promise<void> {
      if (resolveTmuxBinary("") === null) throw new LabDeferred("no tmux binary on this machine");
      if (Bun.which("npm") === null) throw new LabDeferred("no npm on PATH");
      if (Bun.which("git") === null) throw new LabDeferred("no git on PATH");
      makeProject(dirs.project);
      // The login is checked here, before the claim: a token that is too old defers the run and costs nothing.
      if (spec.seedsLogin) seedClaude(dirs.config, dirs.project, options.seedSource, options.minLoginMinutes);
    },

    async install(spec, dirs, version, log): Promise<string> {
      mkdirSync(dirs.bin, { recursive: true });
      const base = { ...serverEnv(env), npm_config_update_notifier: "false", npm_config_fund: "false" };
      const result = await run(["npm", "install", "--prefix", dirs.bin, "--no-audit", "--no-fund", "--no-save", `${spec.npm}@${version}`], dirs.bin, base, INSTALL_TIMEOUT_MS);
      if (result.code !== 0) throw new LabInfraError(`npm install ${spec.npm}@${version} exited ${String(result.code)}: ${result.out.trim().split("\n").slice(-3).join(" ")}`);
      const printed = await run([binaryPath(dirs, spec), "--version"], dirs.root, { ...base, ...spec.env(dirs) }, 30_000);
      const found = VERSION_IN_TEXT.exec(printed.out)?.[0];
      if (found !== version) throw new LabInfraError(`the installed binary prints ${found ?? "no version"}, and the lab asked for ${version}`);
      log(`npm installed ${spec.npm}@${version}; the binary prints ${found}`);
      return found;
    },

    async session(spec, dirs, version, log): Promise<SessionFacts> {
      const tmux = new LabTmux();
      const counters = new LabCounters();
      try {
        const command = paneCommand(spec.env(dirs), binaryPath(dirs, spec), spec.startArgs);
        await tmux.start(dirs.project, command, serverEnv(env));
        log(`tmux server ${tmux.socket} started`);
        const mux = tmux.adapter();
        const paneId = await tmux.paneId();
        const gate = gateFor(mux);
        const pane = new TmuxPane(mux, gate, paneId, spec.id);
        await waitStarted(pane, log);

        const walked = await runWalk(pane, loadSlashLists(spec.id));
        for (const line of walked.log) log(line);
        const screens: ScreenFact[] = [...walked.screens];
        const profile = profileFor(spec.id, version, { log });
        const turns = { used: 0, cap: spec.turnCap };
        let send: SendFact | null = null;
        let ask: AskFact | null = null;

        const walkClean = walked.walk.reached && walked.walk.returned && walked.walk.startedTurn === null && walked.walk.menuRead;
        if (labProfile(spec.id, version, log) !== null && walkClean) {
          const leg: LegEnv = { harness: spec.id, version, mux, pane, sendsDir: dirs.sends, project: dirs.project, counters, turns, log };
          const sent = await runSendLeg(leg);
          send = sent.fact;
          screens.push(...sent.screens);
          if (sent.note.length > 0) log(`send leg: ${sent.note}`);
          if (send !== null && SETTLED_OUTCOMES.includes(send.outcome)) {
            const asked = await runAskLeg(leg);
            ask = asked.fact;
            screens.push(...asked.screens);
            if (asked.note.length > 0) log(`ask leg: ${asked.note}`);
          }
        }
        return {
          facts: { profile: profile?.status ?? "none", walk: walked.walk, screens, send, ask, turns: turns.used },
          counters: [...counters.lines, `key presses by the lab: ${String(pane.keysSent)}`, `screen reads: ${String(pane.reads)}`, `key gate sends: ${JSON.stringify(gate.sentBy())}`],
        };
      } finally {
        const gone = await tmux.stop();
        log(`tmux server ${tmux.socket}: ${gone && !tmux.leftover() ? "stopped, socket gone" : "NOT STOPPED"}`);
      }
    },

    publishPass: (input) => publishPass(input),
    openIssue: (files, issue, repoSlug) => openIssue(files, issue, repoSlug),
  };
}

