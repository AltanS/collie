#!/usr/bin/env bun
// Probe every journal adapter against the REAL logs on this machine.
//
// The unit tests pin each grammar against builders that mirror the on-disk shape; this answers the
// different question those can't — does the log actually exist where the adapter looks, and does a
// real one (with its unannounced version drift, its odd rows, its size) still parse? Run it after
// touching an adapter, and on any machine where a journal is unexpectedly empty:
//
//   bun scripts/journal-probe.ts
//
// It reads only, prints only counts and roles — never transcript content, so its output is safe to
// paste into an issue. A harness you don't have installed reports `no logs found`, which is not a
// failure: exit code is non-zero only when a log EXISTS and the adapter couldn't resolve or parse it.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../bridge/config.ts";
import { buildJournalRegistry } from "../bridge/journal/registry.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry } from "../bridge/journal/types.ts";

/**
 * Every `.jsonl` under `dir`, newest first.
 *
 * We try candidates in order rather than trusting the single newest, because the newest log is often
 * a dud through no fault of the adapter: a session someone opened and abandoned parses to zero turns
 * quite correctly (Codex writes a `session_meta` plus one injected `<environment_context>` turn, both
 * of which are meant to be dropped). Only "no candidate at all worked" is a real failure.
 */
async function logsNewestFirst(dir: string, depth = 4): Promise<string[]> {
  const found: { path: string; mtimeMs: number }[] = [];
  const walk = async (d: string, left: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (left > 0) await walk(p, left - 1);
      } else if (name.endsWith(".jsonl")) {
        found.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  };
  await walk(dir, depth);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

/** How many candidates to try before calling a harness unreadable. */
const MAX_CANDIDATES = 12;

/**
 * Rebuild the session ref Herdr would have reported for this log, per harness.
 *
 * This is the part worth probing: Claude scans flat project dirs, Codex walks date partitions, and
 * the Pi and OMP adapters resolve the reported path directly. Their differently-shaped filenames
 * exercise both id- and path-based refs.
 */
export function refFor(agent: string, path: string): AgentSessionRef | null {
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(file)?.[0];
  if (agent === "pi" || agent === "omp") return { kind: "path", value: path };
  return uuid ? { kind: "id", value: uuid } : null;
}

function summarise(entries: TranscriptEntry[]): string {
  const roles = new Map<string, number>();
  let parts = 0;
  let results = 0;
  for (const e of entries) {
    roles.set(e.role, (roles.get(e.role) ?? 0) + 1);
    for (const p of e.parts) {
      parts++;
      if (p.kind === "tool" && p.result !== undefined) results++;
    }
  }
  const byRole = [...roles].map(([r, n]) => `${r}:${n}`).join(" ");
  return `${entries.length} turns (${byRole}), ${parts} parts, ${results} tool results`;
}

async function probe(adapter: JournalAdapter, root: string): Promise<"ok" | "empty" | "fail"> {
  const label = adapter.agent.padEnd(7);
  const candidates = await logsNewestFirst(root);
  if (candidates.length === 0) {
    console.log(`${label} — no logs found under ${root} (harness not installed here?)`);
    return "empty";
  }

  let tried = 0;
  let lastProblem = "no candidate produced turns";
  for (const log of candidates.slice(0, MAX_CANDIDATES)) {
    const ref = refFor(adapter.agent, log);
    if (ref === null) {
      // Claude keeps subagent logs under `subagents/` with no uuid in the name — not a session, so
      // not something Herdr would ever name. Skip rather than fail.
      lastProblem = `no session ref derivable from ${log}`;
      continue;
    }
    tried++;

    const resolved = await adapter.source.resolve(ref);
    if (resolved === null) {
      lastProblem = `ref ${ref.kind}:${ref.value.slice(0, 60)} did not resolve`;
      continue;
    }

    const { text, complete } = await adapter.source.load(resolved);
    const entries = adapter.parse(text);
    if (entries.length === 0) {
      lastProblem = `resolved a log but parsed 0 turns from ${text.length} bytes`;
      continue;
    }

    const cursors = new Set(entries.map((e) => e.uuid));
    const dupes = entries.length - cursors.size;
    console.log(
      `${label} ✓ ${summarise(entries)}${complete ? "" : " [tail-clipped]"}` +
        `${dupes > 0 ? ` ⚠ ${dupes} duplicate cursors` : ""}`,
    );
    console.log(`${" ".repeat(9)}${resolved}  (candidate ${tried} of ${candidates.length})`);
    return "ok";
  }

  // Every candidate failed: either the logs moved, or a format drifted under the parser.
  console.log(`${label} ✗ ${tried} candidate(s) tried, none readable — last: ${lastProblem}`);
  return "fail";
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const registry = buildJournalRegistry(cfg.journalRoots);
  const roots = new Map<string, string>(Object.entries(cfg.journalRoots));

  console.log("journal adapters — probing real logs\n");
  const results = await Promise.all(
    Object.entries(registry).map(([agent, adapter]) => probe(adapter, roots.get(agent) ?? "")),
  );
  const failed = results.filter((result) => result === "fail").length;
  const ok = results.filter((result) => result === "ok").length;
  console.log(`\n${ok} ok, ${results.length - ok - failed} with no logs, ${failed} failed`);
  return failed;
}

if (import.meta.main) process.exit(await main());
