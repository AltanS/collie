// THE PUSH GUARD FOR ASKS THAT TRAVEL AS DATA (ADR 0100, rule 5 and rule 6).
//
// A durable program raises its asks as data, and a program is less trusted than a terminal: one
// hostile or broken program could raise fifty asks in a second, or raise the same question again
// after every restart. A push crosses a third-party push service and buzzes a phone, so each ask
// goes through this guard before any push.
//
// ── THREE DECISIONS PER ASK ──────────────────────────────────────────────────
//   push        show the ask, and let the pane raise a push
//   show-quiet  show the ask, and push nothing
//   drop        do not list it yet: the pane already shows five, and `moreAsks` counts the rest
//
// ── ONE KEY: (host, toolCallId) ──────────────────────────────────────────────
// A program mints a new ask id after every restart, but the tool call id stays (WIRE.md section 8.4).
// So the guard remembers the tool call, not the ask: a re-asked question is the same key, and it is
// shown, never pushed again. The memory is a small file in the state dir, written before the push
// it allows, so a bridge restart pushes nothing twice.
//
// ── EACH KEY IS DECIDED ONCE ─────────────────────────────────────────────────
// The first time a key is seen, it is decided: push (inside both rates), show-quiet (a rate is
// spent) or drop (past the open cap). Only that first decision may push. Later sightings show it
// quietly, or drop it while it is past the cap, so an ask promoted into a free slot is shown and not
// pushed. The person is already answering the ones before it.
//
// ── THE CAPS ─────────────────────────────────────────────────────────────────
// 3 pushes per pane per minute, 10 per host per minute, 5 open asks shown per pane. The rates are
// counted from the remembered push times, so they hold across a bridge restart as well. A program
// sends its open asks oldest first (WIRE.md section 4), so the five shown are the five oldest, and a
// closed ask frees its slot for the next oldest. A key whose ask closed more than a day ago is
// forgotten.
//
// The decision is a pure function ({@link decideAsks}); the store around it only reads and writes the
// file. Ported from the durable-member spike's guard. The string caps that guard also held are the
// adapter's job now (WIRE.md section 6), so they are not repeated here.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { readGuardFile } from "./parse.ts";

/** What the guard says about one ask. */
export type GuardDecision = "push" | "show-quiet" | "drop";

export interface GuardLimits {
  readonly pushPerPaneMinute: number;
  readonly pushPerHostMinute: number;
  readonly openPerPane: number;
  /** How long a closed ask's key is kept, in ms. */
  readonly keepClosedMs: number;
  /** The most keys kept in all. Past it, the oldest closed ones go first. */
  readonly maxEntries: number;
}

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  pushPerPaneMinute: 3,
  pushPerHostMinute: 10,
  openPerPane: 5,
  keepClosedMs: 24 * 60 * 60 * 1000,
  maxEntries: 5000,
};

const MINUTE_MS = 60_000;

/** The file the guard keeps in the state dir. */
export const GUARD_FILE = "durable-asks.json";

/** What the guard reads of an ask. The wire ask (`Ask` in `bridge/types.ts`) has both fields. */
export interface GuardAsk {
  readonly id: string;
  readonly toolCallId: string;
}

/** One pane's open asks, oldest first. */
export interface GuardPane<A extends GuardAsk = GuardAsk> {
  readonly paneId: string;
  readonly asks: readonly A[];
}

/** One remembered tool call, keyed on `(host, toolCallId)`. */
export interface GuardEntry {
  readonly host: string;
  readonly toolCallId: string;
  /** The pane it was last seen on. */
  readonly paneId: string;
  /** The ask id it was last seen under. A restart changes it. */
  readonly askId: string;
  /** When it was first seen, which is when it was decided. */
  readonly firstSeenAt: number;
  /** When it was pushed. Absent when it never was, and never will be. */
  readonly pushedAt?: number;
  /** When it was last seen closed. Absent while it is open. */
  readonly closedAt?: number;
}

/** One ask's verdict. */
export interface GuardVerdict<A extends GuardAsk = GuardAsk> {
  readonly ask: A;
  readonly decision: GuardDecision;
  readonly why: "new" | "pane rate" | "host rate" | "known" | "over the open cap";
}

