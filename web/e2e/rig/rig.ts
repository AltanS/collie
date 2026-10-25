// The browser leg's rig CLI: an ISOLATED bridge mirroring a SCRATCH Herdr server. Run it with bun:
//
//   bun e2e/rig/rig.ts up [--crew] | down | status | start <harness> [--on lead|member] | pane <cmd...>
//                      | snapshot | read <pane> [lines] [--on member] | crew stop-member
//                      | crew start-member [--env COLLIE_WALKY=off]
//
// Folded from experiments/collie-rig/rig.ts in the workspace (2026-10-17), with the state moved on
// disk (rig-lib.ts STATE_ROOT). The Playwright global setup runs
// `up` and the global teardown runs `down`; by hand the same two commands clean up after a crash.
//
// `up` starts a detached daemon that owns three processes, records their pids in rig.json and stops
// them on SIGTERM:
//   1. `herdr --session collie-rig server`, headless, in the rig's XDG home;
//   2. one attached Herdr client in a PTY (scripts/harness-canary/client.ts), so a harness that asks
//      the terminal for its colours at start gets an answer, as it would in a person's terminal;
//   3. `bun bridge/index.ts` from this checkout on a free port in 18700-18799.
// Then `up` pairs one device the way `collie pair` does, but with the bridge's own pairing module in
// the rig's own state dir, and claims the code over the real POST /api/pair. No CLI verb runs.
//
// `up --crew` (the crew leg) starts the same three for a second machine, the MEMBER: a Herdr server
// in session `collie-rig-member` with its own XDG home, its attached client, and a second bridge on
// another free port with its own state, config and HOME. The daemon then enrols the member into the
// lead with the real verbs as functions (crew-enrol.ts) and restarts each bridge the way a verb
// restarts it: kill the recorded pid, respawn with the same dirs and port. The phone pairs with the
// lead, and `up` returns once the lead reports the member reachable. Every `--crew` command works on
// the crew rig's own state root (rig-lib.ts), so it never meets the solo rig.
//
// `crew stop-member` and `crew start-member` ask the daemon (SIGUSR1, SIGUSR2) to stop the member's
// bridge by its recorded pid and to start it again with the same dirs and port. The member's Herdr
// and its agents keep running, as on a machine whose Collie was stopped. `start-member --env
// COLLIE_WALKY=off` starts it with one allowed setting changed (MEMBER_ENV_ALLOWED), for the case
// that proves a machine with walky talky off; a start without `--env` clears the setting.
import "./rig-mode";

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CREW,
  DEVICE_LABEL,
  LEAD_ID,
  MACHINES,
  MEMBER_ID,
  P,
  PORT_HI,
  PORT_LO,
  assertPrivateDir,
  assertUnderRoot,
  assertUnderXdg,
  herdr,
  herdrEnv,
  killPid,
  machineDirs,
  machineFlag,
  memGuard,
  newWorkspacePane,
  paneRun,
  pidAlive,
  pidIs,
  readRun,
  readToken,
  retireXdgHome,
  sleep,
  writeRun,
  type Machine,
  type MemberRun,
  type Run,
} from "./rig-lib";
import { asJsonObject, asJsonString, parseJson, type JsonValue } from "../../src/lib/json";
import { BIN } from "./bins";
import { enrolMember } from "./crew-enrol";
import { HARNESS_IDS, harnessDirs, prepareHarness } from "./harnesses";
import { socketPathProblem } from "./sock-path";

const SELF = fileURLToPath(import.meta.url);
/** This checkout: web/e2e/rig/rig.ts is three levels below it. */
const WORKTREE = resolve(dirname(SELF), "..", "..", "..");
const DAEMON_TAG = "e2e/rig/rig.ts _daemon";
const BRIDGE_TAG = "bridge/index.ts";

const die = (msg: string): never => {
  console.error(`rig: ${msg}`);
  process.exit(1);
};

