// The browser leg's rig, the parts both sides share: the paths, the guards, the Herdr calls and an
// HTTP client with the phone's headers. Node APIs only, so the Playwright runner (node) and the rig
// CLI (bun, rig.ts) import the same file, and `bun run typecheck` in web/ checks it.
//
// ISOLATION, IN ONE PLACE.
//   - Everything lives under STATE_ROOT, on disk (`~/.cache/collie-lab/browser-leg-state`). Not /tmp:
//     bluefin's /tmp is tmpfs, and an out-of-memory crash wiped a /tmp lab on 2026-10-12.
//   - Herdr: its own server under its own XDG_CONFIG_HOME. Every herdr call below goes through
//     `herdrEnv()`, which drops every inherited HERDR_* name (the operator's agent session sets
//     HERDR_SOCKET_PATH and HERDR_PANE_ID) and points XDG_CONFIG_HOME at the rig's home. The operator's
//     own Herdr server and its panes are never named, read or written. That one folder is the only
//     part of the rig outside STATE_ROOT: Herdr binds its sockets under XDG_CONFIG_HOME and a socket
//     path holds at most 107 bytes, so the folder is a short one in $XDG_RUNTIME_DIR or /tmp, named
//     from a hash of STATE_ROOT (sock-path.ts). `rig.ts up` checks the length; `down` removes it.
//   - The bridge: `bun bridge/index.ts` from this checkout on 127.0.0.1:18700-18799, with fresh state
//     and config dirs and every inherited COLLIE_* name dropped. No `collie` verb is ever run.
//   - Every kill is by a pid the rig recorded, after /proc/<pid>/cmdline matched. No pkill.
//
// THE CREW RIG (`rig.ts up --crew`, the crew leg). A second machine beside the first: the LEAD is the
// rig above, and the MEMBER is a second Herdr server (session `collie-rig-member`, its own short XDG
// home) and a second bridge with its own state, config and HOME under `<rig>/member/`. The crew rig
// has its own default state root (`browser-leg-crew-state`), so the solo leg and the crew leg never
// share a rig folder, a Herdr home or a port. `COLLIE_RIG_CREW=1` selects it (crew-env.ts sets it).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { asJsonObject, asJsonString, parseJson, type JsonObject } from "../../src/lib/json";
import type { TierPlans } from "./replay/tier";
import { coreSocketIn, rigMuxFrom, type RigMux } from "./rig-mux";
import { XDG_HOME_NAME, shortXdgHome } from "./sock-path";

/** True for the crew rig (lead and member); the solo rig otherwise. */
export const CREW = process.env.COLLIE_RIG_CREW === "1";

/** The leg's own folder on disk. The guard below refuses any path outside it. */
export const STATE_ROOT = resolve(process.env.COLLIE_RIG_STATE ?? join(homedir(), ".cache", "collie-lab", CREW ? "browser-leg-crew-state" : "browser-leg-state"));
if (!STATE_ROOT.startsWith(join(homedir(), ".cache", "collie-lab") + "/")) {
  throw new Error(`the rig state must live under ~/.cache/collie-lab/, not ${STATE_ROOT}`);
}

/** The Herdr session name. It exists only under the rig's XDG home. */
export const SESSION = "collie-rig";
/** The member's Herdr session name, under the member's own XDG home. */
export const MEMBER_SESSION = "collie-rig-member";
/** The crew's member ids: the label each side enrols under (`crew invite --as`, `crew join --label`). */
export const LEAD_ID = "rig-lead";
export const MEMBER_ID = "rig-member";
/** The label the rig's one paired device carries: an operator's walky talky message names it. */
export const DEVICE_LABEL = "browser-leg";
/** The bridge's port range. Far from every Collie lane (8787-8799, 5198, 5199). */
export const PORT_LO = 18700;
export const PORT_HI = 18799;

