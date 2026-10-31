#!/usr/bin/env bun
// The nightly harness lab (M56 spec 10). See cli.ts for the options and README.md in the folder above
// for what one run costs and what stops it from running a version twice.
//
//   bun scripts/harness-canary/lab/main.ts --plan                 what would run
//   bun scripts/harness-canary/lab/main.ts                        run each new version once
//   bun scripts/harness-canary/lab/main.ts --version claude=2.1.301
//
// The ritual `nightly-harness-lab` never opens an issue. A person may pass --open-issue on a hand run.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exitCodeOf, fileNotify, parseCli, repoProblem, runCandidates, stateDirOf, summaryLine, sweepAtStart, USAGE, pending, type Candidate } from "./cli";
import { FEEDS, readFeed } from "./feeds";
import { realPorts } from "./ports";
import { findRow, loadLedger, shouldRun } from "./lab-ledger";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main(): Promise<number> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2), repoRoot);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (cli === "help") {
    console.log(USAGE);
    return 0;
  }

  // Before any plan or run: a night with nothing to run still cleans up what an earlier run left.
  for (const line of await sweepAtStart(cli)) console.log(line);

  if (!cli.plan) {
    const problem = repoProblem(cli.repo);
    if (problem !== null) {
      console.error(problem);
      return 2;
    }
  }

  const candidates: Candidate[] = cli.pairs.map((pair) => ({ ...pair, source: "named on the command line", named: true }));
  let feedErrors = 0;
  if (cli.pairs.length === 0) {
    for (const harness of cli.harnesses) {
      const feed = FEEDS[harness];
      if (feed === undefined) continue;
      try {
        candidates.push(...(await readFeed(harness, feed)));
      } catch (err) {
        feedErrors++;
        console.error(`feed ${harness}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (cli.plan) {
    const ledger = loadLedger(cli.ledger, Date.now());
    for (const candidate of candidates) {
      const row = findRow(ledger, candidate.harness, candidate.version);
      const runs = shouldRun(ledger, candidate.harness, candidate.version, candidate.named === true);
      console.log(`${candidate.harness} ${candidate.version}: ${row === undefined ? "would run" : runs ? `would run again, ledger says ${row.result} on ${row.date}` : `skip, ledger says ${row.result} on ${row.date}`}  (${candidate.source})`);
    }
    const next = pending(candidates, cli.ledger, Date.now(), cli.maxRuns);
    console.log(`plan: ${String(next.length)} pairs would run in a throwaway tmux and an isolated config dir; nothing was run`);
    return feedErrors > 0 && candidates.length === 0 ? 1 : 0;
  }

  const report = await runCandidates(candidates, cli, realPorts(), fileNotify(stateDirOf(cli.ledger)));
  for (const outcome of report.outcomes) console.log(summaryLine(outcome));
  if (report.outcomes.length === 0) console.log("nothing to run: every version the feeds name is in the ledger");
  return Math.max(exitCodeOf(report.outcomes), feedErrors > 0 && candidates.length === 0 ? 1 : 0);
}

process.exit(await main());
