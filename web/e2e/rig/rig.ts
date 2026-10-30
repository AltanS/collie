// The browser leg's rig CLI: an ISOLATED bridge mirroring a SCRATCH Herdr server. Run it with bun:
//
//   bun e2e/rig/rig.ts up [--crew] | down | status | start <harness> [--on lead|member] [--replace]
//                      | pane <cmd...> [--replace] | pane ls | pane close <paneId>... | pane close --all
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
// On Linux with systemd-run and the user bus the daemon runs in a systemd scope of its own,
// `rig-<8 hex>-<pid>.scope`, with TasksMax=700 (1400 for `up --crew`; COLLIE_RIG_TASKS_MAX overrides, see
// "THE SCOPE" below). The herdr server, the bridge and every pane are its children, so they follow it.
// Elsewhere it runs where `up` runs, as it always did.
//
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
// THE SCOPE. On 2026-10-26 five rigs started from one Claude session lived in its claude-*.scope and
// filled the task limit of claude.slice (threads count as tasks); Bun, Node and Claude aborted when they
// could not start a thread. `up` therefore starts the daemon with `systemd-run --user --scope`: its own task
// cap (TasksMax 700; 1400 for the crew rig's two servers and two bridges; COLLIE_RIG_TASKS_MAX overrides
// both), a run limit of 6 hours (COLLIE_RIG_RUNTIME_MAX_SEC overrides; systemd ends the scope then, with no
// teardown), a stop timeout of 10 s, no core dumps (COLLIE_RIG_CORES=1 keeps them). The scope goes in the
// user's default slice, or in COLLIE_RIG_SLICE when that names a slice the host defines (a slice unit file on
// the host). Once the daemon is up, `up` reads the scope's pids.max and warns (daemon.log and stderr of `up`)
// when the cap is not the one asked for. systemd-run's stderr goes to logs/systemd-run.err; the plain spawn
// replaces it only when systemd-run itself failed (spawnDaemon), never when the daemon ran and failed.
//
// THE OWNER WATCH, opt-in with COLLIE_RIG_OWNER_WATCH=1. `up` then records the OWNER, the cgroup it ran in
// (only a `claude-*.scope`), when that directory exists under /sys/fs/cgroup. The daemon stats it every 30 s
// and tears the rig down after two checks in a row that find it gone (ENOENT; other errors are ignored). No
// owner is recorded for any other cgroup (a login session, a desktop app, a vte-spawn or tmux-spawn scope).
// `down` stops the scope when it is still active, found by rig.json or, when rig.json names none, by the
// name `rig-<hash of the state root>-*.scope`; a host may run its own reaper for scopes whose daemon is
// gone. All of this runs on Linux only.
//
// THE PANE CAP. A harness pane costs 46 to 64 tasks (omp), and drivers that opened one pane per case and
// closed none filled the task limit at about one pane a minute. So `pane <cmd>` and `start <harness>` refuse
// (exit 75) when the machine already holds COLLIE_RIG_MAX_PANES panes (default 6), and name the fix: `pane
// close <id>` (`pane ls` lists them) or `--replace`, which closes the pane the same key opened last (the
// harness for `start`, "pane" for `pane`) before it opens the new one. The cap lives in these two verbs only;
// the browser leg opens its panes through rig-lib.ts and is never counted against it. It is a soft limit, per
// machine and rig, and not atomic across concurrent callers; the scope's TasksMax is the hard guard. `--replace`,
// `--crew` and `--on <m>` count only before the command's first word (rig-scope.ts splitArgs).
//
// `crew stop-member` and `crew start-member` ask the daemon (SIGUSR1, SIGUSR2) to stop the member's
// bridge by its recorded pid and to start it again with the same dirs and port. The member's Herdr
// and its agents keep running, as on a machine whose Collie was stopped. `start-member --env
// COLLIE_WALKY=off` starts it with one allowed setting changed (MEMBER_ENV_ALLOWED), for the case
// that proves a machine with walky talky off; a start without `--env` clears the setting.
import "./rig-mode";

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  STATE_ROOT,
  VIEW_LABEL,
  assertPrivateDir,
  assertUnderRoot,
  assertUnderXdg,
  coreDirs,
  coreRunning,
  herdr,
  herdrEnv,
  hc,
  killPid,
  machineDirs,
  memGuard,
  muxOf,
  newWorkspacePane,
  openPanes,
  paneClose,
  paneCommand,
  paneRun,
  pidAlive,
  pidIs,
  readRun,
  readToken,
  retireXdgHome,
  sleep,
  stopCore,
  writeRun,
  type Machine,
  type MemberRun,
  type OpenPane,
  type Run,
} from "./rig-lib";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../../src/lib/json";
import { BIN } from "./bins";
import { enrolMember } from "./crew-enrol";
import { HARNESS_IDS, harnessDirs, prepareHarness } from "./harnesses";
import {
  OWNER_MISSES_TO_TEARDOWN,
  type OwnerCheck,
  SCOPE_NAME,
  daemonScript,
  maxPanes as maxPanesFrom,
  nextOwnerMisses,
  ownerCheckOf,
  ownerCgroupFrom,
  paneCapReached,
  scopeRuntimeMaxSec,
  scopeTasksMax,
  scopeUnitName,
  scopeUnitsFrom,
  stateRootHash,
  shouldFallBack,
  type StartObservation,
  sliceFrom,
  splitArgs,
  taskCapWarning,
} from "./rig-scope";
import { startStub, type Stub } from "./replay/stub";
import { CASSETTE_ROOT, planTiers, readVersions, rigLiterals, tiersFromEnv } from "./replay/tier";
import { coreSocketIn } from "./rig-mux";
import { socketPathProblem, sunPathLimit } from "./sock-path";