async function freePort(taken: readonly number[] = []): Promise<number> {
  for (let port = PORT_LO; port <= PORT_HI; port++) {
    if (taken.includes(port)) continue;
    const ok = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
    });
    if (ok) return port;
  }
  return die(`no free port in ${PORT_LO}-${PORT_HI}`);
}

/** Whether something accepts on 127.0.0.1:port. A pinned member answers no plain request, so readiness is a TCP accept. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const conn = createConnection({ host: "127.0.0.1", port });
    const end = (open: boolean) => {
      conn.destroy();
      done(open);
    };
    conn.setTimeout(1000, () => end(false));
    conn.once("connect", () => end(true));
    conn.once("error", () => end(false));
  });
}

/** The machines this rig runs: the lead alone, or the lead and its member. */
const machinesOf = (run: Run | null): readonly Machine[] => (CREW || run?.member !== undefined ? MACHINES : ["lead"]);

/** The part of rig.json one machine owns. The lead's lives at the top level, as the solo rig has always written it. */
type Half = Pick<MemberRun, "port" | "socket" | "herdrPid" | "bridgePid">;
function halfOf(run: Run, machine: Machine): Half {
  if (machine === "lead") return run;
  if (run.member === undefined) throw new Error("this rig has no member (run `up --crew`)");
  return run.member;
}

// ── pairing ──────────────────────────────────────────────────────────────────────────────────────
// What `collie pair` does (cli/pairing.ts cmdPair): generateCode + newPending + write
// <stateDir>/pairing-pending.json at 0600. Done here with the bridge's own module, in the rig's own
// state dir. The claim then goes over the real POST /api/pair, with the Origin a browser sends.
async function pairDevice(port: number, label: string): Promise<void> {
  const pairing = await import(join(WORKTREE, "bridge", "pairing.ts"));
  const code: string = pairing.generateCode();
  const pending: unknown = pairing.newPending(code, Date.now());
  mkdirSync(P.state, { recursive: true, mode: 0o700 });
  writeFileSync(join(P.state, pairing.PENDING_FILENAME), JSON.stringify(pending, null, 2), { mode: 0o600 });
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ code, label }),
  });
  const token = asJsonString(asJsonObject(parseJson(await res.text()))?.token);
  if (res.status !== 200 || token === undefined) return die(`pairing failed: HTTP ${res.status}`);
  writeFileSync(P.token, token, { mode: 0o600 });
  chmodSync(P.token, 0o600);
}

// ── the daemon ───────────────────────────────────────────────────────────────────────────────────
const log = (line: string) => appendFileSync(join(P.logs, "daemon.log"), `${new Date().toISOString()} ${line}\n`);

/** The log file of one machine's process: the lead keeps the solo rig's names. */
const logName = (machine: Machine, what: string): string => join(P.logs, machine === "lead" ? `${what}.log` : `member-${what}.log`);

/**
 * The settings a case may change on the member's bridge, and the file that holds them for the daemon's
 * next start of it (`crew start-member --env NAME=value`). An allow list, so no case can slip any other
 * COLLIE_ name into a bridge the rig keeps clean.
 */
const MEMBER_ENV_ALLOWED: readonly string[] = ["COLLIE_WALKY"];
const MEMBER_ENV_FILE = join(P.rig, "member-env.json");

/** The allowed settings a case asked the member's bridge to start with; none when the file is absent or unreadable. */
function memberEnvOverrides(): [string, string][] {
  try {
    const doc = asJsonObject(parseJson(readFileSync(MEMBER_ENV_FILE, "utf8")));
    return MEMBER_ENV_ALLOWED.flatMap((name): [string, string][] => {
      const value = asJsonString(doc?.[name]);
      return value === undefined ? [] : [[name, value]];
    });
  } catch {
    return [];
  }
}

/** `<dir>/bin` with a link named claude, pi and omp to the binary the rig runs for each (bins.ts). */
function harnessBinDir(home: string): string {
  const dir = join(home, "bin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, target] of Object.entries(BIN)) {
    rmSync(join(dir, name), { force: true });
    symlinkSync(target, join(dir, name));
  }
  return dir;
}

