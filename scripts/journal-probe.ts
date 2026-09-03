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
//
// SECOND SECTION: BEACON MODE (M11/04). The first section asks "can each adapter read this machine's
// logs at all", walking the roots itself. The beacon section asks the question the operator actually
// has when history is missing on tmux or zellij — "does the session ref MY AGENT NAMED resolve to a
// real, parseable log here?" — by taking the refs out of the beacon directory and handing each to the
// journal registry exactly as the history route does. Same read-only promise, same counts-not-content
// output; the ref's kind and a short prefix of its value are printed, never a turn of a transcript.

import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { beaconReader } from "../bridge/beacon-io.ts";
import { identityOf } from "../bridge/beacon/decorate.ts";
import { beaconsDir } from "../bridge/beacon/paths.ts";
import { readBeacons } from "../bridge/beacon/reader.ts";
import { loadConfig } from "../bridge/config.ts";
import { isGrokSessionId } from "../bridge/journal/grok.ts";
import { adapterFor, buildJournalRegistry } from "../bridge/journal/registry.ts";
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
  return found.toSorted((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

/** How many candidates to try before calling a harness unreadable. */
const MAX_CANDIDATES = 12;

/**
 * Rebuild the session ref Herdr would have reported for this log, per harness.
 *
 * This is the part worth probing: each adapter's resolve() is a different strategy (Claude scans flat
 * project dirs, Codex walks date partitions, pi takes the path straight, Grok names the session
 * directory and keeps a fixed `chat_history.jsonl`), and each derives from a differently-shaped path.
 *
 * Exported so the Grok parent-dir case has a regression test — a filename-only UUID walk reports
 * "no logs found" for every real Grok session.
 */
export function refFor(agent: string, path: string): AgentSessionRef | null {
  if (agent === "pi") return { kind: "path", value: path };
  if (agent === "grok") {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return null;
    const dir = path.slice(0, slash);
    const id = dir.slice(dir.lastIndexOf("/") + 1);
    return isGrokSessionId(id) ? { kind: "id", value: id } : null;
  }
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(file)?.[0];
  return uuid ? { kind: "id", value: uuid } : null;
}

/**
 * Candidate session refs for one harness, newest first.
 *
 * Three shapes of storage, so three strategies: the file-backed harnesses that name sessions in
 * `.jsonl` FILENAMES (claude/codex/pi), Grok which uses a fixed `chat_history.jsonl` under a
 * session-uuid directory, and OpenCode which has no per-session file at all — its sessions are rows
 * in `<root>/opencode.db`, which no amount of directory walking will find. All branches stay
 * read-only and content-free, as this script's header promises: the sqlite branch selects ids only.
 */
async function candidateRefs(
  agent: string,
  root: string,
): Promise<{ refs: AgentSessionRef[]; total: number }> {
  // One root per call, capped per root. A harness can have several roots (one per profile home —
  // see config.ts) and `probe` walks them SEPARATELY: flattening them into one capped, newest-first
  // list let a populated healthy first root starve the second one out of the list entirely — the
  // exact "root whose logs the adapter can't read" condition this script exists to catch.
  const { refs, total } = await candidateRefsUnder(agent, root);
  return { refs: refs.slice(0, MAX_CANDIDATES), total };
}

async function candidateRefsUnder(
  agent: string,
  root: string,
): Promise<{ refs: AgentSessionRef[]; total: number }> {
  if (agent === "opencode") {
    let db: Database;
    try {
      db = new Database(join(root, "opencode.db"), { readonly: true });
    } catch {
      return { refs: [], total: 0 };
    }
    try {
      // Root sessions only — a `parent_id` row is a subagent session, which herdr never reports.
      const rows = db
        .query<{ id: string }, [number]>(
          "select id from session where parent_id is null order by time_updated desc limit ?",
        )
        .all(MAX_CANDIDATES);
      const refs: AgentSessionRef[] = rows.map((r) => ({ kind: "id", value: r.id }));
      return { refs, total: refs.length };
    } catch {
      return { refs: [], total: 0 };
    } finally {
      db.close();
    }
  }

  const logs = await logsNewestFirst(root);
  const refs: AgentSessionRef[] = [];
  for (const log of logs.slice(0, MAX_CANDIDATES)) {
    // Claude keeps subagent logs under `subagents/` with no uuid in the name — not a session, so not
    // something Herdr would ever name. Skip rather than fail.
    const ref = refFor(agent, log);
    if (ref !== null) refs.push(ref);
  }
  return { refs, total: logs.length };
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

async function probeRoot(
  adapter: JournalAdapter,
  label: string,
  root: string,
  refs: AgentSessionRef[],
  total: number,
): Promise<boolean> {
  let tried = 0;
  let lastProblem = "no candidate produced turns";
  for (const ref of refs) {
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
    console.log(`${" ".repeat(10)}${resolved}  (candidate ${tried} of ${total})`);
    return true;
  }

  // Every candidate under this root failed: the logs moved, or a format drifted under the parser.
  console.log(`${label} ✗ ${tried} candidate(s) tried under ${root}, none readable — last: ${lastProblem}`);
  return false;
}

async function probe(adapter: JournalAdapter, roots: readonly string[]): Promise<"ok" | "empty" | "fail"> {
  const label = adapter.agent.padEnd(8);
  // Every POPULATED root must produce a readable log — one healthy root must never vouch for a
  // broken sibling. Roots with no candidates at all are simply not installed there.
  let populated = 0;
  let failed = 0;
  for (const root of roots) {
    const { refs, total } = await candidateRefs(adapter.agent, root);
    if (refs.length === 0) continue;
    populated++;
    if (!(await probeRoot(adapter, label, root, refs, total))) failed++;
  }
  if (populated === 0) {
    console.log(`${label} — no logs found under ${roots.join(", ")} (harness not installed here?)`);
    return "empty";
  }
  return failed === 0 ? "ok" : "fail";
}

// ── Beacon mode ───────────────────────────────────────────────────────────────

/** What one beacon's ref did when the journal registry was asked to read it. */
type BeaconOutcome = "parsed" | "empty" | "unresolved" | "no-adapter" | "unnamed";

/** How much of a session ref is printed. Enough to recognise, short enough to stay a label. */
const REF_PREVIEW_CHARS = 12;

/**
 * One beacon's ref, run through the SAME two calls the history route makes.
 *
 * `identityOf` rather than a re-read of the record's own fields, so the harness name is normalised
 * here exactly as the decorator normalises it (M11/03) — a probe that accepted a name the decorator
 * rejects would report history the bridge could never serve. Nothing in this function writes, and
 * nothing it prints comes out of a transcript.
 */
async function probeBeaconRef(
  reading: Awaited<ReturnType<typeof readBeacons>>[number],
  registry: Record<string, JournalAdapter>,
): Promise<BeaconOutcome> {
  const label = `${reading.key}  ${reading.liveness.padEnd(7)}`;
  const identity = identityOf(reading);
  if (identity === null) {
    console.log(`${label} ✗ harness "${reading.harness.slice(0, REF_PREVIEW_CHARS)}…" is not a name Collie will carry`);
    return "unnamed";
  }

  const ref = identity.session;
  const preview = `${ref.kind}:${ref.value.slice(0, REF_PREVIEW_CHARS)}`;
  const adapter = adapterFor(registry, identity.agent);
  if (adapter === undefined) {
    // An ordinary `no-session`, not a failure: a harness may be registered for identity and have no
    // journal adapter at all, and the route already reports that as "no history here".
    console.log(`${label} — ${identity.agent} ${preview}: no journal adapter (no-session)`);
    return "no-adapter";
  }

  // The ONLY path this script takes to a beacon's file, and it is the adapter's own: an `id` is
  // pattern-checked and then built into a path inside a configured root, a `path` is confined by
  // `containedRealpathIn`. The probe adds no branch of its own, so it can never read something the
  // bridge would refuse.
  const resolved = await adapter.source.resolve(ref);
  if (resolved === null) {
    console.log(`${label} — ${identity.agent} ${preview}: did not resolve (log deleted, or another profile's root)`);
    return "unresolved";
  }

  const { text, complete } = await adapter.source.load(resolved);
  const entries = adapter.parse(text);
  if (entries.length === 0) {
    console.log(`${label} ✗ ${identity.agent} ${preview}: resolved a log but parsed 0 turns from ${text.length} bytes`);
    return "empty";
  }
  console.log(`${label} ✓ ${identity.agent} ${preview}: ${summarise(entries)}${complete ? "" : " [tail-clipped]"}`);
  return "parsed";
}

/**
 * Every beacon on this machine, resolved against the journal registry.
 *
 * Exit status is deliberately narrow. A beacon that DID resolve and parsed nothing is drift — the
 * same failure the adapter section reports — so it fails. A beacon that did not resolve is not:
 * `/clear`, a deleted log and a profile whose root this build was not configured with all land there,
 * and every one of them is an honest `no-session` rather than a broken parser.
 */
async function probeBeacons(registry: Record<string, JournalAdapter>, stateDir: string): Promise<number> {
  const dir = beaconsDir(stateDir);
  console.log(`\nbeacons — resolving the session refs agents named (${dir})\n`);
  const readings = await readBeacons(beaconReader(stateDir));
  if (readings.length === 0) {
    console.log("          no beacons here (hooks not installed, or no agent has run in a pane since)");
    return 0;
  }
  const outcomes: BeaconOutcome[] = [];
  for (const reading of readings) outcomes.push(await probeBeaconRef(reading, registry));
  const count = (kind: BeaconOutcome) => outcomes.filter((o) => o === kind).length;
  console.log(
    `\n${readings.length} beacon(s): ${count("parsed")} parsed, ${count("unresolved")} unresolved, ` +
      `${count("no-adapter")} without an adapter, ${count("empty") + count("unnamed")} failed`,
  );
  return count("empty") + count("unnamed");
}

// Guarded so `journal-probe.test.ts` can import `refFor` above with no side effects: unguarded,
// this whole probe (and its `process.exit`) ran at import time, which killed the combined
// `bun test ./bridge ./cli ./scripts` run mid-suite before it ever printed a summary.
if (import.meta.main) {
  const cfg = loadConfig();
  const registry = buildJournalRegistry(cfg.journalRoots);
  // Keyed lookup rather than a cast: JournalRoots is a closed shape on purpose (adding a harness
  // should be a type error here until its root is wired), so widen it explicitly.
  const roots = new Map<string, readonly string[]>(Object.entries(cfg.journalRoots));

  console.log("journal adapters — probing real logs\n");
  const results = await Promise.all(
    Object.entries(registry).map(([agent, adapter]) => probe(adapter, roots.get(agent) ?? [])),
  );
  const failed = results.filter((r) => r === "fail").length;
  const ok = results.filter((r) => r === "ok").length;
  console.log(`\n${ok} ok, ${results.length - ok - failed} with no logs, ${failed} failed`);

  const beaconFailures = await probeBeacons(registry, cfg.stateDir);
  process.exit(failed + beaconFailures > 0 ? 1 : 0);
}