const SELF = fileURLToPath(import.meta.url);
/** This checkout: web/e2e/rig/rig.ts is three levels below it. */
const WORKTREE = resolve(dirname(SELF), "..", "..", "..");
const DAEMON_TAG = "e2e/rig/rig.ts _daemon";
const BRIDGE_TAG = "bridge/index.ts";

const die = (msg: string): never => {
  console.error(`rig: ${msg}`);
  process.exit(1);
};

// ── the scope ────────────────────────────────────────────────────────────────────────────────────
const CGROUP_ROOT = "/sys/fs/cgroup";
/** How often the daemon checks that its owner's cgroup still exists. */
const OWNER_CHECK_MS = 30_000;
/** Every systemctl call is bounded: a user bus that hangs must not hang `up`, `down` or `status`. */
const SYSTEMCTL_TIMEOUT_MS = 15_000;
/** Systemd's scopes, cgroups and user bus exist on Linux only; elsewhere the daemon is a plain child of `up`, and no line says so. */
const onLinux = process.platform === "linux";

const onPath = (name: string): boolean => (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/** Why a Linux daemon cannot get a scope of its own, or null when systemd-run and the user bus are there. */
function noScopeReason(): string | null {
  if (!onPath("systemd-run")) return "systemd-run is not on PATH";
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime === undefined || !isSocket(join(runtime, "bus"))) return "no user bus at $XDG_RUNTIME_DIR/bus";
  return null;
}

/**
 * The cgroup this process runs in, for the owner watch: only with COLLIE_RIG_OWNER_WATCH=1, only on Linux,
 * only when it is a unit that can end under the rig (ownerCgroupFrom), and only when its directory exists now.
 */
function ownerCgroup(): string | null {
  if (!onLinux || process.env.COLLIE_RIG_OWNER_WATCH !== "1") return null;
  try {
    const path = ownerCgroupFrom(readFileSync("/proc/self/cgroup", "utf8"));
    return path !== null && existsSync(`${CGROUP_ROOT}${path}`) ? path : null;
  } catch {
    return null;
  }
}

/** One stat of the owner's cgroup directory. */
function ownerCheck(path: string): OwnerCheck {
  try {
    statSync(path);
    return "present";
  } catch (err) {
    return ownerCheckOf(err instanceof Error && "code" in err ? String(err.code) : undefined);
  }
}

interface SystemctlResult {
  readonly status: number;
  readonly out: string;
}

/** One `systemctl --user` call, bounded by SYSTEMCTL_TIMEOUT_MS; an error of any kind comes back as a non-zero status. */
function systemctl(args: readonly string[]): SystemctlResult {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS });
  return { status: r.status ?? 1, out: r.stdout ?? "" };
}

/**
 * Stop the rig's scope when it is still active: whatever the daemon left behind goes with it. `noBlock` is
 * for the daemon stopping its own scope: a blocking stop would wait for the daemon, which waits for it.
 */
function stopScope(scope: string | null | undefined, opts: { noBlock?: boolean } = {}): void {
  if (!onLinux || !scope || !SCOPE_NAME.test(scope)) return;
  if (systemctl(["is-active", "--quiet", scope]).status !== 0) return;
  systemctl(["stop", ...(opts.noBlock ? ["--no-block"] : []), scope]);
}

/** The scopes of this state root that systemd still lists, found by name when rig.json has none to name. */
function leftoverScopes(): string[] {
  if (!onLinux) return [];
  const hash = stateRootHash(STATE_ROOT);
  return scopeUnitsFrom(systemctl(["list-units", `rig-${hash}-*.scope`, "--no-legend", "--plain"]).out, STATE_ROOT);
}

