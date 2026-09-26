#!/usr/bin/env bun
// `bun run canary`: drive claude, codex, opencode and pi in a Herdr session of the canary's own and
// judge what the phone would read and whether a send lands, with Collie's own code. Spec M37/02;
// the how and the traps are in ./README.md.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE, parseArgs, type CanaryAgent, type CanaryOptions } from "./args";
import { claude } from "./agents/claude";
import { codex } from "./agents/codex";
import { opencode } from "./agents/opencode";
import { pi } from "./agents/pi";
import type { AgentProfile } from "./agents/profile";
import { CANARY_SESSION, CanarySession, listSessions } from "./herdr";
import { loadKnownGaps } from "./known-gaps";
import { LEDGER_FILE, recordVerified } from "./ledger";
import { loadReaders } from "./readers";
import { runAgent } from "./scenarios";
import { installTransport } from "./transport";
import { applyKnownGaps, exitCode, notReachedCase, recordable, renderTable, scenarioResult, type ScenarioResult } from "./verdict";

const PROFILES = { claude, codex, opencode, pi } satisfies Record<CanaryAgent, AgentProfile>;
const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

function log(line: string): void {
  console.log(line);
}

/** The installed version: the first x.y.z the version command prints, or null when it will not run. */
function installedVersion(profile: AgentProfile): string | null {
  try {
    const r = Bun.spawnSync([...profile.versionCommand], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    return /\d+\.\d+\.\d+/.exec(`${r.stdout.toString()} ${r.stderr.toString()}`)?.[0] ?? null;
  } catch {
    return null;
  }
}

function runId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * A fresh git project for the agents to start in. One commit, so every agent sees a real repo.
 *
 * The PATH is fixed, the contents are fresh: Claude and Codex remember folder trust per path in the
 * user's own config (`~/.claude.json`, `~/.codex/config.toml`), so a new random folder per run left
 * one more entry there every run. One path keeps that to one entry per agent. Two runs cannot share
 * it, because the canary refuses to start while its Herdr session exists.
 */
function freshProject(): string {
  const dir = join(tmpdir(), "collie-canary-project");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  writeFileSync(join(dir, "README.md"), "# canary\n\nA scratch project the Collie canary starts agents in.\n");
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=collie-canary", "-c", "user.email=canary@invalid", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  git("init", "-q");
  git("add", "README.md");
  git("commit", "-q", "-m", "canary");
  return dir;
}

async function main(options: CanaryOptions): Promise<number> {
  const gaps = loadKnownGaps();
  const started = new Date();
  const id = runId(started);
  const runDir = join(options.out, id);
  mkdirSync(runDir, { recursive: true });
  log(`canary ${id}: agents ${options.agents.join(",")}; readers ${options.readers}`);

  const project = freshProject();
  let session: CanarySession | null = null;
  let tornDown = false;
  const teardown = (): string[] => {
    if (tornDown) return [];
    tornDown = true;
    if (options.keep) {
      log(`--keep: session ${CANARY_SESSION} and ${project} are still up. Remove them with:`);
      log(`  herdr session stop ${CANARY_SESSION}; herdr session delete ${CANARY_SESSION}; rm -rf ${project}`);
      return [];
    }
    const problems = session?.teardown() ?? [];
    rmSync(project, { recursive: true, force: true });
    return problems;
  };
  const onSignal = (signal: string) => {
    log(`\n${signal}: tearing down`);
    for (const p of teardown()) log(`  teardown: ${p}`);
    process.exit(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGHUP", () => onSignal("SIGHUP"));

  const versions = new Map<string, string>();
  const results: ScenarioResult[] = [];
  let audit: readonly string[] = [];
  let adapters = new Map<string, boolean>();
  try {
    session = await CanarySession.start();
    const transport = installTransport(session, join(project, ".collie-home-unused"));
    audit = transport.audit;
    const readers = await loadReaders(options.readers);
    adapters = new Map(options.agents.map((a) => [a, readers.adapterFor(a) !== undefined]));
    for (const agent of options.agents) {
      const profile = PROFILES[agent];
      const version = installedVersion(profile);
      versions.set(agent, version ?? "not installed");
      log(`${agent} ${version ?? "(not installed)"}${adapters.get(agent) ? "" : ", no adapter: raw mirror, one-step send"}`);
      if (version === null) {
        for (const s of options.scenarios) results.push(scenarioResult(agent, s, [notReachedCase(agent, "not installed")]));
        continue;
      }
      const own = await runAgent({
        profile,
        version,
        session,
        transport,
        readers,
        options,
        project,
        dir: join(runDir, `${agent}-${version}`),
        log,
      });
      for (const r of own) {
        const judged = applyKnownGaps(r, gaps);
        results.push(judged);
        log(`  ${r.scenario}: ${judged.verdict} ${judged.detail}`);
      }
    }
  } finally {
    const problems = teardown();
    for (const p of problems) log(`teardown: ${p}`);
  }

  const summary = {
    run: id,
    started: started.toISOString(),
    finished: new Date().toISOString(),
    readers: options.readers,
    cols: options.cols,
    versions: Object.fromEntries(versions),
    results,
    audit,
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log("");
  log(renderTable(results, versions));
  log("");
  log(`captures and summary.json: ${runDir}`);

  if (!options.keep) {
    const left = listSessions().some((s) => s.name === CANARY_SESSION) || existsSync(project);
    log(left ? `teardown: NOT clean, check \`herdr session list\` and ${project}` : "teardown: clean (no canary session, no project dir)");
  }

  const code = exitCode(results);
  if (options.record) record(options, id, results, versions, adapters);
  return code;
}

function record(
  options: CanaryOptions,
  id: string,
  results: readonly ScenarioResult[],
  versions: ReadonlyMap<string, string>,
  adapters: ReadonlyMap<string, boolean>,
): void {
  if (options.readers !== REPO_ROOT) {
    log("--record: skipped, the readers came from another checkout");
    return;
  }
  const ledger = options.ledger ?? LEDGER_FILE;
  for (const agent of options.agents) {
    if (!recordable(agent, results)) {
      log(`--record: ${agent} not recorded (a fail in the run, or a scenario not reached)`);
      continue;
    }
    const passed = results.filter((r) => r.agent === agent && r.verdict === "pass").map((r) => r.scenario);
    recordVerified(
      {
        agent,
        version: versions.get(agent)!,
        verified: id.slice(0, 4) + "-" + id.slice(4, 6) + "-" + id.slice(6, 8),
        adapter: adapters.get(agent) ?? false,
        evidence: `canary run ${id}: ${passed.join(", ")} pass`,
      },
      ledger,
    );
    log(`--record: ${agent} ${versions.get(agent)} written to ${ledger}`);
  }
}

let parsed: CanaryOptions | "help";
try {
  parsed = parseArgs(process.argv.slice(2), REPO_ROOT);
} catch (err) {
  console.error(`canary: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed === "help") {
  console.log(USAGE);
  process.exit(0);
}
process.exit(await main(parsed));
