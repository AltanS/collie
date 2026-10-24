// Hook edges into the Surface (M56 spec 11). The harness's own hook writes one edge file per event
// (`collie beacon emit`, cli/beacon.ts). This router takes each file once, places the edge on one
// pane, and hands it to that pane's Surface and Send Protocol.
//
// Placing: the edge names the harness pid and every multiplexer marker the hook saw (`HERDR_PANE_ID`,
// `TMUX_PANE`, `ZELLIJ_PANE_ID`, with the scope of each). Each terminal session's adapter has a beacon
// matcher; exactly one pane across all sessions must match. The pid must still be the process that
// wrote the edge (its start time), and where the multiplexer reports the pane's foreground pids, the
// pid must be one of them. An edge that fails any of these is logged and dropped.
//
// What an edge does is the fold's business (web/src/lib/surface/fold.ts): it marks the read stale and
// asks for a fresh read about 700 ms later, it may say "a turn runs" or "a modal is up", and a prompt
// edge may close a send receipt as `effective`. It never makes a `free`, never sends a key, never types.
//
// The hook source of a pane is live while the pid of its last edge runs and no `end` edge came. When
// that pid is gone, the router hands the pane one `end` edge (the hook connection closed) and the
// pane info says "hooks: none" again. The live sources are kept in `<stateDir>/surface/hook-sources.json`,
// so a restarted bridge reads a hooked pane as live at once, before its agent's next event: each saved
// source is placed again like an edge (its markers, its pid and start time), and one whose pid is gone
// is dropped.
//
// THE START'S MODEL. A start edge may name the model the session starts on (`EdgeRecord.model`). The
// router keeps it on the pane's hook source, carries it over the later edges of the same pid, and drops
// it with the source, so a pane whose agent left names no model from a hook. It is saved with the
// source, so a restarted bridge still knows it. bridge/pane-model.ts decides when it is shown.
//
// No harness name lives here (no-harness-names.test.ts scans this folder). The edge names its own
// harness, and that harness's profile maps the event to a kind.

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseEdge } from "../beacon/parse.ts";
import type { BeaconLiveness } from "../beacon/reader.ts";
import type { EdgeRecord } from "../beacon/types.ts";
import type { EdgeSpool } from "../beacon-io.ts";
import type { ForegroundProcess } from "../journal/types.ts";
import type { MuxOutcome } from "../mux/types.ts";
import type { ModelReading } from "../pane-model.ts";
import { edgeKindOf, type EdgeKind } from "../../web/src/lib/surface/edges.ts";
import { findProfile, loadProfiles } from "../../web/src/lib/surface/profile.ts";

/** How often the router takes the spool. */
export const EDGE_TAKE_MS = 200;
/** An edge older than this when taken is dropped: the bridge was down, and its turn is history. */
export { EDGE_MAX_AGE_MS } from "../beacon/paths.ts";
import { EDGE_MAX_AGE_MS } from "../beacon/paths.ts";
/** How often the live hook sources are checked for a gone pid. */
export const HOOK_LIVENESS_MS = 2000;
/** How often one drop reason for one pid makes a journal line. Every drop is counted. */
const DROP_LOG_REPEAT_MS = 60_000;
/** The journal tag of a placed edge. `journalctl ... | grep surface.edge` reads them. */
export const EDGE_TAG = "surface.edge";

export type DropReason = "unparsed" | "old" | "no-pane" | "ambiguous" | "dead-pid" | "not-foreground";

/** One terminal session, as the router sees it. */
export interface EdgeTarget {
  readonly session: string;
  readonly matcher: BeaconMatcher;
  /** The ids of the session's panes in its newest snapshot. */
  paneIds(): readonly string[];
  /** The pane's foreground processes, when the multiplexer reports them. */
  readonly foreground?: (paneId: string) => Promise<MuxOutcome<readonly ForegroundProcess[]>>;
  /** Hand a placed edge to the pane's Surface and Send Protocol. Never throws to the router. */
  deliver(paneId: string, edge: PlacedEdge): void;
}

/** A placed edge: its kind for the fold, its record, and when the bridge took it. */
export interface PlacedEdge {
  readonly kind: EdgeKind;
  readonly record: EdgeRecord;
  /** The bridge's clock when the edge was taken. The fold uses this clock, never the hook's. */
  readonly at: number;
}

/** The tool edge's facts a hold book reads (see bridge/surface/hold.ts `EdgeInfo`). */
export interface EdgeHoldInfo {
  readonly tool: string | null;
  readonly agent: string | null;
  readonly at: number;
  readonly inputHash: string | null;
}