/** The scope's cgroup directory (`systemctl show -p ControlGroup`), or null when systemd has none for it. */
function scopeCgroupDir(scope: string): string | null {
  if (!onLinux || !SCOPE_NAME.test(scope)) return null;
  const group = systemctl(["show", "-p", "ControlGroup", "--value", scope]);
  const path = group.out.trim();
  return group.status === 0 && path.startsWith("/") ? `${CGROUP_ROOT}${path}` : null;
}

/** A file of the scope's cgroup (`pids.max`, `pids.current`), trimmed; null when it cannot be read. */
function readScopeFile(scope: string, name: string): string | null {
  const dir = scopeCgroupDir(scope);
  if (dir === null) return null;
  try {
    return readFileSync(join(dir, name), "utf8").trim();
  } catch {
    return null;
  }
}

/** The daemon's process, and the scope it runs in (null: where `up` runs). */
interface DaemonStart {
  readonly child: ChildProcess;
  readonly scope: string | null;
  /** The TasksMax asked for; null without a scope. */
  readonly tasksMax: number | null;
}

/** What `up` has seen of the systemd-run child so far. */
interface ChildSeen {
  exited: StartObservation["exited"];
  spawnFailed: boolean;
}

/**
 * Start the daemon in a scope of its own, and fall back to a plain spawn (the daemon then lives where `up`
 * lives, with one warning line in daemon.log) only when systemd-run itself failed: see shouldFallBack. A
 * daemon that started and then failed gets no second one; the startup-failure path in cmdUp reports its
 * error. Under `systemd-run --scope` the command replaces systemd-run, so the child's pid is the daemon's.
 */
