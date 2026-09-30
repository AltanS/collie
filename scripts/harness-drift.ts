#!/usr/bin/env bun
// harness-drift — compares each ledger agent's INSTALLED CLI version against the version Collie's
// readers were last verified on (`web/src/lib/harness/verified-versions.json`, M37 spec 01).
//
// 2026-09-26: Claude Code 2.1.283 and Codex 0.156.1 both broke dialog reading the same day they
// updated, and every test stayed green because they run on frozen captures only. This is the
// mechanical half of the fix — the ledger says what was verified, this prints what has moved.
//
// ONE ROW PER READER, not per agent (M41 spec 05). An agent has up to two readers of two different
// things: the SCREEN grammar under `web/src/lib/harness/`, and the JOURNAL grammar under
// `bridge/journal/` that Chat draws from. A vendor can change what it paints without changing what it
// writes, or the other way about, so the two are verified apart and drift apart — one row could only
// have reported one of them, and a `same` on the screen reader says nothing about Chat.
//
//   bun scripts/harness-drift.ts               table, one row per ledger reader, exit 0 always
//   bun scripts/harness-drift.ts --json         the same rows as JSON
//   bun scripts/harness-drift.ts --strict       exit 1 when any installed agent reads NEWER
//   bun scripts/harness-drift.ts --agent a,b    only these ledger agents
//
// READ-ONLY. The only process this script starts is `<agent> --version`, bounded at
// {@link VERSION_TIMEOUT_MS}. It opens no Herdr session, sends no keystroke, and runs no `collie`
// verb — an agent absent from PATH just reads "not installed".

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type How = "canary" | "live sweep" | "capture" | "unverified";

/** One reader's line: the same three facts about a different grammar. */
interface ReaderLine {
  version: string;
  verified: string;
  how: How;
  evidence: string;
}

interface LedgerEntry extends ReaderLine {
  adapter: boolean;
  /** The journal reader's line, present exactly where this build can read that agent's log. */
  journal?: ReaderLine;
}

interface Ledger {
  agents: Record<string, LedgerEntry>;
}

export type DriftState = "same" | "NEWER, run the canary" | "older" | "not installed";

/** Which grammar a row is about: the pane mirror, or the agent's own session log. */
export type Reader = "screen" | "journal";

export interface DriftRow {
  agent: string;
  reader: Reader;
  installed: string | null;
  verified: string;
  state: DriftState;
}

/** A `--version` probe must never leave this script hanging on a broken or interactive binary. */
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /\d+\.\d+\.\d+/;

const LEDGER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web",
  "src",
  "lib",
  "harness",
  "verified-versions.json",
);

export function loadLedger(path: string = LEDGER_PATH): Ledger {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  // SAFETY: `verified-versions.json` is a checked-in, hand-authored file whose shape is pinned by
  // `verified-versions.test.ts` (every registered adapter plus pi and hermes, a `journal` block for
  // every journal adapter, `how` in the allowed set, plain `x.y.z` versions, ISO dates) — this
  // script does not itself validate the shape.
  return parsed as Ledger;
}

/**
 * `<agent> --version`, bounded at {@link VERSION_TIMEOUT_MS}. Null when the binary is not on PATH,
 * the probe times out, or neither stream carries a plain `x.y.z` — any of which reads as
 * "not installed" to the caller, since none of them is a version this script can compare against.
 */
export function installedVersion(agent: string): string | null {
  const bin = Bun.which(agent);
  if (bin === null) return null;
  try {
    const result = Bun.spawnSync([bin, "--version"], {
      timeout: VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.exitedDueToTimeout) return null;
    const text = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    return VERSION_PATTERN.exec(text)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Numeric, per-segment compare of two plain `x.y.z` strings. Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const width = Math.max(pa.length, pb.length);
  for (let i = 0; i < width; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function driftState(installed: string | null, verified: string): DriftState {
  if (installed === null) return "not installed";
  const cmp = compareVersions(installed, verified);
  if (cmp === 0) return "same";
  return cmp > 0 ? "NEWER, run the canary" : "older";
}

/**
 * The rows for one ledger entry: the screen reader's, then the journal reader's where it has one.
 *
 * The `--version` probe runs ONCE per agent however many readers it has — it starts a process, and
 * two rows about one binary must not disagree about what is installed.
 */
export function driftRows(
  agent: string,
  entry: LedgerEntry,
  probe: (agent: string) => string | null = installedVersion,
): DriftRow[] {
  const installed = probe(agent);
  const row = (reader: Reader, line: ReaderLine): DriftRow => ({
    agent,
    reader,
    installed,
    verified: line.version,
    state: driftState(installed, line.version),
  });
  const rows = [row("screen", entry)];
  if (entry.journal !== undefined) rows.push(row("journal", entry.journal));
  return rows;
}

interface Args {
  json: boolean;
  strict: boolean;
  agents: string[] | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const json = argv.includes("--json");
  const strict = argv.includes("--strict");
  const at = argv.indexOf("--agent");
  const agents =
    at === -1
      ? null
      : (argv[at + 1] ?? "")
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0);
  return { json, strict, agents };
}

function printTable(rows: readonly DriftRow[]): void {
  const agentWidth = Math.max(5, ...rows.map((r) => r.agent.length));
  const readerWidth = Math.max(6, ...rows.map((r) => r.reader.length));
  const installedWidth = Math.max(9, ...rows.map((r) => (r.installed ?? "—").length));
  const verifiedWidth = Math.max(8, ...rows.map((r) => r.verified.length));
  console.log(
    `${"agent".padEnd(agentWidth)}  ${"reader".padEnd(readerWidth)}  ${"installed".padEnd(installedWidth)}  ${"verified".padEnd(verifiedWidth)}  state`,
  );
  for (const row of rows) {
    console.log(
      `${row.agent.padEnd(agentWidth)}  ${row.reader.padEnd(readerWidth)}  ${(row.installed ?? "—").padEnd(installedWidth)}  ${row.verified.padEnd(verifiedWidth)}  ${row.state}`,
    );
  }
}

export function selectRows(ledger: Ledger, agents: string[] | null): DriftRow[] {
  const wanted = agents ?? Object.keys(ledger.agents);
  const rows: DriftRow[] = [];
  for (const agent of wanted) {
    const entry = Object.hasOwn(ledger.agents, agent) ? ledger.agents[agent] : undefined;
    if (entry === undefined) {
      console.error(`harness-drift: "${agent}" is not in the ledger (web/src/lib/harness/verified-versions.json)`);
      process.exit(1);
    }
    for (const row of driftRows(agent, entry)) rows.push(row);
  }
  return rows;
}

function main(argv: readonly string[]): void {
  const { json, strict, agents } = parseArgs(argv);
  const ledger = loadLedger();
  const rows = selectRows(ledger, agents);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }

  if (strict && rows.some((r) => r.state === "NEWER, run the canary")) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
