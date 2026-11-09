import { mkdir } from "node:fs/promises";

import type { JsonValue } from "../json.ts";
import { redactText } from "../redact.ts";
import { payloadDigest } from "../worktree-receipts.ts";
import { asJsonObject, parseJson } from "../../web/src/lib/json.ts";
import {
  freshWindowMs,
  HILL_NODE_PREFIX,
  parseTrickDocumentText,
  parseTapRequest,
  REFUSALS_MAX,
  type FactsTrigger,
  type TrickState,
  type TrickTapReply,
  type TricksReply,
  type ParsedTrickDocument,
  type Refusal,
  type TapRequest,
  type WireTrickInfo,
} from "../../web/src/lib/tricks/schema.ts";
import type { HillTrickTap } from "../hill/service.ts";
import { trickCodeHash } from "./code-hash.ts";
import { createTrickScanner, type FoundTrick, type TricksScan } from "./discover.ts";
import { scrubEnv, type ProviderEnv } from "./env.ts";
import { buildFacts, type FactsWorld } from "./facts.ts";
import type { TrickHillRun, TrickHillTrick } from "./hill.ts";
import { tricksConfigDir, trickStateDir } from "./paths.ts";
import { trickSessionPanes, type TrickSessionPanes } from "./panes.ts";
import { receiptFrame, TrickReceiptStore, type TrickReceiptRecord, type TrickReceiptSurface } from "./receipts.ts";
import { outcomeProblem, runProvider, type RunOutcome, type RunSpec } from "./run.ts";
import { TricksStore, problemLine } from "./store.ts";
import { createSwitchReader, updateSwitches, withSwitch, type SwitchEntry, type Switches } from "./switches.ts";

// THE TRICKS RUNNER (M94 slice 01): which trick runs when, and what its run leaves behind.
//
// ── WHEN A TRICK RUNS ─────────────────────────────────────────────────────────────
//   * Only while ON (the switch file), with a manifest that parsed, and with the code a person approved:
//     the switch stores the code hash (code-hash.ts) of the folder when it was switched on, and a trick
//     whose folder no longer hashes the same is "changed". A changed trick does not run, its parts go
//     stale with {@link CHANGED_LINE}, its open decisions stay, and the list says `changed: true`. Switching
//     it on again approves the code as it is now. A `config.toml` edit is not code and never stops it.
//   * Timers run only while a phone has watched in the last five minutes ({@link WATCH_WINDOW_MS}):
//     "watched" is a `/api/snapshot` or `/api/tricks` request from a paired phone (server.ts stamps it).
//     The host's own CLI and a lead's sweep of this machine do not count. A `gh` trick on `30s` makes no
//     call while the phone is in a pocket.
//   * The first run after the trick is loaded, switched on, or its code or `config.toml` changed has the
//     trigger `start`; later ones `timer`, every `every` (at least 5 s) after the last run. A trick with
//     no `every` runs once at start and then on taps only. Any other change in its folder (a log it
//     appends to, a picture in `media/`) changes nothing in the schedule.
//   * One run at a time per trick, and at most {@link RUNS_MAX} programs at once across all tricks;
//     the others wait in order, taps and decision answers ahead of timers. A tick while one runs is
//     skipped. A phone tap queues ONE deep; a second tap while one waits is refused as busy and may be
//     tried again. A decision's answer from the hill is never refused as busy: answers wait in their own
//     queue per trick (up to {@link HILL_QUEUE_MAX}), one at a time, before any timer run.
//   * Before every spawn the trick is read again: still present, on, not changed, and its manifest
//     parses. A tap that waited for a trick that went off answers `rejected`.
//   * After a failed run: 1, 5, then 30 minutes, then the trick stops ({@link BACKOFF_MS}). A change of
//     its code or `config.toml`, switching it on again, or a tap restarts it. A broken provider never
//     runs 1,440 times a day against a paid API.
//
// ── WHAT A RUN LEAVES ───────────────────────────────────────────────────────────
// stdout and stderr are masked in run.ts before anything here sees them. The document is parsed with
// the schema's one parser, against the manifest's declared places and every node kind, and stored per
// part with a rev (store.ts). A failed run keeps the last good parts,
// stale. The error line is masked and capped, and goes to the list entry, the doctor row and one log
// line when it changes, never once per run.
//
// ── TAPS ────────────────────────────────────────────────────────────────────────
// `POST /api/tricks/<host>/<id>/tap` carries the tree's intent shape `{ rid, node, intent, value }`.
// The receipt codes are the tree's: `ok` (applied), `rejected` (refused or the run failed), `unknown`
// (the run timed out and may have done its work). Before the program runs, the tap's `rid` is written
// to the receipt file (receipts.ts) as an in-flight marker, and the receipt completes it after. A repeat
// gets the same receipt again and runs nothing; a repeat still in flight waits for the first; the same
// rid with another payload is refused. A repeat after a bridge restart that finds only the marker
// answers `unknown` and runs nothing. A tap that ran nothing (the trick is off, busy or skipped) keeps
// no receipt on disk, so the same rid may simply be tried again.
//
// ── DECISIONS (M94, M96) ────────────────────────────────────────────────────────
// After a run that succeeded, the document's decisions go to the hill through `deps.decisions`
// (hill.ts): posted, superseded or withdrawn by key. A document with no `decisions` key leaves them as
// they are; an empty list withdraws them. Its refusals join the document's. A trick switched off or
// removed has every open decision withdrawn; a changed one keeps them. The answer comes back from the
// hill as a tap on `hill/<key>` (`tapFromHill`), with the answer's own rid and `seen`, the content hash
// of the version the person saw. The phone's tap route refuses a `hill/` node: a decision is answered
// on the Hill.