async function spawnDaemon(env: NodeJS.ProcessEnv, logFd: number, crew: boolean): Promise<DaemonStart> {
  const spawnPlain = (): DaemonStart => {
    const child = spawn(process.execPath, [SELF, "_daemon"], { env, detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    return { child, scope: null, tasksMax: null };
  };
  if (!onLinux) return spawnPlain();
  const unavailable = noScopeReason();
  if (unavailable !== null) {
    warn(`WARNING: the daemon runs without a scope of its own (${unavailable}), so this rig has no task cap and no owner watch; it shares the cgroup of \`up\``);
    return spawnPlain();
  }
  const scope = scopeUnitName(STATE_ROOT, process.pid);
  const slice = sliceFrom(process.env.COLLIE_RIG_SLICE);
  if (process.env.COLLIE_RIG_SLICE !== undefined && slice === null) log(`WARNING: COLLIE_RIG_SLICE is not a slice name (${process.env.COLLIE_RIG_SLICE}); the scope goes in the default slice`);
  const tasksMax = scopeTasksMax(process.env.COLLIE_RIG_TASKS_MAX, crew);
  const errPath = join(P.logs, "systemd-run.err");
  const errFd = openSync(errPath, "w", 0o600);
  const started = Date.now();
  const child = spawn(
    "systemd-run",
    [
      "--user", "--scope", ...(slice === null ? [] : [`--slice=${slice}`]), `--unit=${scope}`,
      "-p", `TasksMax=${tasksMax}`, "-p", `RuntimeMaxSec=${scopeRuntimeMaxSec(process.env.COLLIE_RIG_RUNTIME_MAX_SEC)}`, "-p", "TimeoutStopSec=10",
      "--", "sh", "-c", daemonScript(process.env.COLLIE_RIG_CORES === "1"), process.execPath, SELF, "_daemon",
    ],
    { env: { ...env, RIG_SCOPE: scope, RIG_OWNER_CGROUP: ownerCgroup() ?? "" }, detached: true, stdio: ["ignore", logFd, errFd] },
  );
  closeSync(errFd);
  const seen: ChildSeen = { exited: null, spawnFailed: false };
  child.once("error", () => (seen.spawnFailed = true));
  child.once("exit", (code) => (seen.exited = { code, afterMs: Date.now() - started }));
  child.unref();
  // The daemon writes rig.json as its first act; a systemd-run that failed exits before that.
  const daemonWrote = () => readRun()?.daemonPid === child.pid;
  const end = Date.now() + 5000;
  while (seen.exited === null && !seen.spawnFailed && !daemonWrote() && Date.now() < end) await sleep(100);
  const stderr = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
  if (shouldFallBack({ exited: seen.exited, spawnFailed: seen.spawnFailed, daemonWrote: daemonWrote(), stderr })) {
    const why = stderr.trim().split("\n")[0] ?? "no reason given";
    warn(`WARNING: the daemon runs without a scope of its own (systemd-run failed: ${why}), so this rig has no task cap and no owner watch; it shares the cgroup of \`up\``);
    return spawnPlain();
  }
  return { child, scope, tasksMax };
}

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
// Appended, never truncated: `up` clears the logs folder once, before the daemon starts, and nothing rewrites this file.
const log = (line: string) => appendFileSync(join(P.logs, "daemon.log"), `${new Date().toISOString()} ${line}\n`);

/** A warning that means "this rig has no cap": in daemon.log, and on stderr of `up`, where the caller sees it. */
function warn(line: string): void {
  log(line);
  console.error(line);
}

/** The log file of one machine's process: the lead keeps the solo rig's names. */
const logName = (machine: Machine, what: string): string => join(P.logs, machine === "lead" ? `${what}.log` : `member-${what}.log`);

/**
 * The settings a case may change on the member's bridge, and the file that holds them for the daemon's
 * next start of it (`crew start-member --env NAME=value`). An allow list, so no case can slip any other
 * COLLIE_ name into a bridge the rig keeps clean.
 */
const MEMBER_ENV_ALLOWED: readonly string[] = ["COLLIE_WALKY"];
const MEMBER_ENV_FILE = join(P.rig, "member-env.json");

/**
 * The pane `--replace` closes: the last one `pane` or `start` opened for a key, as { key: paneId }. A file
 * of its own, not rig.json: the daemon writes rig.json whole from memory (a `crew start-member` would drop
 * a field this CLI added), and pane ids start again at w1 in every rig, so `up` and `down` remove it.
 */
const LAST_PANES_FILE = join(P.rig, "last-panes.json");

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
    if (/^(COLLIE_|HERDR_|HC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|TAILSCALE|XDG_|RIG_|PI_CODING_AGENT_DIR$|CODEX_HOME$)/.test(key)) continue;
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
    // The machine's mux (COLLIE_RIG_MUX): Herdr's API socket, or the scratch core's client socket under
    // the core's endpoint name (bridge/mux/registry.ts muxEndpointVar, spelled out: the web typecheck does not reach bridge/).
    ...(muxOf(machine) === "herdr-core" ? { COLLIE_MUX: "herdr-core", COLLIE_MUX_ENDPOINT_HERDR_CORE: socket } : { COLLIE_MUX: "herdr", HERDR_SOCKET_PATH: socket }),
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
    scope: process.env.RIG_SCOPE || null,
    ownerCgroup: process.env.RIG_OWNER_CGROUP || null,
  };
  // Read once; the herdr server, the bridge and the panes need not inherit them.
  delete process.env.RIG_SCOPE;
  delete process.env.RIG_OWNER_CGROUP;
  if (crew) {
    run.member = { port: Number(process.env.RIG_MEMBER_PORT), socket: "", herdrPid: null, bridgePid: null };
    run.leadId = LEAD_ID;
    run.memberId = MEMBER_ID;
  }
  writeRun(run);
  const machines: readonly Machine[] = crew ? MACHINES : ["lead"];

  const clients: { close(): void }[] = [];
  /** The model stub for pi and omp, up before any harness starts (M67, ADR 0125). */
  let stub: Stub | null = null;
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
    if (stub !== null) {
      // The last counters, for a `down` that comes before the teardown read them (a crashed leg).
      writeFileSync(P.stubStats, `${JSON.stringify(stub.stats(), null, 2)}\n`);
      await stub.close();
    }
    for (const machine of machines.toReversed()) {
      const half = halfOf(run, machine);
      const session = machineDirs(machine).session;
      await killPid(half.bridgePid, BRIDGE_TAG);
      if (muxOf(machine) === "herdr-core") await stopCore(machine, half.herdrPid);
      else {
        herdr(["session", "stop", session], { session: false, machine });
        for (let i = 0; i < 25; i++) {
          if (herdr(["session", "delete", session], { session: false, machine }).code === 0) break;
          await sleep(200);
        }
        await killPid(half.herdrPid, "herdr");
      }
      retireXdgHome(machine);
    }
    rmSync(P.run, { force: true });
    log("teardown done");
    stopScope(run.scope, { noBlock: true }); // what escaped the teardown (a setsid child) goes with the scope; this process too
    process.exit(0);
  };
  process.on("SIGTERM", () => void teardown("SIGTERM"));
  process.on("SIGINT", () => void teardown("SIGINT"));
  // The owner is gone (its Claude session ended): nobody will run `down`, so tear down here. Only an ENOENT
  // counts as gone, and only two in a row: one odd stat must not end a rig.
  const owner = run.ownerCgroup;
  if (onLinux && owner) {
    let misses = 0;
    setInterval(() => {
      misses = nextOwnerMisses(misses, ownerCheck(`${CGROUP_ROOT}${owner}`));
      if (misses >= OWNER_MISSES_TO_TEARDOWN) void teardown(`owner cgroup ${owner} is gone`);
    }, OWNER_CHECK_MS);
  }

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
    newWorkspacePane(d.work, VIEW_LABEL, machine);
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

  /**
   * One machine's scratch herdr-core (M78 spec 03): `hc server start` with the rig's HC_SESSION, HC_SOCKET
   * and XDG homes (rig-lib.ts coreEnv). The core daemonises into a systemd user service of its own and
   * answers with its pid, which rig.json keeps in `herdrPid` (the mux server's pid, whichever mux). No attached
   * client: the core renders every terminal itself and answers a program's colour query. One plain shell
   * terminal labelled VIEW_LABEL stands in for the Herdr rig's view pane (the shell pane case 10 skips).
   */
  const startCore = async (machine: Machine) => {
    const half = halfOf(run, machine);
    const c = coreDirs(machine);
    for (const dir of [c.data, c.cache]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const started = hc(["server", "start", "--json"], machine, { start: true });
    const pid = asJsonNumber(asJsonObject(parseJson(started.out))?.pid);
    if (started.code !== 0 || pid === undefined) throw new Error(`the ${machine}'s scratch core did not start: ${(started.err || started.out).trim()}`);
    half.herdrPid = pid;
    writeRun(run);
    const end = Date.now() + 15_000;
    while (Date.now() < end && !coreRunning(machine)) await sleep(100);
    if (!coreRunning(machine)) throw new Error(`the ${machine}'s scratch core did not bind ${c.socket} in 15 s`);
    half.socket = assertUnderXdg(c.socket, machine);
    writeRun(run);
    log(`herdr-core up (${machine}): session ${c.session}, socket ${half.socket}, pid ${String(pid)}`);
    // The Herdr rig's view workspace is a plain shell pane the walky talky broadcast case (10) must skip.
    // The core has no view client to need, but the same shell terminal under the same label gives that case its pane.
    const shell = newWorkspacePane(machineDirs(machine).work, VIEW_LABEL, machine);
    log(`shell terminal (${machine}): ${shell}`);
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
    // The tiers the global setup chose (COLLIE_RIG_TIERS), or the same rule here for a rig brought up by hand.
    const leg = crew ? "crew" : "solo";
    const tiers = tiersFromEnv() ?? planTiers(leg, process.env, readVersions());
    const taken = [run.port, ...(run.member === undefined ? [] : [run.member.port])];
    stub = await startStub({ root: CASSETTE_ROOT, leg, plans: tiers, literals: rigLiterals(STATE_ROOT), speed: Number(process.env.COLLIE_RIG_REPLAY_SPEED ?? "1") || 1, log: (line) => log(`stub: ${line}`) }, await freePort(taken));
    run.stub = { port: stub.port, tiers };
    writeRun(run);
    for (const machine of machines) await (muxOf(machine) === "herdr-core" ? startCore(machine) : startHerdr(machine));
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
/** The last 8 lines of one of the rig's log files, or "" when there is none. */
const tailOf = (name: string): string => (existsSync(join(P.logs, name)) ? readFileSync(join(P.logs, name), "utf8").trim().split("\n").slice(-8).join("\n") : "");

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
    // The core binds `hc.holder.<8 hex>.sock` beside its socket, the longer of its two.
    const holder = coreSocketIn(d.xdg).replace(/hc\.sock$/, "hc.holder.00000000.sock");
    if (Buffer.byteLength(holder) > sunPathLimit()) die(`the herdr-core socket path is ${Buffer.byteLength(holder)} bytes, over the ${sunPathLimit()} a Unix socket allows: ${holder}`);
  }
  memGuard(crew ? "the crew rig (two Herdr servers + two bridges)" : "the rig (Herdr + bridge)");
  // A leftover from a crashed run lives only in the rig's own Herdr homes.
  if (machines.some((machine) => existsSync(join(machineDirs(machine).xdg, "herdr")) || coreRunning(machine))) await cmdDown();
  // A scratch core keeps its terminals' records in its state home and gives a parked one a shell at its next
  // start, so a core machine starts from an empty one: no terminal of an earlier run comes back.
  const coreHomes = machines.filter((machine) => muxOf(machine) === "herdr-core").map((machine) => join(machineDirs(machine).xdgState, "herdr-core"));
  const dirs = [...machines.flatMap((machine) => [machineDirs(machine).state, machineDirs(machine).config]), ...coreHomes];
  for (const dir of [...dirs, P.logs]) rmSync(assertUnderRoot(dir), { recursive: true, force: true });
  for (const machine of machines) {
    const d = machineDirs(machine);
    for (const dir of [P.rig, d.state, d.config, P.logs, d.work, d.xdg, d.xdgState]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivateDir(d.xdg);
  }
  rmSync(P.token, { force: true });
  rmSync(MEMBER_ENV_FILE, { force: true });
  rmSync(LAST_PANES_FILE, { force: true });
  const port = await freePort();
  const memberPort = crew ? await freePort([port]) : null;
  const logFd = openSync(join(P.logs, "daemon.out"), "a");
  const env = memberPort === null ? { ...process.env, RIG_PORT: String(port) } : { ...process.env, RIG_PORT: String(port), RIG_MEMBER_PORT: String(memberPort) };
  const { child, scope, tasksMax } = await spawnDaemon(env, logFd, crew);
  // The crew rig starts twice the processes and restarts each bridge during the enrolment.
  const end = Date.now() + (crew ? 180_000 : 70_000);
  while (Date.now() < end) {
    if (readRun()?.ready === true) break;
    if (!pidAlive(child.pid ?? null)) break;
    await sleep(300);
  }
  const run = readRun();
  if (run?.ready !== true) {
    // The daemon's own log first; a daemon that died before it wrote one left its words in daemon.out, and systemd-run's in systemd-run.err.
    const tail = tailOf("daemon.log") || tailOf("daemon.out") || tailOf("systemd-run.err");
    await cmdDown();
    stopScope(scope);
    die(`startup failed.\n${tail || "no log line was written: the daemon never started (see logs/systemd-run.err)"}`);
  }
  if (scope !== null && tasksMax !== null) {
    const warning = taskCapWarning(readScopeFile(scope, "pids.max"), tasksMax);
    if (warning !== null) warn(warning);
  }
  await pairDevice(run!.port, DEVICE_LABEL);
  console.log(`up: bridge http://127.0.0.1:${run!.port}  worktree ${WORKTREE}`);
  console.log(`    ${muxLine("lead")}  socket ${run!.socket}`);
  if (crew) {
    const member = halfOf(run!, "member");
    // The lead learns the member on its own sweep, which rides its poll (bridge/crew/lead.ts): wait for it.
    const reachable = await memberHealth(90_000, (health) => health === "reachable");
    if (reachable !== "reachable") {
      await cmdDown();
      die(`the lead never reported the member reachable in 90 s (last: ${reachable ?? "no answer"}); see logs/daemon.log and logs/member-bridge.log`);
    }
    console.log(`    member ${MEMBER_ID}: bridge 127.0.0.1:${String(member.port)} (pinned TLS)  ${muxLine("member")}  socket ${member.socket}`);
    console.log(`    lead ${LEAD_ID} reports the member reachable`);
  }
}

/** "herdr session collie-rig" or "herdr-core session collie-rig-<hex>": what `up` prints per machine. */
const muxLine = (machine: Machine): string => (muxOf(machine) === "herdr-core" ? `herdr-core session ${coreDirs(machine).session}` : `herdr session ${machineDirs(machine).session}`);

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
    const serverPid = run !== null && (machine === "lead" || run.member !== undefined) ? halfOf(run, machine).herdrPid : null;
    if (muxOf(machine) === "herdr-core" || coreRunning(machine)) await stopCore(machine, serverPid);
    else await killPid(serverPid, "herdr");
    retireXdgHome(machine);
  }
  if (run?.scope) stopScope(run.scope);
  else for (const scope of leftoverScopes()) stopScope(scope); // rig.json is gone or names none: a kill between its removal and the scope's stop
  rmSync(P.run, { force: true });
  rmSync(P.token, { force: true });
  rmSync(MEMBER_ENV_FILE, { force: true });
  rmSync(LAST_PANES_FILE, { force: true });
  const what = machines.map((machine) => (muxOf(machine) === "herdr-core" ? "scratch core" : "scratch Herdr"));
  console.log(machines.length === 1 ? `down: bridge and ${what[0]} stopped` : `down: both bridges, the lead's ${what[0]} and the member's ${what[1]} stopped`);
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