/** What one observation decided, and the memory after it. */
export interface GuardResult<A extends GuardAsk = GuardAsk> {
  /** Per pane id, one verdict per ask, in the pane's order. */
  readonly verdicts: ReadonlyMap<string, readonly GuardVerdict<A>[]>;
  readonly entries: readonly GuardEntry[];
  /** Whether {@link entries} differs from the input, so the store knows to write. */
  readonly changed: boolean;
}

function keyOf(host: string, toolCallId: string): string {
  return `${host}\n${toolCallId}`;
}

/**
 * The open cap: the asks a pane lists, and how many wait past it. The first {@link
 * GuardLimits.openPerPane} in the program's own order, which is oldest first, so a closed ask frees
 * its slot for the next oldest.
 */
export interface OpenCap<A> {
  readonly shown: A[];
  readonly more: number;
}

export function openCap<A>(asks: readonly A[], limits: GuardLimits = DEFAULT_GUARD_LIMITS): OpenCap<A> {
  const shown = asks.slice(0, limits.openPerPane);
  return { shown, more: asks.length - shown.length };
}

/** One tool call per pane: a second ask with the same tool call id is the same question. */
function uniqueByToolCall<A extends GuardAsk>(asks: readonly A[]): A[] {
  const seen = new Set<string>();
  return asks.filter((ask) => {
    if (seen.has(ask.toolCallId)) return false;
    seen.add(ask.toolCallId);
    return true;
  });
}

/**
 * Decide every ask of one host's panes, given what the guard remembers (pure, no clock, no disk).
 *
 * `panes` is every pane of `host` that carries asks as data, as seen now. A remembered key of this
 * host that is not open on any of them is marked closed, so it is forgotten a day later; a key that
 * comes back (a restart re-ask) is opened again and keeps its push time, so it is shown, not pushed.
 */
export function decideAsks<A extends GuardAsk>(
  remembered: readonly GuardEntry[],
  host: string,
  panes: readonly GuardPane<A>[],
  now: number,
  limits: GuardLimits = DEFAULT_GUARD_LIMITS,
): GuardResult<A> {
  const memory = new Map<string, GuardEntry>(remembered.map((entry) => [keyOf(entry.host, entry.toolCallId), entry]));
  const open = new Set<string>();
  const verdicts = new Map<string, GuardVerdict<A>[]>();
  let changed = false;

  /** Pushes this host made inside the last minute, on one pane or on all of them. */
  const recentPushes = (paneId: string | null): number => {
    let count = 0;
    for (const entry of memory.values()) {
      if (entry.host !== host || entry.pushedAt === undefined || now - entry.pushedAt >= MINUTE_MS) continue;
      if (paneId === null || entry.paneId === paneId) count += 1;
    }
    return count;
  };

  for (const pane of panes) {
    const list: GuardVerdict<A>[] = [];
    uniqueByToolCall(pane.asks).forEach((ask, index) => {
      const key = keyOf(host, ask.toolCallId);
      open.add(key);
      const known = memory.get(key);
      let verdict: GuardVerdict<A>;
      let pushedAt = known?.pushedAt;
      if (index >= limits.openPerPane) {
        verdict = { ask, decision: "drop", why: "over the open cap" };
      } else if (known !== undefined) {
        verdict = { ask, decision: "show-quiet", why: "known" };
      } else if (recentPushes(pane.paneId) >= limits.pushPerPaneMinute) {
        verdict = { ask, decision: "show-quiet", why: "pane rate" };
      } else if (recentPushes(null) >= limits.pushPerHostMinute) {
        verdict = { ask, decision: "show-quiet", why: "host rate" };
      } else {
        verdict = { ask, decision: "push", why: "new" };
        pushedAt = now;
      }
      list.push(verdict);
      let next: GuardEntry = { host, toolCallId: ask.toolCallId, paneId: pane.paneId, askId: ask.id, firstSeenAt: known?.firstSeenAt ?? now };
      if (pushedAt !== undefined) next = { ...next, pushedAt };
      if (known === undefined || known.paneId !== next.paneId || known.askId !== next.askId || known.closedAt !== undefined || known.pushedAt !== next.pushedAt) {
        memory.set(key, next);
        changed = true;
      }
    });
    verdicts.set(pane.paneId, list);
  }

  // Close what this host no longer shows open, then forget what closed long ago.
  for (const [key, entry] of memory) {
    if (entry.host === host && entry.closedAt === undefined && !open.has(key)) {
      memory.set(key, { ...entry, closedAt: now });
      changed = true;
    }
  }
  const pruned = prune([...memory.values()], now, limits);
  if (pruned.length !== memory.size) changed = true;
  return { verdicts, entries: pruned, changed };
}