/** How long a phone's look keeps timers running. */
export const WATCH_WINDOW_MS = 5 * 60_000;
/** The wait after the first, second and third failure in a row. The fourth stops the trick. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** The scheduler's tick. A timer of 5 s therefore runs within a second of its due time. */
export const TICK_MS = 1000;
/** The least time between two scans of the tricks folder. */
export const SCAN_EVERY_MS = 2000;
/** The tap receipts kept in memory with their parts, newest last. The file keeps its own. */
export const TAP_RECEIPTS_MAX = 200;
/** The most trick programs running at once, across all tricks. */
export const RUNS_MAX = 4;
/** The most decision answers waiting for one trick. One more is refused as busy. */
export const HILL_QUEUE_MAX = 32;
/** The line a changed trick's parts and list entry carry. */
export const CHANGED_LINE = "This trick changed. Switch it on again to run the new code.";
/** The message of a retried tap whose run started before the bridge restarted. */
export const TAP_LOST_LINE = "The bridge restarted while this tap ran. It may have done its work; nothing ran again.";

/** What the server needs: the snapshot's rev, the watch stamp, the two routes. */
export interface TricksSurface {
  /** `tricksRev` for the snapshot, or undefined when there is no tricks folder (no field at all). */
  rev(): number | undefined;
  /** A paired phone looked (`/api/snapshot`, `/api/tricks`). */
  noteWatched(): void;
  /** `GET /api/tricks?since=`. */
  reply(since: number | undefined): Promise<TricksReply>;
  /** `POST /api/tricks/<host>/<id>/tap`. */
  tap(host: string, id: string, body: JsonValue | undefined): Promise<TapAnswer>;
  /**
   * The Tricks Space of this host (slice 03, panes.ts): one pane per `session` part of a trick that is on,
   * read from memory, never a run. Undefined when there is none, so a body with no trick session is the
   * body it always was.
   */
  sessionPanes(): TrickSessionPanes | undefined;
  /** `POST /api/tricks/<host>/<id>/switch`: write the switch file, as `collie trick on|off` does. */
  setSwitch(host: string, id: string, on: boolean): Promise<SwitchAnswer>;
}

/** What the runner needs of the trick's decisions on the hill (hill.ts `TrickHill`). */
export interface TricksHillPort {
  /** Make the hill agree with one successful run's decisions; the refusals join the trick's. */
  sync(trick: TrickHillTrick, run: TrickHillRun): Refusal[];
  /** Withdraw every open decision of a trick switched off or removed. */
  off(trick: Pick<TrickHillTrick, "id" | "name" | "memberId">): void;
  /** Every trick the map knows that is not in `present` is off. */
  prune(present: ReadonlySet<string>, memberId: string): void;
  /** The content hash of the decision the person answered. */
  seenOf(trickId: string, decisionId: string): string | undefined;
}

/** The phone's words when it taps a decision's node directly: answers go through the hill. */
export const HILL_NODE_TAP_REFUSED = "A decision is answered on the Hill, not with a tap.";

