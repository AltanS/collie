// The real hands of a lab run (M56 spec 10): npm, git, a throwaway tmux, the walk, the protocol.
// run.ts holds the order of the steps. This file does the work, so a test of the order needs none of it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveTmuxBinary } from "../../../bridge/mux/tmux/exec";
import { gateFor } from "../../../bridge/surface/key-gate";
import { profileFor } from "../../../web/src/lib/surface/profile";
import { loadSlashLists } from "../slash-commands";
import { binaryPath, npmInstallCommand, serverEnv, type EnvMap, type HarnessSpec, type RunDirs } from "./harnesses";
import { LabCounters, labProfile, runAskLeg, runSendLeg, TmuxPane, type LegEnv } from "./legs";
import { ensureClone } from "./clone";
import { openIssue, publishPass } from "./publish";
import type { LabPorts, SessionFacts, SessionPlan } from "./run";
import { loadKnownGaps } from "../known-gaps";
import { beltCommands, operatorBelt, PHONE_TURN_CAP, runPhoneLeg, shippedBeltFromDisk, writeBeaconHooks, type PhoneFacts } from "./phone";
import { ScratchBridge } from "./phone-bridge";
import { PhoneClient } from "./phone-client";
import { LabDeferred, LabInfraError, loginEnv, prepareRun, seedClaude, type CodexSource, type SeedSource } from "./seed";
import { realLiveness } from "./sweep";
import { LabTmux, paneCommand } from "./tmux";
import { isDialogScreen, SETTLED_OUTCOMES, type AskFact, type ScreenFact, type SendFact, type WalkFact } from "./verdict";
import { runWalk } from "./walk";

const INSTALL_TIMEOUT_MS = 6 * 60_000;

/** The ports the person's own Collie instances use (README of the workspace). The lab never binds one. */
export const RESERVED_PORTS = { from: 8787, to: 8799 } as const;

/**
 * A free TCP port on 127.0.0.1 for the phone leg's scratch bridge: the kernel picks one, the lab
 * closes it again and hands the number on. A port in {@link RESERVED_PORTS} is refused, and the
 * kernel is asked again, at most five times.
 */
export function freePort(listen: (port: number) => { readonly port: number; stop(): void } = (port) => Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const server = listen(0);
    const port = server.port;
    server.stop();
    if (port < RESERVED_PORTS.from || port > RESERVED_PORTS.to) return port;
  }
  throw new LabInfraError("the kernel offered only ports the person's Collie uses");
}
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
  readonly codexSource?: CodexSource;
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

/** The walk did not run (a phone-only run). Every flag reads clean, so it adds no reason; the verdict ignores it. */
const NOT_WALKED: WalkFact = { reached: true, returned: true, menuRead: true, startedTurn: null, sent: [], unclassified: [], missing: [] };

