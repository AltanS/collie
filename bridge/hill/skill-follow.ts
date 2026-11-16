import { parseSyncResult, skillSyncEnabled } from "../../cli/skill-sync-result.ts";
import { collieSelfCommand } from "../root.ts";
import type { SwitchFollower } from "./switch.ts";

// THE BRIDGE'S SKILL SYNC AFTER A SWITCH (M96 spec 12, ADR 0111's addendum of 2026-11-16). A real change
// of the Hill's switch from the phone, or by the takeover's adopt, re-renders the installed WalkyTalky
// skill files, so the Hill's words are in an agent's context only while the Hill is on.
//
// A SPAWN, NOT THE SHARED CODE. The bridge runs this build's own CLI, `collie skill sync --json`
// ({@link collieSelfCommand}), the very command `collie update` runs after a swap. So the guards are the
// verb's own (a symlinked file refused, one backup, an uninstalled target left out), the render needs the
// CLI's context (the pinned binary path, the version), and the bridge's import graph stays without
// cli/skill-install.ts and the embedded docs it pulls in. Only cli/skill-sync-result.ts is read here,
// which imports nothing.
//
// NOTHING FROM THE REQUEST. The argv is fixed, the environment is the bridge's own with its state dir set,
// so the child reads the same switch and the same uninstall marker. The phone's answer never waits: the
// follower starts the child and returns. One journal line per sync, or one per fault. `COLLIE_SKILL_SYNC
// =off` keeps the files as they are, as it does for the update. Syncs run one at a time; a change while
// one runs queues one more, so the last sync always starts after the last write and the files end on
// the switch's last value.

/** How long one sync may run. It writes a handful of small files; a hang is killed. */
export const SKILL_FOLLOW_TIMEOUT_MS = 30_000;

/** One child, as the follower needs it. */
export interface SkillSyncChild {
  readonly exited: Promise<number>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  kill(): void;
}

export interface SkillFollowDeps {
  /** This instance's state dir: the child's `COLLIE_STATE_DIR`. */
  readonly stateDir: string;
  /** The bridge's environment, read for `COLLIE_SKILL_SYNC` and handed to the child. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** The argv prefix of this Collie's CLI. {@link collieSelfCommand} unless a test fakes it. */
  readonly self?: readonly string[];
  /** Start the child. Bun's spawn unless a test fakes it. */
  readonly spawn?: (argv: readonly string[], env: Record<string, string>) => SkillSyncChild;
  readonly timeoutMs?: number;
}

function bunSpawn(argv: readonly string[], env: Record<string, string>): SkillSyncChild {
  const child = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    exited: child.exited,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    kill: () => child.kill(),
  };
}

/** The child's environment: the bridge's own, with the state dir it runs on. Nothing else is added. */
function childEnv(deps: SkillFollowDeps) {
  const own = Object.entries(deps.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { ...Object.fromEntries(own), COLLIE_STATE_DIR: deps.stateDir };
}

/** Run one `skill sync --json` and say what it did in one line. Never throws. */
export async function runSkillSync(deps: SkillFollowDeps, on: boolean): Promise<void> {
  const why = `the Hill was switched ${on ? "on" : "off"}`;
  const argv = [...(deps.self ?? collieSelfCommand()), "skill", "sync", "--json"];
  let child: SkillSyncChild;
  try {
    child = (deps.spawn ?? bunSpawn)(argv, childEnv(deps));
  } catch (err) {
    deps.log(`[hill] ${why}, and the WalkyTalky skill sync did not start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, deps.timeoutMs ?? SKILL_FOLLOW_TIMEOUT_MS);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout, child.stderr]);
    const result = parseSyncResult(stdout);
    if (timedOut) return deps.log(`[hill] ${why}, and the WalkyTalky skill sync took longer than ${String((deps.timeoutMs ?? SKILL_FOLLOW_TIMEOUT_MS) / 1000)} s; run \`collie skill sync\``);
    if (code !== 0 || result === null) {
      const said = stderr.trim().split("\n").findLast((l) => l.trim() !== "") ?? (code !== 0 ? `it exited ${String(code)}` : "it printed no sync result");
      return deps.log(`[hill] ${why}, and the WalkyTalky skill sync failed: ${said}; run \`collie skill sync\``);
    }
    const changed = result.changed.map((c) => `${c.action} ${c.harness}`);
    const refused = result.refused.map((r) => `refused ${r.harness}: ${r.reason}`);
    deps.log(`[hill] ${why}; WalkyTalky skill sync: ${[...changed, ...refused].join(", ") || "nothing to change"}`);
  } catch (err) {
    deps.log(`[hill] ${why}, and the WalkyTalky skill sync failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bridge's follower for {@link setHillSwitch}: starts the sync and returns at once. One sync at a time;
 * changes while one runs fold into one more run, with the switch's value at that run's start.
 */
export function bridgeSkillFollower(deps: SkillFollowDeps): SwitchFollower & { readonly idle: () => Promise<void> } {
  let running: Promise<void> | null = null;
  let again: boolean | null = null;
  const loop = async (on: boolean): Promise<void> => {
    let next: boolean | null = on;
    // Ends when a pass finishes with no change queued; each pass is one bounded child, and only a person's
    // tap or the operator's verb queues one, so the loop never repeats a sync on its own.
    while (next !== null) {
      const value: boolean = next;
      again = null;
      await runSkillSync(deps, value);
      next = again;
    }
    running = null;
  };
  const follow = (on: boolean): void => {
    if (!skillSyncEnabled(deps.env.COLLIE_SKILL_SYNC)) {
      deps.log(`[hill] the Hill was switched ${on ? "on" : "off"}; COLLIE_SKILL_SYNC is off, so the WalkyTalky skill stays as it is (run \`collie skill sync\`)`);
      return;
    }
    if (running !== null) {
      again = on;
      return;
    }
    running = loop(on);
  };
  return Object.assign(follow, { idle: async () => (running === null ? undefined : running) });
}