/** The bridge's environment on one machine: only what it needs, every inherited COLLIE_/HERDR_ name dropped. */
function bridgeEnv(machine: Machine, port: number, socket: string) {
  const d = machineDirs(machine);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(COLLIE_|HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|TAILSCALE|XDG_|RIG_|PI_CODING_AGENT_DIR$|CODEX_HOME$)/.test(key)) continue;
    env[key] = value;
  }
  mkdirSync(d.bridgeHome, { recursive: true, mode: 0o700 });
  Object.assign(env, {
    // A HOME of its own: the bridge reads no file of the operator's (hooks probe, front door
    // records, journals). The journal roots below name the harnesses' scratch homes instead, so
    // Chat reads the leg's own sessions and never the operator's ~/.claude/projects.
    HOME: d.bridgeHome,
    // A directory of links to the three binaries the rig runs, first on the PATH. The bridge reads a
    // harness's version by running `<name> --version` on the login PATH, then this one
    // (bridge/surface/binary-version.ts), and that must be the very binary the pane runs. Without it
    // the operator's PATH decides: a `claude` shim ahead of ~/.local/bin resolves its target from
    // $HOME/.local/bin, and under the bridge's scratch HOME that file does not exist (exit 127, version
    // null, every Claude send provisional); and ~/.local/bin holding a newer `omp` than BIN.omp would
    // read the wrong omp version.
    PATH: [harnessBinDir(d.bridgeHome), env.PATH].filter((part) => part !== undefined && part !== "").join(delimiter),
    COLLIE_TRANSCRIPT_ROOT: join(harnessDirs("claude", machine).config, "projects"),
    COLLIE_PI_ROOT: [join(harnessDirs("pi", machine).agent, "sessions"), join(harnessDirs("omp", machine).agent, "sessions")].join(","),
    COLLIE_HOST: "127.0.0.1",
    COLLIE_PORT: String(port),
    COLLIE_STATE_DIR: d.state,
    HERDR_PLUGIN_CONFIG_DIR: d.config,
    COLLIE_CONFIG: d.homeCfg,
    COLLIE_INSTANCE: machine === "lead" ? "rig" : "rig-member",
    COLLIE_MUX: "herdr",
    HERDR_SOCKET_PATH: socket,
    COLLIE_SKIP_SERVE: "1",
    COLLIE_MULTI_SESSION: "0",
    // The release check is the bridge's only outbound call; a loopback mirror with nothing
    // listening keeps it off the network (bridge/update.ts, the rehearsal mirror).
    COLLIE_UPDATE_MIRROR: "http://127.0.0.1:1",
  });
  if (machine === "member") for (const [name, value] of memberEnvOverrides()) env[name] = value;
  return env;
}

const HERDR_CONFIG = `# Written by the Collie browser leg for its own Herdr session.\nonboarding = false\n\n[update]\nversion_check = false\nmanifest_check = false\n\n[ui.toast]\ndelivery = "off"\n\n[ui.sound]\nenabled = false\n`;

