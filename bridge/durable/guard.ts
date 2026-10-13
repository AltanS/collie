// THE PUSH GUARD FOR ASKS THAT TRAVEL AS DATA (ADR 0100, rule 5 and rule 6).
//
// A durable program raises its asks as data, and a program is less trusted than a terminal: one
// hostile or broken program could raise fifty asks in a second, or raise the same question again
// after every restart. A push crosses a third-party push service and buzzes a phone, so each ask
// goes through this guard before any push.
//
// ── THE GUARD CAPS PUSHES, NEVER VISIBILITY ──────────────────────────────────
// Every open ask reaches the pane wire (the program's own cap of 50 per pane is the only limit, in
// the adapter). The guard decides one thing per ask: push, or show quietly. It never hides an ask.
//
// ── ONE KEY: (host, toolCallId) ──────────────────────────────────────────────
// A program mints a new ask id after every restart, but the tool call id stays (WIRE.md section 8.4).
// So the guard remembers the tool call, not the ask: a re-asked question is the same key, and it is
// shown, never pushed again. The memory is a small file in the state dir, written before the push
// it allows, so a bridge restart pushes nothing twice.
//
// ── EACH KEY IS DECIDED ONCE ─────────────────────────────────────────────────
// The first time a key is seen, it is decided: push (inside every rate) or show-quiet (a rate is
// spent). Only that first decision may push. Later sightings show it quietly.
//
// ── THE CAPS ─────────────────────────────────────────────────────────────────
// 3 pushes per pane per minute, 10 per host per minute, and 30 per host per hour. The rates are
// counted from the remembered push times, so they hold across a bridge restart as well.
//
// THE HOURLY CAP IS A BREAKER. The ask that would be the 31st push of the hour trips it: instead of
// that push, the host gets ONE summary push ("a program on <host> is raising many asks"), and then
// nothing at all for that host until the hour since the trip is over. The trip time is kept in the
// same file, so a restart does not reset it.
//
// ── WHAT IS FORGOTTEN ────────────────────────────────────────────────────────
// A key is forgotten an hour after it was last seen open, and the file keeps at most 2000 keys (the
// oldest closed ones go first). An open key is never forgotten while it is open: that would push it
// again.
//
// The decision is a pure function ({@link decideAsks}); the store around it only reads and writes the
// file. Ported from the durable-member spike's guard. The string caps that guard also held are the
// adapter's job now (WIRE.md section 6), so they are not repeated here.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { readGuardFile } from "./parse.ts";

/** What the guard says about one ask. Both show it; only `push` lets the pane raise a push. */
export type GuardDecision = "push" | "show-quiet";

export interface GuardLimits {
  readonly pushPerPaneMinute: number;
  readonly pushPerHostMinute: number;
  /** Pushes per host per hour. The one past it trips the breaker. */
  readonly pushPerHostHour: number;
  /** How long a closed ask's key is kept after it was last seen open, in ms. */
  readonly keepClosedMs: number;
  /** The most keys kept in all. Past it, the oldest closed ones go first. */
  readonly maxEntries: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  pushPerPaneMinute: 3,
  pushPerHostMinute: 10,
  pushPerHostHour: 30,
  keepClosedMs: HOUR_MS,
  maxEntries: 2000,
};

/** How long a tripped breaker keeps a host silent. */
export const BREAKER_MS = HOUR_MS;

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
  readonly why: "new" | "pane rate" | "host rate" | "hourly cap" | "known";
}

/** What one observation decided, and the memory after it. */
export interface GuardResult<A extends GuardAsk = GuardAsk> {
  /** Per pane id, one verdict per ask, in the pane's order. */
  readonly verdicts: ReadonlyMap<string, readonly GuardVerdict<A>[]>;
  readonly entries: readonly GuardEntry[];
  /** Whether {@link entries} or the trip time differs from the input, so the store knows to write. */
  readonly changed: boolean;
  /** When this host's breaker tripped, while it holds. Undefined when it is not tripped. */
  readonly trippedAt: number | undefined;
  /** True only for the observation that tripped the breaker: send the one summary push now. */
  readonly flood: boolean;
}