/** A tap route's answer: the HTTP status and the JSON body. */
export type TapAnswer =
  | { status: 200; body: TrickTapReply }
  | { status: 400; body: { error: "tap-invalid"; refusals: Refusal[] } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" } }
  | { status: 409; body: { error: "request-id-reused"; rid: string } };

/** The switch route's answer: the trick as the list now shows it, or why not. */
export type SwitchAnswer =
  | { status: 200; body: WireTrickInfo }
  | { status: 400; body: { error: "switch-invalid" } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" } };

export interface TricksServiceDeps {
  configDir: string;
  stateDir: string;
  /**
   * This bridge's stable id for facts, part keys and trick session ids (bridge/bridge-id.ts): the crew
   * member id, or the install id. Resolved once at boot: a bridge that joins a crew while it runs keeps
   * this id until it restarts.
   */
  memberId: string;
  /** The id this bridge served before a crew join or leave: a tap or a switch under it still lands. */
  previousId?: string | null;
  /**
   * Write the id to the state folder before a run hands it to a program (bridge-id.ts `keep`): a run is
   * the first use, never the start. Absent in a test.
   */
  keepId?: () => void;
  /**
   * The sessions and spaces, read at run time, with session ids keyed on `memberId`, and the machine's
   * display name (`machine`) the facts' `host` fields say.
   */
  world: (memberId: string) => Omit<FactsWorld, "memberId">;
  /** The unit's environment; each run gets the allow-listed part of it (env.ts). */
  env: ProviderEnv;
  now?: () => number;
  /** The process runner. A test passes a fake or the real one with short limits. */
  run?: (spec: RunSpec) => Promise<RunOutcome>;
  /** Limits passed to the runner, for tests. */
  limits?: Pick<RunSpec, "timeoutMs" | "stdoutCap" | "stderrCap">;
  warn?: (line: string) => void;
  /** The first rev. Default the start time in ms (store.ts says why). */
  revBase?: number;
  /** The platform, for the shell. */
  platform?: NodeJS.Platform;
  /** The trick's decisions on the hill. Absent: decisions are parsed and posted nowhere. */
  decisions?: TricksHillPort;
  /** The tap receipt file. Default `<stateDir>/tricks/receipts.json`. */
  receipts?: TrickReceiptSurface;
}

interface QueuedTap {
  request: TapRequest;
  /** Only on a decision's answer from the hill: the content hash the person saw. */
  seen?: string;
  /** The in-flight marker written before the program runs. */
  marker: TrickReceiptRecord;
  /** Set once the marker reached disk: only then is the receipt completed on disk. */
  marked: boolean;
  resolve: (reply: TrickTapReply) => void;
}

/** A queued tap as the trigger its run gets. */
function tapTrigger(tap: Pick<QueuedTap, "request" | "seen">): FactsTrigger {
  return tap.seen === undefined ? { kind: "tap", ...tap.request } : { kind: "tap", ...tap.request, seen: tap.seen };
}

interface TrickRuntime {
  found: FoundTrick;
  on: boolean;
  /** On, but the code no longer hashes as it did when it was switched on. */
  changed: boolean;
  /** Failed runs in a row. */
  failures: number;
  stopped: boolean;
  /** The next run is a `start` run. */
  pendingStart: boolean;
  /** Earliest time the next start or timer run may begin. */
  nextAt: number;
  /** The run this trick has going or waiting for a slot. */
  running: Promise<void> | null;
  /** A phone tap waiting, one deep. */
  queued: QueuedTap | null;
  /** Decision answers waiting, oldest first. */
  hillQueue: QueuedTap[];
  lastRunAt?: number;
  lastError?: string;
  /** The last document's refusals. */
  docRefusals: Refusal[];
}

interface Receipt {
  digest: string;
  reply: TrickTapReply;
}

/** A trick's state on the wire. A changed trick reads as stopped, with {@link CHANGED_LINE} as its error. */
export function trickStateOf(rt: Pick<TrickRuntime, "on" | "found" | "stopped" | "failures"> & { changed?: boolean }): TrickState {
  if (rt.found.manifest === undefined) return "skipped";
  if (!rt.on) return "off";
  if (rt.stopped || rt.changed === true) return "stopped";
  return rt.failures > 0 ? "failing" : "ok";
}

/** Whether a switch entry approves this code: on, with the hash the folder has now. */
export function isChanged(entry: SwitchEntry | undefined, found: FoundTrick): boolean {
  if (entry === undefined || found.manifest === undefined) return false;
  return entry.hash === null || entry.hash !== found.codeHash;
}

/** The wait after the `failures`-th failure in a row, or null when the trick stops. */
export function backoffAfter(failures: number): number | null {
  return BACKOFF_MS[failures - 1] ?? null;
}

/** A fresh window as the `fresh` string a part carries, so the phone needs no manifest. */
export function freshString(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * At most `max` holders at once. A waiter is let in by the holder that leaves, urgent ones (taps and
 * decision answers) first, then in the order they came.
 */
export class RunSlots {
  private active = 0;
  private seq = 0;
  private readonly waiting: { urgent: boolean; seq: number; go: () => void }[] = [];

  constructor(private readonly max: number) {}

  /** How many hold a slot now. */
  get held(): number {
    return this.active;
  }

  /** Wait for a slot; the answer gives it back, once. */
  async acquire(urgent: boolean): Promise<() => void> {
    if (this.active < this.max && this.waiting.length === 0) {
      this.active += 1;
      return this.releaser();
    }
    await new Promise<void>((go) => {
      this.waiting.push({ urgent, seq: this.seq, go });
      this.seq += 1;
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.handOver();
    };
  }

  /** Pass the slot to the next waiter, or free it. */
  private handOver(): void {
    const urgent = this.waiting.filter((w) => w.urgent);
    const pool = urgent.length > 0 ? urgent : this.waiting;
    const next = pool.reduce<(typeof this.waiting)[number] | undefined>((best, w) => (best === undefined || w.seq < best.seq ? w : best), undefined);
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    this.waiting.splice(this.waiting.indexOf(next), 1);
    next.go();
  }
}

export class TricksService implements TricksSurface {
  private readonly deps: TricksServiceDeps;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private readonly store: TricksStore;
  private readonly scanner: ReturnType<typeof createTrickScanner>;
  private readonly readSwitches: () => Promise<Switches>;
  private readonly runtimes = new Map<string, TrickRuntime>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly inflight = new Map<string, { digest: string; reply: Promise<TrickTapReply> }>();
  private readonly receiptFile: TrickReceiptSurface;
  private receiptsLoaded: Promise<void> | null = null;
  private readonly slots = new RunSlots(RUNS_MAX);
  private watchedAt = -Infinity;
  private folderExists = false;
  private scannedAt = -Infinity;
  private scanning: Promise<void> | null = null;
  /** Scans started, and the start number of the last one that finished: a write waits for a later scan. */
  private scansStarted = 0;
  private scanDone = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Switch writes run one at a time, so two phones cannot lose each other's change. */
  private switching: Promise<unknown> = Promise.resolve();

  constructor(deps: TricksServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((line) => console.warn(`[tricks] ${line}`));
    this.store = new TricksStore(deps.revBase ?? Date.now());
    this.scanner = createTrickScanner(tricksConfigDir(deps.configDir), { warn: this.warn });
    this.readSwitches = createSwitchReader(deps.stateDir, this.warn);
    this.receiptFile = deps.receipts ?? new TrickReceiptStore(deps.stateDir, this.warn);
  }

  /** Start the scheduler. Silent and nearly free while no phone watches: a tick then does nothing. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  rev(): number | undefined {
    return this.folderExists ? this.store.rev : undefined;
  }

  noteWatched(): void {
    this.watchedAt = this.now();
    void this.refresh();
  }

  /** Whether a phone looked within {@link WATCH_WINDOW_MS}. */
  watched(): boolean {
    return this.now() - this.watchedAt < WATCH_WINDOW_MS;
  }

  /** The PATH a provider gets. */
  runnerPath(): string {
    return scrubEnv(this.deps.env).PATH ?? "";
  }

  /** How many programs run (or hold a slot) now. For a test. */
  runsHeld(): number {
    return this.slots.held;
  }

  async reply(since: number | undefined): Promise<TricksReply> {
    await this.refresh();
    return this.store.reply(since, this.folderExists ? this.runnerPath() : undefined);
  }

  sessionPanes(): TrickSessionPanes | undefined {
    if (!this.folderExists) return undefined;
    const all = this.store.reply(undefined);
    return trickSessionPanes({
      host: this.deps.memberId,
      tricks: all.tricks,
      parts: all.parts,
      dirOf: (id) => this.runtimes.get(id)?.found.dir,
      now: this.now(),
    });
  }

  /**
   * Read the folder and the switches again, at most every {@link SCAN_EVERY_MS} unless `force`. Joins
   * a scan in flight. Never throws.
   */
  refresh(force = false): Promise<void> {
    if (this.scanning !== null) return this.scanning;
    if (!force && this.now() - this.scannedAt < SCAN_EVERY_MS) return Promise.resolve();
    this.scansStarted += 1;
    const mine = this.scansStarted;
    this.scanning = (async () => {
      try {
        const switches = await this.readSwitches();
        const scan = await this.scanner.scan(new Set(switches.on.keys()));
        this.apply(scan, switches);
      } catch (err) {
        this.warn(`the tricks folder could not be read: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.scannedAt = this.now();
        this.scanDone = mine;
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /** Wait for a scan that STARTED after this call, so an answer reflects a write just made. */
  private async freshScan(): Promise<void> {
    const need = this.scansStarted + 1;
    // At most: join the scan in flight, then run one of our own.
    for (let i = 0; i < 3 && this.scanDone < need; i += 1) await this.refresh(true);
  }

  /** Fold a scan and the switches into the runtimes and the list. */
  private apply(scan: TricksScan, switches: Switches): void {
    this.folderExists = scan.exists;
    const host = this.deps.memberId;
    const ids = new Set(scan.tricks.map((m) => m.id));
    // A kept scan (it ran over, or the folder could not be listed) never removes a trick.
    if (scan.kept === undefined) {
      for (const [id, rt] of this.runtimes) {
        if (ids.has(id)) continue;
        this.runtimes.delete(id);
        this.store.removeTrick(host, id);
        this.deps.decisions?.off(this.hillTrick(rt));
      }
      // A trick removed while the bridge was down has its open decisions withdrawn too.
      this.deps.decisions?.prune(ids, host);
    }
    for (const found of scan.tricks) this.applyOne(found, switches.on.get(found.id));
  }

  /** Fold one trick folder and its switch entry into its runtime and its list entry. */
  private applyOne(found: FoundTrick, entry: SwitchEntry | undefined): void {
    const host = this.deps.memberId;
    const on = entry !== undefined;
    const changed = isChanged(entry, found);
    const old = this.runtimes.get(found.id);
    if (old === undefined) {
      this.runtimes.set(found.id, {
        found,
        on,
        changed,
        failures: 0,
        stopped: false,
        pendingStart: true,
        nextAt: 0,
        running: null,
        queued: null,
        hillQueue: [],
        docRefusals: [],
      });
      // Off at start (switched off while the bridge was down): its open decisions go.
      if (!on) this.deps.decisions?.off({ id: found.id, name: found.manifest?.name ?? found.id, memberId: host });
      this.publish(found.id);
      return;
    }
    if (old.found.fingerprint !== found.fingerprint) {
      // Only a change of the code or of config.toml restarts the trick: a log or a picture changes nothing.
      const restarts = old.found.codeHash !== found.codeHash || old.found.configHash !== found.configHash;
      old.found = found;
      if (restarts) this.restart(old);
      if (found.manifest === undefined) this.store.markStale(host, found.id, problemLine(found.refusals[0]?.reason ?? "trick.toml is refused."));
    }
    const switched = old.on !== on;
    const approvalMoved = old.changed !== changed;
    old.on = on;
    old.changed = changed;
    if (switched && !on) {
      this.store.dropParts(host, found.id);
      this.deps.decisions?.off(this.hillTrick(old));
    }
    // Switched on, or approved again (switched on over a changed trick, or the code went back): a start run.
    if ((switched || approvalMoved) && on && !changed) this.restart(old);
    // Changed: the parts stay, stale, and the decisions stay open.
    if (changed && (switched || approvalMoved)) this.store.markStale(host, found.id, CHANGED_LINE);
    this.publish(found.id);
  }

  /** The trick as the hill's sender names it. */
  private hillTrick(rt: TrickRuntime): TrickHillTrick {
    return { id: rt.found.id, name: rt.found.manifest?.name ?? rt.found.id, memberId: this.deps.memberId, dir: rt.found.dir };
  }

  /** Whether a route's host segment names this bridge: its id, or the id it served before a crew join. */
  private isOwn(host: string): boolean {
    return host === this.deps.memberId || (this.deps.previousId != null && host === this.deps.previousId);
  }

  private restart(rt: TrickRuntime): void {
    rt.failures = 0;
    rt.stopped = false;
    rt.pendingStart = true;
    rt.nextAt = 0;
  }

  /** Put a trick's list entry in the store, which takes a rev only when it changed. */
  private publish(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt === undefined) return;
    const m = rt.found.manifest;
    const info: WireTrickInfo = {
      host: this.deps.memberId,
      id,
      name: m?.name ?? id,
      icon: m?.icon ?? "plug",
      on: rt.on,
      state: trickStateOf(rt),
      places: m?.places ?? [],
      provenance: { via: "folder" },
    };
    const error = m === undefined ? rt.found.refusals[0]?.reason : rt.changed ? CHANGED_LINE : rt.lastError;
    if (error !== undefined) info.error = problemLine(error);
    if (rt.lastRunAt !== undefined) info.lastRunAt = new Date(rt.lastRunAt).toISOString();
    const refusals = [...rt.found.refusals, ...rt.docRefusals].slice(0, REFUSALS_MAX);
    if (refusals.length > 0) info.refusals = refusals;
    if (rt.changed) info.changed = true;
    if (m?.env !== undefined) info.env = m.env;
    this.store.setInfo(info);
  }

  /** Whether the trick may run at all: on, approved and with a manifest. */
  private runnable(rt: TrickRuntime): boolean {
    return rt.on && !rt.changed && rt.found.manifest !== undefined;
  }

  /** Whether a start or timer run is due now. */
  private due(rt: TrickRuntime, now: number): boolean {
    if (!this.runnable(rt) || rt.stopped) return false;
    if (rt.running !== null || rt.queued !== null || rt.hillQueue.length > 0) return false;
    if (now < rt.nextAt) return false;
    // A failed start run keeps `pendingStart`, so it is tried again after its backoff; a trick with no
    // `every` never runs on the clock otherwise.
    return rt.pendingStart || rt.found.manifest?.everyMs !== undefined;
  }

  /**
   * One scheduler tick: nothing at all unless a phone watched; else a scan (throttled) and every due
   * run started. Resolves when the runs it started are done, which is what a test waits on.
   */
  async tick(): Promise<void> {
    if (!this.watched()) return;
    await this.refresh();
    const now = this.now();
    const started: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      if (!this.due(rt, now)) continue;
      const trigger: FactsTrigger = rt.pendingStart ? { kind: "start" } : { kind: "timer" };
      started.push(this.begin(rt, trigger, null));
    }
    await Promise.all(started);
  }

  /**
   * Read one trick again before its program starts. Answers why it may not run, or null. A folder
   * that changed is folded in on the way, so a code change stops this very run.
   */
  private async recheck(rt: TrickRuntime): Promise<string | null> {
    const id = rt.found.id;
    if (this.runtimes.get(id) !== rt) return "The trick is gone.";
    const [found, switches] = await Promise.all([this.scanner.one(id), this.readSwitches()]);
    if (found === null) return "The trick's folder could not be read again before the run.";
    if (this.runtimes.get(id) !== rt) return "The trick is gone.";
    this.applyOne(found, switches.on.get(id));
    if (rt.found.manifest === undefined) return "The trick's trick.toml is refused. Run `collie trick check` on its folder.";
    if (!rt.on) return "The trick is off.";
    if (rt.changed) return CHANGED_LINE;
    return null;
  }

  /**
   * Run once: wait for a slot (a tap ahead of a timer), read the trick again, write the tap's marker,
   * run, answer the tap. Then the next waiting tap of this trick. The promise ends when this run (not
   * the next tap) is done.
   */
  private begin(rt: TrickRuntime, trigger: FactsTrigger, tap: QueuedTap | null): Promise<void> {
    const rid = trigger.kind === "tap" ? trigger.rid : "";
    const run = (async () => {
      const release = await this.slots.acquire(tap !== null);
      try {
        const why = await this.recheck(rt);
        if (why !== null) {
          tap?.resolve({ rid, code: "rejected", message: why });
          return;
        }
        if (tap !== null) {
          tap.marked = await this.receiptFile.recordFirst(tap.marker);
          if (!tap.marked) {
            tap.resolve({ rid, code: "rejected", message: "The tap could not be recorded, so nothing ran. Try again." });
            return;
          }
        }
        const reply = await this.runOnce(rt, trigger);
        tap?.resolve(reply);
      } catch (err) {
        const line = problemLine(`The run could not start: ${err instanceof Error ? err.message : String(err)}`);
        this.warn(`${rt.found.id}: ${line}`);
        tap?.resolve({ rid, code: "rejected", message: line });
      } finally {
        release();
      }
    })();
    rt.running = run.finally(() => {
      rt.running = null;
      this.pump(rt);
    });
    return rt.running;
  }

  /** Start the next waiting tap of a trick that runs nothing: a decision answer first, then a phone tap. */
  private pump(rt: TrickRuntime): void {
    if (rt.running !== null) return;
    const next = rt.hillQueue.shift() ?? rt.queued;
    if (next === null) return;
    if (next === rt.queued) rt.queued = null;
    void this.begin(rt, tapTrigger(next), next);
  }

  /** Run the provider once and store what it left. The reply is the tap's, when the trigger is a tap. */
  private async runOnce(rt: TrickRuntime, trigger: FactsTrigger): Promise<TrickTapReply> {
    const manifest = rt.found.manifest;
    const host = this.deps.memberId;
    const id = rt.found.id;
    const rid = trigger.kind === "tap" ? trigger.rid : "";
    const revBefore = this.store.rev;
    if (manifest === undefined) return { rid, code: "rejected", message: "The trick's trick.toml is refused." };
    const startedAt = this.now();
    const state = trickStateDir(this.deps.stateDir, id);
    // The provider's own folder under <stateDir>/tricks, owner only like the rest of the state folder.
    await mkdir(state, { recursive: true, mode: 0o700 }).catch(() => {});
    // The program may keep the id in its own state: it is written down before the first run sees it.
    this.deps.keepId?.();
    const world = this.deps.world(host);
    const facts = buildFacts({ memberId: host, ...world }, { id, dir: rt.found.dir, state }, trigger);
    const outcome = await (this.deps.run ?? runProvider)({
      command: manifest.run,
      cwd: rt.found.dir,
      env: scrubEnv(this.deps.env, manifest.env ?? []),
      stdin: JSON.stringify(facts),
      platform: this.deps.platform,
      ...this.deps.limits,
    });
    rt.lastRunAt = startedAt;
    // A run that was switched off, removed or changed while it ran leaves nothing behind.
    if (this.runtimes.get(id) !== rt || !rt.on) {
      return { rid, code: "rejected", message: "The trick was switched off while it ran." };
    }
    if (rt.changed) return { rid, code: "rejected", message: CHANGED_LINE };
    let problem = outcomeProblem(outcome, 200);
    let parsed: ParsedTrickDocument | null = null;
    let decisionsListed = false;
    if (problem === null && outcome.kind === "exited") {
      // Masked in run.ts already; again here, so no runner behind the seam can hand the parser a key.
      const text = redactText(outcome.stdout);
      parsed = parseTrickDocumentText(text, { declared: manifest.places });
      if (parsed.documentRefused) problem = `The output was refused: ${parsed.refusals[0]?.reason ?? "not a document"}`;
      // An absent `decisions` key means "unchanged"; an empty list withdraws them all.
      decisionsListed = asJsonObject(parseJson(text))?.decisions !== undefined;
    }
    if (problem !== null || parsed === null || parsed.documentRefused) {
      const line = problemLine(problem ?? "The run failed.");
      this.failed(rt, line, parsed?.refusals ?? []);
      this.store.markStale(host, id, line);
      this.publish(id);
      // A timeout answers `unknown`: the run may have done its work. A failed or refused run answers `rejected`.
      const reply: TrickTapReply = { rid, code: outcome.kind === "timeout" ? "unknown" : "rejected", message: line, rev: this.store.rev };
      const mine = this.store.trickParts(host, id, revBefore);
      if (mine.parts.length > 0) reply.parts = mine.parts;
      reply.present = mine.present;
      return reply;
    }
    const freshMs = freshWindowMs(parsed.freshMs, manifest.everyMs);
    const asOf = parsed.asOf ?? new Date(startedAt).toISOString();
    this.store.applyDocument(host, id, parsed, { asOf, fresh: parsed.fresh ?? freshString(freshMs) });
    // The decisions reach the hill only from a run that succeeded and listed them. A list refused as a
    // whole (over the cap) changes nothing there either: the last good decisions stay, as the last good
    // parts do.
    const listRefused = parsed.refusals.some((refusal) => refusal.path === "/decisions" && refusal.decision === undefined);
    const posted = listRefused || !decisionsListed ? [] : (this.deps.decisions?.sync({ ...this.hillTrick(rt), name: manifest.name }, { decisions: parsed.decisions, refusedKeys: parsed.refusedDecisions }) ?? []);
    this.succeeded(rt, startedAt, [...parsed.refusals, ...posted]);
    this.publish(id);
    const mine = this.store.trickParts(host, id, revBefore);
    return { rid, code: "ok", rev: this.store.rev, parts: mine.parts, present: mine.present };
  }

  private failed(rt: TrickRuntime, line: string, refusals: Refusal[]): void {
    const changed = rt.lastError !== line;
    rt.lastError = line;
    rt.docRefusals = refusals;
    rt.failures += 1;
    const wait = backoffAfter(rt.failures);
    if (wait === null) {
      rt.stopped = true;
      this.warn(`${rt.found.id}: stopped after ${rt.failures} failed runs in a row: ${line}`);
      return;
    }
    rt.nextAt = this.now() + wait;
    if (changed) this.warn(`${rt.found.id}: ${line}; next try in ${Math.round(wait / 60_000)} min`);
  }

  private succeeded(rt: TrickRuntime, startedAt: number, refusals: Refusal[]): void {
    if (rt.failures > 0 || rt.stopped) this.warn(`${rt.found.id}: runs again`);
    rt.failures = 0;
    rt.stopped = false;
    rt.pendingStart = false;
    rt.lastError = undefined;
    rt.docRefusals = refusals;
    const every = rt.found.manifest?.everyMs;
    rt.nextAt = every === undefined ? Infinity : startedAt + every;
  }

  async tap(host: string, id: string, body: JsonValue | undefined): Promise<TapAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    const parsed = parseTapRequest(body);
    if (parsed.request === undefined) return { status: 400, body: { error: "tap-invalid", refusals: parsed.refusals } };
    // A decision's answer comes from the hill only (`tapFromHill`), so it is closed and receipted there.
    if (parsed.request.node.startsWith(HILL_NODE_PREFIX)) return { status: 200, body: { rid: parsed.request.rid, code: "rejected", message: HILL_NODE_TAP_REFUSED } };
    return this.runTap(host, id, parsed.request, undefined);
  }

  /**
   * The answer to a trick's decision, from the hill (bridge/index.ts wires it as the hill's `tap`): one
   * tap on `hill/<key>` with the answer's rid, and `seen`, the content hash of the version the person
   * saw. True when the run succeeded; a refused, failed or timed-out run is false, and nothing retries.
   */
  async tapFromHill(host: string, id: string, tap: HillTrickTap, decisionId: string): Promise<boolean> {
    const request: TapRequest = { rid: tap.rid, node: tap.node, intent: tap.intent, value: { text: tap.value.text } };
    const answer = await this.runTap(host, id, request, this.deps.decisions?.seenOf(id, decisionId));
    return answer.status === 200 && answer.body.code === "ok";
  }

  private loadReceipts(): Promise<void> {
    this.receiptsLoaded ??= this.receiptFile.load().catch(() => {});
    return this.receiptsLoaded;
  }

  private async runTap(host: string, id: string, request: TapRequest, seen: string | undefined): Promise<TapAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    const digest = payloadDigest([id, request.node, request.intent, JSON.stringify(request.value ?? null), request.from?.session ?? ""]);
    // A replay answers the same receipt again, from the receipt log, unchanged (the tree's intent rule).
    const kept = this.receipts.get(request.rid);
    if (kept !== undefined) {
      if (kept.digest !== digest) return { status: 409, body: { error: "request-id-reused", rid: request.rid } };
      return { status: 200, body: kept.reply };
    }
    const flying = this.inflight.get(request.rid);
    if (flying !== undefined) {
      if (flying.digest !== digest) return { status: 409, body: { error: "request-id-reused", rid: request.rid } };
      return { status: 200, body: await flying.reply };
    }
    // The file: a receipt from before a restart, or only its marker, which never runs twice.
    await this.loadReceipts();
    const stored = this.receiptFile.get(request.rid);
    if (stored !== undefined) {
      if (stored.payloadDigest !== digest) return { status: 409, body: { error: "request-id-reused", rid: request.rid } };
      if (stored.pending || stored.reply === null) return { status: 200, body: { rid: request.rid, code: "unknown", message: TAP_LOST_LINE } };
      return { status: 200, body: { rid: request.rid, ...stored.reply } };
    }
    await this.refresh();
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { status: 404, body: { error: "unknown-trick" } };
    const refuse = (message: string): TapAnswer => ({ status: 200, body: { rid: request.rid, code: "rejected", message } });
    if (rt.found.manifest === undefined) return refuse("The trick's trick.toml is refused. Run `collie trick check` on its folder.");
    if (!rt.on) return refuse("The trick is off.");
    if (rt.changed) return refuse(CHANGED_LINE);
    const answer = request.node.startsWith(HILL_NODE_PREFIX);
    // A decision's answer waits in its own queue; a phone tap queues one deep.
    if (answer && rt.hillQueue.length >= HILL_QUEUE_MAX) return refuse("The trick has too many answers waiting. Try again in a moment.");
    if (!answer && rt.queued !== null) return refuse("The trick is busy. Try again in a moment.");
    // A tap restarts a trick that backed off or stopped (design §3.2).
    rt.failures = 0;
    rt.stopped = false;
    const marker: TrickReceiptRecord = { requestId: request.rid, payloadDigest: digest, at: this.now(), pending: true, reply: null };
    let queued: QueuedTap | undefined;
    const reply = new Promise<TrickTapReply>((resolve) => {
      queued = seen === undefined ? { request, marker, marked: false, resolve } : { request, seen, marker, marked: false, resolve };
    });
    if (queued === undefined) throw new Error("the tap promise did not run its executor");
    if (answer) rt.hillQueue.push(queued);
    else rt.queued = queued;
    this.inflight.set(request.rid, { digest, reply });
    this.pump(rt);
    try {
      const body = await reply;
      this.receipts.set(request.rid, { digest, reply: body });
      while (this.receipts.size > TAP_RECEIPTS_MAX) {
        const oldest = this.receipts.keys().next().value;
        if (oldest === undefined) break;
        this.receipts.delete(oldest);
      }
      if (queued.marked) await this.receiptFile.record({ ...marker, pending: false, reply: receiptFrame(body) });
      return { status: 200, body };
    } finally {
      this.inflight.delete(request.rid);
    }
  }

  /**
   * Switch a trick on or off: the same file `collie trick on|off` writes, through the one locked writer
   * (switches.ts). On stores the code hash of the folder as it is now. Then the answer waits for a scan
   * that started after the write, so the list, the runtime and `tricksRev` move before it. Works for a
   * trick whose manifest is refused or that keeps failing: the switch is Collie's, not the trick's
   * (design §7).
   */
  async setSwitch(host: string, id: string, on: boolean): Promise<SwitchAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    const turn = this.switching.then(() => this.writeSwitch(id, on));
    this.switching = turn.catch(() => {});
    return await turn;
  }

  private async writeSwitch(id: string, on: boolean): Promise<SwitchAnswer> {
    await this.refresh(true);
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { status: 404, body: { error: "unknown-trick" } };
    let hash: string | null = null;
    if (on) {
      const code = await trickCodeHash(rt.found.dir);
      hash = code.ok ? code.hash : null;
    }
    const at = new Date(this.now()).toISOString();
    await updateSwitches(this.deps.stateDir, (switches) => withSwitch(switches, id, on, at, hash));
    await this.freshScan();
    const info = this.store.reply(this.store.rev).tricks.find((trick) => trick.id === id);
    if (info === undefined) return { status: 404, body: { error: "unknown-trick" } };
    return { status: 200, body: info };
  }
}
