// Surface shadow mode (M56 spec 04). On every poll, when `COLLIE_SURFACE_SHADOW=1`, the bridge reads
// each agent pane, computes its Surface from the screen alone (web/src/lib/surface/fold.ts) beside the
// old verdict, and keeps counters. Nothing reads the Surface to decide a send yet: the composer keeps
// its old inputs until spec 06. The phone snapshot carries the Surface per pane for the next spec.
//
// The old verdict is "the adapter's own input-box reader found the box and no block owns the
// keyboard" (web/src/lib/surface/lift.ts `legacyFree`). It never claimed the turn or an empty box: the
// old reader says yes on a draft and on a running turn, where the Surface's `free` is no by design.
// So the comparison masks those two claims out (`freeOnOldAxis`): a disagreement is a read where the
// Surface and the old verdict differ on "no modal is up and the box can be reached". Without the mask
// every draft and every running poll would be a journal line, and the real classes would drown.
//
// A disagreement is one journal line with the pane, the revision, both verdicts, the claims, the
// reason and a short hash of the bottom cluster. Never the rows: they can hold secrets. A read is
// logged once, by its revision and its text, and one pane repeats one class (the same claims, the
// same verdicts) at most once a minute: a running turn moves its screen on every poll. The counters
// count every new read, keyed by harness and version.
//
// No harness name lives here (no-harness-names.test.ts scans this folder). The agent string comes
// from the multiplexer and picks the profile by id; the version comes from the profile's binary.