// ── panes ────────────────────────────────────────────────────────────────────────────────────────
/** The exit code of a refused pane (EX_TEMPFAIL): nothing is wrong with the call, the machine is full. */
const EXIT_PANE_CAP = 75;

/** The most panes `pane` and `start` leave open on one machine (COLLIE_RIG_MAX_PANES, default 6). */
const maxPanes = (): number => maxPanesFrom(process.env.COLLIE_RIG_MAX_PANES);

/** The recorded pane per key, `lead` keys bare and the member's as `member:<key>`: the two machines count their pane ids apart. */
const paneKey = (machine: Machine, key: string): string => (machine === "lead" ? key : `${machine}:${key}`);

function lastPanes(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const [name, value] of Object.entries(asJsonObject(parseJson(readFileSync(LAST_PANES_FILE, "utf8"))) ?? {})) {
      const id = asJsonString(value);
      if (id !== undefined) out.set(name, id);
    }
  } catch {
    /* none recorded yet */
  }
  return out;
}

function recordPane(machine: Machine, key: string, paneId: string): void {
  const panes = lastPanes().set(paneKey(machine, key), paneId);
  // A temp file in the same folder, then a rename: a reader never sees half a file.
  const tmp = `${LAST_PANES_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(panes)), { mode: 0o600 });
  renameSync(tmp, LAST_PANES_FILE);
}

/** "45s", "12m", "3h" since a `rig-<time in base 36>` workspace was made (cmdPane's label); "-" for any other label. */
function ageOf(label: string): string {
  const made = /^rig-([0-9a-z]+)$/.exec(label)?.[1];
  const sec = made === undefined ? Number.NaN : Math.round((Date.now() - Number.parseInt(made, 36)) / 1000);
  if (!(sec >= 0)) return "-";
  return sec < 90 ? `${sec}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`;
}

/** One line per pane: id, workspace label, age, and what runs in it (its foreground command, else its cwd). */
function paneLines(panes: readonly OpenPane[], machine: Machine): string[] {
  return panes.map((p) => {
    const what = paneCommand(p.paneId, machine) ?? p.cwd;
    return `  ${p.paneId.padEnd(7)} ${p.label.padEnd(14)} ${ageOf(p.label).padEnd(5)} ${what.length > 70 ? `${what.slice(0, 67)}...` : what}`;
  });
}

/** The flags a follow-up command needs to reach the same rig and machine. */
const rigFlags = (machine: Machine): string => `${CREW ? " --crew" : ""}${machine === "member" ? " --on member" : ""}`;

/** `pane ls`: the panes open on a machine, the rig's view pane left out. */
function cmdPaneLs(machine: Machine): void {
  const panes = openPanes(machine);
  console.log(panes.length === 0 ? `no open panes on the ${machine}` : `${panes.length} open on the ${machine} (cap ${maxPanes()}):\n${paneLines(panes, machine).join("\n")}`);
}

/**
 * `pane close <paneId>...` and `pane close --all`. An id that is not open is reported and skipped (it was
 * closed already, or it is the view pane, which is never listed and never closed); the rest still close.
 */
function cmdPaneClose(ids: readonly string[], all: boolean, machine: Machine): void {
  if (all === (ids.length > 0)) die("usage: pane close <paneId>... | pane close --all");
  const open = openPanes(machine);
  let refused = 0;
  for (const id of new Set(all ? open.map((p) => p.paneId) : ids)) {
    if (!open.some((p) => p.paneId === id)) console.log(`${id}: not open (closed already, or not a pane of this rig)`);
    else if (paneClose(id, machine)) console.log(`${id}: closed`);
    else {
      console.log(`${id}: Herdr refused to close it`);
      refused += 1;
    }
  }
  process.exitCode = refused === 0 ? 0 : 1;
}

/**
 * Before a new pane: with `--replace`, close the pane this key opened last (a pane that is gone does not
 * matter), then refuse with exit 75 when the machine still holds the cap. The refusal lists the open panes.
 */
function makeRoom(machine: Machine, key: string, replace: boolean): void {
  const old = replace ? lastPanes().get(paneKey(machine, key)) : undefined;
  if (old !== undefined) console.log(paneClose(old, machine) ? `replace: closed ${old}` : `replace: ${old} was gone already`);
  const open = openPanes(machine);
  const max = maxPanes();
  if (!paneCapReached(open.length, max)) return;
  console.error(
    `rig: ${open.length} panes are open on the ${machine} (cap ${max}, COLLIE_RIG_MAX_PANES); no new pane started. Each harness pane costs 46 to 64 tasks.\n` +
      `${paneLines(open, machine).join("\n")}\n` +
      `close one: bun e2e/rig/rig.ts pane close <id>${rigFlags(machine)}   (or add --replace to close the pane this command opened last)`,
  );
  process.exit(EXIT_PANE_CAP);
}

/** A new pane on a machine, running `args` as one line when there are any; prints its id and records it under `key` for `--replace`. */
async function cmdPane(args: readonly string[], machine: Machine, key: string): Promise<void> {
  const cmd = args.join(" ");
  const paneId = newWorkspacePane(machineDirs(machine).work, `rig-${Date.now().toString(36)}`, machine);
  recordPane(machine, key, paneId);
  if (cmd !== "") {
    await sleep(700); // let the shell print its prompt first
    paneRun(paneId, cmd, machine);
  }
  console.log(paneId);
}

/** What `status` prints: rig.json, and whether each recorded process still runs. */
interface StatusView extends Run {
  readonly stateRoot: string;
  /** The mux of each machine (COLLIE_RIG_MUX): one name, or `<lead>,<member>` on the crew rig. */
  readonly mux: string;
  /** The daemon's scope, or "none" when it runs outside one. */
  readonly scope: string;
  /** The scope's `pids.current/pids.max`; absent without a scope or when systemd gives none. */
  tasks?: string;
  readonly daemonAlive: boolean;
  readonly bridgeAlive: boolean;
  memberBridgeAlive?: boolean;
  memberHerdrAlive?: boolean;
}

const argv = process.argv.slice(2);
const split = splitArgs(argv);
const cmd = split.verb;
const rest = split.rest;

/** The machine `--on` names; the lead without the flag. */
function machineOf(on: string | null): Machine {
  if (on === null || on === "lead") return "lead";
  return on === "member" ? "member" : die("--on takes lead or member");
}

switch (cmd) {
  case "_daemon":
    await daemon();
    break;
  case "up":
    await cmdUp(split.crew);
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
    const shown: StatusView = { stateRoot: dirname(P.rig), mux: CREW || run.member !== undefined ? `${muxOf("lead")},${muxOf("member")}` : muxOf("lead"), ...run, scope: run.scope ?? "none", daemonAlive: pidIs(run.daemonPid, DAEMON_TAG), bridgeAlive: pidIs(run.bridgePid, BRIDGE_TAG) };
    const used = run.scope ? readScopeFile(run.scope, "pids.current") : null;
    const cap = run.scope ? readScopeFile(run.scope, "pids.max") : null;
    if (used !== null && cap !== null) shown.tasks = `${used}/${cap}`;
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
  case "pane": {
    // `ls` and `close` are verbs here; to run a shell command of that name in a pane, write `pane sh -c ls`
    // (or `pane -- ls`). Flags count only before the command's first word, so the command reaches the pane untouched.
    const machine = machineOf(split.on);
    const verb = split.literal ? undefined : rest[0];
    if (verb === "ls" && rest.length > 1) die("`pane ls` takes no arguments; to run ls in a pane, write `pane sh -c 'ls ...'`");
    else if (verb === "ls") cmdPaneLs(machine);
    else if (verb === "close") cmdPaneClose(rest.slice(1).filter((arg) => arg !== "--all"), rest.includes("--all"), machine);
    else {
      makeRoom(machine, "pane", split.replace);
      await cmdPane(rest, machine, "pane");
    }
    break;
  }
  case "start": {
    // A harness in a fresh pane, the way the leg starts it: `start claude|pi|omp [--on lead|member] [--replace]`.
    const id = HARNESS_IDS.find((harness) => harness === rest[0]) ?? die("usage: start claude|pi|omp [--on lead|member] [--replace]");
    const machine = machineOf(split.on);
    if (machine === "member" && readRun()?.member === undefined) die("this rig has no member (run `up --crew`)");
    memGuard(`harness ${id}`);
    makeRoom(machine, id, split.replace);
    const { line } = prepareHarness(id, machine);
    await cmdPane([line], machine, id);
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
    const host = machineOf(split.on) === "member" ? `&host=${MEMBER_ID}` : "";
    const r = await api(`/api/pane/${encodeURIComponent(pane)}?lines=${Number(rest[1] ?? 60)}${host}`);
    const text = asJsonString(asJsonObject(r.json)?.text) ?? r.text;
    console.log(text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), ""));
    break;
  }
  default:
    console.log(
      "usage: bun e2e/rig/rig.ts up [--crew] | down | status | start claude|pi|omp [--on lead|member] [--replace] | pane <cmd...> [--replace] | pane ls | pane close <paneId>... | pane close --all | snapshot | read <pane> [lines] [--on member] | crew stop-member | crew start-member [--env NAME=value]\n" +
        "       add --crew to any command to reach the crew rig's state root (`crew <verb>` implies it)\n" +
        "       pane and start refuse with exit 75 at COLLIE_RIG_MAX_PANES open panes (default 6)",
    );
    process.exitCode = cmd === undefined || cmd === "help" ? 0 : 1;
}
