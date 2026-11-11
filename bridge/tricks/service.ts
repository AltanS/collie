import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { redactText } from "../redact.ts";
import { payloadDigest } from "../worktree-receipts.ts";
import { asJsonObject, parseJson } from "../../web/src/lib/json.ts";
import {
  freshWindowMs,
  HILL_NODE_PREFIX,
  INPUTS_CONTRACT,
  parseTrickDocumentText,
  parseTapRequest,
  REFUSALS_MAX,
  RULES_NEVER_AUTO,
  type FactsTrigger,
  type TrickState,
  type TrickTapReply,
  type TricksReply,
  type TricksRunsOn,
  type ParsedTrickDocument,
  type Refusal,
  type TapRequest,
  type TrickManifest,
  type WireTrickInfo,
  type WireTrickPending,
  type WireTrickWarning,
} from "../../web/src/lib/tricks/schema.ts";
import type { HillTrickTap } from "../hill/service.ts";
import type { ViewGate } from "../agent-view/service.ts";
import { approveFolder, copyListing, fileCounts, migrateSwitches, powersOf, promoteCopy, pruneCopies, snapshotTrick, syncConfig, verifyCopy, type ApproveOptions } from "./approved.ts";
import { diskTrickFs, unsafeText } from "./code-hash.ts";
import { createTrickScanner, scanTrickDir, SCAN_TIMEOUT_MS, within, type FoundTrick, type TricksScan } from "./discover.ts";
import { scrubEnv, type ProgramEnv } from "./env.ts";
import { buildFacts, type FactsWorld } from "./facts.ts";
import type { TrickInputs } from "./inputs.ts";
import { readTrickMedia, type TrickMediaFile } from "./media.ts";
import { isUnlistedOfficialOrigin, shippedOfficialList, type OfficialEntry } from "./official.ts";
import { originRepoName, type ProposalOrigin } from "./origin.ts";
import { replaceTrickCode, writeProposedTrick } from "./proposal-install.ts";
import type { ProposedFile } from "./propose-wire.ts";
import type { TrickHillRun, TrickHillTrick } from "./hill.ts";
import { approvedCopyDir, approvedTrickDir, pendingTrickDir, tricksConfigDir, trickStateDir } from "./paths.ts";
import { trickSessionPanes, type TrickSessionPanes } from "./panes.ts";
import { receiptFrame, TrickReceiptStore, type TrickReceiptRecord, type TrickReceiptSurface } from "./receipts.ts";
import { outcomeProblem, runProgram, type RunOutcome, type RunSpec } from "./run.ts";
import { trickWarnings, wireWarnings } from "./scan.ts";
import { TricksStore, problemLine } from "./store.ts";
import { createSwitchReader, updateSwitches, withApproval, withEntry, withSwitch, type SwitchEntry, type Switches } from "./switches.ts";

// THE TRICKS RUNNER (M94 slice 01): which trick runs when, and what its run leaves behind.
//
// ── WHEN A TRICK RUNS ─────────────────────────────────────────────────────────────
//   * Only while ON (the switch file), from the APPROVED COPY (approved.ts): the switch stores the code
//     hash of the version a person said yes to, and `<configDir>/tricks/.collie-approved/<id>/<hash16>/` holds
//     exactly those bytes. The program runs there: its working folder, `facts.trick.dir`, its manifest
//     (the run line, `every`, `env`, the places), its pictures and the images of its decisions all come
//     from the copy. An edit of the trick's folder never stops it (see THE NEW VERSION below). A
//     `config.toml` edit is copied into the copy with no question and restarts the trick.
//   * The copy is checked before every run and on each scan: its listing against the one verified last,
//     and when that moved, its hash again. A copy that no longer hashes right stops the trick with
//     {@link TAMPERED_LINE}. A switch entry whose copy is missing is copied again from the folder when the
//     folder still hashes to the approved hash, the same bytes; otherwise the trick waits for a yes.
//   * Only on a bridge that may schedule (`deps.active`): a lead or a solo bridge that is not deposed.
//     A peer, a deputy and a deposed lead run no timer, so a crew never runs one trick on two machines.
//   * Timers run only while a phone has watched in the last five minutes ({@link WATCH_WINDOW_MS}):
//     "watched" is a `/api/snapshot` or `/api/tricks` request from a paired phone (server.ts stamps it).
//     The host's own CLI and a lead's sweep of this machine do not count. A `gh` trick on `30s` makes no
//     call while the phone is in a pocket.
//   * The first run after the trick is loaded, switched on, a new version approved or its `config.toml` changed has the
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
//   * After a failed run: 1, 5, then 30 minutes, then the trick stops ({@link BACKOFF_MS}). A new version
//     approved, a change of its `config.toml`, switching it on again, or a tap restarts it. A broken program never
//     runs 1,440 times a day against a paid API.
//
// ── WHAT A RUN LEAVES ───────────────────────────────────────────────────────────
// stdout and stderr are masked in run.ts before anything here sees them. The document is parsed with
// the schema's one parser, against the manifest's declared places and every node kind, and stored per
// part with a rev (store.ts). The read is tolerant (schema.ts, "strict at write, tolerant at read"): a
// node kind or a place this Collie does not draw is left out with a note on the list entry, and the
// other nodes and parts draw; the decisions are read strictly. A failed run keeps the last good parts,
// stale. The error line is masked and capped, and goes to the list entry, the doctor row and one log
// line when it changes, never once per run.
//
// ── THE NEW VERSION (crew slice 2) ──────────────────────────────────────────────
// A trick that is on and whose folder no longer hashes to the approved version keeps running the copy,
// and its row says `changed: true` and carries `pending`: once the folder has not moved for
// {@link PENDING_SETTLE_MS}, a snapshot of it lands in `.collie-pending/<id>/<hash16>/` with how many code files
// it adds, changes and removes against the copy, whether its powers moved (approved.ts `powersOf`), and
// the warnings that are new since the approved version. {@link TricksService.approvePending},
// {@link TricksService.declinePending} and {@link TricksService.undo} are the seam a card builds on; each
// refuses when the folder moved again after the snapshot. With `auto` on (`collie trick auto <id> on`) a
// new version whose powers did not move and that does nothing new (no warning KIND the approved copy
// did not have: network, spawn, write, model, import) is approved on its own, with an audit line and
// `previous` kept for undo; a change of powers, or a new kind of warning, always waits for a person (a
// card on the Hill). A declined version is not offered again.
//
// ── WARNINGS AT THE SWITCH (review 15) ─────────────────────────────────────────
// The row of a trick that is off, or on and changed, carries the check scan's warnings (scan.ts), one per
// kind with a plain sentence, so Settings shows them before the person switches it on. They are taken
// after a scan, once per code hash, never while a trick is on and unchanged, and a slow read never holds
// the scan past {@link SCAN_TIMEOUT_MS}: the row then gains them when the read ends. They never refuse.
// A trick `collie trick add` made shows its origin record (origin.ts) as its provenance.
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
// removed has every open decision withdrawn; one with a new version waiting keeps them, and keeps running. The answer comes back from the
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
/** The row's line while a new version of an on trick waits for a person's yes. */
export const PENDING_LINE = "A new version waits for your yes.";
/** The line of a trick that is on but has no approved version (a version 1 entry, a migration of a changed folder). */
export const NOT_APPROVED_LINE = "No version of this trick is approved yet. Switch it on again to approve its code as it is now.";
/** The answer to a tap on a trick that is only an agent view: it has no program, so nothing runs. */
export const NO_PROGRAM_LINE = "This trick has no program, so nothing runs.";
/** The line of a trick whose approved copy changed on disk. */
export const TAMPERED_LINE = "The approved copy changed on disk, so the trick stopped. Switch it on again to approve its code as it is now.";
/** The row's line when the approved copy holds a symbolic link (one made before links were refused). */
export const LINK_LINE = "The approved copy holds a symbolic link, so the trick stopped. A trick holds regular files only: replace the link in its folder, then switch it on again.";
/** How long a changed folder must stay still before its snapshot is taken. */
export const PENDING_SETTLE_MS = 5000;
/** How often the unreferenced copies are pruned. */
export const PRUNE_EVERY_MS = 60_000;
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
  /**
   * `POST /api/tricks/<host>/<id>/switch`: write the switch file, as `collie trick on|off` does. `hash`: the
   * code the person read (the row's `approves`), null when the phone named none; the route always passes it.
   */
  setSwitch(host: string, id: string, on: boolean, hash?: string | null): Promise<SwitchAnswer>;
  /** `POST /api/tricks/<host>/<id>/auto`: take changes without asking, as `collie trick auto` does (crew slice 3). */
  autoRoute(host: string, id: string, on: boolean): Promise<VersionRouteAnswer>;
  /** `POST /api/tricks/<host>/<id>/undo`: go back to the version before the last one (crew slice 3). */
  undoRoute(host: string, id: string): Promise<VersionRouteAnswer>;
  /**
   * `GET /api/tricks/<host>/<id>/media/<file>`: one picture of the trick's own `media/` folder
   * (media.ts), or null for every miss. Only a trick of this bridge that is switched on.
   */
  media(host: string, id: string, rel: string): Promise<TrickMediaFile | null>;
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

