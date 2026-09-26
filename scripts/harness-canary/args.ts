// Command-line options of `bun run canary`. Pure, so the parse is unit-tested.

import { resolve } from "node:path";
import { SCENARIOS, isScenarioId, type ScenarioId } from "./verdict";

export const CANARY_AGENTS = ["claude", "codex", "opencode", "pi"] as const;
export type CanaryAgent = (typeof CANARY_AGENTS)[number];

export function isCanaryAgent(value: string): value is CanaryAgent {
  return CANARY_AGENTS.some((a) => a === value);
}

export interface CanaryOptions {
  readonly agents: readonly CanaryAgent[];
  readonly scenarios: readonly ScenarioId[];
  /** Terminal width for scenarios 1, 2, 3 and 5, or null for the pane's own width (119 columns in a
   *  headless Herdr session). Scenario 4 always runs at {@link NARROW_COLS}. */
  readonly cols: number | null;
  /** Leave the Herdr session and the project up after the run, for a look. */
  readonly keep: boolean;
  /** Write each clean agent's version into the ledger (spec M37/01). */
  readonly record: boolean;
  /** The Collie checkout whose web/src/lib readers and reply action the canary judges with. */
  readonly readers: string;
  /** Where the run's captures and summary.json go; the run id is a directory below it. */
  readonly out: string;
  /** The ledger `--record` writes; a test points it at a copy. */
  readonly ledger: string | null;
}

export const NARROW_COLS = 50;
/** The widest `--cols` that fits: a headless Herdr pane is 119 columns, and a wider `stty` wraps
 *  every full-width row the agent paints. */
export const MAX_COLS = 119;
export const DEFAULT_OUT = "/tmp/collie-canary";

export const USAGE = `Usage: bun run canary [options]

Drives claude, codex, opencode and pi in a Herdr session of its own (collie-canary) and judges each
screen and send with Collie's own readers. See scripts/harness-canary/README.md.

  --agent a,b        agents to run (default: ${CANARY_AGENTS.join(",")})
  --scenario a,b     scenarios to run (default: ${SCENARIOS.join(",")})
  --cols N           terminal width for the wide scenarios, 40 to ${MAX_COLS} (default: the pane's own)
  --keep             leave the collie-canary session and the project up after the run
  --record           after a run with no fail, write each agent's version into the ledger
  --ledger PATH      the ledger --record writes (default: web/src/lib/harness/verified-versions.json)
  --readers PATH     judge with the web/src/lib readers of another Collie checkout (a worktree)
  --out DIR          where captures and summary.json go (default: ${DEFAULT_OUT})
  -h, --help         print this`;

/** Parse argv (without the runtime and script). Throws a one-line message on anything unknown. */
export function parseArgs(argv: readonly string[], repoRoot: string): CanaryOptions | "help" {
  let agents: CanaryAgent[] = [...CANARY_AGENTS];
  let scenarios: ScenarioId[] = [...SCENARIOS];
  let cols: number | null = null;
  let keep = false;
  let record = false;
  let readers = repoRoot;
  let out = DEFAULT_OUT;
  let ledger: string | null = null;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--agent":
        agents = value(i, arg).split(",").map((a) => {
          if (!isCanaryAgent(a)) throw new Error(`unknown agent "${a}" (known: ${CANARY_AGENTS.join(", ")})`);
          return a;
        });
        i++;
        break;
      case "--scenario":
        scenarios = value(i, arg).split(",").map((s) => {
          if (!isScenarioId(s)) throw new Error(`unknown scenario "${s}" (known: ${SCENARIOS.join(", ")})`);
          return s;
        });
        i++;
        break;
      case "--cols": {
        const n = Number(value(i, arg));
        if (!Number.isInteger(n) || n < 40 || n > MAX_COLS) throw new Error(`--cols takes a width from 40 to ${MAX_COLS}`);
        cols = n;
        i++;
        break;
      }
      case "--keep":
        keep = true;
        break;
      case "--record":
        record = true;
        break;
      case "--ledger":
        ledger = resolve(value(i, arg));
        i++;
        break;
      case "--readers":
        readers = resolve(value(i, arg));
        i++;
        break;
      case "--out":
        out = resolve(value(i, arg));
        i++;
        break;
      default:
        throw new Error(`unknown option "${arg}"`);
    }
  }
  if (agents.length === 0) throw new Error("--agent names no agent");
  return { agents, scenarios, cols, keep, record, readers, out, ledger };
}
