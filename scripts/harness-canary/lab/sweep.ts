// What a lab run left behind when it died (M56 spec 10). The run folder holds a copy of the person's login,
// and a throwaway tmux server holds a running agent. Neither may outlive its run. A signal handler cleans
// up in the normal case (run.ts). This sweep runs at the start of every run and cleans up the rest: a run
// the OOM killer or a power cut ended, where no handler ran.
//
// A run folder is `<lab root>/<harness>-<version>/`. It is kept only when its ledger row is a live
// `running` row: the row's process is alive. A folder with no row yet is a run that is still starting, and
// it is spared for a short grace. A tmux server named `harness-lab-<pid>` is killed when that pid is dead.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { findRow, loadLedger, settle } from "./lab-ledger";
import { LabTmux } from "./tmux";

export interface Liveness {
  isAlive(pid: number): boolean;
  /** The names of the tmux sockets that carry the lab prefix, like `harness-lab-1234`. */
  servers(): string[];
  /** Kill the server on that socket and remove the socket file. */
  killServer(name: string): Promise<void>;
}

const RUN_FOLDER = /^[a-z][a-z0-9-]*-\d+\.\d+\.\d+$/u;
const SERVER_NAME = /^harness-lab-(\d+)$/u;
/** A folder with no row is a run that is still starting. It gets this long before the sweep removes it. */
export const STARTING_GRACE_MS = 2 * 60_000;

export const realLiveness: Liveness = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists and belongs to someone else.
      return err instanceof Error && "code" in err && err.code === "EPERM";
    }
  },
  servers() {
    const dir = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${String(process.getuid?.() ?? 0)}`);
    try {
      return readdirSync(dir).filter((name) => SERVER_NAME.test(name));
    } catch {
      return [];
    }
  },
  async killServer(name) {
    try {
      await new LabTmux(name).stop();
    } catch {
      // No tmux binary: nothing can be running either.
    }
  },
};

export interface SweepResult {
  /** Run folders removed. */
  readonly removed: readonly string[];
  /** Tmux servers killed. */
  readonly killed: readonly string[];
  /** `running` rows whose process was dead, now `failed`. */
  readonly settled: readonly string[];
}

export interface SweepInput {
  readonly labRoot: string;
  readonly ledgerPath: string;
  readonly now: number;
  readonly live: Liveness;
}

/** Run folders under the lab root: `<harness>-<version>` only. `logs`, `issues`, `worktrees` and `clone` are not. */
export function runFoldersOf(labRoot: string): string[] {
  try {
    return readdirSync(labRoot).filter((name) => RUN_FOLDER.test(name));
  } catch {
    return [];
  }
}

export async function sweepLab(input: SweepInput): Promise<SweepResult> {
  const settled: string[] = [];
  const removed: string[] = [];
  const killed: string[] = [];
  const ledger = loadLedger(input.ledgerPath, input.now);
  for (const row of ledger.rows) {
    if (row.result !== "running" || row.pid === undefined || input.live.isAlive(row.pid)) continue;
    settle(input.ledgerPath, row.harness, row.version, { result: "failed", note: `interrupted: the run's process ${String(row.pid)} died` });
    settled.push(`${row.harness}-${row.version}`);
  }
  const rows = loadLedger(input.ledgerPath, input.now);
  for (const name of runFoldersOf(input.labRoot)) {
    const at = name.lastIndexOf("-");
    const row = findRow(rows, name.slice(0, at), name.slice(at + 1));
    const keep = row?.result === "running" && (row.pid === undefined || input.live.isAlive(row.pid));
    if (keep) continue;
    const folder = join(input.labRoot, name);
    if (row === undefined && input.now - statSync(folder).mtimeMs < STARTING_GRACE_MS) continue;
    rmSync(folder, { recursive: true, force: true });
    if (!existsSync(folder)) removed.push(name);
  }
  for (const name of input.live.servers()) {
    const pid = Number(SERVER_NAME.exec(name)?.[1]);
    if (!Number.isInteger(pid) || input.live.isAlive(pid)) continue;
    await input.live.killServer(name);
    killed.push(name);
  }
  return { removed, killed, settled };
}