const RIG = join(STATE_ROOT, "rig");
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
export const P = {
  rig: RIG,
  state: join(RIG, "state"), // COLLIE_STATE_DIR
  config: join(RIG, "config"), // HERDR_PLUGIN_CONFIG_DIR
  xdg: shortXdgHome(STATE_ROOT, SESSION, RUNTIME_DIR !== undefined && existsSync(RUNTIME_DIR) ? RUNTIME_DIR : undefined), // XDG_CONFIG_HOME for herdr only; short, so its sockets fit sun_path
  xdgState: join(RIG, "xdg-state"), // XDG_STATE_HOME for herdr only (its agent-detection status file)
  logs: join(RIG, "logs"),
  stubStats: join(RIG, "logs", "stub-stats.json"), // the stub's last counters, written by the rig daemon's teardown; startRun removes it
  work: join(RIG, "work"), // cwd of the view workspace
  bridgeHome: join(RIG, "bridge-home"), // HOME of the bridge
  run: join(RIG, "rig.json"),
  token: join(RIG, "token"),
  herdrCfg: join(RIG, "herdr-config.toml"),
  homeCfg: join(RIG, "config", "home-config.toml"), // COLLIE_CONFIG: a file that never exists
  harness: join(STATE_ROOT, "harness"), // one scratch HOME / config dir per harness
  results: join(STATE_ROOT, "results"), // one folder per run: ledger, table, screen captures
} as const;

/** One machine of the rig: the lead (the solo rig is a lead with no member) or the crew's member. */
export type Machine = "lead" | "member";
export const MACHINES: readonly Machine[] = ["lead", "member"];

/** What one machine of the rig owns: its Herdr session and home, and its bridge's dirs. */
export interface MachineDirs {
  readonly machine: Machine;
  readonly session: string;
  readonly state: string;
  readonly config: string;
  readonly xdg: string;
  readonly xdgState: string;
  readonly work: string;
  readonly bridgeHome: string;
  readonly homeCfg: string;
  readonly herdrCfg: string;
  /** The parent of this machine's harness folders. */
  readonly harness: string;
}

const MEMBER_ROOT = join(RIG, "member");
const DIRS = {
  lead: { machine: "lead", session: SESSION, state: P.state, config: P.config, xdg: P.xdg, xdgState: P.xdgState, work: P.work, bridgeHome: P.bridgeHome, homeCfg: P.homeCfg, herdrCfg: P.herdrCfg, harness: P.harness },
  member: {
    machine: "member",
    session: MEMBER_SESSION,
    state: join(MEMBER_ROOT, "state"),
    config: join(MEMBER_ROOT, "config"),
    // Its own hash input, so the member's Herdr home is never the lead's.
    xdg: shortXdgHome(join(STATE_ROOT, "member"), MEMBER_SESSION, RUNTIME_DIR !== undefined && existsSync(RUNTIME_DIR) ? RUNTIME_DIR : undefined),
    xdgState: join(MEMBER_ROOT, "xdg-state"),
    work: join(MEMBER_ROOT, "work"),
    bridgeHome: join(MEMBER_ROOT, "bridge-home"),
    homeCfg: join(MEMBER_ROOT, "config", "home-config.toml"),
    herdrCfg: join(MEMBER_ROOT, "herdr-config.toml"),
    harness: join(STATE_ROOT, "harness", "member"),
  },
} as const satisfies Record<Machine, MachineDirs>;

export function machineDirs(machine: Machine): MachineDirs {
  return DIRS[machine];
}

/** The multiplexer each machine runs (COLLIE_RIG_MUX, rig-mux.ts): Herdr unless it says herdr-core. */
export const RIG_MUX = rigMuxFrom(process.env.COLLIE_RIG_MUX);
export const muxOf = (machine: Machine): RigMux => RIG_MUX[machine];

/** The member's half of a crew rig: its port, its Herdr socket and the pids the daemon started. */
export interface MemberRun {
  readonly port: number;
  socket: string;
  herdrPid: number | null;
  bridgePid: number | null;
}

/** What the rig daemon records about the processes it started. */
export interface Run {
  readonly worktree: string;
  readonly port: number;
  socket: string;
  readonly daemonPid: number;
  herdrPid: number | null;
  bridgePid: number | null;
  ready: boolean;
  readonly startedAt: string;
  /** The systemd scope the daemon runs in (`rig-<hash>-<pid>.scope`), or null when it runs where `up` ran. Absent in an older rig.json. */
  readonly scope?: string | null;
  /** The cgroup `up` ran in (a path under /sys/fs/cgroup), the owner the daemon watches; null when none was recorded. */
  readonly ownerCgroup?: string | null;
  /** Set on a crew rig only: the member, and the ids both sides enrolled under. */
  member?: MemberRun;
  leadId?: string;
  memberId?: string;
  /** The model stub for pi and omp (M67, replay/stub.ts): its port, and the tier each harness runs on. */
  stub?: { readonly port: number; readonly tiers: TierPlans };
}

export function assertUnderRoot(path: string): string {
  const full = resolve(path);
  if (full !== STATE_ROOT && !full.startsWith(`${STATE_ROOT}/`)) throw new Error(`refusing a path outside ${STATE_ROOT}: ${full}`);
  return full;
}