async function daemon(): Promise<void> {
  mkdirSync(P.logs, { recursive: true });
  const crew = process.env.RIG_MEMBER_PORT !== undefined;
  const run: Run = {
    worktree: WORKTREE,
    port: Number(process.env.RIG_PORT),
    socket: "",
    daemonPid: process.pid,
    herdrPid: null,
    bridgePid: null,
    ready: false,
    startedAt: new Date().toISOString(),
  };
  if (crew) {
    run.member = { port: Number(process.env.RIG_MEMBER_PORT), socket: "", herdrPid: null, bridgePid: null };
    run.leadId = LEAD_ID;
    run.memberId = MEMBER_ID;
  }
  writeRun(run);
  const machines: readonly Machine[] = crew ? MACHINES : ["lead"];

  const clients: { close(): void }[] = [];
  /** The bridge child each machine runs now. A child that is not the current one exits quietly: the rig stopped it. */
  const children = new Map<Machine, ChildProcess>();
  let tearing = false;

  const teardown = async (why: string) => {
    if (tearing) return;
    tearing = true;
    log(`teardown: ${why}`);
    for (const client of clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    for (const machine of machines.toReversed()) {
      const half = halfOf(run, machine);
      const session = machineDirs(machine).session;
      await killPid(half.bridgePid, BRIDGE_TAG);
      herdr(["session", "stop", session], { session: false, machine });
      for (let i = 0; i < 25; i++) {
        if (herdr(["session", "delete", session], { session: false, machine }).code === 0) break;
        await sleep(200);
      }
      await killPid(half.herdrPid, "herdr");
      retireXdgHome(machine);
    }
    rmSync(P.run, { force: true });
    log("teardown done");
    process.exit(0);
  };
  process.on("SIGTERM", () => void teardown("SIGTERM"));
  process.on("SIGINT", () => void teardown("SIGINT"));

  /** One machine's Herdr server, its view workspace and its attached client. */
  const startHerdr = async (machine: Machine) => {
    const d = machineDirs(machine);
    const half = halfOf(run, machine);
    writeFileSync(d.herdrCfg, HERDR_CONFIG);
    const out = openSync(logName(machine, "herdr-server"), "a");
    const server = spawn("herdr", ["--session", d.session, "server"], { env: herdrEnv(machine), detached: true, stdio: ["ignore", out, out] });
    server.unref();
    half.herdrPid = server.pid ?? null;
    writeRun(run);
    const end = Date.now() + 15_000;
    while (Date.now() < end && half.socket === "") {
      const list = herdr(["session", "list", "--json"], { session: false, machine });
      try {
        const doc: { sessions: { name: string; running: boolean; socket_path: string }[] } = JSON.parse(list.out);
        const row = doc.sessions.find((s) => s.name === d.session);
        if (row?.running === true && row.socket_path !== "" && herdr(["workspace", "list"], { machine }).code === 0) half.socket = row.socket_path;
      } catch {
        /* retry */
      }
      if (half.socket === "") await sleep(200);
    }
    if (half.socket === "") throw new Error(`the ${machine}'s scratch Herdr server did not come up in 15 s`);
    assertUnderXdg(half.socket, machine);
    writeRun(run);
    log(`herdr up (${machine}): ${half.socket}`);

    // A view workspace + an attached client that answers colour queries (as the canary does).
    newWorkspacePane(d.work, "rig-view", machine);
    try {
      const mod = await import(join(WORKTREE, "scripts", "harness-canary", "client.ts"));
      const attached: { close(): void; answered(): boolean } = mod.attachClient(d.session, herdrEnv(machine));
      clients.push(attached);
      const t0 = Date.now();
      while (!attached.answered() && Date.now() - t0 < 10_000) await sleep(100);
      await sleep(1000);
      log(`client attached (${machine})`);
    } catch (err) {
      log(`client not attached on the ${machine} (${err instanceof Error ? err.message : String(err)}); panes still work, colour queries go unanswered`);
    }
  };

  const spawnBridge = (machine: Machine) => {
    const half = halfOf(run, machine);
    const blog = openSync(logName(machine, "bridge"), "a");
    const bridge = spawn(process.execPath, ["bridge/index.ts"], { cwd: WORKTREE, env: bridgeEnv(machine, half.port, half.socket), stdio: ["ignore", blog, blog] });
    children.set(machine, bridge);
    half.bridgePid = bridge.pid ?? null;
    writeRun(run);
    bridge.on("exit", (code) => {
      if (tearing || children.get(machine) !== bridge) return;
      children.delete(machine);
      log(`the ${machine}'s bridge exited with ${String(code)}`);
      if (machine === "lead") {
        void teardown(`bridge exited with ${String(code)}`);
        return;
      }
      half.bridgePid = null;
      writeRun(run);
    });
  };

  /** The bridge answers: the lead's /api/health (its listener never pins), the member's TCP accept (a pinned member answers no plain request). */
  const bridgeReady = async (machine: Machine): Promise<boolean> => {
    const port = halfOf(run, machine).port;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const up =
        machine === "lead"
          ? await fetch(`http://127.0.0.1:${port}/api/health`)
              .then((r) => r.ok)
              .catch(() => false)
          : await portOpen(port);
      if (up) return true;
      await sleep(250);
    }
    return false;
  };

  /** Stop one machine's bridge by its recorded pid. Its exit is the rig's own, so nothing tears down. */
  const stopBridge = async (machine: Machine) => {
    const half = halfOf(run, machine);
    children.delete(machine);
    await killPid(half.bridgePid, BRIDGE_TAG);
    half.bridgePid = null;
    writeRun(run);
  };

  /** A verb's restart, the rig's way: kill the recorded pid, respawn with the same dirs and port. */
  const restartBridge = async (machine: Machine): Promise<number> => {
    await stopBridge(machine);
    spawnBridge(machine);
    const up = await bridgeReady(machine);
    log(`restart (${machine}): ${up ? "back" : "NOT BACK in 30 s"}`);
    return up ? 0 : 1;
  };

  try {
    for (const machine of machines) await startHerdr(machine);
    for (const machine of machines) spawnBridge(machine);
    for (const machine of machines) {
      if (!(await bridgeReady(machine))) throw new Error(`the ${machine}'s bridge did not answer in 30 s (see logs/${machine === "lead" ? "" : "member-"}bridge.log)`);
    }
    if (crew) {
      const member = halfOf(run, "member");
      await enrolMember(
        WORKTREE,
        { machine: "lead", port: run.port, socket: run.socket, restart: () => restartBridge("lead") },
        { machine: "member", port: member.port, socket: member.socket, restart: () => restartBridge("member") },
        log,
      );
      // The member's bridge, asked for by `crew stop-member` / `crew start-member`.
      process.on("SIGUSR1", () => {
        log("stop-member");
        void stopBridge("member").then(() => log("stop-member: stopped"));
      });
      process.on("SIGUSR2", () => {
        if (children.has("member")) return;
        log("start-member");
        spawnBridge("member");
        void bridgeReady("member").then((up) => log(`start-member: ${up ? "back" : "NOT BACK in 30 s"}`));
      });
    }
    run.ready = true;
    writeRun(run);
    log(`ready on 127.0.0.1:${run.port}${crew ? ` (member on 127.0.0.1:${String(halfOf(run, "member").port)})` : ""}`);
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await teardown("startup failure");
  }
  setInterval(() => undefined, 1 << 30); // stay alive until a signal
}

