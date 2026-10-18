// After the last case: print the harness x scenario table from the run's ledger, write it beside the
// ledger, and bring the rig down (Herdr stops every pane with it, so every harness stops too).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { HARNESS_IDS, SETUPS } from "./harnesses";
import type { LedgerRow } from "./leg";
import { SCENARIOS, scenarioApplies, type Leg } from "./scenarios";
import { P } from "./rig-lib";

const WEB = resolve(import.meta.dirname, "..", "..");

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The harness x scenario table of one leg: a row for each case that leg runs, and only those. */
export function table(rows: readonly LedgerRow[], leg: Leg = "solo"): string {
  const head = ["harness", "scenario", "verdict", "taps", "note"];
  const body: string[][] = [];
  for (const harness of HARNESS_IDS) {
    for (const scenario of SCENARIOS) {
      if (!scenarioApplies(scenario, harness, leg)) continue;
      // The last row a case wrote for this cell wins: a case records once, a rerun appends.
      const row = rows.findLast((r) => r.harness === harness && r.scenario === scenario.id);
      body.push([harness, scenario.title, row?.verdict ?? "not reached", row?.taps === null || row?.taps === undefined ? "-" : row.minTaps === undefined ? String(row.taps) : `${String(row.taps)}/${String(row.minTaps)}`, row?.note ?? "the case did not run"]);
    }
  }
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => Math.min(r[i]!.length, i === 4 ? 200 : 40))));
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c, widths[i]!)).join(" | ")} |`;
  return [line(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...body.map(line)].join("\n");
}

/**
 * The provider key never belongs in evidence. With a key file set, a subshell that alone reads the
 * key scrubs it from every text file of this run, the rig's logs and Playwright's test results, and
 * drops a screenshot whose pane capture or page snapshot held it. Prints a count, never the key.
 */
const SCRUB = `
import os, pathlib, sys
key = os.environ.get(sys.argv[1], "").encode()
changed = 0
if len(key) >= 16:
    for root in sys.argv[2:]:
        for path in pathlib.Path(root).rglob("*"):
            if not path.is_file() or path.suffix == ".png":
                continue
            data = path.read_bytes()
            if key not in data:
                continue
            path.write_bytes(data.replace(key, b"[redacted key]"))
            changed += 1
            shots = path.parent.glob("*.png") if path.name == "error-context.md" else [path.with_suffix(".png")]
            for shot in shots:
                shot.unlink(missing_ok=True)
print(changed)
`;

function scrubKey(roots: readonly string[]): void {
  const file = process.env.COLLIE_RIG_KEY_FILE;
  const names = [...new Set(HARNESS_IDS.flatMap((id) => (SETUPS[id].keyEnv === null ? [] : [SETUPS[id].keyEnv])))];
  if (file === undefined || names.length === 0) return;
  for (const name of names) {
    const out = execFileSync("sh", ["-c", 'set -a; . "$1" >/dev/null 2>&1; set +a; shift; exec python3 -I -c "$0" "$@"', SCRUB, file, name, ...roots.filter((root) => existsSync(root))], { encoding: "utf8", timeout: 60_000 });
    const changed = out.trim();
    if (changed !== "0") console.log(`key scrub: ${name} found and redacted in ${changed} file(s)`);
  }
}

/**
 * The end of a run of one leg: scrub the key, print and write the table, bring the rig down. The solo
 * leg's teardown is this with `solo`; crew-teardown.ts calls it with `crew`, and `rig.ts down` then
 * stops the crew rig, because the crew leg's processes carry COLLIE_RIG_CREW (crew-env.ts).
 */
export async function finishRun(leg: Leg): Promise<void> {
  const id = process.env.COLLIE_RIG_RUN_ID ?? "adhoc";
  const ledger = join(P.results, id, "ledger.jsonl");
  const rows: LedgerRow[] = existsSync(ledger)
    ? readFileSync(ledger, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line): LedgerRow => JSON.parse(line))
    : [];
  scrubKey([join(P.results, id), P.logs, join(WEB, "e2e", "rig", "test-results")]);
  const text = table(rows, leg);
  writeFileSync(join(P.results, id, "table.md"), `${text}\n`);
  console.log(`\nBrowser leg${leg === "crew" ? " (crew)" : ""}, run ${id} (results in ${join(P.results, id)}):\n\n${text}\n`);
  if (process.env.COLLIE_RIG_KEEP === "1") return;
  execFileSync("bun", [join(WEB, "e2e", "rig", "rig.ts"), "down", ...(leg === "crew" ? ["--crew"] : [])], { cwd: WEB, stdio: "inherit", timeout: 90_000 });
}

export default async function globalTeardown(): Promise<void> {
  await finishRun("solo");
}