/** Where one placed edge goes on a terminal session. */
export interface EdgeSinks {
  /** The pane's Surface (its fold). True when the pane took it; a pane not read yet takes none. */
  fold(paneId: string, kind: EdgeKind, at: number): boolean;
  /** An edge of the main session that no fold took: it is counted under its harness, like a dropped one. */
  unfolded?(record: EdgeRecord, kind: EdgeKind): void;
  /** A prompt edge with its salted hash: the Send Protocol closes a receipt as `effective` on it. */
  promptEdge?(paneId: string, promptHash: string, at: number): void;
  /** The hold book: a tool edge ends a "Sent" card of a hook-held permission, a subagent's too. */
  hold?(paneId: string, kind: EdgeKind, info: EdgeHoldInfo): void;
}

/**
 * Hand a placed edge to its sinks. A SUBAGENT IS NOT THE PANE: an edge whose record names a subagent
 * (`agent`, only a tool edge carries it) came from a task inside the session, while the pane's own
 * turn may be idle. It never goes into the fold, so it neither marks the read stale nor opens or
 * closes a block, and it is not counted as an edge of the pane. It still reaches the hold book, which
 * ends a subagent's held permission on it.
 */
export function deliverEdge(sinks: EdgeSinks, paneId: string, edge: PlacedEdge): void {
  const { record, kind, at } = edge;
  const subagent = record.agent !== undefined;
  if (!subagent && !sinks.fold(paneId, kind, at)) sinks.unfolded?.(record, kind);
  if (!subagent && kind === "prompt" && record.promptHash !== null) sinks.promptEdge?.(paneId, record.promptHash, record.at);
  sinks.hold?.(paneId, kind, { tool: record.tool ?? null, agent: record.agent ?? null, at: record.at, inputHash: record.inputHash ?? null });
}

export type Placement =
  | { readonly kind: "placed"; readonly target: EdgeTarget; readonly paneId: string }
  | { readonly kind: "dropped"; readonly reason: DropReason };

/** The edge's kind under its harness's profile. No profile, or no row: a `reread`. */
export function kindOfEdge(record: EdgeRecord): EdgeKind {
  const events = findProfile(loadProfiles(), record.harness)?.edges?.events ?? {};
  return edgeKindOf(events, record.event, record.detail);
}

/**
 * Place one edge on one pane, or say why not. Exactly one pane across every target must match one of
 * the edge's markers; the pid must still be the writer; a reported foreground must hold the pid.
 */
export async function placeEdge(record: EdgeRecord, targets: readonly EdgeTarget[], liveness: BeaconLiveness): Promise<Placement> {
  const hits: { target: EdgeTarget; paneId: string }[] = [];
  for (const target of targets) {
    const markers = record.markers.filter((marker) => marker.namespace === target.matcher.namespace);
    if (markers.length === 0) continue;
    const scope = await target.matcher.scope().catch(() => null);
    if (scope === null) continue;
    for (const paneId of target.paneIds()) {
      if (markers.some((marker) => target.matcher.matches({ paneId }, marker, scope))) hits.push({ target, paneId });
    }
  }
  if (hits.length === 0) return { kind: "dropped", reason: "no-pane" };
  if (hits.length > 1) return { kind: "dropped", reason: "ambiguous" };
  const hit = hits[0]!;
  const start = await liveness.startTimeOf(record.pid).catch(() => null);
  if (start === null || start !== record.pidStartTime) return { kind: "dropped", reason: "dead-pid" };
  if (hit.target.foreground !== undefined) {
    const outcome = await hit.target.foreground(hit.paneId).catch(() => null);
    const pids = outcome?.ok === true ? outcome.value.flatMap((process) => (process.pid === undefined ? [] : [process.pid])) : [];
    if (pids.length > 0 && !pids.includes(record.pid)) return { kind: "dropped", reason: "not-foreground" };
  }
  return { kind: "placed", target: hit.target, paneId: hit.paneId };
}

/** The live hook source of one pane. */
interface HookSource {
  readonly target: EdgeTarget;
  readonly paneId: string;
  readonly pid: number;
  readonly pidStartTime: number;
  readonly record: EdgeRecord;
  /**
   * The model the newest start edge of this pid named, and when the hook ran: the edge's own `at`, by
   * the same machine clock the transcript's timestamps use, so the label can tell which came later.
   * Undefined when no start of this pid named one.
   */
  readonly model: ModelReading | undefined;
}

/**
 * The model a pane's hook source names after one more edge: the edge's own when it carries one, else
 * the one the source already had while the pid is the same process, else none.
 */
export function modelAfter(known: Pick<HookSource, "pid" | "pidStartTime" | "model"> | undefined, record: EdgeRecord): ModelReading | undefined {
  if (record.model !== undefined) return { model: record.model, at: record.at };
  if (known === undefined || known.pid !== record.pid || known.pidStartTime !== record.pidStartTime) return undefined;
  return known.model;
}

