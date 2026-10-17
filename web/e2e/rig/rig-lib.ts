// The browser leg's rig, the parts both sides share: the paths, the guards, the Herdr calls and an
// HTTP client with the phone's headers. Node APIs only, so the Playwright runner (node) and the rig
// CLI (bun, rig.ts) import the same file, and `bun run typecheck` in web/ checks it.
//
// ISOLATION, IN ONE PLACE.
//   - Everything lives under STATE_ROOT, on disk (`~/.cache/collie-lab/browser-leg-state`). Not /tmp:
//     bluefin's /tmp is tmpfs, and an out-of-memory crash wiped a /tmp lab on 2026-10-12.
//   - Herdr: its own server under its own XDG_CONFIG_HOME (STATE_ROOT/rig/xdg). Every herdr call
//     below goes through `herdrEnv()`, which drops every inherited HERDR_* name (the operator's agent
//     session sets HERDR_SOCKET_PATH and HERDR_PANE_ID) and points XDG_CONFIG_HOME at the rig's home.
//     The operator's own Herdr server and its panes are never named, read or written.
//   - The bridge: `bun bridge/index.ts` from this checkout on 127.0.0.1:18700-18799, with fresh state
//     and config dirs and every inherited COLLIE_* name dropped. No `collie` verb is ever run.
//   - Every kill is by a pid the rig recorded, after /proc/<pid>/cmdline matched. No pkill.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { asJsonObject, asJsonString, parseJson, type JsonObject } from "../../src/lib/json";

/** The leg's own folder on disk. The guard below refuses any path outside it. */
export const STATE_ROOT = resolve(process.env.COLLIE_RIG_STATE ?? join(homedir(), ".cache", "collie-lab", "browser-leg-state"));
if (!STATE_ROOT.startsWith(join(homedir(), ".cache", "collie-lab") + "/")) {
  throw new Error(`the rig state must live under ~/.cache/collie-lab/, not ${STATE_ROOT}`);
}

/** The Herdr session name. It exists only under the rig's XDG home. */
export const SESSION = "collie-rig";
/** The bridge's port range. Far from every Collie lane (8787-8799, 5198, 5199). */
export const PORT_LO = 18700;
export const PORT_HI = 18799;

const RIG = join(STATE_ROOT, "rig");
export const P = {
  rig: RIG,
  state: join(RIG, "state"), // COLLIE_STATE_DIR
  config: join(RIG, "config"), // HERDR_PLUGIN_CONFIG_DIR
  xdg: join(RIG, "xdg"), // XDG_CONFIG_HOME for herdr only
  xdgState: join(RIG, "xdg-state"), // XDG_STATE_HOME for herdr only (its agent-detection status file)
  logs: join(RIG, "logs"),
  work: join(RIG, "work"), // cwd of the view workspace
  bridgeHome: join(RIG, "bridge-home"), // HOME of the bridge
  run: join(RIG, "rig.json"),
  token: join(RIG, "token"),
  herdrCfg: join(RIG, "herdr-config.toml"),
  homeCfg: join(RIG, "config", "home-config.toml"), // COLLIE_CONFIG: a file that never exists
  harness: join(STATE_ROOT, "harness"), // one scratch HOME / config dir per harness
  results: join(STATE_ROOT, "results"), // one folder per run: ledger, table, screen captures
} as const;

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
}

export function assertUnderRoot(path: string): string {
  const full = resolve(path);
  if (full !== STATE_ROOT && !full.startsWith(`${STATE_ROOT}/`)) throw new Error(`refusing a path outside ${STATE_ROOT}: ${full}`);
  return full;
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
export function herdrEnv() {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|COLLIE_)/.test(key)) continue;
    out[key] = value;
  }
  out.XDG_CONFIG_HOME = P.xdg;
  out.XDG_STATE_HOME = P.xdgState;
  out.HERDR_CONFIG_PATH = P.herdrCfg;
  out.HERDR_DISABLE_SOUND = "1";
  return out;
}

export interface HerdrResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** One herdr call in the rig's home. `session: false` leaves out `--session collie-rig`. */
export function herdr(args: readonly string[], opts: { session?: boolean } = {}): HerdrResult {
  const argv = opts.session === false ? [...args] : ["--session", SESSION, ...args];
  const r = spawnSync("herdr", argv, { env: herdrEnv(), encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function herdrJson(args: readonly string[]): JsonObject {
  const r = herdr(args);
  const doc = asJsonObject(parseJson(r.out)) ?? {};
  if (r.code !== 0 || doc.error !== undefined) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${asJsonString(asJsonObject(doc.error)?.message) ?? (r.err || r.out).trim()}`);
  }
  return asJsonObject(doc.result) ?? {};
}

/** A new workspace in the rig's Herdr with one shell pane; returns the pane id. */
export function newWorkspacePane(cwd: string, label: string): string {
  const ws = herdrJson(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  const paneId = asJsonString(asJsonObject(ws.root_pane)?.pane_id) ?? null;
  if (paneId === null) throw new Error("herdr gave no pane id");
  return paneId;
}

/** Close a rig pane, and with it the harness in it. */
export function paneClose(paneId: string): void {
  herdr(["pane", "close", paneId]);
}

/** Type a line into a rig pane and press Enter (`herdr pane run`). */
export function paneRun(paneId: string, line: string): void {
  const r = herdr(["pane", "run", paneId, line]);
  if (r.code !== 0) throw new Error(`herdr pane run: ${(r.err || r.out).trim()}`);
}