import type { MuxAdapter } from "../mux/types.ts";
import { redactText } from "../redact.ts";
import type { AgentView } from "../types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { DEFAULT_EDGE_PROFILE, type EdgeKind } from "../../web/src/lib/surface/edges.ts";
import { emptyFoldState, readFold, stepFold, type FoldContext, type FoldState, type SurfaceInput, type SurfaceRead } from "../../web/src/lib/surface/fold.ts";
import { readIsUnstyled, rowText, type IdleProfile } from "../../web/src/lib/surface/frame.ts";
import { legacyFree, liftAsk, liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { findProfile, loadProfiles, profileFor, type Profile } from "../../web/src/lib/surface/profile.ts";
import { askOf, frameImageKey, isFree, modalWord, shortHash, type Ask, type Surface, type SurfaceTurn } from "../../web/src/lib/surface/surface.ts";
import type { CounterKey } from "./counters.ts";
import { ASK_LIFETIME_MS, type AskBook } from "./ask.ts";
import { spawnBinaryVersion } from "./binary-version.ts";
import { steerTrusted } from "./protocol.ts";
import type { Block } from "../../web/src/lib/blocks.ts";

/** How many rows of the viewport one shadow read asks for. `viewport` scope never moves a screen. */
export const SHADOW_READ_LINES = 120;
/** How long a binary version read is trusted before it is read again. */
export const VERSION_TTL_MS = 10 * 60_000;
/** The journal tag of a disagreement line. `journalctl ... | grep surface.shadow.disagree` reads them. */
export const DISAGREE_TAG = "surface.shadow.disagree";
/** How often one pane may log one disagreement class again. The counters count every one. */
export const DISAGREE_REPEAT_MS = 60_000;

/** The counters for one harness and version. */
export interface ShadowCounters {
  /** New reads counted (a read whose revision had not been counted before). */
  observed: number;
  free: number;
  /** Reads neither free nor a modal with a claim unknown, by reason. `weak-cue` is an unknown modal with no reason. */
  unknown: Record<string, number>;
  /** Reads with a modal up, by kind: an ask's kind, or `unreadable`. */
  modal: Record<string, number>;
  /** Reads where the Surface and the old verdict differ (see `freeOnOldAxis`). */
  disagreements: number;
}

export interface ShadowPane {
  readonly pane: string;
  readonly harness: string;
  readonly version: string;
  /** The profile status at that version (`verified`, `provisional`, `revoked`), null with no profile. */
  readonly status: string | null;
  readonly surface: Surface;
  readonly legacyFree: boolean;
}

export interface ShadowReport {
  readonly panes: readonly ShadowPane[];
  readonly counters: Readonly<Record<string, ShadowCounters>>;
}

/** Reads a binary's version for a profile, or null. Injected so tests run no process. */
export type VersionReader = (profile: Profile) => Promise<string | null>;

export interface ShadowOptions {
  readonly mux: Pick<MuxAdapter, "readGrid">;
  readonly pollMs: number;
  /** Where a disagreement line goes. Defaults to `console.log`, which is the journal under systemd. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly version?: VersionReader;
  /**
   * Compare each read with the old readers and log every disagreement (spec 04's shadow mode). Off
   * once the Send Protocol makes the Surface the verdict (M56 spec 06): the counters still count, and
   * nothing reads the old verdict. Defaults to on.
   */
  readonly compare?: boolean;
  /**
   * The persisted counters (M56 spec 09): every new read is also counted per harness, version, profile
   * id and status in the day file, and an `unknown` one files the hash of its bottom cluster. Called
   * inside a try; it never changes the Surface.
   */
  readonly ledger?: { read(key: CounterKey, surface: Surface, frame: string | null): void; edge?(key: CounterKey, word: string): void } | undefined;
  /**
   * The session's ask book and the pane generation (M56 spec 08). With it every lifted dialog gets the
   * book's single-use id, the one the answer route knows; without it (the Send Protocol off) an ask
   * is named by its content alone and nothing answers it.
   */
  readonly asks?: { readonly book: AskBook; readonly generation: (paneId: string) => string | null };
  /**
   * Runs `run` after `ms` and returns a cancel (M56 spec 11: the fresh read an edge asks for).
   * Defaults to an unref'd timer. A test passes its own clock.
   */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

/** The default scheduler: an unref'd timer, cancelled by clearing it. */
const timerSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

interface PaneState {
  /** The fold's state: the newest read, the edges' blocks and the lost-Stop count (M56 spec 11). */
  fold: FoldState;
  seq: number;
  /** The pane as the newest poll saw it, so an edge's fresh read can read it again. */
  agent: AgentView;
  /** The profile's edge timing. */
  settleMs: number;
  rereadMs: number;
  /** The cancel of the fresh read an edge asked for, while it waits. */
  reread: (() => void) | null;
  lastLegacy: boolean;
  /** The read last counted and logged: its revision and a hash of its text (see `observePane`). */
  countedRead: string | null;
  /** The revision of the newest good read, carried by an unreachable one. */
  lastRevision: number;
  read: SurfaceRead | null;
  harness: string;
  version: string;
  status: string | null;
  /** Whether the range the version fell in or borrowed is revoked, as `StopService` reads `match.range.status`. */
  rangeRevoked: boolean;
  profileId: string;
  idle: IdleProfile | null;
  /** When each disagreement class last made a journal line on this pane. */
  logged: Map<string, number>;
  /** The box rows a request proved stale ({@link SurfaceShadow.markStale}), until a read shows other rows; null with none. */
  staleFrame: string | null;
}

function emptyCounters(): ShadowCounters {
  return { observed: 0, free: 0, unknown: {}, modal: {}, disagreements: 0 };
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function verdict(free: boolean): string {
  return free ? "free" : "not-free";
}

/**
 * The Surface's verdict on the old verdict's axis: no modal is up and the box can be reached (empty or
 * a draft), whatever the turn. `free` itself adds "the turn is idle and the box is empty", two claims
 * the old reader never made.
 */
export function freeOnOldAxis(surface: Surface): boolean {
  return surface.modal === "none" && (surface.composer === "empty" || surface.composer === "draft");
}

export class SurfaceShadow {
  private readonly panes = new Map<string, PaneState>();
  private readonly counters = new Map<string, ShadowCounters>();
  private readonly versions = new Map<string, { version: string | null; at: number; pending: boolean }>();
  private observing = false;
  /** The read in flight per pane: a poll and a fresh read an edge asked for never read one pane at once. */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly readVersion: VersionReader;

  constructor(private readonly options: ShadowOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? (() => Date.now());
    this.readVersion = options.version ?? spawnBinaryVersion;
  }

  /** The newest Surface of a pane, or undefined before its first read. */
  surfaceOf(paneId: string): Surface | undefined {
    return this.panes.get(paneId)?.read?.surface;
  }

  /** Whether the pane's newest read shows an ask (a card the phone can answer). The poll lifts such a
   *  pane to `blocked` (state-engine.ts `liftScreenAsks`, M78 spec 07). A box proven stale is no ask. */
  askOnScreen(paneId: string): boolean {
    const surface = this.surfaceOf(paneId);
    return surface !== undefined && surface.staleFrame !== true && askOf(surface.modal) !== null;
  }

  /**
   * The input box of the pane's newest screen read, when it was read and the turn the Surface claimed
   * (ADR 0122): the box's text, "" when
   * empty or showing the placeholder, null when that read found no box (a dialog over it, an unreadable
   * screen). Null before the pane's first read. The Send Protocol reads it for queued sends that came
   * back to the box; the box text never leaves the bridge from here.
   */
  boxOf(paneId: string): { readonly box: string | null; readonly at: number; readonly turn: SurfaceTurn; readonly plain: boolean } | null {
    const state = this.panes.get(paneId);
    const fold = state?.fold;
    if (fold?.screen == null) return null;
    const frame = fold.screenRead?.frame ?? null;
    const turn = state?.read?.surface.turn ?? "unknown";
    // A read with no styling at all (herdr-core): a draft there may be the placeholder (M78 spec 06).
    const plain = fold.screen.rows !== null && readIsUnstyled(fold.screen.rows);
    return { box: frame === null ? null : frame.placeholder ? "" : frame.interior.text, at: fold.screen.at, turn, plain };
  }

  /**
   * Whether a Stop (M68) has a key to press on this pane: the pane was read under a profile whose
   * `keys.interrupt` names a key, and the profile is not revoked at the binary's version. The phone
   * draws its Stop button from this and from nothing else, so no harness name lives in the web app.
   */
  canStopOf(paneId: string): boolean {
    const state = this.panes.get(paneId);
    if (state === undefined || state.read === null || state.status === "revoked" || state.rangeRevoked) return false;
    const profile = loadProfiles().get(state.profileId);
    return profile !== undefined && profile.keys.interrupt.length > 0;
  }

  /** Every pane's Surface and every counter, for the debug route. */
  report(): ShadowReport {
    const panes: ShadowPane[] = [];
    for (const [pane, state] of this.panes) {
      if (state.read === null) continue;
      panes.push({ pane, harness: state.harness, version: state.version, status: state.status, surface: state.read.surface, legacyFree: state.lastLegacy });
    }
    return { panes, counters: Object.fromEntries(this.counters) };
  }

  /**
   * Whether the pane's harness may be steered from the phone (M69): its profile names a steer key and
   * the binary's version may be trusted with a running turn ({@link steerTrusted}), the rule the Send
   * Protocol applies to a steer. False before the pane's first read and on an unread version.
   */
  canSteer(paneId: string): boolean {
    const state = this.panes.get(paneId);
    if (state === undefined || state.profileId === "-" || state.version === "unread") return false;
    return steerTrusted(profileFor(state.profileId, state.version, { log: () => undefined }));
  }

  /** The persisted counter key of a pane (spec 09's row), or undefined before its first read. */
  counterKeyOf(paneId: string): CounterKey | undefined {
    const state = this.panes.get(paneId);
    return state === undefined ? undefined : { harness: state.harness, version: state.version, profileId: state.profileId, status: state.status ?? "-" };
  }

  /** The counter key of a pane: `harness@version`. */
  keyOf(paneId: string): string | undefined {
    const state = this.panes.get(paneId);
    return state === undefined ? undefined : `${state.harness}@${state.version}`;
  }

  /**
   * One poll. Reads each agent pane's viewport (one extra multiplexer read per agent pane, only while
   * shadow mode is on), folds, compares, counts. The counters and the log line take a read once, by
   * its revision and its text, so a screen that did not move is not counted twice. A poll that lands while the
   * last one is still reading adds a tick to every pane instead, so a slow multiplexer shows as stale
   * and never as free. Never throws.
   */
  async observe(agents: readonly AgentView[]): Promise<void> {
    const at = this.now();
    if (this.observing) {
      for (const state of this.panes.values()) {
        this.push(state, { seq: ++state.seq, source: "tick", at });
        if (state.read !== null) state.read = this.folded(state);
      }
      return;
    }
    this.observing = true;
    try {
      const live = new Set(agents.map((a) => a.paneId));
      for (const [id, state] of this.panes) {
        if (live.has(id)) continue;
        state.reread?.();
        this.panes.delete(id);
      }
      for (const agent of agents) {
        try {
          await this.readPane(agent, "poll");
        } catch (err) {
          console.warn(`[surface] shadow read of ${agent.paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.observing = false;
    }
  }

  /**
   * A harness's profile and its binary's version. The first read of a profile waits for the version
   * (the shadow runs beside the poll, never in it); later reads use the cached one and refresh it in
   * the background once it is older than VERSION_TTL_MS.
   */
  private async profileOf(harness: string): Promise<{ profile: Profile | null; version: string }> {
    const profile = findProfile(loadProfiles(), harness) ?? null;
    if (profile === null) return { profile: null, version: "-" };
    const known = this.versions.get(profile.id);
    if (known === undefined) {
      const version = await this.readVersion(profile);
      this.versions.set(profile.id, { version, at: this.now(), pending: false });
      return { profile, version: version ?? "unread" };
    }
    if (this.now() - known.at > VERSION_TTL_MS && !known.pending) {
      known.pending = true;
      this.readVersion(profile).then(
        (version) => this.versions.set(profile.id, { version, at: this.now(), pending: false }),
        () => this.versions.set(profile.id, { ...known, at: this.now(), pending: false }),
      );
    }
    return { profile, version: known.version ?? "unread" };
  }

  /**
   * One read of one pane, through the pane's guard. A poll that finds a read in flight skips the pane:
   * that read is at least as fresh. A fresh read an edge asked for waits for the read in flight, then
   * reads again, because the read in flight may have started before the edge.
   */
  private async readPane(agent: AgentView, why: "poll" | "edge"): Promise<void> {
    const busy = this.reading.get(agent.paneId);
    if (busy !== undefined) {
      if (why === "poll") return;
      await busy.catch(() => undefined);
      return this.readPane(agent, why);
    }
    const run = this.observePane(agent).finally(() => this.reading.delete(agent.paneId));
    this.reading.set(agent.paneId, run);
    return run;
  }

  private async observePane(agent: AgentView): Promise<void> {
    const harness = agent.agent;
    const { profile, version } = await this.profileOf(harness);
    // The status is looked up once the binary was read, so its once-per-version note in the journal
    // names a real version. The anchors are the profile's whatever the status: the status gates the
    // send path (spec 05), not the reading.
    const match = profile === null || version === "unread" ? null : profileFor(profile.id, version);
    const status = profile === null ? null : version === "unread" ? "provisional" : (match?.status ?? null);
    const rangeRevoked = match?.range?.status === "revoked";
    const idle = profile?.idle ?? null;

    const edges = profile?.edges ?? DEFAULT_EDGE_PROFILE;
    let state = this.panes.get(agent.paneId);
    if (state === undefined) {
      state = {
        fold: emptyFoldState(),
        seq: 0,
        agent,
        settleMs: edges.settleMs,
        rereadMs: edges.rereadMs,
        reread: null,
        lastLegacy: false,
        countedRead: null,
        lastRevision: 0,
        read: null,
        // Counted under the profile's id, so each name a multiplexer reports for a harness files under one row.
        harness: profile?.id ?? harness,
        version,
        status,
        rangeRevoked,
        profileId: profile?.id ?? "-",
        idle,
        logged: new Map(),
        staleFrame: null,
      };
      this.panes.set(agent.paneId, state);
    }
    state.agent = agent;
    state.settleMs = edges.settleMs;
    state.rereadMs = edges.rereadMs;
    state.harness = profile?.id ?? harness;
    state.version = version;
    state.status = status;
    state.rangeRevoked = rangeRevoked;
    state.profileId = profile?.id ?? "-";
    state.idle = idle;

    // A read is new when its revision OR its text moved. The revision alone is not enough: Herdr
    // answers a `visible` read with revision 0 on every pane (HERDR_API.md, "revision is a stub"), and
    // a read counted by revision alone would be counted once per pane, ever.
    let readKey: string;
    // The time of the read is taken right before it, never before the profile lookup: the fold orders
    // reads by this time, and a version read can take a while.
    const at = this.now();
    const grid = await this.options.mux.readGrid(agent.paneId, { scope: "viewport", lines: SHADOW_READ_LINES, styling: "preserve" });
    if (!grid.ok) {
      readKey = `unreachable:${String(state.lastRevision)}`;
      this.push(state, { seq: ++state.seq, source: "screen", at, revision: state.lastRevision, rows: null, ask: null });
      state.lastLegacy = false;
    } else {
      readKey = `${String(grid.value.revision)}:${shortHash(grid.value.text)}`;
      state.lastRevision = grid.value.revision;
      const rows = splitLines(parseAnsi(grid.value.text));
      const blocks = readerBlocks(rows, harness);
      this.push(state, { seq: ++state.seq, source: "screen", at, revision: grid.value.revision, rows, ask: this.askOf(agent.paneId, blocks, grid.value.revision, profile) });
      state.lastLegacy = this.options.compare === false ? false : legacyFree(rows, blocks, harness);
    }

    const read = this.folded(state);
    state.read = read;
    if (state.countedRead === readKey) return;
    state.countedRead = readKey;
    this.count(agent.paneId, state, read);
  }

  /**
   * The Send Protocol proved that the box a pane shows does not take keys and a second read showed the same rows
   * (2026-10-25): `frame` names the box's rows ({@link frameImageKey}). The pane's Surface carries
   * `staleFrame` on every read that shows the same rows, and the mark goes at the first read that shows
   * other rows or no box. A pane the shadow has not read takes no mark. Never throws.
   */
  markStale(paneId: string, frame: string): void {
    const state = this.panes.get(paneId);
    if (state === undefined) return;
    state.staleFrame = frame;
    if (state.read !== null) state.read = this.folded(state);
  }

  /** The fold's read of a pane, marked `staleFrame` while its newest screen shows the box rows a request proved stale. */
  private folded(state: PaneState): SurfaceRead {
    const read = readFold(state.fold, this.contextOf(state));
    if (state.staleFrame === null) return read;
    const rows = state.fold.screen?.rows ?? null;
    const frame = state.fold.screenRead?.frame ?? null;
    if (rows === null || frame === null || frameImageKey(rows.map((row) => rowText(row)), frame.top, frame.bottom) !== state.staleFrame) {
      state.staleFrame = null;
      return read;
    }
    return { ...read, surface: { ...read.surface, staleFrame: true } };
  }

  /** The ask a read lifted: through the session's book when it has one, else named by its content. */
  private askOf(paneId: string, blocks: readonly Block[], revision: number, profile: Profile | null): Ask | null {
    const asks = this.options.asks;
    if (asks === undefined) return liftAsk(blocks, revision);
    return asks.book.publish(paneId, asks.generation(paneId) ?? "gone", liftDialog(blocks), profile?.ask?.lifetimeMs ?? ASK_LIFETIME_MS);
  }

  private contextOf(state: PaneState): FoldContext {
    return { idle: state.idle, pollMs: this.options.pollMs, settleMs: state.settleMs };
  }

  /** One input into the pane's fold. A block the screen ended with free reads is a lost-Stop incident. */
  private push(state: PaneState, input: SurfaceInput): void {
    const before = state.fold.lostStops;
    state.fold = stepFold(state.fold, input, this.contextOf(state));
    if (state.fold.lostStops === before) return;
    this.countEdge(state, "lost-stop");
    this.log(`[surface] surface.lost-stop pane=${state.agent.paneId} harness=${state.harness} version=${state.version}`);
  }

  /**
   * A hook edge placed on this pane (M56 spec 11). It goes into the fold, which marks the newest read
   * stale, and a fresh read follows after the profile's re-read delay. The edge is counted by kind. A
   * pane the shadow has not read yet takes no edge: it has no Surface to change. Returns whether the
   * pane took it. Never throws.
   */
  edge(paneId: string, kind: EdgeKind, at: number): boolean {
    const state = this.panes.get(paneId);
    if (state === undefined) return false;
    try {
      this.push(state, { seq: ++state.seq, source: "edge", at, kind });
      if (state.read !== null) state.read = this.folded(state);
      this.countEdge(state, kind);
      state.reread?.();
      state.reread = (this.options.schedule ?? timerSchedule)(() => {
        state.reread = null;
        // The pane may have left: only a pane still in the map is read again.
        if (this.panes.get(paneId) !== state) return;
        this.readPane(state.agent, "edge").catch((err) => {
          console.warn(`[surface] fresh read of ${paneId} failed: ${String(err)}`);
        });
      }, state.rereadMs);
    } catch (err) {
      console.warn(`[surface] edge on ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  /**
   * Collie's own Stop receipt said `stopped` on this pane (M68): two fresh reads after the interrupt
   * key showed the turn idle and no dialog. A harness that fires no stop hook on an interrupt (Claude
   * Code 2.1.309, on Escape and on a refused permission) leaves the prompt edge's running block open,
   * and the screen may hold nothing that ends it: Escape before the first token puts the prompt back
   * into the box, a draft, so the lost-Stop reads never count (live rerun 2026-10-23: 20 s and more).
   * This is the stop the hook did not send: it goes into the fold as a `stop` edge, which ends the
   * blocks and makes no free, and is counted as `stop-receipt`, apart from the hooks' own `stop`.
   * No fresh read is asked for: the route pokes the engine. Returns whether the pane took it. Never throws.
   */
  stopSeen(paneId: string): boolean {
    const state = this.panes.get(paneId);
    if (state === undefined) return false;
    try {
      this.push(state, { seq: ++state.seq, source: "edge", at: this.now(), kind: "stop" });
      if (state.read !== null) state.read = this.folded(state);
      this.countEdge(state, "stop-receipt");
    } catch (err) {
      console.warn(`[surface] stop receipt on ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  /** One edge word into the persisted counters (a kind, `lost-stop` or `stop-receipt`). A failure is a warning. */
  private countEdge(state: PaneState, word: string): void {
    const ledger = this.options.ledger;
    if (ledger?.edge === undefined) return;
    try {
      ledger.edge({ harness: state.harness, version: state.version, profileId: state.profileId, status: state.status ?? "-" }, word);
    } catch (err) {
      console.warn(`[surface] counters failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One new read into the persisted counters. A failure is a warning, never a different Surface. */
  private persist(state: PaneState, surface: Surface, frame: string | null): void {
    const { ledger } = this.options;
    if (ledger === undefined) return;
    try {
      ledger.read({ harness: state.harness, version: state.version, profileId: state.profileId, status: state.status ?? "-" }, surface, frame);
    } catch (err) {
      console.warn(`[surface] counters failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private count(paneId: string, state: PaneState, read: SurfaceRead): void {
    const key = `${state.harness}@${state.version}`;
    let counters = this.counters.get(key);
    if (counters === undefined) {
      counters = emptyCounters();
      this.counters.set(key, counters);
    }
    const { surface } = read;
    this.persist(state, surface, read.cues?.hash ?? null);
    const free = isFree(surface);
    counters.observed++;
    if (free) counters.free++;
    const modal = surface.modal;
    const ask = askOf(modal);
    if (ask !== null) bump(counters.modal, ask.kind);
    else if (modal === "unreadable") bump(counters.modal, "unreadable");
    else {
      // Neither free nor a modal: count why a claim is unknown. A weak cue carries no reason.
      const anyUnknown = surface.turn === "unknown" || modal === "unknown" || surface.composer === "unknown";
      if (!free && anyUnknown) bump(counters.unknown, surface.reason ?? (modal === "unknown" ? "weak-cue" : "other"));
    }
    if (this.options.compare === false) return;
    const axis = freeOnOldAxis(surface);
    if (axis === state.lastLegacy) return;
    counters.disagreements++;
    const kind = `${verdict(axis)}/${verdict(state.lastLegacy)}/${surface.turn}/${modalWord(surface.modal)}/${surface.composer}/${surface.reason ?? "-"}`;
    const now = this.now();
    const last = state.logged.get(kind);
    if (last !== undefined && now - last < DISAGREE_REPEAT_MS) return;
    state.logged.set(kind, now);
    this.log(
      [
        `[surface] ${DISAGREE_TAG}`,
        `pane=${paneId}`,
        `rev=${String(surface.revision)}`,
        `harness=${state.harness}`,
        `version=${state.version}`,
        `new=${verdict(axis)}`,
        `old=${verdict(state.lastLegacy)}`,
        `free=${String(free)}`,
        `turn=${surface.turn}`,
        `modal=${modalWord(surface.modal)}`,
        `composer=${surface.composer}`,
        `reason=${surface.reason ?? "-"}`,
        `cluster=${read.cues?.hash ?? "-"}`,
      ].join(" "),
    );
  }
}

/** What the debug route answers: a status and a JSON body. */
export interface SurfaceRouteAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The debug route's body (`GET /api/surface?pane=`): one pane with its harness's counters, or every
 * pane and every counter. `redact` masks the asks' option labels, as the snapshot does.
 */
export function surfaceRouteBody(shadow: SurfaceShadow, paneId: string | null, redact: boolean): SurfaceRouteAnswer {
  const report = shadow.report();
  const panes = redact ? report.panes.map((pane) => ({ ...pane, surface: maskSurface(pane.surface) })) : report.panes;
  if (paneId === null) return { status: 200, body: { panes, counters: report.counters } };
  const pane = panes.find((p) => p.pane === paneId);
  if (pane === undefined) return { status: 404, body: { error: "no surface for this pane yet" } };
  const key = `${pane.harness}@${pane.version}`;
  return { status: 200, body: { ...pane, counters: report.counters[key] ?? emptyCounters() } };
}

/** A Surface with its ask's option labels masked like the mirror (bridge/redact.ts). */
export function maskSurface(surface: Surface): Surface {
  const ask = askOf(surface.modal);
  if (ask === null) return surface;
  return { ...surface, modal: { ask: { ...ask, options: ask.options.map((option) => ({ id: option.id, label: redactText(option.label) })) } } };
}