/** A live source as saved across a restart: the session, the pane and the last edge it sent. */
export interface SavedSource {
  readonly session: string;
  readonly paneId: string;
  readonly record: EdgeRecord;
  /** When the hook that named `record.model` ran, which may be an earlier edge than `record`. */
  readonly modelAt?: number;
}

/** Where the live sources are kept across a restart. Both calls never throw to the router. */
export interface SourceStore {
  load(): readonly SavedSource[];
  save(sources: readonly SavedSource[]): void;
}

/** How long after the start a saved source waits for its pane to show in a snapshot. */
export const SEED_WINDOW_MS = 60_000;

export interface EdgeRouterDeps {
  readonly spool: EdgeSpool;
  /** The live sources across a restart. Absent: every pane starts at "hooks: none". */
  readonly store?: SourceStore;
  /** Called once per {@link HOOK_LIVENESS_MS} on a take: the bridge keeps its hook target file there. */
  readonly keep?: () => void;
  readonly liveness: BeaconLiveness;
  /** Every terminal session that can take edges, read on each take. */
  targets(): readonly EdgeTarget[];
  /** Where a dropped edge is counted, by its harness. Never throws to the router. */
  readonly onDrop?: (record: EdgeRecord | null, reason: DropReason) => void;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

/** A live source as it is saved. The model rides on the saved record, with the time its own hook ran. */
function savedOf(source: HookSource): SavedSource {
  const saved: SavedSource = { session: source.target.session, paneId: source.paneId, record: source.record };
  if (source.model === undefined) return saved;
  return { ...saved, record: { ...source.record, model: source.model.model }, modelAt: source.model.at };
}

function keyOf(session: string, paneId: string): string {
  return `${session}\u0000${paneId}`;
}

/** Takes the spool, places each edge, and keeps the live hook source of each pane. */
export class EdgeRouter {
  private readonly sources = new Map<string, HookSource>();
  private readonly dropLogged = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private taking = false;
  private lastLiveness = Number.NEGATIVE_INFINITY;
  private lastKeep = Number.NEGATIVE_INFINITY;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Saved sources not placed yet, and until when they may still be. */
  private seeds: readonly SavedSource[];
  private readonly seedUntil: number;

  constructor(private readonly deps: EdgeRouterDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? (() => Date.now());
    this.seeds = deps.store?.load() ?? [];
    this.seedUntil = this.now() + SEED_WINDOW_MS;
  }

  /** Take the spool every {@link EDGE_TAKE_MS}. The timer never keeps the process alive. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), EDGE_TAKE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * "live" while the pane has a hook source whose pid runs; "holds" when its newest edge also says the
   * harness's settings hold permissions (M56 spec 12); "none" otherwise.
   */
  hooksOf(session: string, paneId: string): "live" | "holds" | "none" {
    const source = this.sources.get(keyOf(session, paneId));
    if (source === undefined) return "none";
    return source.record.holds === true ? "holds" : "live";
  }