/**
 * One trick that is on, as the "new version" card reads it (crew slice 3, version-card.ts). `waiting`:
 * the folder holds code that is neither approved nor declined, so a card may stand even while the
 * snapshot settles. `pending`: the snapshot, once taken. `base`: the approved copy that runs, if any.
 */
export interface TrickVersionSubject {
  id: string;
  name: string;
  waiting: boolean;
  pending: { hash: string; dir: string; info: WireTrickPending; manifest?: TrickManifest } | null;
  base: { dir: string; manifest?: TrickManifest } | null;
}

/** What the runner tells the "new version" card after each scan and each version change. */
export interface TrickVersionsPort {
  /** Every trick that is on, as it is now. A trick not listed is off or gone: its card goes. Never blocks. */
  sync(subjects: readonly TrickVersionSubject[]): void;
}

/** The phone's words when it taps a decision's node directly: answers go through the hill. */
export const HILL_NODE_TAP_REFUSED = "A decision is answered on the Hill, not with a tap.";

/** A tap route's answer: the HTTP status and the JSON body. */
export type TapAnswer =
  | { status: 200; body: TrickTapReply }
  | { status: 400; body: { error: "tap-invalid"; refusals: Refusal[] } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" } }
  | { status: 409; body: { error: "request-id-reused"; rid: string } };

/** The auto and undo routes' answer: the trick as the list now shows it, or why not, in plain words. */
export type VersionRouteAnswer =
  | { status: 200; body: WireTrickInfo }
  | { status: 400; body: { error: "auto-invalid" | "undo-invalid" } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" } }
  | { status: 409; body: { error: "off" | "no-pending" | "moved" | "no-previous" | "copy-failed" | "has-rules"; message: string } };

/** A version change as a route's answer. */
function routeAnswer(answer: VersionAnswer): VersionRouteAnswer {
  if (answer.ok) return { status: 200, body: answer.info };
  if (answer.code === "unknown-trick") return { status: 404, body: { error: "unknown-trick" } };
  return { status: 409, body: { error: answer.code, message: answer.message } };
}

/**
 * Where a proposal for a trick id lands (crew slice 8, proposals.ts): a NEW trick, a new VERSION of one that
 * is on (the runner's own card asks), or refused in plain words.
 */
export type ProposalTarget =
  | { kind: "new" }
  /** A trick a proposal made, on, with the approved copy a new version is shown against. */
  | { kind: "version"; baseHash: string; baseDir: string; baseManifest?: TrickManifest }
  | { kind: "refused"; reason: string };

/** What writing a proposal into the tricks folder came to. */
export type ProposalPlaced = { ok: true; codeHash: string } | { ok: false; message: string };

/** The switch route's answer: the trick as the list now shows it, or why not. */
export type SwitchAnswer =
  | { status: 200; body: WireTrickInfo }
  | { status: 400; body: { error: "switch-invalid" } }
  | { status: 409; body: { error: "moved"; message: string } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" } };

export interface TricksServiceDeps {
  configDir: string;
  stateDir: string;
  /** The official list, for the row of a trick from its repository that is not on it. Default: the one this binary carries. */
  officialEntries?: () => readonly OfficialEntry[];
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
  /** Whether this bridge leads a crew, so a trick's inputs come from every machine (the Settings sentence says so). Absent: false. */
  crewWide?: () => boolean;
  /** The fetch of a contract 2 trick's inputs before each run (inputs.ts `TrickInputs`). Absent: no files, no `inputs` on the sessions. */
  inputs?: Pick<TrickInputs, "fetch" | "forget">;
  /** The unit's environment; each run gets the allow-listed part of it (env.ts). */
  env: ProgramEnv;
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
  /**
   * Whether this bridge may schedule tricks now: a lead or a solo bridge that is not deposed. A peer, a
   * deputy and a deposed lead run no timer (bridge/index.ts wires the crew mode and the deposed state).
   * Absent: always.
   */
  active?: () => boolean;
  /**
   * Where tricks run when this bridge schedules none (`active` false because another machine of the
   * crew does): `{ lead }`, or `{}` when the lead is not known. Null on a lead or a solo bridge. The reply
   * carries it, so Settings and `collie trick list` say that this machine runs none. Absent: never set.
   */
  runsOn?: () => TricksRunsOn | null;
  /** One audit line per version the bridge approves, declines or undoes (bridge/audit.ts). Absent in a test. */
  audit?: (entry: { action: string; detail: Record<string, string> }) => void;
  /** The "new version" card on the Hill (version-card.ts). Absent: no card, Settings alone says it. */
  versions?: TrickVersionsPort;
}

/** The approved copy a trick runs from, as read and verified. */
interface ApprovedRun {
  hash: string;
  dir: string;
  /** The copy read as a trick: its manifest, its config hash, its origin record. */
  found: FoundTrick;
  /** The copy's code listing when it was last verified (approved.ts `copyListing`). */
  listing: string;
}

/** A snapshot of a changed folder, waiting for a yes. */
interface PendingVersion {
  hash: string;
  dir: string;
  info: WireTrickPending;
  /** The snapshot's manifest, as read when it was taken; absent when it did not parse. */
  manifest?: TrickManifest;
  /**
   * The new version does something the approved one did not: a warning KIND the approved copy did not
   * have (network, spawn, write, model, import), or its warnings could not be read. `auto` holds it.
   */
  doesMore: boolean;
}

/** What a version change answers: the trick as the list now shows it, or why not. */
export type VersionAnswer =
  | { ok: true; info: WireTrickInfo }
  | { ok: false; code: "unknown-trick" | "off" | "no-pending" | "moved" | "no-previous" | "copy-failed" | "has-rules"; message: string };

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
  /** The trick's folder, as the scan last read it. */
  found: FoundTrick;
  on: boolean;
  /** The switch entry, while on. */
  entry: SwitchEntry | undefined;
  /** On, and the folder no longer hashes to the approved version: a new version is there. */
  changed: boolean;
  /** The approved copy that runs, or null when none does. */
  approved: ApprovedRun | null;
  /** Why the approved copy cannot run (it changed on disk, or it is gone), or null. */
  copyProblem: string | null;
  /** The approval (`<hash>@<at>`) whose copy was found changed: not checked again until a new approval. */
  tampered: string | null;
  /** The snapshot of a changed folder, waiting for a yes. */
  pending: PendingVersion | null;
  /** The folder's fingerprint and since when it has not moved, for the pending snapshot's wait. */
  settle: { fingerprint: string; since: number } | null;
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
  /**
   * The last good document listed at least one Decision. On the wire as `decides`, so the phone can say
   * on the trick's row that its Decisions are not shown while the Hill is switched off. Absent: none yet.
   */
  decides?: boolean;
}

interface Receipt {
  digest: string;
  reply: TrickTapReply;
}

/**
 * A trick's state on the wire. `found` is what the row shows (the approved copy while one runs, else the
 * folder); `blocked` is a trick that is on but cannot run (no approved copy, or a copy that changed).
 */
/**
 * Whether a trick gives agents instructions (`rules`, contract 2) in the folder, in the approved copy or in
 * the version waiting: such a trick never takes a change without asking.
 */
/** The code hash a switch on approves now: the waiting version's, else the folder's (review 8 V-N1). */
function approvesOf(rt: Pick<TrickRuntime, "found" | "pending">): string | undefined {
  return rt.pending?.hash ?? rt.found.codeHash;
}

/** The words of a switch on that names code other than the trick's now. */
export const SWITCH_MOVED = "The trick changed after you read it. Read it again, then switch it on.";

export function hasRules(rt: Pick<TrickRuntime, "found" | "approved" | "pending">): boolean {
  return rt.found.manifest?.rules !== undefined || rt.approved?.found.manifest?.rules !== undefined || rt.pending?.manifest?.rules !== undefined;
}

export function trickStateOf(rt: Pick<TrickRuntime, "on" | "found" | "stopped" | "failures"> & { blocked?: boolean }): TrickState {
  if (rt.found.manifest === undefined) return "skipped";
  if (!rt.on) return "off";
  if (rt.stopped || rt.blocked === true) return "stopped";
  return rt.failures > 0 ? "failing" : "ok";
}

/** Whether a switch entry's approved version differs from the folder as it is now: a new version is there. */
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
  /** The warnings of each trick's code, by the code hash they were taken for. */
  private readonly warningsOf = new Map<string, { codeHash: string; warnings: WireTrickWarning[] }>();
  /** The warnings read in flight, one at a time. */
  private warningRead: Promise<void> | null = null;
  /** When the unreferenced copies were last pruned. */
  private prunedAt = -Infinity;

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

  /**
   * The tricks rev the snapshot carries, or undefined to send nothing: while the tricks folder exists, and,
   * on a bridge that runs tricks (no `runsOn`), also while the official list offers something. So a
   * fresh install with no tricks folder shows Settings, Tricks with only the list, and the first add makes
   * the folder (proposal-install.ts `writeNewTrick`), which the next scan reads with no restart.
   */
  rev(): number | undefined {
    if (this.folderExists) return this.store.rev;
    if ((this.deps.runsOn?.() ?? null) !== null || this.officialEntries().length === 0) return undefined;
    return this.store.rev;
  }

  noteWatched(): void {
    this.watchedAt = this.now();
    void this.refresh();
  }

  /** Whether a phone looked within {@link WATCH_WINDOW_MS}. */
  watched(): boolean {
    return this.now() - this.watchedAt < WATCH_WINDOW_MS;
  }

  /** The PATH a program gets. */
  runnerPath(): string {
    return scrubEnv(this.deps.env).PATH ?? "";
  }

  /** How many programs run (or hold a slot) now. For a test. */
  runsHeld(): number {
    return this.slots.held;
  }

  async reply(since: number | undefined): Promise<TricksReply> {
    await this.refresh();
    return this.store.reply(since, this.folderExists ? this.runnerPath() : undefined, this.deps.runsOn?.());
  }

  sessionPanes(): TrickSessionPanes | undefined {
    if (!this.folderExists) return undefined;
    const all = this.store.reply(undefined);
    return trickSessionPanes({
      host: this.deps.memberId,
      tricks: all.tricks,
      parts: all.parts,
      // The session's folder is the trick's own, where a person edits it, not the copy that runs.
      dirOf: (id) => this.runtimes.get(id)?.found.dir,
      now: this.now(),
    });
  }

  /**
   * The agent view gate of one trick, as the bridge knows it now (agent views SECURITY rule 1): the trick
   * is on, approved at the hash its switch names, its approved copy is whole, no new version of its folder
   * waits for a yes, and the approved copy's manifest lists `agent-view` with a rules text. Anything else
   * is a refusal: `no_trick` for a trick not found here, `trick_off` for one off, not approved, broken or
   * waiting, `not_a_view` for one whose approved manifest lists no agent view. A read: it never scans.
   */
  viewGate(id: string): ViewGate {
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { ok: false, code: "no_trick", error: `no trick "${id}" on this machine` };
    const entry = rt.entry;
    if (!rt.on || entry === undefined) return { ok: false, code: "trick_off", error: `the trick "${id}" is off; only the person turns it on, on the phone` };
    const approved = rt.approved;
    if (approved === null || rt.copyProblem !== null || approved.hash !== entry.hash) return { ok: false, code: "trick_off", error: `the trick "${id}" is not approved as it is now; the person approves it on the phone` };
    const hash = rt.found.codeHash;
    const waiting = rt.found.manifest !== undefined && hash !== undefined && hash !== entry.hash && hash !== entry.declined;
    if (waiting || rt.pending !== null) return { ok: false, code: "trick_off", error: `a new version of the trick "${id}" waits for the person's yes; its view is off until then` };
    const manifest = approved.found.manifest;
    if (manifest?.agentView !== true || manifest.rulesText === undefined) return { ok: false, code: "not_a_view", error: `the trick "${id}" adds no agent view` };
    return { ok: true, name: manifest.name, rules: manifest.rulesText };
  }

  /** The agent view gate after a scan inside the usual cadence: for an agent's write and a person's send. */
  async viewGateFresh(id: string): Promise<ViewGate> {
    await this.refresh();
    return this.viewGate(id);
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
        let switches = await this.readSwitches();
        // A version 1 or 2 switch file is migrated before anything runs (approved.ts `migrateSwitches`).
        if (switches.version === 1 || switches.version === 2) {
          const done = await migrateSwitches({ stateDir: this.deps.stateDir, configDir: this.deps.configDir, platform: this.deps.platform });
          if (done !== null) this.warn(`switches.json is version 3 now: ${done.kept.length} trick(s) run from an approved copy, ${done.waiting.length} wait for a yes`);
          switches = await this.readSwitches();
        }
        const scan = await this.scanner.scan(new Set(switches.on.keys()));
        this.apply(scan, switches);
        // A snapshot of the runtimes: each step awaits, and the loop must not see the map move under it.
        const runtimes = [...this.runtimes.values()];
        for (const rt of runtimes) await this.ensureApproved(rt);
        for (const rt of runtimes) await this.notePending(rt);
        this.syncVersions();
        await this.readWarnings();
        await this.prune(switches);
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
        this.deps.inputs?.forget(id);
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
        entry,
        changed,
        approved: null,
        copyProblem: null,
        tampered: null,
        pending: null,
        settle: null,
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
    // A change of the folder restarts nothing: the trick runs its approved copy, and a new version waits
    // (notePending). A config.toml edit restarts it once it reaches the copy (ensureApproved).
    old.found = found;
    const switched = old.on !== on;
    old.on = on;
    old.entry = entry;
    old.changed = changed;
    if (switched && !on) {
      old.approved = null;
      old.copyProblem = null;
      old.tampered = null;
      old.pending = null;
      old.settle = null;
      this.store.dropParts(host, found.id);
      this.deps.decisions?.off(this.hillTrick(old));
      this.deps.inputs?.forget(found.id);
    }
    if (switched && on) this.restart(old);
    this.publish(found.id);
  }

  /**
   * Bring a trick's approved copy in line with its switch entry: load and verify a newly approved copy (or
   * copy it again from a folder that still hashes the same), check a loaded one against its listing and
   * hash it again when the listing moved, and copy a changed `config.toml` in. A copy that no longer
   * hashes right stops the trick. Never throws.
   */
  private async ensureApproved(rt: TrickRuntime): Promise<void> {
    const want = rt.on ? (rt.entry?.hash ?? null) : null;
    const id = rt.found.id;
    if (want === null) {
      const had = rt.approved !== null || rt.copyProblem !== null;
      rt.approved = null;
      rt.copyProblem = null;
      rt.tampered = null;
      if (had) this.publish(id);
      return;
    }
    const dir = approvedCopyDir(this.deps.configDir, id, want);
    try {
      if (rt.approved?.hash === want && rt.copyProblem === null) {
        const loaded = rt.approved;
        let holds = (await copyListing(dir)) === loaded.listing;
        if (!holds) {
          const check = await verifyCopy(dir, want);
          // A copy that is gone is loaded again below (and copied again from a folder that still matches).
          if (!check.ok && !check.missing) return this.copyFailed(rt, check.link === true ? LINK_LINE : TAMPERED_LINE, check.reason, `${want}@${rt.entry?.at ?? ""}`);
          if (check.ok) loaded.listing = check.listing;
          holds = check.ok;
        }
        if (holds) {
          await this.syncConfigOf(rt, loaded);
          return;
        }
        rt.approved = null;
      }
      const approval = `${want}@${rt.entry?.at ?? ""}`;
      if (rt.tampered === approval) return;
      let check = await verifyCopy(dir, want);
      // A missing copy of a version the folder still holds is the same bytes: copy it again.
      if (!check.ok && check.missing && rt.found.codeHash === want) {
        const snap = await snapshotTrick({ src: rt.found.dir, parent: approvedTrickDir(this.deps.configDir, id), expect: want, platform: this.deps.platform });
        if (snap.ok) check = await verifyCopy(dir, want);
      }
      if (!check.ok) return this.copyFailed(rt, check.missing ? NOT_APPROVED_LINE : check.link === true ? LINK_LINE : TAMPERED_LINE, check.reason, check.missing ? null : approval);
      await syncConfig(rt.found.dir, dir);
      const found = await scanTrickDir(diskTrickFs, dir, id, undefined);
      rt.approved = { hash: want, dir, found, listing: check.listing };
      rt.copyProblem = null;
      rt.tampered = null;
      this.restart(rt);
      this.publish(id);
    } catch (err) {
      this.copyFailed(rt, TAMPERED_LINE, err instanceof Error ? err.message : String(err), null);
    }
  }

  /** Copy a changed config.toml into the approved copy, read it again, and restart the trick. */
  private async syncConfigOf(rt: TrickRuntime, run: ApprovedRun): Promise<void> {
    if (rt.found.configHash === run.found.configHash) return;
    if (!(await syncConfig(rt.found.dir, run.dir))) return;
    run.found = await scanTrickDir(diskTrickFs, run.dir, rt.found.id, undefined);
    this.restart(rt);
    this.publish(rt.found.id);
  }

  /** The approved copy cannot run: stop the trick with a plain line, once. */
  private copyFailed(rt: TrickRuntime, line: string, why: string, tampered: string | null): void {
    const fresh = rt.copyProblem !== line;
    rt.approved = null;
    rt.tampered = tampered;
    rt.copyProblem = line;
    if (!fresh) return;
    this.warn(`${rt.found.id}: ${line} (${why})`);
    this.store.markStale(this.deps.memberId, rt.found.id, line);
    this.publish(rt.found.id);
  }

  /**
   * Take the snapshot of a changed folder once it settled, and take it on its own when `auto` allows.
   * Nothing for a trick that is off, a folder that equals the approved version, a version the person
   * declined, or a folder whose manifest is refused. Never throws.
   */
  private async notePending(rt: TrickRuntime): Promise<void> {
    const hash = rt.found.codeHash;
    const entry = rt.entry;
    if (!rt.on || entry === undefined || hash === undefined || rt.found.manifest === undefined || hash === entry.hash || hash === entry.declined) {
      this.dropPending(rt);
      return;
    }
    if (rt.pending?.hash === hash) return;
    const now = this.now();
    if (rt.settle?.fingerprint !== rt.found.fingerprint) {
      rt.settle = { fingerprint: rt.found.fingerprint, since: now };
      return;
    }
    if (now - rt.settle.since < PENDING_SETTLE_MS) return;
    try {
      const snap = await snapshotTrick({ src: rt.found.dir, parent: pendingTrickDir(this.deps.configDir, rt.found.id), expect: hash, platform: this.deps.platform });
      if (!snap.ok) {
        // It moved while it was copied: wait for it to settle again.
        rt.settle = null;
        return;
      }
      rt.pending = { hash, dir: snap.dir, ...(await this.pendingInfo(rt, snap.dir, hash)) };
      this.publish(rt.found.id);
      // Auto takes a version only when its rights did not move AND it does nothing new (security re-review B5),
      // and never for a trick that gives agents instructions, before or after (contract 2, agent views).
      if (entry.auto && rt.approved !== null && rt.copyProblem === null && !rt.pending.info.powersChanged && !rt.pending.doesMore && !hasRules(rt) && rt.pending.manifest?.rules === undefined) {
        const took = await this.promote(rt, hash, "auto");
        if (took.ok) this.warn(`${rt.found.id}: took the new version ${hash.slice(0, 16)} without asking (auto); undo restores ${entry.hash?.slice(0, 16) ?? "nothing"}`);
      }
    } catch (err) {
      this.warn(`${rt.found.id}: the new version could not be copied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private dropPending(rt: TrickRuntime): void {
    rt.settle = null;
    if (rt.pending === null) return;
    rt.pending = null;
    this.publish(rt.found.id);
  }

  /**
   * What the row says of a pending snapshot: the file counts, whether its powers moved, its new warnings,
   * and the snapshot's manifest for the card. A warning is new when its KIND is (crew slice 3): a new
   * line of a kind the approved copy already had says nothing the person did not see at the switch.
   */
  private async pendingInfo(rt: TrickRuntime, dir: string, hash: string): Promise<Omit<PendingVersion, "hash" | "dir">> {
    const next = await scanTrickDir(diskTrickFs, dir, rt.found.id, undefined);
    const base = rt.approved !== null && rt.copyProblem === null ? rt.approved : null;
    const files = await fileCounts(base?.dir ?? null, dir);
    const was = base?.found.manifest;
    const now = next.manifest;
    const powersChanged = was === undefined || now === undefined || powersOf(was) !== powersOf(now);
    // A read that fails counts against the new version: a failed read of the approved copy makes every
    // kind new, and a failed read of the new version holds auto.
    const before = new Set((was === undefined || base === null ? [] : await trickWarnings(base.dir, was).catch(() => [])).map((w) => w.kind));
    const after = now === undefined ? null : await trickWarnings(dir, now).catch(() => null);
    const added = (after ?? []).filter((w) => !before.has(w.kind));
    const info: WireTrickPending = { hash, files, powersChanged, warnings: wireWarnings(added) };
    const doesMore = after === null || added.length > 0;
    return now === undefined ? { info, doesMore } : { info, manifest: now, doesMore };
  }

  /** Tell the "new version" card every trick that is on, as it is now. Never throws. */
  private syncVersions(): void {
    const port = this.deps.versions;
    if (port === undefined) return;
    const subjects: TrickVersionSubject[] = [];
    for (const rt of this.runtimes.values()) {
      const entry = rt.entry;
      if (!rt.on || entry === undefined) continue;
      const hash = rt.found.codeHash;
      const waiting = rt.found.manifest !== undefined && hash !== undefined && hash !== entry.hash && hash !== entry.declined;
      const base = rt.approved !== null && rt.copyProblem === null ? { dir: rt.approved.dir, manifest: rt.approved.found.manifest } : null;
      const pending = rt.pending === null ? null : { hash: rt.pending.hash, dir: rt.pending.dir, info: rt.pending.info, manifest: rt.pending.manifest };
      subjects.push({ id: rt.found.id, name: this.shownOf(rt).manifest?.name ?? rt.found.id, waiting, pending, base });
    }
    try {
      port.sync(subjects);
    } catch (err) {
      this.warn(`the new version card could not be updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Promote the pending snapshot `hash` to the approved copy: refused unless it is the snapshot held and
   * the folder still hashes to it, and the snapshot still hashes right. Writes the switch (by `by`), audits
   * it, and folds the new approval in.
   */
  private async promote(rt: TrickRuntime, hash: string, by: string): Promise<VersionAnswer> {
    const id = rt.found.id;
    const pending = rt.pending;
    if (pending === null || pending.hash !== hash) return { ok: false, code: "no-pending", message: "That version is not the one waiting." };
    const fresh = await this.scanner.one(id);
    if (fresh === null || fresh.codeHash !== hash) return { ok: false, code: "moved", message: "The trick's folder changed again after this version was taken. Look at the new one." };
    const check = await verifyCopy(pending.dir, hash);
    if (!check.ok) return { ok: false, code: "copy-failed", message: "The waiting version changed on disk. Look at the folder again." };
    const target = approvedCopyDir(this.deps.configDir, id, hash);
    const placed = await promoteCopy(pending.dir, target, hash);
    if (!placed) return { ok: false, code: "copy-failed", message: "The waiting version could not be moved into place." };
    await syncConfig(fresh.dir, target);
    const powers = (await scanTrickDir(diskTrickFs, target, id, undefined)).manifest;
    const at = new Date(this.now()).toISOString();
    const written = await updateSwitches(this.deps.stateDir, (now) => withApproval(now, id, { at, hash, by, powers: powers === undefined ? null : powersOf(powers), instructs: powers?.rules !== undefined }));
    rt.pending = null;
    rt.settle = null;
    this.deps.audit?.({ action: "trick.approve", detail: { trick: id, hash: hash.slice(0, 16), by } });
    return await this.foldIn(rt, fresh, written);
  }

  /** Fold a switch file just written into the runtime, and answer the row. */
  private async foldIn(rt: TrickRuntime, found: FoundTrick, switches: Switches): Promise<VersionAnswer> {
    this.applyOne(found, switches.on.get(found.id));
    await this.ensureApproved(rt);
    this.publish(found.id);
    this.syncVersions();
    const info = this.store.reply(this.store.rev).tricks.find((trick) => trick.id === found.id);
    if (info === undefined) return { ok: false, code: "unknown-trick", message: "The trick is gone." };
    return { ok: true, info };
  }

  /** Run one version change after the switch writes before it, and after any scan in flight. */
  private serial(work: () => Promise<VersionAnswer>): Promise<VersionAnswer> {
    const turn = this.switching.then(async () => {
      await this.scanning;
      return await work();
    });
    this.switching = turn.catch(() => {});
    return turn;
  }

  /** The runtime of a trick that is on, or why not. */
  private onRuntime(id: string): TrickRuntime | VersionAnswer {
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { ok: false, code: "unknown-trick", message: "There is no such trick." };
    if (!rt.on || rt.entry === undefined) return { ok: false, code: "off", message: "The trick is off." };
    return rt;
  }

  /**
   * Say yes to the version waiting (the seam the "new version" card builds on): the snapshot `hash` becomes
   * the approved copy, and the trick restarts on it. Refused when it is not the version waiting, or the
   * folder moved again after the snapshot.
   */
  async approvePending(id: string, hash: string, by = "phone"): Promise<VersionAnswer> {
    return await this.serial(async () => {
      const rt = this.onRuntime(id);
      if (!("found" in rt)) return rt;
      return await this.promote(rt, hash, by);
    });
  }

  /**
   * Say no to the version waiting: it is recorded as `declined` and not offered again while the folder
   * holds it. The approved copy keeps running. Refused like {@link approvePending}.
   */
  async declinePending(id: string, hash: string): Promise<VersionAnswer> {
    return await this.serial(async () => {
      const rt = this.onRuntime(id);
      if (!("found" in rt)) return rt;
      if (rt.pending === null || rt.pending.hash !== hash) return { ok: false, code: "no-pending", message: "That version is not the one waiting." };
      const fresh = await this.scanner.one(id);
      if (fresh === null || fresh.codeHash !== hash) return { ok: false, code: "moved", message: "The trick's folder changed again after this version was taken. Look at the new one." };
      const written = await updateSwitches(this.deps.stateDir, (now) => {
        const held = now.on.get(id);
        return held === undefined ? now : withEntry(now, id, { ...held, declined: hash });
      });
      rt.pending = null;
      rt.settle = null;
      this.deps.audit?.({ action: "trick.decline", detail: { trick: id, hash: hash.slice(0, 16) } });
      return await this.foldIn(rt, fresh, written);
    });
  }

  /**
   * Go back to the version approved before the last one (`previous`): its copy must still hash right. The
   * version undone is recorded as declined, so `auto` does not take it again at once.
   */
  async undo(id: string): Promise<VersionAnswer> {
    return await this.serial(async () => {
      const rt = this.onRuntime(id);
      if (!("found" in rt)) return rt;
      const previous = rt.entry?.previous;
      const undone = rt.entry?.hash ?? null;
      if (previous === undefined) return { ok: false, code: "no-previous", message: "There is no earlier version to go back to." };
      const check = await verifyCopy(approvedCopyDir(this.deps.configDir, id, previous.hash), previous.hash);
      if (!check.ok) return { ok: false, code: "copy-failed", message: "The earlier version's copy is gone or changed on disk." };
      const written = await updateSwitches(this.deps.stateDir, (now) => {
        const held = now.on.get(id);
        if (held === undefined) return now;
        const entry: SwitchEntry = { at: previous.at, hash: previous.hash, auto: held.auto, by: previous.by, powers: previous.powers };
        if (undone !== null) entry.declined = undone;
        return withEntry(now, id, entry);
      });
      this.deps.audit?.({ action: "trick.undo", detail: { trick: id, hash: previous.hash.slice(0, 16) } });
      return await this.foldIn(rt, rt.found, written);
    });
  }

  /**
   * Take changes without asking, or ask again (crew slice 3; `collie trick auto` writes the same field).
   * Only for a trick that is on. A version already waiting is not taken by this: the next one is.
   */
  async setAuto(id: string, on: boolean): Promise<VersionAnswer> {
    return await this.serial(async () => {
      const rt = this.onRuntime(id);
      if (!("found" in rt)) return rt;
      if (on && hasRules(rt)) return { ok: false, code: "has-rules", message: RULES_NEVER_AUTO };
      const written = await updateSwitches(this.deps.stateDir, (now) => {
        const held = now.on.get(id);
        return held === undefined ? now : withEntry(now, id, { ...held, auto: on });
      });
      if (!written.on.has(id)) return { ok: false, code: "off", message: "The trick is off." };
      this.deps.audit?.({ action: on ? "trick.auto.on" : "trick.auto.off", detail: { trick: id } });
      return await this.foldIn(rt, rt.found, written);
    });
  }

  async autoRoute(host: string, id: string, on: boolean): Promise<VersionRouteAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    return routeAnswer(await this.setAuto(id, on));
  }

  async undoRoute(host: string, id: string): Promise<VersionRouteAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    return routeAnswer(await this.undo(id));
  }

  /** Remove the copies nothing names, at most once a minute. */
  private async prune(switches: Switches): Promise<void> {
    const now = this.now();
    if (now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    const pending = new Map<string, string>();
    for (const [id, rt] of this.runtimes) if (rt.pending !== null) pending.set(id, rt.pending.hash);
    await pruneCopies(this.deps.configDir, switches, { pending, now: Date.now() });
  }

  /** Whether a trick's row shows the folder's warnings: a manifest that parsed, and off or with a new version. */
  private wantsWarnings(rt: TrickRuntime): boolean {
    return rt.found.manifest !== undefined && rt.found.codeHash !== undefined && (!rt.on || rt.changed);
  }

  /**
   * Take the warnings of every trick that shows them and whose code moved since they were taken, then
   * publish its row again. Waits at most {@link SCAN_TIMEOUT_MS}; a read that runs over goes on, and its
   * rows move when it ends. Never throws.
   */
  private async readWarnings(): Promise<void> {
    for (const id of this.warningsOf.keys()) if (!this.runtimes.has(id)) this.warningsOf.delete(id);
    const stale = [...this.runtimes.values()].filter((rt) => this.wantsWarnings(rt) && this.warningsOf.get(rt.found.id)?.codeHash !== rt.found.codeHash);
    if (stale.length === 0 && this.warningRead === null) return;
    this.warningRead ??= (async () => {
      for (const rt of stale) {
        const { manifest, codeHash, dir, id } = rt.found;
        if (manifest === undefined || codeHash === undefined) continue;
        const warnings = wireWarnings(await trickWarnings(dir, manifest).catch(() => []));
        this.warningsOf.set(id, { codeHash, warnings });
        this.publish(id);
      }
    })().finally(() => {
      this.warningRead = null;
    });
    await within(this.warningRead, SCAN_TIMEOUT_MS);
  }

  /** The trick as the hill's sender names it: its decisions' images are read where its program ran, the approved copy. */
  private hillTrick(rt: TrickRuntime): TrickHillTrick {
    const shown = this.shownOf(rt);
    return { id: rt.found.id, name: shown.manifest?.name ?? rt.found.id, memberId: this.deps.memberId, dir: rt.approved?.dir ?? rt.found.dir };
  }

  /** What a trick's row and runs read: the approved copy while one runs, else the folder. */
  private shownOf(rt: TrickRuntime): FoundTrick {
    return rt.on && rt.approved !== null ? rt.approved.found : rt.found;
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

  /** The official list's entries: the deps' or the one this binary carries, none when it is refused. */
  private officialEntries(): readonly OfficialEntry[] {
    if (this.deps.officialEntries !== undefined) return this.deps.officialEntries();
    const list = shippedOfficialList();
    return list.ok ? list.entries : [];
  }

  /** Put a trick's list entry in the store, which takes a rev only when it changed. */
  private publish(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt === undefined) return;
    const shown = this.shownOf(rt);
    const m = shown.manifest;
    const blocked = rt.on && !this.runnable(rt);
    const info: WireTrickInfo = {
      host: this.deps.memberId,
      id,
      name: m?.name ?? id,
      icon: m?.icon ?? "plug",
      on: rt.on,
      state: trickStateOf({ on: rt.on, found: shown, stopped: rt.stopped, failures: rt.failures, blocked: blocked && m !== undefined }),
      places: m?.places ?? [],
      provenance: { via: "folder" },
    };
    // The provenance of what runs: the approved copy keeps the origin record of the version approved.
    const origin = shown.origin;
    if (origin !== undefined) info.provenance = { via: "repo", at: origin.at, repo: originRepoName(origin.url), sha: origin.commit };
    // From the official repository, but not a version of the official list: the row must not read as the list.
    if (origin !== undefined && info.provenance !== undefined && isUnlistedOfficialOrigin(this.officialEntries(), id, origin, shown.codeHash)) info.provenance.unlisted = true;
    // A proposed trick (`collie trick propose`, crew slice 8): the web reads `proposed` and says "Proposed …"
    // ("Proposed from <host>. The session is not confirmed." when no agent pane was placed); `via` is only
    // for a reader that predates `proposed`.
    const proposal = shown.proposal;
    if (origin === undefined && proposal !== undefined) {
      const host = [...proposal.host].map((ch) => (unsafeText(ch) ? "?" : ch)).slice(0, 40).join("");
      info.provenance = { via: proposal.by === "agent" ? "agent" : "cli", at: proposal.at, proposed: { by: proposal.by, host } };
    }
    const waiting = rt.pending === null ? NOT_APPROVED_LINE : PENDING_LINE;
    const error = m === undefined ? shown.refusals[0]?.reason : blocked ? (rt.copyProblem ?? waiting) : rt.lastError;
    if (error !== undefined) info.error = problemLine(error);
    if (rt.lastRunAt !== undefined) info.lastRunAt = new Date(rt.lastRunAt).toISOString();
    const refusals = [...shown.refusals, ...rt.docRefusals].slice(0, REFUSALS_MAX);
    if (refusals.length > 0) info.refusals = refusals;
    if (rt.changed) info.changed = true;
    if (rt.pending !== null) info.pending = rt.pending.info;
    if (rt.decides === true) info.decides = true;
    if (m?.env !== undefined) info.env = m.env;
    if (m?.inputs !== undefined && m.inputs.length > 0) info.inputs = { globs: m.inputs, crew: this.deps.crewWide?.() ?? false };
    if (m?.description !== undefined) info.description = m.description;
    if (m?.about !== undefined) info.about = m.about;
    // Contract 2: an agent view and its rules, whole, for the About sheet; this build draws no view yet.
    const approves = approvesOf(rt);
    if (approves !== undefined) info.approves = approves;
    if (m?.agentView === true) info.agentView = true;
    if (m?.rules !== undefined && m.rulesText !== undefined) info.rules = { file: m.rules, text: m.rulesText };
    // A trick with rules never takes a change without asking, whatever an older switch file says.
    if (rt.on && rt.entry !== undefined) info.auto = rt.entry.auto && !hasRules(rt);
    // Undo is offered only for a version taken without asking, while the one before it is there.
    if (rt.on && rt.entry?.by === "auto" && rt.entry.previous !== undefined) info.autoAt = rt.entry.at;
    const taken = this.warningsOf.get(id);
    if (this.wantsWarnings(rt) && taken !== undefined && taken.codeHash === rt.found.codeHash && taken.warnings.length > 0) info.warnings = taken.warnings;
    this.store.setInfo(info);
  }

  /** Whether the trick may run at all: on, with an approved copy that holds and whose manifest parsed. */
  private runnable(rt: TrickRuntime): boolean {
    return rt.on && rt.approved !== null && rt.copyProblem === null && rt.approved.found.manifest !== undefined;
  }

  /** Whether a start or timer run is due now. */
  private due(rt: TrickRuntime, now: number): boolean {
    if (!this.runnable(rt) || rt.stopped) return false;
    if (rt.running !== null || rt.queued !== null || rt.hillQueue.length > 0) return false;
    if (now < rt.nextAt) return false;
    // A trick that is only an agent view has no program: nothing is ever due.
    if (rt.approved?.found.manifest?.run === undefined) return false;
    // A failed start run keeps `pendingStart`, so it is tried again after its backoff; a trick with no
    // `every` never runs on the clock otherwise.
    return rt.pendingStart || rt.approved?.found.manifest?.everyMs !== undefined;
  }

  /**
   * One scheduler tick: nothing at all unless a phone watched; else a scan (throttled) and every due
   * run started. Resolves when the runs it started are done, which is what a test waits on.
   */
  async tick(): Promise<void> {
    // A peer, a deputy and a deposed lead schedule nothing (`deps.active`), so no trick runs twice in a crew.
    if (!this.watched() || this.deps.active?.() === false) return;
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
   * Read one trick again before its program starts. Answers why it may not run, or null. The switch is
   * read again and the approved copy checked (its listing, and its hash when that moved), so a copy that
   * changed on disk stops this very run. A change of the folder does not: the copy runs.
   */
  private async recheck(rt: TrickRuntime): Promise<string | null> {
    const id = rt.found.id;
    if (this.runtimes.get(id) !== rt) return "The trick is gone.";
    const [found, switches] = await Promise.all([this.scanner.one(id), this.readSwitches()]);
    if (found === null) return "The trick's folder could not be read again before the run.";
    if (this.runtimes.get(id) !== rt) return "The trick is gone.";
    this.applyOne(found, switches.on.get(id));
    await this.ensureApproved(rt);
    if (!rt.on) return "The trick is off.";
    if (rt.approved === null || rt.copyProblem !== null) return rt.copyProblem ?? (rt.pending === null ? NOT_APPROVED_LINE : PENDING_LINE);
    if (rt.approved.found.manifest === undefined) return "The trick's trick.toml is refused. Run `collie trick check` on its folder.";
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

  /** Run the program once and store what it left. The reply is the tap's, when the trigger is a tap. */
  private async runOnce(rt: TrickRuntime, trigger: FactsTrigger): Promise<TrickTapReply> {
    // Everything a run reads comes from the approved copy: the manifest, the working folder, `trick.dir`.
    const run = rt.approved;
    const manifest = run?.found.manifest;
    const host = this.deps.memberId;
    const id = rt.found.id;
    const rid = trigger.kind === "tap" ? trigger.rid : "";
    const revBefore = this.store.rev;
    if (run === null || manifest === undefined) return { rid, code: "rejected", message: "The trick's trick.toml is refused." };
    // An agent view and nothing else: no program, so nothing starts, whatever asked.
    const command = manifest.run;
    if (command === undefined) return { rid, code: "rejected", message: NO_PROGRAM_LINE };
    const startedAt = this.now();
    const state = trickStateDir(this.deps.stateDir, id);
    // The program's own folder under <stateDir>/tricks, owner only like the rest of the state folder.
    await mkdir(state, { recursive: true, mode: 0o700 }).catch(() => {});
    // The program may keep the id in its own state: it is written down before the first run sees it.
    this.deps.keepId?.();
    const world = this.deps.world(host);
    // Contract 2: the files the trick's globs match in its agent sessions' folders, fetched into the
    // copy's `inputs/` before the run, listed on each session (inputs.ts). Never for a contract 1 trick.
    const globs = manifest.contract >= INPUTS_CONTRACT ? (manifest.inputs ?? []) : [];
    if (globs.length > 0 && this.deps.inputs !== undefined) {
      const got = await this.deps.inputs.fetch({ id, dir: run.dir, globs }, world.sessions);
      world.sessions = world.sessions.map((session) => {
        const inputs = got.get(session.id);
        return inputs === undefined ? session : { ...session, inputs };
      });
    }
    const facts = buildFacts({ memberId: host, ...world }, { id, dir: run.dir, state }, trigger, manifest.contract);
    const outcome = await (this.deps.run ?? runProgram)({
      command,
      cwd: run.dir,
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
    // A copy that stopped while the program ran (it changed on disk) keeps nothing of that run.
    if (!this.runnable(rt)) return { rid, code: "rejected", message: rt.copyProblem ?? NOT_APPROVED_LINE };
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
    const posted = listRefused || !decisionsListed ? [] : (this.deps.decisions?.sync({ ...this.hillTrick(rt), name: manifest.name }, { decisions: parsed.decisions, refusedKeys: parsed.refusedDecisions, sessions: new Set(facts.sessions.map((session) => session.id)) }) ?? []);
    // An absent `decisions` key leaves the trick's Decisions as they were, so it leaves this as it was too.
    if (!listRefused && decisionsListed) rt.decides = parsed.decisions.length > 0;
    // What the tolerant read left out (a node kind or a place this Collie does not draw) is one note on
    // the trick's row; an ignored key is for `collie trick check` and `dev` only.
    const dropped = parsed.notes.filter((note) => note.code === "dropped");
    this.succeeded(rt, startedAt, [...parsed.refusals, ...dropped, ...posted]);
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
    const every = rt.approved?.found.manifest?.everyMs;
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
    if (!rt.on) return refuse("The trick is off.");
    if (rt.approved === null || rt.copyProblem !== null) return refuse(rt.copyProblem ?? (rt.pending === null ? NOT_APPROVED_LINE : PENDING_LINE));
    if (rt.approved.found.manifest === undefined) return refuse("The trick's trick.toml is refused. Run `collie trick check` on its folder.");
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

  async media(host: string, id: string, rel: string): Promise<TrickMediaFile | null> {
    if (!this.isOwn(host)) return null;
    await this.refresh();
    const rt = this.runtimes.get(id);
    // A trick the person never switched on gets nothing served, whatever its folder holds. The pictures
    // are the approved copy's: its program writes them there.
    if (rt === undefined || !rt.on || rt.approved === null || rt.copyProblem !== null) return null;
    return readTrickMedia(rt.approved.dir, rel);
  }

  /**
   * Switch a trick on or off: the same file `collie trick on|off` writes, through the one locked writer
   * (switches.ts). On approves a version: the one waiting when there is one, else the folder as it is
   * now, copied into `.collie-approved/` (approved.ts). Then the answer waits for a scan that started after the
   * write, so the list, the runtime and `tricksRev` move before it. Works for a trick whose manifest is
   * refused or that keeps failing: the switch is Collie's, not the trick's (design §7).
   */
  async setSwitch(host: string, id: string, on: boolean, hash?: string | null): Promise<SwitchAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    const turn = this.switching.then(() => this.writeSwitch(id, on, hash));
    this.switching = turn.catch(() => {});
    return await turn;
  }

  /** Run `work` in the lane switch writes and version changes take, after a scan in flight. */
  private lane<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.switching.then(async () => {
      await this.scanning;
      return await work();
    });
    this.switching = turn.catch(() => {});
    return turn;
  }

  /**
   * Run an official write (official-install.ts) in the lane switch writes and version changes take, after
   * a scan of its own, then wait for a scan that started after it, so the list and `tricksRev` move before
   * the answer. A folder written here is read like any other: off and new, or, for a trick that is on, a
   * new version the runner's own path takes (a pending copy and its card).
   */
  async officialLane<T>(work: () => Promise<T>): Promise<T> {
    return await this.lane(async () => {
      await this.refresh(true);
      const out = await work();
      await this.freshScan();
      return out;
    });
  }

  /**
   * What a proposal for `id` would be now (crew slice 8): new, a new version, or refused. Only a trick a
   * proposal made takes a new version by proposal: a trick from a repository is changed there, and one
   * added on this machine is the person's folder. A trick that is off, has a change waiting, or runs no
   * approved copy is refused too. A trick on auto takes a proposal: the proposal still waits for the
   * person's yes on its own card, since it comes from an agent and not from the folder.
   */
  async proposalTarget(id: string): Promise<ProposalTarget> {
    await this.refresh(true);
    return this.targetOf(id);
  }

  private targetOf(id: string): ProposalTarget {
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { kind: "new" };
    const repo = rt.found.origin ?? rt.approved?.found.origin;
    if (repo !== undefined) return { kind: "refused", reason: `This trick comes from ${originRepoName(repo.url)}. Change it there.` };
    if (rt.found.proposal === undefined) return { kind: "refused", reason: `${id} was added on this machine. Change it there.` };
    const entry = rt.entry;
    if (!rt.on || entry === undefined) return { kind: "refused", reason: `A trick named ${id} is here and switched off. Ask your person to remove it or switch it on, then propose again.` };
    if (rt.pending !== null || (rt.found.codeHash !== undefined && rt.found.codeHash !== entry.hash && rt.found.codeHash !== entry.declined)) {
      return { kind: "refused", reason: `A new version of ${id} already waits for a yes. Propose again after your person answers it.` };
    }
    if (rt.approved === null || rt.copyProblem !== null || entry.hash === null || rt.found.codeHash !== entry.hash) return { kind: "refused", reason: `${id} runs no approved version now, so nothing was changed.` };
    const target: ProposalTarget = { kind: "version", baseHash: entry.hash, baseDir: rt.approved.dir };
    return rt.approved.found.manifest === undefined ? target : { ...target, baseManifest: rt.approved.found.manifest };
  }

  /**
   * After the person's yes to a proposal card: write the proposal as `<configDir>/tricks/<id>/`, approve
   * exactly the code written (the snapshot must hash to it), and switch it on. Refused when a folder of
   * that name appeared since the card. By `proposal` in the switch file and the audit line.
   */
  async installProposed(id: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<ProposalPlaced> {
    return await this.lane(async () => {
      await this.refresh(true);
      if (this.runtimes.has(id)) return { ok: false, message: `A trick named ${id} is here now. Nothing was switched on.` };
      const written = await writeProposedTrick(tricksConfigDir(this.deps.configDir), id, files, origin);
      if (!written.ok) return { ok: false, message: written.reason };
      const placed = await this.approveWritten(id, written.codeHash, "The trick was written but changed before it could be approved, so it stays off.");
      await this.freshScan();
      return placed;
    });
  }

  /**
   * After the person's yes to a new version's proposal card: the trick must still be the one the card was
   * made against (same approved hash, folder unchanged). Then only its code files change, in place
   * (proposal-install.ts `replaceTrickCode`: every file the code hash does not read stays byte for
   * byte), and exactly the code written is approved. The trick stays on. No scan runs between the write and the approval,
   * so the runner never sees the written code as a version waiting.
   */
  async installProposedVersion(id: string, files: readonly ProposedFile[], origin: ProposalOrigin, baseHash: string): Promise<ProposalPlaced> {
    return await this.lane(async () => {
      await this.refresh(true);
      const target = this.targetOf(id);
      if (target.kind === "refused") return { ok: false, message: target.reason };
      if (target.kind !== "version" || target.baseHash !== baseHash) return { ok: false, message: `${id} changed since this card, so nothing was changed.` };
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      this.scanning = held;
      let placed: ProposalPlaced;
      try {
        const written = await replaceTrickCode(tricksConfigDir(this.deps.configDir), id, files, origin);
        placed = written.ok ? await this.approveWritten(id, written.codeHash, "The new version was written but changed before it could be approved.") : { ok: false, message: written.reason };
      } finally {
        if (this.scanning === held) this.scanning = null;
        release();
      }
      await this.freshScan();
      return placed;
    });
  }

  /** Copy the folder just written into an approved copy that must hash to `codeHash`, and approve it. */
  private async approveWritten(id: string, codeHash: string, failed: string): Promise<ProposalPlaced> {
    const src = join(tricksConfigDir(this.deps.configDir), id);
    const snap = await snapshotTrick({ src, parent: approvedTrickDir(this.deps.configDir, id), expect: codeHash, platform: this.deps.platform });
    if (!snap.ok) return { ok: false, message: `${failed} ${snap.reason}` };
    const read = await scanTrickDir(diskTrickFs, snap.dir, id, undefined);
    const at = new Date(this.now()).toISOString();
    await updateSwitches(this.deps.stateDir, (now) => withApproval(now, id, { at, hash: snap.hash, by: "proposal", powers: read.manifest === undefined ? null : powersOf(read.manifest) }));
    this.deps.audit?.({ action: "trick.approve", detail: { trick: id, hash: snap.hash.slice(0, 16), by: "proposal" } });
    return { ok: true, codeHash: snap.hash };
  }

  private async writeSwitch(id: string, on: boolean, hash: string | null | undefined): Promise<SwitchAnswer> {
    await this.refresh(true);
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { status: 404, body: { error: "unknown-trick" } };
    // Approve what the person read (review 8 V-N1): a switch on from the route names the code the row showed.
    // Another hash, or none while there is code to approve, is refused, and the copy must hash to it.
    const expect = approvesOf(rt);
    if (on && hash !== undefined && expect !== undefined && hash !== expect) return { status: 409, body: { error: "moved", message: SWITCH_MOVED } };
    const at = new Date(this.now()).toISOString();
    if (!on) await updateSwitches(this.deps.stateDir, (switches) => withSwitch(switches, id, false, at));
    // On with a version waiting: that snapshot is what the row showed, so it is what is approved. Else the
    // folder as it is now is copied, and the copy's hash approved.
    const promoted = on && rt.pending !== null ? await this.promote(rt, rt.pending.hash, "phone") : null;
    if (on && promoted?.ok !== true) {
      const approve: ApproveOptions = { stateDir: this.deps.stateDir, configDir: this.deps.configDir, id, by: "phone", at, platform: this.deps.platform };
      if (hash !== undefined && expect !== undefined) approve.expect = expect;
      const approved = await approveFolder(approve);
      // A folder that cannot be copied is still switched on, with nothing approved: the row says why.
      if (!approved.ok) await updateSwitches(this.deps.stateDir, (switches) => withSwitch(switches, id, true, at, null));
      else this.deps.audit?.({ action: "trick.approve", detail: { trick: id, hash: approved.hash.slice(0, 16), by: "phone" } });
    }
    await this.freshScan();
    const info = this.store.reply(this.store.rev).tricks.find((trick) => trick.id === id);
    if (info === undefined) return { status: 404, body: { error: "unknown-trick" } };
    return { status: 200, body: info };
  }
}