// ── subcommands ──────────────────────────────────────────────────────────────────────────────────
async function cmdUp(crew: boolean): Promise<void> {
  if (crew && !CREW) die("internal: `up --crew` without the crew state root");
  if (!existsSync(join(WORKTREE, "bridge", "index.ts"))) die(`${WORKTREE} is not a Collie checkout`);
  if (!existsSync(join(WORKTREE, "web", "dist", "index.html"))) die("no web/dist: run `bun run build` in web/ first");
  const existing = readRun();
  if (existing !== null && pidIs(existing.daemonPid, DAEMON_TAG)) die("already up (run `down` first)");
  const machines: readonly Machine[] = crew ? MACHINES : ["lead"];
  for (const machine of machines) {
    const d = machineDirs(machine);
    const tooLong = socketPathProblem(d.xdg, d.session); // Herdr fails on a long path only after it starts, and the rig would wait 15 s
    if (tooLong !== null) die(tooLong);
  }
  memGuard(crew ? "the crew rig (two Herdr servers + two bridges)" : "the rig (Herdr + bridge)");
  // A leftover from a crashed run lives only in the rig's own Herdr homes.
  if (machines.some((machine) => existsSync(join(machineDirs(machine).xdg, "herdr")))) await cmdDown();
  const dirs = machines.flatMap((machine) => [machineDirs(machine).state, machineDirs(machine).config]);
  for (const dir of [...dirs, P.logs]) rmSync(assertUnderRoot(dir), { recursive: true, force: true });
  for (const machine of machines) {
    const d = machineDirs(machine);
    for (const dir of [P.rig, d.state, d.config, P.logs, d.work, d.xdg, d.xdgState]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivateDir(d.xdg);
  }
  rmSync(P.token, { force: true });
  rmSync(MEMBER_ENV_FILE, { force: true });
  const port = await freePort();
  const memberPort = crew ? await freePort([port]) : null;
  const logFd = openSync(join(P.logs, "daemon.out"), "a");
  const env = memberPort === null ? { ...process.env, RIG_PORT: String(port) } : { ...process.env, RIG_PORT: String(port), RIG_MEMBER_PORT: String(memberPort) };
  const child = spawn(process.execPath, [SELF, "_daemon"], {
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  // The crew rig starts twice the processes and restarts each bridge during the enrolment.
  const end = Date.now() + (crew ? 180_000 : 70_000);
  while (Date.now() < end) {
    if (readRun()?.ready === true) break;
    if (!pidAlive(child.pid ?? null)) break;
    await sleep(300);
  }
  const run = readRun();
  if (run?.ready !== true) {
    const tail = existsSync(join(P.logs, "daemon.log")) ? readFileSync(join(P.logs, "daemon.log"), "utf8").split("\n").slice(-8).join("\n") : "";
    await cmdDown();
    die(`startup failed.\n${tail}`);
  }
  await pairDevice(run!.port, DEVICE_LABEL);
  console.log(`up: bridge http://127.0.0.1:${run!.port}  worktree ${WORKTREE}`);
  console.log(`    herdr session ${machineDirs("lead").session}  socket ${run!.socket}`);
  if (crew) {
    const member = halfOf(run!, "member");
    // The lead learns the member on its own sweep, which rides its poll (bridge/crew/lead.ts): wait for it.
    const reachable = await memberHealth(90_000, (health) => health === "reachable");
    if (reachable !== "reachable") {
      await cmdDown();
      die(`the lead never reported the member reachable in 90 s (last: ${reachable ?? "no answer"}); see logs/daemon.log and logs/member-bridge.log`);
    }
    console.log(`    member ${MEMBER_ID}: bridge 127.0.0.1:${String(member.port)} (pinned TLS)  herdr session ${machineDirs("member").session}  socket ${member.socket}`);
    console.log(`    lead ${LEAD_ID} reports the member reachable`);
  }
}

/** The lead's word for the member (`GET /api/crew`), polled until `ok` holds or `ms` ran out; the last word, or null. */
async function memberHealth(ms: number, ok: (health: string) => boolean): Promise<string | null> {
  const end = Date.now() + ms;
  let last: string | null = null;
  for (;;) {
    const r = await api("/api/crew").catch(() => null);
    const members = r === null ? undefined : asJsonObject(r.json)?.members;
    const row = Array.isArray(members) ? members.map((m) => asJsonObject(m)).find((m) => m?.id === MEMBER_ID) : undefined;
    last = asJsonString(row?.health) ?? last;
    if (last !== null && ok(last)) return last;
    if (Date.now() > end) return last;
    await sleep(1000);
  }
}

async function cmdDown(): Promise<void> {
  const run = readRun();
  const machines = machinesOf(run);
  if (run !== null) {
    if (pidIs(run.daemonPid, DAEMON_TAG)) {
      process.kill(run.daemonPid, "SIGTERM");
      const end = Date.now() + 40_000;
      while (Date.now() < end && pidAlive(run.daemonPid)) await sleep(200);
    }
    // The daemon is gone or stuck: its teardown by hand, by recorded pid only.
    await killPid(run.daemonPid, DAEMON_TAG);
    for (const machine of machines) {
      if (machine === "member" && run.member === undefined) continue;
      await killPid(halfOf(run, machine).bridgePid, BRIDGE_TAG);
    }
  }
  for (const machine of machines) {
    const session = machineDirs(machine).session;
    if (existsSync(join(machineDirs(machine).xdg, "herdr"))) {
      const list = herdr(["session", "list", "--json"], { session: false, machine });
      if (list.out.includes(`"${session}"`)) {
        herdr(["session", "stop", session], { session: false, machine });
        for (let i = 0; i < 25; i++) {
          if (herdr(["session", "delete", session], { session: false, machine }).code === 0) break;
          await sleep(200);
        }
      }
    }
    if (run !== null && (machine === "lead" || run.member !== undefined)) await killPid(halfOf(run, machine).herdrPid, "herdr");
    retireXdgHome(machine);
  }
  rmSync(P.run, { force: true });
  rmSync(P.token, { force: true });
  rmSync(MEMBER_ENV_FILE, { force: true });
  console.log(machines.length === 1 ? "down: bridge and scratch Herdr stopped" : "down: both bridges and both scratch Herdr servers stopped");
}

/** `crew stop-member` / `crew start-member`: the daemon does it, and this waits until rig.json and the port agree. */
async function cmdCrew(verb: string | undefined, args: readonly string[] = []): Promise<void> {
  const run = readRun();
  if (run?.ready !== true || run.member === undefined) return die("the crew rig is not up (`up --crew`)");
  if (!pidIs(run.daemonPid, DAEMON_TAG)) return die("the rig's daemon is gone; run `down --crew`");
  const port = run.member.port;
  if (verb === "stop-member") {
    process.kill(run.daemonPid, "SIGUSR1");
    const stopped = await until(async () => readRun()?.member?.bridgePid === null && !(await portOpen(port)), 20_000);
    if (!stopped) die("the member's bridge did not stop in 20 s");
    console.log(`crew: the member's bridge is stopped (port ${String(port)} closed); its Herdr and agents run on`);
    return;
  }
  if (verb === "start-member") {
    // `--env NAME=value`, repeated: the allowed settings the member starts with. Without it the member starts clean.
    const wanted: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const pair = args[i + 1] ?? "";
      const at = pair.indexOf("=");
      if (args[i] !== "--env" || at < 1) return die("usage: crew start-member [--env NAME=value ...]");
      const name = pair.slice(0, at);
      if (!MEMBER_ENV_ALLOWED.includes(name)) return die(`--env takes ${MEMBER_ENV_ALLOWED.join(", ")}, not ${name}`);
      wanted[name] = pair.slice(at + 1);
    }
    if (Object.keys(wanted).length === 0) rmSync(MEMBER_ENV_FILE, { force: true });
    else writeFileSync(MEMBER_ENV_FILE, JSON.stringify(wanted), { mode: 0o600 });
    if (run.member.bridgePid !== null && pidIs(run.member.bridgePid, BRIDGE_TAG)) {
      console.log("crew: the member's bridge already runs");
      return;
    }
    process.kill(run.daemonPid, "SIGUSR2");
    const started = await until(async () => {
      const pid = readRun()?.member?.bridgePid ?? null;
      return pid !== null && pidIs(pid, BRIDGE_TAG) && (await portOpen(port));
    }, 40_000);
    if (!started) die("the member's bridge did not come back in 40 s (see logs/member-bridge.log)");
    console.log(`crew: the member's bridge runs again on 127.0.0.1:${String(port)}, pid ${String(readRun()?.member?.bridgePid)}`);
    return;
  }
  die("usage: crew stop-member | crew start-member");
}

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(300);
  }
  return false;
}