/** A socket path Herdr reported must sit in that machine's own Herdr home. */
export function assertUnderXdg(path: string, machine: Machine = "lead"): string {
  const full = resolve(path);
  const xdg = DIRS[machine].xdg;
  if (!full.startsWith(`${xdg}/`)) throw new Error(`refusing a socket outside ${xdg}: ${full}`);
  return full;
}

/** The Herdr home may sit in /tmp: use it only when it is a real directory of this user that nobody else can enter. */
export function assertPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new Error(`refusing ${dir}: it is not a directory of this user with mode 0700`);
  }
}

/**
 * Remove the rig's Herdr home once its session has no running server. It refuses any folder that does
 * not carry the rig's own name, and leaves the folder alone while Herdr could still use it.
 */
export function retireXdgHome(machine: Machine = "lead"): void {
  const xdg = DIRS[machine].xdg;
  if (!XDG_HOME_NAME.test(basename(xdg))) throw new Error(`refusing to remove ${xdg}: not a rig Herdr home`);
  if (!existsSync(xdg) || sessionRunning(machine) || coreRunning(machine)) return;
  rmSync(xdg, { recursive: true, force: true });
}

export function readRun(): Run | null {
  try {
    const run: Run = JSON.parse(readFileSync(P.run, "utf8"));
    return run;
  } catch {
    return null;
  }
}

export function writeRun(run: Run): void {
  writeFileSync(P.run, JSON.stringify(run, null, 2), { mode: 0o600 });
}

export function readToken(): string {
  return readFileSync(P.token, "utf8").trim();
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ── pids ─────────────────────────────────────────────────────────────────────────────────────────

export function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True only when the pid is alive AND its command line contains `needle`: never kill a stranger. */
export function pidIs(pid: number | null, needle: string): boolean {
  if (pid === null || !pidAlive(pid)) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").includes(needle);
  } catch {
    return false;
  }
}

export async function killPid(pid: number | null, needle: string, ms = 8000): Promise<void> {
  if (pid === null || !pidIs(pid, needle)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end && pidAlive(pid)) await sleep(100);
  if (pidIs(pid, needle)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

// ── the memory guard ─────────────────────────────────────────────────────────────────────────────

/** The leg stops before a browser or a harness starts when less than this is free. */
export const MEM_FLOOR_KB = 8 * 1024 * 1024;

export function memAvailableKb(): number {
  const line = readFileSync("/proc/meminfo", "utf8")
    .split("\n")
    .find((row) => row.startsWith("MemAvailable:"));
  return Number(/(\d+)/.exec(line ?? "")?.[1] ?? 0);
}

/** Throws under 8 GB available. `what` names the start the guard stood in front of. */
export function memGuard(what: string): void {
  const kb = memAvailableKb();
  if (kb < MEM_FLOOR_KB) {
    throw new Error(`memory guard: ${(kb / 1024 / 1024).toFixed(1)} GB available, under 8 GB; ${what} not started`);
  }
}

// ── Herdr, always the rig's own ──────────────────────────────────────────────────────────────────

/** The environment for herdr and the panes it starts: no inherited HERDR_ or CLAUDE names. */
export function herdrEnv(machine: Machine = "lead") {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|COLLIE_)/.test(key)) continue;
    out[key] = value;
  }
  const d = DIRS[machine];
  out.XDG_CONFIG_HOME = d.xdg;
  out.XDG_STATE_HOME = d.xdgState;
  out.HERDR_CONFIG_PATH = d.herdrCfg;
  out.HERDR_DISABLE_SOUND = "1";
  return out;
}

