// Who reads the transcripts, and how often. The bridge-owned ledger of prompt-cache state.
//
// WHY THIS IS NOT INLINE. `localSnapshot` in `bridge/server.ts` is SYNCHRONOUS — an arrow function
// returning a body directly — and a probe touches disk. So the probe runs out of band on the state
// engine's own poll (`bridge/index.ts` § engine.onUpdate) and the snapshot reads a memo, exactly as
// `activity.get` is read at serialise time. The countdown can be five seconds behind, which is
// invisible on a window measured in minutes.
//
// TWO FLOORS AND A READ GATE, because forty working panes must not cost forty reads a second:
//   • a session is looked at AT MOST once every `floorMs` (5 s). Under the floor nothing happens at
//     all, not even a `stat`.
//   • past the floor, `source.stat` answers size and mtime WITHOUT reading the log. Unchanged means
//     the memo stands and only the clock has moved; changed means one 128 KB tail read.
//   • a query-backed adapter (opencode, whose `stat` is two indexed counts rather than one syscall)
//     gets its own, longer floor.
// Forty panes therefore cost about eight `stat`s a second in total, not forty per poll.
//
// A FAILED READ DROPS THE MEMO, IT NEVER FREEZES IT (ADR 0041, Decision 9). A stat that throws, a tail
// read that fails, a locked database: the session's entry is deleted, the chip falls to `unknown` and
// renders nothing, and the next floor tick retries. A forever-stale countdown is worse than no
// countdown, because it is confidently wrong.
//
// STATE IS KEYED BY THE HARNESS SESSION ID, never the pane id. Pane ids churn — a renumbered pane must
// inherit nothing — and a session id is what both the transcript and the rule catalog are about.
//
// NOTHING IS PERSISTED. A restart costs one poll, and a memo that survived a restart would be a
// countdown for a process that is gone.

import { adapterFor } from "../journal/registry.ts";
import type { JournalAdapter } from "../journal/types.ts";
import { journalAgentOf, type AgentView } from "../types.ts";
import type { CacheRule, Sourced } from "./claims.ts";
import { evaluate, type CacheMemo, type CacheOverride, type EvaluateInput, type PaneCache } from "./engine.ts";
import { modelRuleFor, ruleForProbe } from "./rules/index.ts";

/** Where the operator's overrides come from. One method, so the reader can be faked in a test. */
export interface CacheRuleSource {
  /** Never throws: the shared operator reader holds the last good rows on any failure. */
  overrides(): Promise<readonly CacheOverride[]>;
}

export interface CacheTrackerOptions {
  /** Least time between two looks at one file-backed session. */
  floorMs?: number;
  /** The same, for an adapter whose `stat` is a query rather than a syscall. */
  opencodeFloorMs?: number;
}

export const DEFAULT_FLOOR_MS = 5000;
export const DEFAULT_OPENCODE_FLOOR_MS = 10_000;

/**
 * Adapters whose `stat` costs a QUERY rather than a syscall, and so take the longer floor.
 *
 * Named by agent rather than sniffed, because "is this backed by a database" is not a question a
 * `TranscriptSource` answers and inventing a flag for one adapter would be a worse seam than a list of
 * one. opencode's `stat` is two indexed counts over `message` and `part` (journal/opencode.ts §
 * sessionMeta), which already IS the cheap "did anything move" probe — so no second query is needed,
 * only a longer gap between them.
 */
export const QUERY_BACKED_AGENTS: ReadonlySet<string> = new Set(["opencode"]);

/** What the tracker remembers per session. None of it survives a restart. */
interface Entry {
  /** When this session was last looked at — the floor's own clock. */
  lastProbedAt: number;
  /** The `stat` the current memo was derived from. */
  seen: { size: number; mtimeMs: number };
  memo: CacheMemo;
  cache: PaneCache;
  /**
   * The rule and model TTL the last PROBE chose, kept so an unchanged poll re-evaluates against the
   * same ones. Re-deriving them from the memo is not possible — a memo carries no model and no tier —
   * and falling back to the harness's pessimistic rule would make the chip drop from 30 minutes to 5
   * on the first poll where nothing was written, which is precisely the flicker the memo exists to
   * prevent.
   */
  rule: CacheRule | undefined;
  modelTtl: Sourced<number> | undefined;
}

