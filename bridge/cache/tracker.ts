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
// A FAILED READ KEEPS THE LAST READING AND LETS IT AGE. A stat that throws, a tail read that fails, a
// locked database: the entry stands on the memo the last successful probe left, and the next floor
// tick retries. The reading is not frozen — it keeps ageing on the clock, so warm becomes expiring and
// expiring becomes cold on its own. Only a pane that has LEFT its session's pane list drops its entry.
// Dropping on a transient failure made every such blip erase a countdown the bridge already knew, and
// the next poll paid a full transcript read to learn the same number again.
//
// A PROBE THAT FOUND NOTHING IS NOT A FAILED READ EITHER, and it keeps the last reading too. The 128 KB tail is a
// window, not the log: `/compact` in a Claude pane writes a summary large enough to push the last
// assistant turn out of that window, and a Codex or pi turn can do the same. The read succeeded and the
// window simply holds no turn, so the entry stands on its memo and ages on the clock — which is what
// `bridge/journal/claude.ts` § claudeCacheProbe has always said it does. Dropping there made a pane's
// countdown vanish for good after one `/compact`, because nothing ever writes that turn back into the
// window. A failure is an exception from the seam; an empty window is `null`, and the two are told
// apart here rather than folded together.
//
// STATE IS KEYED BY THE HARNESS SESSION ID, never the pane id. Pane ids churn — a renumbered pane must
// inherit nothing — and a session id is what both the transcript and the rule catalog are about.
//
// ONE TRACKER, MANY MULTIPLEXER SESSIONS, AND A REAP THAT IS SCOPED TO ONE OF THEM. `bridge/index.ts`
// builds ONE tracker and every session runtime calls `refresh` with its OWN panes, on its own poll. So
// the list a `refresh` is handed is never the whole machine, and reaping every key it does not name
// would delete the other sessions' readings on every poll. `refresh` therefore takes the session's
// name, each entry remembers the session and the pane it was read for, and a poll forgets only entries
// that belong to THAT session and whose pane has left its list. A refresh with no session named owns
// the entries it wrote and no others, so a solo caller behaves exactly as before.
//
// AN UNRESOLVED SESSION ID IS NOT A DEPARTURE. A pane whose `agentSession` the poll could not resolve
// is still one of the session's panes, so its entry stands. Ownership is judged on the PANE, not on
// whether this poll managed to name its session — otherwise one unlucky poll reaped a live pane's
// reading and the next poll re-probed the transcript to learn it again.
//
// A PENDING RESET IS HELD LIKE THE RULE, NOT IN THE MEMO. A `/model` switch is written once, and the
// polls after it find the file unchanged and read nothing. So the reset events the last probe reported
// sit on the entry beside the rule and the model TTL it chose, and an unchanged poll hands them back to
// the engine. The next probe replaces the list whole; its turn is newer than the action, so the action
// stops being pending without anything clearing it.
//
// NOTHING IS PERSISTED. A restart costs one poll, and a memo that survived a restart would be a
// countdown for a process that is gone.

import { adapterFor } from "../journal/registry.ts";
import type { JournalAdapter } from "../journal/types.ts";
import { journalAgentOf, type AgentView } from "../types.ts";
import type { CacheRule, ResetEvent, ResetRule, Sourced } from "./claims.ts";
import { evaluate, type CacheMemo, type CacheOverride, type EvaluateInput, type PaneCache } from "./engine.ts";
import { modelRuleFor, resetRulesFor, ruleForProbe } from "./rules/index.ts";

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
 * one. opencode's `stat` is one indexed count over `session_message` (V2) or two over
 * `message`/`part` (V1) plus the store lookup (journal/opencode.ts § sessionMeta), which already IS
 * the cheap "did anything move" probe — so no second query is needed, only a longer gap between them.
 */
export const QUERY_BACKED_AGENTS: ReadonlySet<string> = new Set(["opencode"]);

/** Which multiplexer session's poll this refresh speaks for. Absent means "the only caller there is". */
export interface CacheRefreshScope {
  session?: string;
}

/** Who an entry belongs to: the session that read it, and the pane it was read for. */
interface Owner {
  session: string | undefined;
  paneId: string;
}

/**
 * What the last PROBE chose, kept so an unchanged poll re-evaluates against the same answers.
 *
 * Re-deriving the rule and the model TTL from the memo is not possible — a memo carries no model and
 * no tier — and falling back to the harness's pessimistic rule would make the chip drop from 30
 * minutes to 5 on the first poll where nothing was written, which is precisely the flicker the memo
 * exists to prevent. The reset events are held for the same reason (see the module header).
 */
interface Chosen {
  rule: CacheRule | undefined;
  modelTtl: Sourced<number> | undefined;
  resets: readonly ResetEvent[];
  resetRules: readonly ResetRule[];
}