interface ApiAnswer {
  readonly status: number;
  readonly json: JsonValue | undefined;
  readonly text: string;
}

async function api(path: string): Promise<ApiAnswer> {
  const run = readRun();
  if (run?.ready !== true) return die("the rig is not up");
  const res = await fetch(`http://127.0.0.1:${run!.port}${path}`, {
    headers: { authorization: `Bearer ${readToken()}`, "x-requested-with": "XMLHttpRequest" },
  });
  const text = await res.text();
  // Plain text parses to undefined and is read from `text` instead.
  return { status: res.status, json: parseJson(text), text };
}

async function cmdPane(args: string[], machine: Machine): Promise<void> {
  const cmd = args.join(" ");
  const paneId = newWorkspacePane(machineDirs(machine).work, `rig-${Date.now().toString(36)}`, machine);
  if (cmd !== "") {
    await sleep(700); // let the shell print its prompt first
    paneRun(paneId, cmd, machine);
  }
  console.log(paneId);
}

/** What `status` prints: rig.json, and whether each recorded process still runs. */
interface StatusView extends Run {
  readonly stateRoot: string;
  readonly daemonAlive: boolean;
  readonly bridgeAlive: boolean;
  memberBridgeAlive?: boolean;
  memberHerdrAlive?: boolean;
}