function keyOf(host: string, toolCallId: string): string {
  return `${host}\n${toolCallId}`;
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
 * host that is not open on any of them is marked closed, so it is forgotten an hour later; a key that
 * comes back (a restart re-ask) is opened again and keeps its push time, so it is shown, not pushed.
 * `trippedAt` is when this host's breaker last tripped, if it did.
 */
export function decideAsks<A extends GuardAsk>(
  remembered: readonly GuardEntry[],
  host: string,
  panes: readonly GuardPane<A>[],
  now: number,
  limits: GuardLimits = DEFAULT_GUARD_LIMITS,
  trippedAt?: number,
): GuardResult<A> {
  const memory = new Map<string, GuardEntry>(remembered.map((entry) => [keyOf(entry.host, entry.toolCallId), entry]));
  const open = new Set<string>();
  const verdicts = new Map<string, GuardVerdict<A>[]>();
  let changed = false;
  let flood = false;
  // A breaker whose hour is over is gone, and that is a change to write.
  let tripped = trippedAt !== undefined && now - trippedAt < BREAKER_MS ? trippedAt : undefined;
  if (tripped !== trippedAt) changed = true;

  /** Pushes this host made inside `windowMs`, on one pane or on all of them. */
  const recentPushes = (paneId: string | null, windowMs: number): number => {
    let count = 0;
    for (const entry of memory.values()) {
      if (entry.host !== host || entry.pushedAt === undefined || now - entry.pushedAt >= windowMs) continue;
      if (paneId === null || entry.paneId === paneId) count += 1;
    }
    return count;
  };

  for (const pane of panes) {
    const list: GuardVerdict<A>[] = [];
    for (const ask of uniqueByToolCall(pane.asks)) {
      const key = keyOf(host, ask.toolCallId);
      open.add(key);
      const known = memory.get(key);
      let verdict: GuardVerdict<A>;
      let pushedAt = known?.pushedAt;
      if (known !== undefined) {
        verdict = { ask, decision: "show-quiet", why: "known" };
      } else if (recentPushes(pane.paneId, MINUTE_MS) >= limits.pushPerPaneMinute) {
        verdict = { ask, decision: "show-quiet", why: "pane rate" };
      } else if (recentPushes(null, MINUTE_MS) >= limits.pushPerHostMinute) {
        verdict = { ask, decision: "show-quiet", why: "host rate" };
      } else if (tripped !== undefined) {
        verdict = { ask, decision: "show-quiet", why: "hourly cap" };
      } else if (recentPushes(null, HOUR_MS) >= limits.pushPerHostHour) {
        // This would be one push past the hour's cap: the breaker trips, and one summary goes instead.
        tripped = now;
        flood = true;
        changed = true;
        verdict = { ask, decision: "show-quiet", why: "hourly cap" };
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
    }
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
  return { verdicts, entries: pruned, changed, trippedAt: tripped, flood };
}

/** Mark every open key of `host` closed: the host left, and nothing will report its asks again. */
export function closeHost(remembered: readonly GuardEntry[], host: string, now: number): GuardEntry[] {
  return remembered.map((entry) => (entry.host === host && entry.closedAt === undefined ? { ...entry, closedAt: now } : entry));
}

/** The order `prune` lets keys go in: closed before open, then by the time that put them there. */
function pruneOrder(entry: GuardEntry): [number, number] {
  return [entry.closedAt === undefined ? 1 : 0, entry.closedAt ?? entry.firstSeenAt];
}

/** Drop keys closed more than an hour ago, then hold the total under the cap, oldest closed first. */
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
 * be split by a crash between two awaits. The file is small (one line per tool call, at most 2000)
 * and is written only when an observation changed it, which is when an ask opened or closed. A
 * bridge that never sees a durable pane never writes it. A write that fails is logged and the memory
 * stays in this process: the push still goes, and only the dedupe across a restart is lost.
 *
 * `stateDir` null keeps the memory in this process only, for a test or a server built by hand.
 */
/** What one observation of a host's panes decided. */
export interface GuardObservation<A extends GuardAsk> {
  /** Per pane id, a verdict for each of its asks. */
  readonly verdicts: ReadonlyMap<string, readonly GuardVerdict<A>[]>;
  /** True for the one observation that tripped the host's hourly breaker. */
  readonly flood: boolean;
}

export class AskGuardStore {
  private entries: GuardEntry[] = [];
  /** Per host, when its breaker tripped. A host whose hour is over is dropped on its next observation. */
  private breakers = new Map<string, number>();
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
      const file = readGuardFile(parsed);
      this.entries = file.entries.slice(-this.limits.maxEntries);
      this.breakers = new Map(file.breakers);
    } catch {
      this.entries = [];
      this.breakers = new Map();
    }
  }

  /** What the guard remembers now. */
  remembered(): readonly GuardEntry[] {
    return this.entries;
  }

  /** When this host's breaker tripped, while the store still holds it. */
  trippedAt(host: string): number | undefined {
    return this.breakers.get(host);
  }

  /**
   * Decide one observation of one host's panes, and record it before anyone pushes. `flood` is true
   * for the one observation that tripped the host's breaker: the caller sends the summary push.
   */
  observe<A extends GuardAsk>(host: string, panes: readonly GuardPane<A>[], now: number): GuardObservation<A> {
    const result = decideAsks(this.entries, host, panes, now, this.limits, this.breakers.get(host));
    this.entries = [...result.entries];
    if (result.trippedAt === undefined) this.breakers.delete(host);
    else this.breakers.set(host, result.trippedAt);
    if (result.changed) this.save();
    return { verdicts: result.verdicts, flood: result.flood };
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
      const breakers = [...this.breakers].map(([host, trippedAt]) => ({ host, trippedAt }));
      writeFileSync(tmp, JSON.stringify({ entries: this.entries, breakers }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`[asks] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