export class CacheTracker {
  private readonly bySession = new Map<string, Entry>();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    private readonly rules: CacheRuleSource,
    private readonly now: () => number,
    options: CacheTrackerOptions = {},
  ) {
    this.floorMs = options.floorMs ?? DEFAULT_FLOOR_MS;
    this.opencodeFloorMs = options.opencodeFloorMs ?? DEFAULT_OPENCODE_FLOOR_MS;
  }

  private readonly floorMs: number;

  private readonly opencodeFloorMs: number;

  /** The reading for one harness session, or undefined. A synchronous map read, as `activity.get` is. */
  get(sessionKey: string): PaneCache | undefined {
    return this.bySession.get(sessionKey)?.cache;
  }

  /** Drop these sessions outright. Called by {@link refresh} for panes that are gone. */
  forget(sessionKeys: readonly string[]): void {
    for (const key of sessionKeys) this.bySession.delete(key);
  }

  /**
   * Walk the agent panes and bring their readings up to date. NEVER THROWS.
   *
   * A harness with no `cacheProbe` is skipped whole (grok, hermes), as is a pane that named no
   * session. A session under its floor is not even `stat`ed. Everything else is one `stat`, and a tail
   * read only when that `stat` moved.
   */
  async refresh(panes: readonly AgentView[]): Promise<void> {
    const at = this.now();
    const live = new Set<string>();
    for (const pane of panes) {
      const ref = pane.agentSession;
      if (ref === undefined) continue;
      const harness = journalAgentOf(pane);
      const adapter = adapterFor(this.registry, harness);
      if (adapter?.cacheProbe === undefined) continue;
      live.add(ref.value);
      const entry = this.bySession.get(ref.value);
      const floor = QUERY_BACKED_AGENTS.has(adapter.agent) ? this.opencodeFloorMs : this.floorMs;
      if (entry !== undefined && at - entry.lastProbedAt < floor) continue;
      await this.look(adapter, harness, ref, at);
    }
    // Reap the sessions no pane names any more, on the same poll the activity ledger reconciles on.
    this.forget([...this.bySession.keys()].filter((key) => !live.has(key)));
  }

  /** One session's look: the floor has passed, so `stat`, then read only if it moved. */
  private async look(
    adapter: JournalAdapter,
    harness: string,
    ref: { kind: "id" | "path"; value: string },
    at: number,
  ): Promise<void> {
    const key = ref.value;
    const previous = this.bySession.get(key);
    const drop = () => this.bySession.delete(key);

    const stat = await this.statOf(adapter, ref);
    if (stat === null) {
      drop();
      return;
    }

    const overrides = await this.overridesOrNone();
    const unchanged =
      previous !== undefined && previous.seen.size === stat.size && previous.seen.mtimeMs === stat.mtimeMs;

    // Unchanged: nothing new has been written, so the memo stands and only the clock has moved. Still
    // re-evaluated, because warm becomes expiring and expiring becomes cold without anybody writing.
    if (unchanged) {
      this.store(key, at, stat, previous.rule, previous.modelTtl, {
        rule: previous.rule,
        memo: previous.memo,
        modelTtl: previous.modelTtl,
        override: overrideFor(overrides, previous.rule?.id),
        now: at,
      });
      return;
    }

    let probe;
    try {
      probe = await adapter.cacheProbe?.(ref);
    } catch {
      probe = null;
    }
    if (probe === null || probe === undefined) {
      // Nothing readable where there used to be something: drop rather than freeze (Decision 9).
      drop();
      return;
    }
    const rule = ruleForProbe(harness, probe);
    const modelTtl = modelRuleFor(harness, probe.model);
    this.store(key, at, stat, rule, modelTtl, {
      rule,
      probe,
      memo: previous?.memo,
      modelTtl,
      override: overrideFor(overrides, rule?.id),
      now: at,
    });
  }

  /** Evaluate and keep, or drop when there is nothing to say (Decision 1). */
  private store(
    key: string,
    at: number,
    seen: { size: number; mtimeMs: number },
    rule: CacheRule | undefined,
    modelTtl: Sourced<number> | undefined,
    input: EvaluateInput,
  ): void {
    const out = evaluate(input);
    if (out === undefined) {
      this.bySession.delete(key);
      return;
    }
    this.bySession.set(key, { lastProbedAt: at, seen, memo: out.memo, cache: out.cache, rule, modelTtl });
  }

  /** `resolve` then `stat`, both through the adapter's own source. Null for anything unreadable. */
  private async statOf(
    adapter: JournalAdapter,
    ref: { kind: "id" | "path"; value: string },
  ): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const path = await adapter.source.resolve(ref);
      if (path === null) return null;
      return await adapter.source.stat(path);
    } catch {
      return null;
    }
  }

  /** The operator's rows, or none. The shared reader already holds the last good set on a failure. */
  private async overridesOrNone(): Promise<readonly CacheOverride[]> {
    try {
      return await this.rules.overrides();
    } catch {
      return [];
    }
  }
}

/** The override for a rule id, or undefined. A memo-only poll has no probe to pick a rule with. */
function overrideFor(
  overrides: readonly CacheOverride[],
  ruleId: string | undefined,
): CacheOverride | undefined {
  if (ruleId === undefined || ruleId === "") return undefined;
  return overrides.find((o) => o.ruleId === ruleId);
}