/** Mark every open key of `host` closed: the host left, and nothing will report its asks again. */
export function closeHost(remembered: readonly GuardEntry[], host: string, now: number): GuardEntry[] {
  return remembered.map((entry) => (entry.host === host && entry.closedAt === undefined ? { ...entry, closedAt: now } : entry));
}

/** The order `prune` lets keys go in: closed before open, then by the time that put them there. */
function pruneOrder(entry: GuardEntry): [number, number] {
  return [entry.closedAt === undefined ? 1 : 0, entry.closedAt ?? entry.firstSeenAt];
}

/** Drop keys closed more than a day ago, then hold the total under the cap, oldest closed first. */
function prune(entries: GuardEntry[], now: number, limits: GuardLimits): GuardEntry[] {
  const kept = entries.filter((entry) => entry.closedAt === undefined || now - entry.closedAt <= limits.keepClosedMs);
  if (kept.length <= limits.maxEntries) return kept;
  // Closed before open, and among each, the oldest first: those are the ones to let go.
  const ranked = kept.toSorted((a, b) => {
    const [ga, ta] = pruneOrder(a);
    const [gb, tb] = pruneOrder(b);
    return ga - gb || ta - tb;
  });
  const drop = new Set(ranked.slice(0, kept.length - limits.maxEntries));
  return kept.filter((entry) => !drop.has(entry));
}

// ── The file ──────────────────────────────────────────────────────────────────

/**
 * The guard's memory, kept in `<stateDir>/durable-asks.json`.
 *
 * WRITTEN BEFORE THE PUSH IT ALLOWS, and written synchronously, so the decision and its record cannot
 * be split by a crash between two awaits. The file is small (one line per tool call, pruned daily)
 * and is written only when an observation changed it, which is when an ask opened or closed. A
 * bridge that never sees a durable pane never writes it. A write that fails is logged and the memory
 * stays in this process: the push still goes, and only the dedupe across a restart is lost.
 *
 * `stateDir` null keeps the memory in this process only, for a test or a server built by hand.
 */
export class AskGuardStore {
  private entries: GuardEntry[] = [];
  private readonly file: string | null;

  constructor(
    private readonly stateDir: string | null,
    private readonly limits: GuardLimits = DEFAULT_GUARD_LIMITS,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.file = stateDir === null ? null : join(stateDir, GUARD_FILE);
  }

  /** Read the file once at start. A missing or broken file is an empty memory, and nothing is written. */
  load(): void {
    if (this.file === null) return;
    try {
      const parsed: JsonValue = JSON.parse(readFileSync(this.file, "utf8"));
      this.entries = readGuardFile(parsed);
    } catch {
      this.entries = [];
    }
  }

  /** What the guard remembers now. */
  remembered(): readonly GuardEntry[] {
    return this.entries;
  }

  /** Decide one observation of one host's panes, and record it before anyone pushes. */
  observe<A extends GuardAsk>(host: string, panes: readonly GuardPane<A>[], now: number): ReadonlyMap<string, readonly GuardVerdict<A>[]> {
    const result = decideAsks(this.entries, host, panes, now, this.limits);
    this.entries = [...result.entries];
    if (result.changed) this.save();
    return result.verdicts;
  }

  /** A host left: its open keys close now, and are forgotten a day later. */
  forgetHost(host: string, now: number): void {
    const next = closeHost(this.entries, host, now);
    if (next.every((entry, index) => entry === this.entries[index])) return;
    this.entries = next;
    this.save();
  }

  private save(): void {
    if (this.file === null || this.stateDir === null) return;
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries: this.entries }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`[asks] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