/** The arguments with `--crew` and `--on <machine>` taken out. */
function plain(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--crew") continue;
    if (args[i] === "--on") {
      i += 1;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

const argv = process.argv.slice(2);
const [cmd, ...rest] = plain(argv);
switch (cmd) {
  case "_daemon":
    await daemon();
    break;
  case "up":
    await cmdUp(argv.includes("--crew"));
    break;
  case "down":
    await cmdDown();
    break;
  case "status": {
    const run = readRun();
    if (run === null) {
      console.log(`not up (state root ${dirname(P.rig)})`);
      break;
    }
    const shown: StatusView = { stateRoot: dirname(P.rig), ...run, daemonAlive: pidIs(run.daemonPid, DAEMON_TAG), bridgeAlive: pidIs(run.bridgePid, BRIDGE_TAG) };
    if (run.member !== undefined) {
      shown.memberBridgeAlive = pidIs(run.member.bridgePid, BRIDGE_TAG);
      shown.memberHerdrAlive = pidIs(run.member.herdrPid, "herdr");
    }
    console.log(JSON.stringify(shown, null, 2));
    break;
  }
  case "crew":
    await cmdCrew(rest[0], rest.slice(1));
    break;
  case "pane":
    await cmdPane(rest, machineFlag(argv));
    break;
  case "start": {
    // A harness in a fresh pane, the way the leg starts it: `start claude|pi|omp [--on lead|member]`.
    const id = HARNESS_IDS.find((harness) => harness === rest[0]) ?? die("usage: start claude|pi|omp [--on lead|member]");
    const machine = machineFlag(argv);
    if (machine === "member" && readRun()?.member === undefined) die("this rig has no member (run `up --crew`)");
    memGuard(`harness ${id}`);
    const { line } = prepareHarness(id, machine);
    await cmdPane([line], machine);
    break;
  }
  case "snapshot": {
    const r = await api("/api/snapshot");
    const doc = asJsonObject(r.json) ?? die("the snapshot answer is not a JSON object");
    for (const list of [doc.agents, doc.shellPanes]) {
      for (const p of Array.isArray(list) ? list : []) {
        const pane = asJsonObject(p);
        console.log(JSON.stringify({ host: pane?.host, paneId: pane?.paneId, agent: pane?.agent, status: pane?.status }));
      }
    }
    break;
  }
  case "read": {
    const pane = rest[0] ?? die("usage: read <pane> [lines] [--on member]");
    const host = machineFlag(argv) === "member" ? `&host=${MEMBER_ID}` : "";
    const r = await api(`/api/pane/${encodeURIComponent(pane)}?lines=${Number(rest[1] ?? 60)}${host}`);
    const text = asJsonString(asJsonObject(r.json)?.text) ?? r.text;
    console.log(text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), ""));
    break;
  }
  default:
    console.log(
      "usage: bun e2e/rig/rig.ts up [--crew] | down | status | start claude|pi|omp [--on lead|member] | pane <cmd...> | snapshot | read <pane> [lines] [--on member] | crew stop-member | crew start-member [--env NAME=value]\n" +
        "       add --crew to any command to reach the crew rig's state root (`crew <verb>` implies it)",
    );
    process.exitCode = cmd === undefined || cmd === "help" ? 0 : 1;
}