export interface HerdrResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** One herdr call in a machine's home. `session: false` leaves out `--session <its session>`. */
export function herdr(args: readonly string[], opts: { session?: boolean; machine?: Machine } = {}): HerdrResult {
  const machine = opts.machine ?? "lead";
  const argv = opts.session === false ? [...args] : ["--session", DIRS[machine].session, ...args];
  const r = spawnSync("herdr", argv, { env: herdrEnv(machine), encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** True while a machine's Herdr session has a running server. */
export function sessionRunning(machine: Machine = "lead"): boolean {
  try {
    const doc: { sessions: { name: string; running: boolean }[] } = JSON.parse(herdr(["session", "list", "--json"], { session: false, machine }).out);
    return doc.sessions.some((s) => s.name === DIRS[machine].session && s.running);
  } catch {
    return false;
  }
}

export function herdrJson(args: readonly string[], machine: Machine = "lead"): JsonObject {
  const r = herdr(args, { machine });
  const doc = asJsonObject(parseJson(r.out)) ?? {};
  if (r.code !== 0 || doc.error !== undefined) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${asJsonString(asJsonObject(doc.error)?.message) ?? (r.err || r.out).trim()}`);
  }
  return asJsonObject(doc.result) ?? {};
}

/** A new workspace in a machine's Herdr with one shell pane; returns the pane id. */
export function newWorkspacePane(cwd: string, label: string, machine: Machine = "lead"): string {
  if (muxOf(machine) === "herdr-core") return coreNewTerminal(cwd, label, [], machine);
  const ws = herdrJson(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"], machine);
  const paneId = asJsonString(asJsonObject(ws.root_pane)?.pane_id) ?? null;
  if (paneId === null) throw new Error("herdr gave no pane id");
  return paneId;
}

/** Close a rig pane, and with it the harness in it. False when Herdr refused: the pane is already gone, or never was. */
export function paneClose(paneId: string, machine: Machine = "lead"): boolean {
  if (muxOf(machine) === "herdr-core") return coreClose(paneId, machine);
  return herdr(["pane", "close", paneId], { machine }).code === 0;
}

/** The label of the view workspace the daemon opens first (rig.ts startHerdr): the pane its attached client shows. */
export const VIEW_LABEL = "rig-view";

/** One open pane of a machine's rig, as `rig.ts pane ls` and the pane cap see it. */
export interface OpenPane {
  readonly paneId: string;
  /** The label of the pane's workspace: `rig-<time in base 36>` from `pane` and `start`, `leg-<harness>` from the leg. */
  readonly label: string;
  readonly cwd: string;
}

/**
 * The panes open in a machine's Herdr, less the view pane. `newWorkspacePane` gives every pane its own
 * workspace, and only the view workspace carries VIEW_LABEL, so the view pane is told apart by its
 * workspace's label, not by its id.
 */
export function openPanes(machine: Machine = "lead"): OpenPane[] {
  if (muxOf(machine) === "herdr-core") return coreOpenPanes(machine);
  const labels = new Map<string, string>();
  const workspaces = herdrJson(["workspace", "list"], machine).workspaces;
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    const ws = asJsonObject(w);
    const id = asJsonString(ws?.workspace_id);
    if (id !== undefined) labels.set(id, asJsonString(ws?.label) ?? "");
  }
  const panes = herdrJson(["pane", "list"], machine).panes;
  const out: OpenPane[] = [];
  for (const p of Array.isArray(panes) ? panes : []) {
    const pane = asJsonObject(p);
    const paneId = asJsonString(pane?.pane_id);
    if (paneId === undefined) continue;
    const label = labels.get(asJsonString(pane?.workspace_id) ?? "") ?? "";
    if (label === VIEW_LABEL) continue;
    out.push({ paneId, label, cwd: asJsonString(pane?.cwd) ?? "" });
  }
  return out;
}

/** The command a pane runs in its foreground (`herdr pane process-info`), or null when Herdr gives none. */
export function paneCommand(paneId: string, machine: Machine = "lead"): string | null {
  if (muxOf(machine) === "herdr-core") return coreCommand(paneId, machine);
  try {
    const info = asJsonObject(herdrJson(["pane", "process-info", "--pane", paneId], machine).process_info);
    const procs = info?.foreground_processes;
    return asJsonString(asJsonObject(Array.isArray(procs) ? procs[0] : undefined)?.cmdline) ?? null;
  } catch {
    return null;
  }
}

/** Type a line into a rig pane and press Enter (`herdr pane run`). */
export function paneRun(paneId: string, line: string, machine: Machine = "lead"): void {
  if (muxOf(machine) === "herdr-core") {
    // `hc send` pastes the line and presses Enter once nobody typed for about 3 s (HC_API.md "Typing").
    const sent = hc(["send", paneId, line], machine);
    if (sent.code !== 0) throw new Error(`hc send: ${(sent.err || sent.out).trim()}`);
    return;
  }
  const r = herdr(["pane", "run", paneId, line], { machine });
  if (r.code !== 0) throw new Error(`herdr pane run: ${(r.err || r.out).trim()}`);
}

/**
 * A fresh pane on a machine that runs `line` (a start script's `exec '<path>'`), and its pane id as the
 * machine's bridge names it. Herdr: a shell pane in a workspace of its own, its prompt first, then the
 * line typed in (the rig as it always was). herdr-core: a terminal whose program is `sh -c <line>`,
 * started over the API (`hc run --bg`), with no shell beneath; the start script carries every setting
 * the harness needs, because a program started over the API gets the core's environment, not the caller's.
 */
export async function startInPane(cwd: string, label: string, line: string, machine: Machine = "lead"): Promise<string> {
  if (muxOf(machine) === "herdr-core") return coreNewTerminal(cwd, label, ["sh", "-c", line], machine);
  const paneId = newWorkspacePane(cwd, label, machine);
  await sleep(800); // the shell's prompt first
  paneRun(paneId, line, machine);
  return paneId;
}

// ── herdr-core, always the rig's own ─────────────────────────────────────────────────────────────
//
// A scratch core per machine: `hc server start` with HC_SESSION `collie-rig-<8 hex>` (the short home's
// own name) and HC_SOCKET `<short home>/hc.sock`, under scratch XDG homes. Every `hc` call below carries
// that socket, and every inherited HC_ name is dropped first, so the operator's core
// (`$XDG_RUNTIME_DIR/herdr-core/default.sock`) is never dialled. Two facts shape the code (hc 0.1.14,
// probed 2026-10-30): EVERY hc call starts a core when none answers on the socket, `server status`
// included, so nothing here calls hc unless the socket file is there; and the core places its server
// and its holder (the process the terminals run under) in systemd user services of their own
// (`hc-serve-<hex>.service`, `hc-hold-<hex>.service`), outside the rig's scope, so the scope's TasksMax
// does not bound them and the rig stops them itself (rig.ts).

/** The scratch core's socket, session name and XDG homes for one machine. */
export function coreDirs(machine: Machine = "lead") {
  const d = DIRS[machine];
  return { socket: coreSocketIn(d.xdg), session: basename(d.xdg), data: join(d.xdgState, "core-data"), cache: join(d.xdgState, "core-cache") };
}

/** The environment for `hc` and for the core it starts (its terminals inherit it): no inherited HC_, HERDR_, COLLIE_ or CLAUDE names. */
export function coreEnv(machine: Machine = "lead") {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(HC_|HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|COLLIE_)/.test(key)) continue;
    out[key] = value;
  }
  const d = DIRS[machine];
  const c = coreDirs(machine);
  out.HC_SESSION = c.session;
  out.HC_SOCKET = c.socket;
  out.XDG_CONFIG_HOME = d.xdg;
  out.XDG_STATE_HOME = d.xdgState;
  out.XDG_DATA_HOME = c.data;
  out.XDG_CACHE_HOME = c.cache;
  return out;
}

/** True while the machine's scratch core has its socket: the one test that starts no core. */
export function coreRunning(machine: Machine = "lead"): boolean {
  return existsSync(coreDirs(machine).socket);
}

/** One hc call against the machine's scratch core. Refuses when its socket is gone, because hc would start a new core. */
export function hc(args: readonly string[], machine: Machine = "lead", opts: { start?: boolean } = {}): HerdrResult {
  if (opts.start !== true && !coreRunning(machine)) return { code: 1, out: "", err: `no scratch core on the ${machine} (${coreDirs(machine).socket} is gone)` };
  const r = spawnSync("hc", [...args], { env: coreEnv(machine), encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function hcJson(args: readonly string[], machine: Machine): JsonObject {
  const r = hc([...args, "--json"], machine);
  const doc = asJsonObject(parseJson(r.out));
  if (r.code !== 0 || doc === undefined) throw new Error(`hc ${args.slice(0, 2).join(" ")}: ${(r.err || r.out).trim()}`);
  return doc;
}

/** A terminal name the core takes: 1-32 of a-z 0-9 - _, unique among live terminals, so it carries a time stamp. */
function coreName(label: string): string {
  const stamp = Date.now().toString(36).slice(-5);
  const base = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32 - stamp.length - 1);
  return `${base}-${stamp}`;
}

/** A new terminal on the machine's core, in `cwd`, running `argv` (none: the machine's own shell); its address. */
function coreNewTerminal(cwd: string, label: string, argv: readonly string[], machine: Machine): string {
  const doc = hcJson(["run", "--bg", "--name", coreName(label), "--cwd", cwd, "--no-parent", "--no-notify", ...(argv.length === 0 ? [] : ["--", ...argv])], machine);
  const address = asJsonString(doc.address);
  if (address === undefined) throw new Error("hc run gave no address");
  return address;
}

/** End a terminal's program and remove its record. False when the core refused: it is gone, or never was. */
function coreClose(address: string, machine: Machine): boolean {
  const killed = hc(["kill", address], machine).code === 0;
  if (killed) hc(["rm", address], machine);
  return killed;
}

/** The live terminals of the machine's core, as `pane ls` and the pane cap see them; the label is the terminal's name. */
function coreOpenPanes(machine: Machine): OpenPane[] {
  const rows = hcJson(["ls"], machine).terminals;
  const out: OpenPane[] = [];
  for (const t of Array.isArray(rows) ? rows : []) {
    const row = asJsonObject(t);
    const paneId = asJsonString(row?.address);
    if (paneId === undefined) continue;
    out.push({ paneId, label: (asJsonString(row?.name) ?? "").replace(/-[0-9a-z]{1,5}$/, ""), cwd: asJsonString(row?.cwd) ?? "" });
  }
  return out;
}

/** The foreground command of a core terminal (`hc get`), or null. */
function coreCommand(address: string, machine: Machine): string | null {
  try {
    const argv = asJsonObject(hcJson(["get", address], machine).foreground)?.argv;
    return Array.isArray(argv) ? argv.map((word) => String(word)).join(" ") : null;
  } catch {
    return null;
  }
}

/** The pids of herdr-core processes that belong to this machine's scratch core: the holder names its socket beside ours, the server carries HC_SOCKET. */
function corePids(machine: Machine): number[] {
  const { socket } = coreDirs(machine);
  const home = `${DIRS[machine].xdg}/`;
  const out: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return out;
  }
  for (const name of entries) {
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!cmdline.includes("herdr-core")) continue;
      const ours = cmdline.includes(home) || readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`HC_SOCKET=${socket}`);
      if (ours) out.push(Number(name));
    } catch {
      /* gone, or not ours to read */
    }
  }
  return out;
}

/**
 * Stop the machine's scratch core and everything it runs: `hc server stop` (it ends the holder and every
 * terminal's program), then the recorded server pid, then any herdr-core process still bound to this
 * rig's socket. Never touches another core: the sweep matches this machine's socket path only.
 */
export async function stopCore(machine: Machine, pid: number | null): Promise<void> {
  if (coreRunning(machine)) hc(["server", "stop", "--json"], machine);
  await killPid(pid, "herdr-core");
  for (const left of corePids(machine)) await killPid(left, "herdr-core");
  rmSync(coreDirs(machine).socket, { force: true });
}

/**
 * The pane markers a process in a pane of this machine carries, as `collie walky` reads them
 * (cli/beacon.ts MUX_ENV_MARKERS): Herdr's pane id and socket, or the core's terminal id and socket.
 */
export function paneMarkers(paneId: string, socket: string, machine: Machine = "lead"): Record<string, string> {
  return muxOf(machine) === "herdr-core" ? { HC_TERMINAL_ID: paneId, HC_TERMINAL_SOCKET: socket } : { HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: socket };
}

// ── walky talky, through a machine's own socket ──────────────────────────────────────────────────

/** A machine's walky talky socket: `<state>/walky/sock`, the one `collie walky` asks (bridge/walky/socket.ts). */
export function walkySocket(machine: Machine = "lead"): string {
  return join(DIRS[machine].state, "walky", "sock");
}

/**
 * One request line to a machine's walky socket and its one answer line, as `collie walky` sends it
 * (`cli/walky.ts` askSocket) but with no pane markers: the answer is the machine's, not a pane's. So
 * `{ op: "status", id }` reads a message's receipts the way `collie walky status <id>` does on that
 * machine. Null when nothing answered in `ms`.
 */
export async function askWalky(machine: Machine, body: JsonObject, ms = 10_000): Promise<JsonObject | null> {
  const line = `${JSON.stringify({ v: 1, markers: [], ...body })}\n`;
  const conn = createConnection({ path: walkySocket(machine) });
  conn.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), ms);
  });
  const answered = (async (): Promise<string | null> => {
    const connected = await once(conn, "connect").then(
      () => true,
      () => false,
    );
    if (!connected) return null;
    conn.setEncoding("utf8");
    conn.write(line);
    let text = "";
    for await (const chunk of conn) {
      text += String(chunk);
      const at = text.indexOf("\n");
      if (at >= 0) return text.slice(0, at);
    }
    return text === "" ? null : text;
  })();
  const raw = await Promise.race([answered, late]);
  clearTimeout(timer);
  conn.destroy();
  return raw === null ? null : (asJsonObject(parseJson(raw)) ?? null);
}
