#!/usr/bin/env bun
// The version-change trigger (M44 spec 06, carried by M56 spec 10). It compares each installed agent
// with the verified-versions ledger. For an agent that is NEWER, it runs the lab on the installed
// version: the same lab, the same one-run-per-version ledger and the same pass and fail ends as the
// nightly feed run (lab/main.ts). NOTHING SCHEDULES THIS SCRIPT. The ritual `nightly-harness-lab` runs
// lab/main.ts, and no systemd unit is made here. A person runs this one by hand, for example after
// a Claude update, when the feed has not named the new version yet. The two share one ledger, so
// they never run the same version twice.
//
//   bun scripts/harness-canary/watch.ts --dry-run --fake-version claude=99.0.0
//   bun scripts/harness-canary/watch.ts
//
// --fake-version h=x.y.z       pretend the installed binary prints that version. Needs --dry-run.
// --dry-run                    print what would run and run nothing.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareVersions, driftState, installedVersion, loadLedger as loadVerified } from "../harness-drift";
import { exitCodeOf, fileNotify, parseCli, pending, repoProblem, runCandidates, stateDirOf, summaryLine, sweepAtStart, USAGE, type Candidate, type CliOptions } from "./lab/cli";
import { HARNESSES } from "./lab/harnesses";
import { realPorts } from "./lab/ports";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The agents whose installed version is newer than the verified-versions ledger, as lab candidates. */
export function newerThanLedger(cli: CliOptions, installed: (agent: string) => string | null = installedVersion, ledgerFile?: string): Candidate[] {
  const verified = ledgerFile === undefined ? loadVerified() : loadVerified(ledgerFile);
  const out: Candidate[] = [];
  for (const [agent, entry] of Object.entries(verified.agents)) {
    if (HARNESSES[agent] === undefined) continue;
    const fake = cli.fakeVersions.find((pair) => pair.harness === agent)?.version;
    const version = fake ?? installed(agent);
    if (version === null) continue;
    if (driftState(version, entry.version) !== "NEWER, run the canary") continue;
    if (compareVersions(version, entry.version) <= 0) continue;
    out.push({ harness: agent, version, source: `installed ${agent} prints ${version}, the ledger says ${entry.version}` });
  }
  return out;
}

async function main(): Promise<number> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2), repoRoot);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (cli === "help") {
    console.log(USAGE.replace("bun scripts/harness-canary/lab/main.ts", "bun scripts/harness-canary/watch.ts"));
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
  const candidates = newerThanLedger(cli);
  if (cli.plan) {
    for (const candidate of candidates) console.log(`would run the lab for ${candidate.harness} ${candidate.version} in a throwaway tmux and a throwaway config dir (${candidate.source})`);
    console.log(`plan: ${String(pending(candidates, cli.ledger, Date.now(), cli.maxRuns).length)} pairs would run; nothing was run`);
    return 0;
  }
  const report = await runCandidates(candidates, cli, realPorts(), fileNotify(stateDirOf(cli.ledger)));
  for (const outcome of report.outcomes) console.log(summaryLine(outcome));
  if (report.outcomes.length === 0) console.log("nothing to run: no installed agent is newer than the ledger, or the lab ledger already has the pair");
  return exitCodeOf(report.outcomes);
}

if (import.meta.main) process.exit(await main());