/** This checkout: the scratch bridge and the beacon hooks run from it. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

type PhoneTarget = { readonly kind: "scratch"; readonly tmux: LabTmux } | { readonly kind: "bridge"; readonly url: string; readonly token: string };

export function realPorts(options: RealOptions = {}): LabPorts {
  const env = options.env ?? process.env;
  // The tmux server of the session that runs now. A signal handler stops it through `stopAll`.
  let active: LabTmux | null = null;
  // The phone leg's scratch bridge, while it runs. `stopAll` stops it before the tmux server.
  let activeBridge: ScratchBridge | null = null;

  /**
   * The phone leg: its own config folder (a second login copy, no refresh token, inside the run
   * folder), its own panes, and a scratch bridge or the bridge the operator named. Never throws: a
   * leg that cannot start returns a note, and the verdict says the phone leg did not run.
   */
  async function phoneLeg(input: { spec: HarnessSpec; dirs: RunDirs; version: string; log: (line: string) => void; plan: SessionPlan; target: PhoneTarget }): Promise<{ facts: PhoneFacts | null; note?: string }> {
    const { spec, dirs, version, log, plan, target } = input;
    const work = join(dirs.root, "phone");
    const config = join(work, "config");
    let bridge: ScratchBridge | null = null;
    try {
      mkdirSync(work, { recursive: true, mode: 0o700 });
      // The phone panes' folders are not trusted ahead: the trust question is answered like a person would.
      seedClaude(config, join(work, "nothing-trusted"), options.seedSource, options.minLoginMinutes);
      const phoneDirs: RunDirs = { ...dirs, config };
      let client: PhoneClient;
      let agentEnv: EnvMap;
      let streamWanted: readonly string[];
      if (target.kind === "scratch") {
        writeBeaconHooks(config, REPO_ROOT);
        await target.tmux.setDefaultSize();
        bridge = await ScratchBridge.start({ repoRoot: REPO_ROOT, root: join(work, "bridge"), tmuxSocket: target.tmux.socket, tmuxBinary: target.tmux.binaryPath(), agentBinDir: dirname(binaryPath(dirs, spec)), agentConfig: config, env }, log);
        activeBridge = bridge;
        client = new PhoneClient(bridge.url, bridge.token);
        // The hooks write their edges to the scratch bridge's state dir and find no other bridge.
        agentEnv = { ...spec.env(phoneDirs), COLLIE_STATE_DIR: bridge.stateDir, XDG_STATE_HOME: bridge.xdgState };
        streamWanted = ["effective"];
      } else {
        client = new PhoneClient(target.url, target.token);
        if (!(await client.health())) throw new LabInfraError(`the bridge at ${target.url} does not answer /api/health`);
        await client.config();
        // No hooks against a running bridge: the leg does not know its state dir, so a send ends `sent` there.
        agentEnv = { ...spec.env(phoneDirs), COLLIE_STATE_DIR: join(work, "no-bridge-state"), XDG_STATE_HOME: join(work, "xdg-state") };
        streamWanted = ["sent", "effective"];
        log(`phone: against the running bridge ${target.url}; no hooks reach it from the lab, so a stream send may end sent or effective`);
      }
      const belt = beltCommands(shippedBeltFromDisk(spec.id), operatorBelt(await client.config().catch(() => undefined), spec.id));
      const facts = await runPhoneLeg(
        {
          harness: spec.id,
          version,
          client,
          target: target.kind,
          streamWanted,
          agentBinary: binaryPath(dirs, spec),
          agentArgs: spec.startArgs(phoneDirs),
          agentEnv,
          workDir: work,
          outDir: plan.phoneOut,
          redact: plan.redact,
          turns: { used: 0, cap: PHONE_TURN_CAP },
          gaps: loadKnownGaps(),
          lists: loadSlashLists(spec.id),
          belt,
          log,
        },
        makeProject,
      );
      log(`phone: summary ${facts.summary}`);
      return { facts };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      log(`phone: the leg could not run: ${note}`);
      return { facts: null, note };
    } finally {
      if (bridge !== null) {
        mkdirSync(plan.phoneOut, { recursive: true });
        writeFileSync(join(plan.phoneOut, "bridge.log"), plan.redact(bridge.logText()));
        const gone = await bridge.stop();
        activeBridge = null;
        log(`scratch bridge: ${gone ? "stopped, its state folder deleted" : "NOT STOPPED"}`);
      }
    }
  }

  return {
    liveness: realLiveness,
    clone: (source, labRoot) => ensureClone(source, labRoot),
    async stopAll(): Promise<void> {
      const bridge = activeBridge;
      activeBridge = null;
      if (bridge !== null) await bridge.stop();
      const tmux = active;
      active = null;
      if (tmux !== null) await tmux.stop();
    },
    async preflight(spec: HarnessSpec, dirs: RunDirs): Promise<void> {
      if (resolveTmuxBinary("") === null) throw new LabDeferred("no tmux binary on this machine");
      if (Bun.which("npm") === null) throw new LabDeferred("no npm on PATH");
      if (Bun.which("git") === null) throw new LabDeferred("no git on PATH");
      makeProject(dirs.project);
      // The folders, the config files and the login are made here, before the claim: a login that is not
      // usable (a Claude token that is too old, no Codex API key, no OpenRouter key) defers the run and costs nothing.
      prepareRun(spec, dirs, { seedSource: options.seedSource, minLoginMinutes: options.minLoginMinutes, codexSource: options.codexSource, env });
    },

    async install(spec, dirs, version, log): Promise<string> {
      mkdirSync(dirs.bin, { recursive: true });
      const base = { ...serverEnv(env), npm_config_update_notifier: "false", npm_config_fund: "false" };
      const command = npmInstallCommand(spec, dirs, version, base);
      const result = await run([...command.argv], dirs.bin, command.env, INSTALL_TIMEOUT_MS);
      if (result.code !== 0) throw new LabInfraError(`npm install ${spec.npm}@${version} exited ${String(result.code)}: ${result.out.trim().split("\n").slice(-3).join(" ")}`);
      const printed = await run([binaryPath(dirs, spec), "--version"], dirs.root, { ...base, ...spec.env(dirs) }, 30_000);
      const found = VERSION_IN_TEXT.exec(printed.out)?.[0];
      if (found !== version) throw new LabInfraError(`the installed binary prints ${found ?? "no version"}, and the lab asked for ${version}`);
      log(`npm installed ${spec.npm}@${version}; the binary prints ${found}`);
      return found;
    },

    async session(spec, dirs, version, log, plan): Promise<SessionFacts> {
      const legs = plan?.legs ?? "all";
      const phonePlan = plan ?? null;
      const profile = profileFor(spec.id, version, { log });
      // A phone-only run against a bridge that already runs: no tmux, no scratch bridge.
      if (phonePlan?.bridge !== undefined) {
        const phone = await phoneLeg({ spec, dirs, version, log, plan: phonePlan, target: { kind: "bridge", url: phonePlan.bridge.url, token: phonePlan.bridge.token } });
        return { facts: { profile: profile?.status ?? "none", walk: NOT_WALKED, screens: [], send: null, ask: null, turns: phone.facts?.turns ?? 0, phone: phone.facts, phoneNote: phone.note }, counters: [] };
      }
      const tmux = new LabTmux();
      active = tmux;
      const counters = new LabCounters();
      try {
        const command = legs === "all" ? paneCommand(spec.env(dirs), binaryPath(dirs, spec), spec.startArgs(dirs)) : "exec sleep 86400";
        // A key a harness signs in with goes into the tmux server's environment, never onto the command line.
        await tmux.start(dirs.project, command, { ...serverEnv(env), ...loginEnv(spec, env) });
        log(`tmux server ${tmux.socket} started`);
        const runPhone = async (): Promise<{ phone?: PhoneFacts | null; phoneNote?: string }> => {
          if (!spec.phone || phonePlan === null) return {};
          const phone = await phoneLeg({ spec, dirs, version, log, plan: phonePlan, target: { kind: "scratch", tmux } });
          return { phone: phone.facts, phoneNote: phone.note };
        };
        if (legs === "phone") {
          const phone = await runPhone();
          return { facts: { profile: profile?.status ?? "none", walk: NOT_WALKED, screens: [], send: null, ask: null, turns: phone.phone?.turns ?? 0, ...phone }, counters: [] };
        }
        const mux = tmux.adapter();
        const paneId = await tmux.paneId();
        const gate = gateFor(mux);
        const pane = new TmuxPane(mux, gate, paneId, spec.id);
        await waitStarted(pane, log);

        // The walk logs each line as it writes it, so every line carries its own time.
        const walked = await runWalk(pane, loadSlashLists(spec.id), log);
        const screens: ScreenFact[] = [...walked.screens];
        const turns = { used: 0, cap: spec.turnCap };
        let send: SendFact | null = null;
        let ask: AskFact | null = null;

        // A dialog the Surface read as free ends the walk, and the run is already a fail. No send or ask
        // goes into a screen the reader cannot tell from a free box.
        const freeDialog = screens.some((screen) => isDialogScreen(screen) && screen.free);
        const walkClean = walked.walk.reached && walked.walk.returned && walked.walk.startedTurn === null && walked.walk.menuRead && !freeDialog;
        let sendNote = freeDialog ? "skipped: a dialog read free during the walk" : undefined;
        let askNote = sendNote;
        if (labProfile(spec.id, version, log) !== null && walkClean) {
          const leg: LegEnv = { harness: spec.id, version, mux, pane, sendsDir: dirs.sends, project: dirs.project, counters, turns, decline: spec.decline, log };
          const sent = await runSendLeg(leg);
          send = sent.fact;
          sendNote = sent.note;
          askNote = "skipped: the send did not settle";
          screens.push(...sent.screens);
          if (sent.note.length > 0) log(`send leg: ${sent.note}`);
          if (send !== null && SETTLED_OUTCOMES.includes(send.outcome)) {
            const asked = await runAskLeg(leg);
            ask = asked.fact;
            askNote = asked.note;
            screens.push(...asked.screens);
            if (asked.note.length > 0) log(`ask leg: ${asked.note}`);
          }
        }
        // After step 4: the phone leg, on its own panes of the same tmux server, through a scratch bridge.
        const phone = labProfile(spec.id, version, () => {}) !== null ? await runPhone() : {};
        return {
          facts: { profile: profile?.status ?? "none", walk: walked.walk, screens, send, ask, turns: turns.used + (phone.phone?.turns ?? 0), sendNote, askNote, ...phone },
          counters: [...counters.lines, `key presses by the lab: ${String(pane.keysSent)}`, `screen reads: ${String(pane.reads)}`, `key gate sends: ${JSON.stringify(gate.sentBy())}`],
        };
      } finally {
        active = null;
        const gone = await tmux.stop();
        log(`tmux server ${tmux.socket}: ${gone && !tmux.leftover() ? "stopped, socket gone" : "NOT STOPPED"}`);
      }
    },

    publishPass: (input) => publishPass(input),
    openIssue: (files, issue, repoSlug) => openIssue(files, issue, repoSlug),
  };
}