/** What the tracker remembers per session. None of it survives a restart. */
interface Entry extends Owner, Chosen {
  /** When this session was last looked at — the floor's own clock. */
  lastProbedAt: number;
  /** The `stat` the current memo was derived from. */
  seen: { size: number; mtimeMs: number };
  memo: CacheMemo;
  cache: PaneCache;
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
  async refresh(panes: readonly AgentView[], scope: CacheRefreshScope = {}): Promise<void> {
    const at = this.now();
    const session = scope.session;
    // What each of THIS session's panes named, including the panes that named nothing. The reap reads
    // this map by pane id, so an unresolved id keeps the entry rather than reaping it.
    const named = new Map<string, string | undefined>();
    for (const pane of panes) {
      const ref = pane.agentSession;
      named.set(pane.paneId, ref?.value);
      if (ref === undefined) continue;
      const harness = journalAgentOf(pane);
      const adapter = adapterFor(this.registry, harness);
      if (adapter?.cacheProbe === undefined) continue;
      const entry = this.bySession.get(ref.value);
      const floor = QUERY_BACKED_AGENTS.has(adapter.agent) ? this.opencodeFloorMs : this.floorMs;
      const owner = { session, paneId: pane.paneId };
      if (entry !== undefined && at - entry.lastProbedAt < floor) {
        // Under the floor nothing is read, but the pane is still this session's — re-stamp the owner
        // so a pane that moved between sessions is reaped by the one that now holds it.
        this.bySession.set(ref.value, { ...entry, ...owner });
        continue;
      }
      await this.look(adapter, harness, ref, at, owner);
    }
    // Reap THIS session's departed panes, on the same poll the activity ledger reconciles on. Another
    // session's entries are none of this poll's business.
    this.forget(
      [...this.bySession.entries()]
        .filter(([key, entry]) => entry.session === session && departed(named, key, entry.paneId))
        .map(([key]) => key),
    );
  }

  /** One session's look: the floor has passed, so `stat`, then read only if it moved. */
  private async look(
    adapter: JournalAdapter,
    harness: string,
    ref: { kind: "id" | "path"; value: string },
    at: number,
    owner: Owner,
  ): Promise<void> {
    const key = ref.value;
    const previous = this.bySession.get(key);

    const stat = await this.statOf(adapter, ref);
    const overrides = await this.overridesOrNone();
    if (stat === null) {
      // A stat that failed. Keep the last reading on ITS OWN `seen`, so the next stat that succeeds is
      // still compared against the file the memo came from, and let the clock age it.
      if (previous !== undefined) this.keep(key, at, previous.seen, previous, overrides, owner);
      return;
    }

    const unchanged =
      previous !== undefined && previous.seen.size === stat.size && previous.seen.mtimeMs === stat.mtimeMs;

    // Unchanged: nothing new has been written, so the memo stands and only the clock has moved. Still
    // re-evaluated, because warm becomes expiring and expiring becomes cold without anybody writing.
    if (unchanged) {
      this.keep(key, at, stat, previous, overrides, owner);
      return;
    }

    let probe;
    try {
      probe = await adapter.cacheProbe?.(ref);
    } catch {
      // A read that FAILED. Same rule as a stat that failed: keep the last reading on its own `seen`,
      // so the file the memo came from is still what the next successful stat is compared against.
      if (previous !== undefined) this.keep(key, at, previous.seen, previous, overrides, owner);
      return;
    }
    if (probe === null || probe === undefined) {
      // A read that found no turn in the window — see the module header. Keep what the last successful
      // probe left behind, and let it age; with nothing behind it there is nothing to say (Decision 1).
      if (previous !== undefined) this.keep(key, at, stat, previous, overrides, owner);
      return;
    }
    const chosen: Chosen = {
      rule: ruleForProbe(harness, probe),
      modelTtl: modelRuleFor(harness, probe.model),
      resets: probe.resets ?? [],
      resetRules: resetRulesFor(harness),
    };
    this.store(key, at, stat, chosen, owner, {
      rule: chosen.rule,
      probe,
      memo: previous?.memo,
      modelTtl: chosen.modelTtl,
      resetRules: chosen.resetRules,
      override: overrideFor(overrides, chosen.rule?.id),
      now: at,
    });
  }

  /**
   * Re-evaluate an existing entry against the clock alone, with no new probe.
   *
   * Two callers, one meaning: nothing new was read, so the rule, the model TTL, the reset events and
   * the memo the last successful probe chose all stand, and only `now` has moved. The state still
   * changes under it — warm becomes expiring and expiring becomes cold without anybody writing a line.
   */
  private keep(
    key: string,
    at: number,
    seen: { size: number; mtimeMs: number },
    previous: Entry,
    overrides: readonly CacheOverride[],
    owner: Owner,
  ): void {
    this.store(key, at, seen, previous, owner, {
      rule: previous.rule,
      memo: previous.memo,
      modelTtl: previous.modelTtl,
      resetRules: previous.resetRules,
      heldResets: previous.resets,
      override: overrideFor(overrides, previous.rule?.id),
      now: at,
    });
  }

  /** Evaluate and keep, or drop when there is nothing to say (Decision 1). */
  private store(
    key: string,
    at: number,
    seen: { size: number; mtimeMs: number },
    chosen: Chosen,
    owner: Owner,
    input: EvaluateInput,
  ): void {
    const out = evaluate(input);
    if (out === undefined) {
      this.bySession.delete(key);
      return;
    }
    this.bySession.set(key, {
      lastProbedAt: at,
      seen,
      memo: out.memo,
      cache: out.cache,
      rule: chosen.rule,
      modelTtl: chosen.modelTtl,
      resets: chosen.resets,
      resetRules: chosen.resetRules,
      session: owner.session,
      paneId: owner.paneId,
    });
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

/**
 * Has the pane this entry was read for left the session's list?
 *
 * Two ways, and only two. The pane is gone from the list altogether; or the pane is still there and
 * has NAMED a different harness session, which makes this entry the previous session's leftover. A
 * pane still in the list that named nothing this poll is neither — see the module header.
 */
function departed(named: Map<string, string | undefined>, key: string, paneId: string): boolean {
  if (!named.has(paneId)) return true;
  const now = named.get(paneId);
  return now !== undefined && now !== key;
}

/** The override for a rule id, or undefined. A memo-only poll has no probe to pick a rule with. */
function overrideFor(
  overrides: readonly CacheOverride[],
  ruleId: string | undefined,
): CacheOverride | undefined {
  if (ruleId === undefined || ruleId === "") return undefined;
  return overrides.find((o) => o.ruleId === ruleId);
}