  /** One take: every edge file in the spool, in name order, then the liveness of the sources. Never throws. */
  async tick(): Promise<void> {
    if (this.taking) return;
    this.taking = true;
    try {
      const texts = await this.deps.spool.take().catch(() => []);
      if (this.seeds.length > 0) await this.seed();
      const targets = texts.length === 0 ? [] : this.deps.targets();
      for (const text of texts) await this.route(text, targets);
      await this.checkLiveness();
    } catch (err) {
      console.warn(`[surface] edge take failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.taking = false;
    }
  }

  private async route(text: string, targets: readonly EdgeTarget[]): Promise<void> {
    const record = parseEdge(text);
    if (record === null) return this.drop(null, "unparsed");
    const now = this.now();
    if (now - record.at > EDGE_MAX_AGE_MS) return this.drop(record, "old");
    const placement = await placeEdge(record, targets, this.deps.liveness);
    if (placement.kind === "dropped") return this.drop(record, placement.reason);
    const kind = kindOfEdge(record);
    const key = keyOf(placement.target.session, placement.paneId);
    if (kind === "end") this.forget(key);
    else {
      const model = modelAfter(this.sources.get(key), record);
      this.remember(key, { target: placement.target, paneId: placement.paneId, pid: record.pid, pidStartTime: record.pidStartTime, record, model });
    }
    this.log(
      [
        `[surface] ${EDGE_TAG}`,
        `event=${record.event}${record.detail === null ? "" : `:${record.detail}`}`,
        `kind=${kind}`,
        `pid=${String(record.pid)}`,
        `session=${placement.target.session}`,
        `pane=${placement.paneId}`,
        `prompt=${record.promptHash === null ? "-" : "hashed"}`,
        ...(record.model === undefined ? [] : [`model=${record.model}`]),
      ].join(" "),
    );
    this.deliver(placement.target, placement.paneId, { kind, record, at: now });
  }

  /**
   * Places the saved sources of the last run. A source whose pid is gone or reused is dropped; one
   * whose pane is not in a snapshot yet waits, up to {@link SEED_WINDOW_MS} after the start. Nothing is
   * delivered: a seed only says the pane's hooks are live.
   */
  private async seed(): Promise<void> {
    const targets = this.deps.targets();
    const waiting: SavedSource[] = [];
    for (const saved of this.seeds) {
      const placement = await placeEdge(saved.record, targets.filter((target) => target.session === saved.session), this.deps.liveness);
      if (placement.kind === "placed") {
        const key = keyOf(placement.target.session, placement.paneId);
        // The saved model keeps the time its hook ran, so a log that named a model after it still wins.
        const model = saved.record.model === undefined ? undefined : { model: saved.record.model, at: saved.modelAt ?? saved.record.at };
        if (!this.sources.has(key)) this.remember(key, { target: placement.target, paneId: placement.paneId, pid: saved.record.pid, pidStartTime: saved.record.pidStartTime, record: saved.record, model });
      } else if (placement.reason === "no-pane" && this.now() < this.seedUntil) {
        waiting.push(saved);
      }
    }
    this.seeds = waiting;
    if (waiting.length === 0) this.persist();
  }

  /**
   * The model the pane's live hook source names, from its newest start edge, or undefined: no live
   * source, or a start that named none.
   */
  modelOf(session: string, paneId: string): ModelReading | undefined {
    return this.sources.get(keyOf(session, paneId))?.model;
  }

  /** A pane's source is live, its pid changed, or its start named another model: saved when that is news. */
  private remember(key: string, source: HookSource): void {
    const known = this.sources.get(key);
    this.sources.set(key, source);
    if (known === undefined || known.pid !== source.pid || known.pidStartTime !== source.pidStartTime || known.model?.model !== source.model?.model) this.persist();
  }

  private forget(key: string): void {
    if (this.sources.delete(key)) this.persist();
  }

  /** The live sources to the store. Seeds still waiting are kept in it too. */
  private persist(): void {
    const store = this.deps.store;
    if (store === undefined) return;
    const live: SavedSource[] = [...this.sources.values()].map(savedOf);
    try {
      store.save([...live, ...this.seeds]);
    } catch (err) {
      console.warn(`[surface] could not save the hook sources: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private deliver(target: EdgeTarget, paneId: string, edge: PlacedEdge): void {
    try {
      target.deliver(paneId, edge);
    } catch (err) {
      console.warn(`[surface] edge delivery to ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private drop(record: EdgeRecord | null, reason: DropReason): void {
    try {
      this.deps.onDrop?.(record, reason);
    } catch {
      // A counter is not a verdict.
    }
    if (reason === "old" || reason === "unparsed") return;
    const key = `${reason}:${String(record?.pid ?? 0)}`;
    const now = this.now();
    const last = this.dropLogged.get(key);
    if (last !== undefined && now - last < DROP_LOG_REPEAT_MS) return;
    if (this.dropLogged.size > 256) this.dropLogged.clear();
    this.dropLogged.set(key, now);
    this.log(`[surface] ${EDGE_TAG}.dropped reason=${reason} event=${record?.event ?? "-"} pid=${String(record?.pid ?? "-")}`);
  }

  /**
   * A source whose pid is gone, or whose pane left its session, closed its hook connection: the pane
   * gets one `end` edge and reads "hooks: none". At most once per {@link HOOK_LIVENESS_MS}.
   */
  private async checkLiveness(): Promise<void> {
    const now = this.now();
    if (this.deps.keep !== undefined && now - this.lastKeep >= HOOK_LIVENESS_MS) {
      this.lastKeep = now;
      try {
        this.deps.keep();
      } catch (err) {
        console.warn(`[surface] could not keep the hook target: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (now - this.lastLiveness < HOOK_LIVENESS_MS || this.sources.size === 0) return;
    this.lastLiveness = now;
    // Deleting the entry being visited is safe in a Map's own iteration.
    for (const [key, source] of this.sources) {
      const start = await this.deps.liveness.startTimeOf(source.pid).catch(() => null);
      const paneThere = source.target.paneIds().includes(source.paneId);
      if (start === source.pidStartTime && paneThere) continue;
      this.forget(key);
      this.log(`[surface] ${EDGE_TAG} event=closed kind=end pid=${String(source.pid)} session=${source.target.session} pane=${source.paneId}`);
      if (paneThere) this.deliver(source.target, source.paneId, { kind: "end", record: source.record, at: now });
    }
  }
}
