import { randomUUID } from "node:crypto";
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
  tapControls,
  RULES_NEVER_AUTO,
  type FactsTrigger,
  type TrickState,
  type TrickTapReply,
  type TricksReply,
  type TricksRunsOn,
  type FactsSession,
  partKey,
  type ParsedTrickDocument,
  type Refusal,
  TAP_REFUSED_LINES,
  type TapRefusal,
  type TapRequest,
  type TrickManifest,
  type WireTrickInfo,
  type WireTrickPart,
  type WireTrickPending,
  type WireTrickWarning,
  TRICKS_OFF_LINE,
  TRICKS_WINDOWS_LINE,
  isSourceUrl,
  tricksGated,
} from "../../web/src/lib/tricks/schema.ts";
import type { HillTrickTap } from "../hill/service.ts";
import type { ViewGate } from "../agent-view/service.ts";
import type { TrickRightsPort, TrickRightsSubject } from "./rights-card.ts";
import { bindingAgainst, bindParts, type GenerationOf, type InstanceOf } from "./bound.ts";
import { approveFolder, copyListing, forgetLeftovers, fileCounts, forgetMigratedPowers, holdsMigratedPowers, legacyPowersOf, migrateSwitches, powersOf, promoteCopy, pruneCopies, snapshotTrick, sweepGone, syncConfig, verifyCopy, type ApproveOptions } from "./approved.ts";
import { fieldsChanged } from "./version-card.ts";
import { codeHashOfFiles, diskTrickFs, unsafeText } from "./code-hash.ts";
import { createTrickScanner, scanTrickDir, SCAN_TIMEOUT_MS, within, type FoundTrick, type TricksScan } from "./discover.ts";
import { envPath, scrubEnv, type ProgramEnv } from "./env.ts";
import { HOST, hostFor, type Host } from "../host.ts";
import { buildFacts, type FactsWorld } from "./facts.ts";
import type { TrickInputs } from "./inputs.ts";
import { codeFile, codeIndex, codeShowsWhole, codeSource, type CodeFile, type CodeIndex } from "./code-view.ts";
import { readTrickMedia, TrickMediaSync, TrickMediaVersions, type TrickMediaFile } from "./media.ts";
import { isUnlistedOfficialOrigin, shippedOfficialList, type OfficialEntry } from "./official.ts";
import { originRepoName, type ProposalOrigin } from "./origin.ts";
import { replaceTrickCode, writeProposedTrick } from "./proposal-install.ts";
import { proposalHash, splitPictures, type ProposedFile } from "./propose-wire.ts";
import { PROPOSAL_CHANGED } from "./proposals.ts";
import type { TrickHillRun, TrickHillTrick } from "./hill.ts";
import { approvedCopyDir, approvedTrickDir, pendingTrickDir, tricksConfigDir, trickStateDir } from "./paths.ts";
import { trickSessionPanes, type TrickSessionPanes } from "./panes.ts";
import { receiptFrame, TrickReceiptStore, type TrickReceiptRecord, type TrickReceiptSurface } from "./receipts.ts";
import { maskRunToken, maskRunTokenText, outcomeProblem, runProgram, windowsRunProblem, type RunOutcome, type RunSpec } from "./run.ts";
import { RunTokens, type RunTokenHolder } from "./run-tokens.ts";
import type { RepoFactsPort } from "./repo-facts.ts";
import { trickWarnings, wireWarnings } from "./scan.ts";
import { TricksStore, problemLine, type CliTricksExtra } from "./store.ts";
import { TricksFeatureSwitch, type TricksFeaturePort } from "./feature-switch.ts";
import { createSwitchReader, MIGRATED, updateSwitches, withApproval, withEntry, withFreshApproval, withSwitch, type SwitchEntry, type Switches } from "./switches.ts";
import { fieldsWire, SeenWrites, TrickValues, withValues } from "./values.ts";
import { fieldValueProblem, isRequestId, isTrickId, type FieldRefusal, type FieldValue } from "../../web/src/lib/tricks/schema.ts";
import { BACKOFF_MS, HILL_QUEUE_MAX, RUNS_MAX, WATCH_WINDOW_MS } from "../../web/src/lib/tricks/limits.ts";
import { menuMessageLine } from "../../web/src/lib/tricks/menu-message.ts";
import type { EventBus } from "../events/bus.ts";
import { systemTimers, TrickReactions, type Admit, type FloorTimers, type ReactionCounts, type ReactTrigger } from "./triggers.ts";
import { WATCH_POLL_MS, type WatchOptions } from "./watch.ts";

// The run caps live in web/src/lib/tricks/limits.ts, which the tricks catalogue reads too.
export { BACKOFF_MS, HILL_QUEUE_MAX, RUNS_MAX, WATCH_WINDOW_MS };

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
//   * An event (`on`) or a file change (`watch`) runs a trick with NO phone open: only the timer waits for a
//     look. Those runs keep every other bound here, and at least {@link REACT_FLOOR_MS} separates the
//     STARTS of two of them (triggers.ts, THE FLOOR). Taps, Hill answers and timer runs are not delayed by it.
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
// stdout and stderr are masked in run.ts before anything here sees them, and the run's own token is replaced
// by a mark (`maskRunToken`) right after the run, before anything else reads them. The document is parsed with
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
// THE TAP NAMES WHAT WAS DRAWN (fault A). A phone's tap runs the program only when it names what this
// bridge drew: `node` is a part the store holds for that trick, `rev` is the rev the phone drew it at and
// the part's value has not moved since (store.ts `held`), `intent` is one a control of that part sends
// (schema.ts `tapControls`: a belt mark, a session's actions and view buttons; a status chip, a tile and a
// bar item send none), `value` is the one that control sends, or absent where it sends none, and
// `from.session`, when present, is an agent session the facts list now. Anything else is refused before
// the receipt's marker, with one `trick.tap.refused` audit line and a typed `refused` word the phone
// says in its own words; a moved rev answers `changed` with the trick's parts now, and the phone draws
// them and sends nothing again by itself. A tap without `rev` comes from a bundle older than the check
// (the bridge serves its own bundle, so only a tab that has not reloaded since the update sends one): it
// is answered `changed` too, and the next tap, from the new bundle, carries the rev. An answer from the
// Hill is checked there (hill/service.ts `claim`: the decision is open, the intent is one of its
// options, `answer` or `dismiss`, and the text keeps its rule), so `tapFromHill` skips these checks.
//
// ── DECISIONS (M94, M96) ────────────────────────────────────────────────────────
// After a run that succeeded, the document's decisions go to the hill through `deps.decisions`
// (hill.ts): posted, superseded or withdrawn by key. A document with no `decisions` key leaves them as
// they are; an empty list withdraws them. Its refusals join the document's. A trick switched off or
// removed has every open decision withdrawn; one with a new version waiting keeps them, and keeps running. The answer comes back from the
// hill as a tap on `hill/<key>` (`tapFromHill`), with the answer's own rid and `seen`, the content hash
// of the version the person saw. The phone's tap route refuses a `hill/` node: a decision is answered
// on the Hill.

// How long a phone's look keeps timers running: WATCH_WINDOW_MS, in limits.ts so the About sheet names it.
/** The scheduler's tick. A timer of 5 s therefore runs within a second of its due time. */
export const TICK_MS = 1000;
/** The least time between two scans of the tricks folder. */
export const SCAN_EVERY_MS = 2000;
/** A changed value restarts its trick once, this long after the LAST write: a person typing or a slider moving costs one run. */
export const VALUE_RESTART_MS = 1000;
/** The tap receipts kept in memory with their parts, newest last. The file keeps its own. */
export const TAP_RECEIPTS_MAX = 200;
/** The row's line while a new version of an on trick waits for a person's yes. */
export const PENDING_LINE = "A new version waits for your yes.";
/** The line of a trick that is on but has no approved version (a version 1 entry, a migration of a changed folder). */
export const NOT_APPROVED_LINE = "No version of this trick is approved yet. Switch it on again to approve its code as it is now.";
/** The answer to a tap on a trick that is only an agent view: it has no program, so nothing runs. */
export const NO_PROGRAM_LINE = "This trick has no program, so nothing runs.";
/** The reply of a run that a new version or new settings overtook while it went (its output is dropped). */
export const SUPERSEDED_LINE = "The trick changed while it ran, so it runs again with the new version.";
/** The line of a trick whose approved copy changed on disk. */
export const TAMPERED_LINE = "The approved copy changed on disk, so the trick stopped. Switch it on again to approve its code as it is now.";
/**
 * The row's line when the rights a trick was approved with are not the rights its approved copy asks for as
 * this Collie reads it (fault B): a newer reader names a right the older one did not, or the stored powers
 * are unknown. The trick stops until a person switches it on again, which approves it with the rights read now.
 */
export const RIGHTS_LINE = "Its rights changed. Switch it on again.";
/** The row's line when the approved copy holds a symbolic link (one made before links were refused). */
export const LINK_LINE = "The approved copy holds a symbolic link, so the trick stopped. A trick holds regular files only: replace the link in its folder, then switch it on again.";
/** How long a changed folder must stay still before its snapshot is taken. */
export const PENDING_SETTLE_MS = 5000;
/** How often the unreferenced copies are pruned. */
export const PRUNE_EVERY_MS = 60_000;
/** What a run's bound parts are stamped with, read with its facts (service.ts `tokensOf`). */
interface RunBindings {
  /** Each agent session's walky instance token. */
  readonly tokens: ReadonlyMap<string, string>;
  /** Each agent session's binding generation (bound.ts), null where it cannot be read. */
  readonly generations: ReadonlyMap<string, string | null>;
}

/** The message of a retried tap whose run started before the bridge restarted. */
export const TAP_LOST_LINE = "The bridge restarted while this tap ran. It may have done its work; nothing ran again.";

/** Whether the phone asked for bound parts (`?bound=1`): one that does not draws none, never one in every session. */
export interface BoundAsk {
  readonly bound?: boolean;
}

/** What the server needs: the snapshot's rev, the watch stamp, the two routes. */
export interface TricksSurface {
  /** `tricksRev` for the snapshot, or undefined when there is no tricks folder (no field at all). */
  rev(): number | undefined;
  /** A paired phone looked (`/api/snapshot`, `/api/tricks`). */
  noteWatched(): void;
  /**
   * `GET /api/tricks?since=`, with bound parts only for a phone that asks `bound=1` (bound.ts). `forCli`
   * is true only for a request from the host's own CLI; the reply then also carries the runner's PATH,
   * which no phone gets.
   */
  reply(since: number | undefined, opts?: BoundAsk & { readonly forCli?: boolean }): Promise<TricksReply & CliTricksExtra>;
  /** `POST /api/tricks/<host>/<id>/tap`, its receipt's parts with bound ones only for `bound=1`. */
  tap(host: string, id: string, body: JsonValue | undefined, opts?: BoundAsk): Promise<TapAnswer>;
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
  /**
   * `GET /api/tricks/<host>/<id>/code[?file=<rel>]`: the index of a trick's code, or one file of it, as the
   * About sheet's "Read the code" folds read them (code-view.ts). A read only; no right beyond the list's.
   */
  code(host: string, id: string, file: string | null): Promise<CodeAnswer>;
  /** The switch for tricks as a whole (feature-switch.ts): whether tricks run here as far as the switches go. */
  switchedOn(): boolean;
  /** Move it from the phone (`POST /api/tricks/switch`): whether tricks are on now, or null when it could not be written. */
  switchTo(on: boolean, device: string | null): boolean | null;
  /** The Windows gate's line, or null where tricks run. */
  gateLine(): string | null;
  /**
   * `POST /api/tricks/<host>/<id>/value` (contract 3): one field's value, with the request id the phone
   * minted; null clears it back to the default. See {@link TricksService.setValue}.
   */
  setValue?(host: string, id: string, request: ValueRequest): Promise<ValueAnswer>;
}

/** The answer of the code route. */
export type CodeAnswer =
  | { status: 200; body: CodeIndex | CodeFile }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" | "no-file"; message?: string } }
  | { status: 409; body: { error: "windows" | "no-code" | "moved"; message: string } };

/** One value write: the request id, the field's key, the value (null clears it). */
export interface ValueRequest {
  rid: string;
  key: string;
  value: FieldValue | null;
}

/** The receipt of a value write that took: the request id, the key, whether the value moved, the row now. */
export interface ValueReceipt {
  rid: string;
  code: "ok";
  key: string;
  changed: boolean;
  info: WireTrickInfo;
}

/** Why a value write was refused, as a code the phone branches on: a field rule, or no such field. */
export type ValueRefusalCode = FieldRefusal | "unknown-field";

/** The value route's answer: the receipt, or why not in plain words that name the next step. */
export type ValueAnswer =
  | { status: 200; body: ValueReceipt }
  | { status: 400; body: { error: "value-invalid" } }
  | { status: 400; body: { error: "value-refused"; rid: string; code: ValueRefusalCode; message: string } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick" } }
  | { status: 409; body: { error: "request-id-reused"; rid: string } }
  | { status: 409; body: { error: "windows" | "not-here" | "write-failed" | "tricks-off"; message: string } };

/** The words of a value write on a bridge that runs no tricks: the values live where the tricks run, on the lead. */
export const VALUES_ON_LEAD = "Tricks run on the lead of this crew, and their settings live there. Set the value on the lead, or on the phone.";
/** The words of a value write the disk refused. */
export const VALUES_WRITE_FAILED = "The value could not be saved on this machine. Try again; if it fails again, look at the bridge's log.";

/** Why an answer from the Hill is not given to a trick: the card is not one the trick holds now. One sentence. */
export const STALE_CARD_LINE = "That card is not one this trick asked, so the answer was not given to it.";

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

/**
 * N5 (review 11): a refused tap writes its audit line at most once a minute per trick and reason, the
 * rule of the agent view's refused writes (agent-view/service.ts `noteRefusedWrite`), so a phone or a
 * forger tapping in a loop cannot fill the audit log. Past this many keys, a new one waits for a free slot.
 */
export const TAP_REFUSAL_AUDIT_MS = 60_000;
export const TAP_REFUSAL_KEYS_MAX = 1024;

/** The bridge's words for a refused phone tap (fault A); they live in the schema, which the tricks catalogue reads too. */
export { TAP_REFUSED_LINES };

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
  | { status: 409; body: { error: "off" | "no-pending" | "moved" | "no-previous" | "copy-failed" | "has-rules" | "windows" | "tricks-off"; message: string } };

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
  /** `code`: `no_tricks` while tricks as a whole are switched off (the wire's code for "tricks do not run here"). */
  | { kind: "refused"; reason: string; code?: "no_tricks" };

/** What writing a proposal into the tricks folder came to. */
export type ProposalPlaced = { ok: true; codeHash: string } | { ok: false; message: string };

/** The switch route's answer: the trick as the list now shows it, or why not. */
export type SwitchAnswer =
  | { status: 200; body: WireTrickInfo }
  | { status: 400; body: { error: "switch-invalid" } }
  | { status: 409; body: { error: "moved" | "windows" | "windows-shell" | "tricks-off" | "not-whole"; message: string } }
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
  /**
   * The facts world of this bridge for a run, capped as the schema caps it. `{ all: true }`: every session,
   * past the caps, for the bridge's own tap check (fault A), never for a program.
   */
  world: (memberId: string, opts?: { readonly all?: boolean }) => Omit<FactsWorld, "memberId">;
  /**
   * Contract 2, bound parts (bound.ts): the walky instance token a facts session's pane holds now, or null
   * when there is none (a crew member that sent none, a pane not seen). Read with a run's facts, before it
   * starts (review 12 N6), and again at each tap on a bound or a menu part. Absent: every bound part is dropped, fail closed.
   */
  instanceOf?: InstanceOf;
  /**
   * The binding generation (bound.ts) of a facts session's pane now, `<agent>:<agent session or ->`, or null
   * when it cannot be read (a crew member's session: the wire carries no agent session). Read with a run's
   * facts and before each list and tap. Absent: bindings are checked by their instance token alone.
   */
  generationOf?: GenerationOf;
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
  /**
   * The platform: the shell a run line runs in, and the Windows gate (`gated`). bridge/index.ts passes
   * `process.platform`; a test passes `"win32"` to see the gate on any host. Absent: the shell of this
   * host, and no gate.
   */
  platform?: NodeJS.Platform;
  /** The trick's decisions on the hill. Absent: decisions are parsed and posted nowhere. */
  decisions?: TricksHillPort;
  /**
   * A new trick was added under this id (an agent's proposal, here; the official list and the repository index
   * get their own): drop what lives beside its files from an earlier trick of that name, its agent views and its
   * Hill keys. Absent: nothing of the kind is held.
   */
  forgetTrick?: (id: string) => void | Promise<void>;
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
  /** Fault B: the card that says a trick stopped for its rights (rights-card.ts). Absent: the row alone says it. */
  rights?: TrickRightsPort;
  /**
   * Stars and the last commit of a trick's GitHub repository (repo-facts.ts), for the About sheet. A phone's
   * read of the list asks for the stale ones; the read never waits for them. Absent: no facts, no read.
   */
  repoFacts?: RepoFactsPort;
  /**
   * The switch for tricks as a whole (feature-switch.ts), read on each use. Absent: the file switch of
   * `stateDir`, so a runner built without one reads no file as OFF and runs nothing (fail closed). A test
   * that runs tricks passes `{ on: () => true }`.
   */
  feature?: TricksFeaturePort & { onChange?(listener: (on: boolean) => void): () => void };
  /**
   * The local API socket's path while it stands, else null (bridge/index.ts: `apiSocketPath` while the `ApiSocket`
   * runs). A trick whose approved manifest declares `access` gets it in its facts as `api` (M105 spec 04), and
   * when it is null the row says so once. Absent: the local API never stands here.
   */
  localApi?: () => string | null;
  /**
   * Told the key (the hash hex) of every run token that dies, at once, whatever killed it (run-tokens.ts).
   * bridge/index.ts hands it to `ApiSocket.endToken`, which ends every connection bound to that token. Absent:
   * nobody is told, and the socket still refuses the dead token at the connection's next request or answer.
   */
  runTokenEnded?: (key: string) => void;
  /**
   * Told whether the local API should stand ({@link TricksService.localApiWanted}) when that moved, and once
   * at the first tell. bridge/index.ts starts and stops the socket on it (decision 14, as the lead wired it
   * on 2026-11-17: the switch for tricks as a whole, on a bridge where tricks run, with or without a trick on).
   */
  onLocalApi?: (wanted: boolean) => void;
  /** The bridge's event bus: a trick that lists `on` runs on its events (triggers.ts). Absent: `on` runs nothing. */
  bus?: EventBus;
  /** The file watch's knobs, for a test (watch.ts). Absent: the production values. */
  watchOptions?: WatchOptions;
  /** The timer of the 10 second floor between two event or watch runs, for a test (triggers.ts). Absent: `setTimeout`. */
  reactionTimers?: FloorTimers;
  /** The timer of a changed value's restart ({@link VALUE_RESTART_MS} after the last write), for a test. Absent: `setTimeout`. */
  valueTimers?: FloorTimers;
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
  | { ok: false; code: "unknown-trick" | "off" | "no-pending" | "moved" | "no-previous" | "copy-failed" | "has-rules" | "windows" | "tricks-off"; message: string };

/** The rights an approval holds against the rights its copy asks for now (fault B). */
export interface RightsMoved {
  /** The approved code hash. */
  hash: string;
  /** The powers the switch entry stores, or null when it stores none. */
  stored: string | null;
  /** The powers of the approved copy's manifest, as this Collie reads it. */
  now: string;
}

interface QueuedTap {
  request: TapRequest;
  /** Only on a decision's answer from the hill: the content hash the person saw. */
  seen?: string;
  /** The in-flight marker written before the program runs. */
  marker: TrickReceiptRecord;
  /** Set once the marker reached disk: only then is the receipt completed on disk. */
  marked: boolean;
  /** Only on a phone's tap: the rev it drew, checked again when the tap's run begins (N1). */
  phone?: { rev: number | undefined };
  resolve: (reply: TrickTapReply) => void;
}

/** A queued tap as the trigger its run gets. */
function tapTrigger(tap: Pick<QueuedTap, "request" | "seen">): FactsTrigger {
  return tap.seen === undefined ? { kind: "tap", ...tap.request } : { kind: "tap", ...tap.request, seen: tap.seen };
}

interface TrickRuntime {
  /** The trick's folder, as the scan last read it. */
  found: FoundTrick;
  /** On and live: its own switch is on AND tricks as a whole are on. Every run and part reads this. */
  on: boolean;
  /** Its own switch (`switches.json`), whatever the switch for tricks as a whole says: what its row shows. */
  own: boolean;
  /** The switch entry, while on. */
  entry: SwitchEntry | undefined;
  /** On, and the folder no longer hashes to the approved version: a new version is there. */
  changed: boolean;
  /** The approved copy that runs, or null when none does. */
  approved: ApprovedRun | null;
  /** Why the approved copy cannot run (it changed on disk, or it is gone), or null. */
  copyProblem: string | null;
  /** The content version of each picture in the approved copy's `media/` (`WireTrickInfo.media`), as the last scan read it. Absent: none. */
  media?: Record<string, string>;
  /** The approval (`<hash>@<at>`) whose copy was found changed: not checked again until a new approval. */
  tampered: string | null;
  /**
   * Fault B: the approved copy asks for other rights than the switch entry approved, as this Collie reads
   * them. Set with {@link RIGHTS_LINE} as the copy problem; cleared by a new approval or the switch off.
   */
  rightsMoved: RightsMoved | null;
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
  /** A changed value asked for a restart at this time; each later write moves it (`tick` starts the one run). Absent: none asked. */
  valueRestartAt?: number;
  /**
   * An immediate start run was asked for ({@link TricksService.startSoon}) and has not gone yet: it waits for the run
   * or tap ahead to end, then `begin` asks again. Cleared when the start run begins or cannot begin.
   */
  soon?: boolean;
  /** A microtask for {@link TricksService.startNow} is queued, so a burst of restarts in one turn is one start. */
  soonQueued?: boolean;
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
  /** When each (trick, reason) of a refused tap last wrote its audit line (N5). */
  private readonly tapRefusalLines = new Map<string, number>();
  private readonly inflight = new Map<string, { digest: string; reply: Promise<TrickTapReply> }>();
  private readonly receiptFile: TrickReceiptSurface;
  private receiptsLoaded: Promise<void> | null = null;
  private readonly slots = new RunSlots(RUNS_MAX);
  /** The immediate start runs going now ({@link startNow}), so a test (and `tick`) can wait for them. */
  private readonly soonRuns = new Set<Promise<void>>();
  private readonly valueTimers: FloorTimers;
  /** The open restart timer of each trick whose value was written, by trick id. */
  private readonly valueTimerOf = new Map<string, number>();
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
  /** The start's sweep of `.gone-*` leftovers (`boot`); a test waits on it. */
  swept: Promise<void> = Promise.resolve();
  /** Whether a good scan ran already: the first one only learns which trick ids the service holds. */
  private scannedOnce = false;
  /** When the unreferenced copies were last pruned. */
  private prunedAt = -Infinity;
  /** The switch for tricks as a whole (feature-switch.ts). */
  private readonly feature: NonNullable<TricksServiceDeps["feature"]> & { set?(on: boolean): boolean };
  /** Aborted when tricks are switched off as a whole: it kills every program running now, then a fresh one stands for the next runs. */
  private runStop = new AbortController();
  /** The last scan found tricks switched off as a whole: every runtime is folded in as off, its own switch kept. */
  private suspended = false;
  /** What `onLocalApi` was last told; null before the first. */
  private localApiTold: boolean | null = null;
  /**
   * The run tokens of the local API (M105 spec 05, run-tokens.ts): one per run of a trick that declares
   * `access`, while the socket stands. Each dies with its run (`runOnce`), its trick's switch or removal
   * (`applyOne`, `apply`), tricks going off as a whole (the feature switch's `onChange`) and `stop`.
   */
  private readonly runTokens = new RunTokens((key) => this.deps.runTokenEnded?.(key));
  /** `on` and `watch`: the bus subscription, the file watches and the waiting requests (triggers.ts). */
  private readonly reactions: TrickReactions;
  /** The tricks whose file watch fell back to a stat check (watch.ts): the row says it, from `watchPollSeconds`. */
  private readonly watchPolled = new Set<string>();
  /** The values a person keeps for each trick (contract 3, values.ts). */
  private readonly values: TrickValues;
  /** The versions of the approved copies' pictures, read again only for a file whose size or time moved. */
  private readonly mediaVersions = new TrickMediaVersions();
  /** What the installed folders' `media/` last gave the approved copies: a picture changed by hand reaches the copy. */
  private readonly mediaSync = new TrickMediaSync();
  /** The request ids of value writes already taken, with their receipts: the same id twice writes once. */
  private readonly valueWrites = new SeenWrites<ValueAnswer>();

  constructor(deps: TricksServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((line) => console.warn(`[tricks] ${line}`));
    this.store = new TricksStore(deps.revBase ?? Date.now());
    this.scanner = createTrickScanner(tricksConfigDir(deps.configDir), { warn: this.warn });
    this.readSwitches = createSwitchReader(deps.stateDir, this.warn);
    this.receiptFile = deps.receipts ?? new TrickReceiptStore(deps.stateDir, this.warn);
    this.values = new TrickValues(deps.stateDir);
    this.reactions = new TrickReactions(
      { admit: (id) => this.reactAdmit(id), start: (id, trigger) => this.reactStart(id, trigger), due: (id) => this.reactDue(id), note: (id, note) => this.reactNote(id, note), warn: this.warn },
      { bus: deps.bus, watch: deps.watchOptions, now: this.now, timers: deps.reactionTimers },
    );
    this.valueTimers = deps.valueTimers ?? systemTimers();
    this.feature = deps.feature ?? new TricksFeatureSwitch(deps.stateDir, this.warn);
    // A move of the switch folds in at once (after the read that saw it), so the parts go and the rows move.
    this.feature.onChange?.((on) => {
      // Off kills the programs that run now (their runs end `stopped`; the waiting runs are refused at `recheck`).
      if (!on) {
        this.runStop.abort();
        this.runStop = new AbortController();
        // Every run token dies with tricks (spec 05, decision 2), before the killed runs report.
        this.runTokens.clear();
      }
      queueMicrotask(() => {
        this.scannedAt = -Infinity;
        void this.refresh(true);
      });
    });
  }

  // ── The switch for tricks as a whole (feature-switch.ts) ─────────────────────────────────────
  // THE CHECK POINT. Tricks are an experiment, off by default. While the switch is off:
  //   * every run passes `recheck` right before its program starts (start, timer, tap, a Decision's
  //     answer, an `on` event, a `watch` change: every run goes through `begin`), and `recheck` refuses first;
//   * `on` and `watch` (triggers.ts) hold nothing open while off: `syncReactions` gives triggers.ts no target,
//     so the bus subscription and the file watches close, and `reactAdmit` drops a request that still arrives;
  //   * a scan folds every trick in as off (`refresh`, `applyOne`): its parts are dropped, its approved copy
  //     is unloaded, no agent view passes `viewGate`, nothing is due; its own switch is kept for its row;
  //   * the doors that read without a scan or write before one ask `switchedOff()` themselves: `reply`
  //     (no parts), `sessionPanes`, `viewGate`, `media`, `tick`, `runTap`, `runOnce` after the program
  //     ends, `setSwitch`, `approvePending`, `declinePending`, `undo`, `setAuto`, `officialLane`,
  //     `proposalTarget`, `installProposed`, `installProposedVersion`.
  // A trick's open Decisions are not withdrawn by it: the Hill hides them while tricks are off and refuses
  // their answers, as it keeps its own waiting Decisions while the Hill is off (hill/service.ts
  // `tricksOff`). The Windows gate stays first everywhere.

  /** Whether tricks as a whole are switched off on this machine. No switch file is off. */
  switchedOff(): boolean {
    return !this.feature.on();
  }

  /**
   * Whether tricks run on this bridge as far as the switches go: not gated, and switched on. Synchronous,
   * for the local API (it opens while this is true and tricks run on this bridge).
   */
  switchedOn(): boolean {
    return !this.gated() && this.feature.on();
  }

  /**
   * Whether the local API socket should stand: tricks switched on (not gated) AND tricks run on this bridge
   * (`deps.active`: not a crew peer, a deputy or a deposed lead). No trick need be on. Never true on Windows:
   * the gate closes tricks there, and the socket follows them (the local API has no Windows transport yet).
   */
  localApiWanted(): boolean {
    return this.switchedOn() && this.deps.active?.() !== false;
  }

  /**
   * The trick and level of a live run token, or null (M105 spec 05, decision 2): the one door the local API
   * socket asks, through the narrow `RunTokenCheck` bridge/index.ts builds from this. Constant time.
   */
  resolveRunToken(token: string): RunTokenHolder | null {
    return this.runTokens.resolve(token);
  }

  /** Whether the run token whose hash hex is `key` (from {@link resolveRunToken}) is still live. */
  runTokenAlive(key: string): boolean {
    return this.runTokens.alive(key);
  }

  /** Listen for a move of the switch for tricks as a whole; the answer stops listening. */
  onSwitchChange(listener: (on: boolean) => void): () => void {
    return this.feature.onChange?.(listener) ?? (() => {});
  }

  /** The line a door answers while tricks are switched off, or null while they are on. Windows answers its own line first. */
  offLine(): string | null {
    return this.switchedOff() ? TRICKS_OFF_LINE : null;
  }

  /**
   * Move the switch for tricks as a whole from the phone. Answers whether tricks are on now, or null when it
   * could not be written (nothing changed). Refused (null) on a Windows bridge. One `tricks.switch` audit line.
   */
  switchTo(on: boolean, device: string | null = null): boolean | null {
    if (this.gated()) return null;
    if (this.feature.set?.(on) !== true) return null;
    this.deps.audit?.({ action: "tricks.switch", detail: device === null ? { on: String(on) } : { on: String(on), device } });
    return this.feature.on();
  }

  // ── The Windows gate ────────────────────────────────────────────────────────────────────────
  // THE ONE PLACE. On a Windows bridge no trick runs (start, timer, tap, a Decision's answer), nothing is
  // switched on, approved, taken without asking, added from the list or placed by a proposal, no part
  // draws, and no agent view opens or takes a write. The folder is not even read, so no copy is made.
  // Each entry below asks `gated()` first and answers TRICKS_WINDOWS_LINE. Why: the env scrub, the
  // helper's output, the timeout kill and the shell line are not ready on Windows yet (docs/windows.md).
  // `collie trick off` still writes the switch file, so a person can turn a trick off for the day the gate
  // lifts. The Hill's own cards and the person's answers do not pass here and stay as they are.

  /** Whether tricks are gated on this bridge: a Windows machine (`deps.platform`). */
  gated(): boolean {
    return tricksGated(this.deps.platform);
  }

  /** The line a gated bridge answers, or null where tricks run. For the official list's add (official-install.ts). */
  gateLine(): string | null {
    return this.gated() ? TRICKS_WINDOWS_LINE : null;
  }

  /** Start the scheduler. Silent and nearly free while no phone watches: a tick then does nothing. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /**
   * ONE SCAN AT BRIDGE START, so a trick that reacts (`on`, `watch`) stands without a phone's look (the
   * lead, 2026-11-17). The local API socket does not follow this scan: it follows the switch for tricks as
   * a whole ({@link localApiWanted}), which the first tick and each scan tell through `onLocalApi`. The
   * scan runs only where it is needed: never while the Windows gate is closed, never where tricks do not
   * run (`deps.active` false: a crew peer, a deputy, a deposed lead), and only when the switch file holds
   * a trick that is on. Then one forced scan, and the start run of each trick that reacts, since a trick
   * takes no event before its start run. A trick that only runs on its timer still waits for a phone, as
   * before. One scan, not a loop: a failure is logged once, and the next phone look scans as today.
   * Resolves when the start runs it began are done, which is what a test waits on.
   */
  async boot(): Promise<void> {
    if (this.gated() || this.deps.active?.() === false) return;
    // What a crashed add left set aside (approved.ts `forgetLeftovers`), whatever is switched on. Not awaited:
    // the removal of a large state folder never holds the start.
    this.swept = (async () => {
      await sweepGone({ stateDir: this.deps.stateDir, configDir: this.deps.configDir });
    })();
    try {
      const switches = await this.readSwitches();
      if (switches.on.size === 0) return;
      await this.refresh(true);
      const now = this.now();
      const started: Promise<void>[] = [];
      for (const rt of this.runtimes.values()) {
        const manifest = rt.approved?.found.manifest;
        const reacts = (manifest?.on?.length ?? 0) > 0 || (manifest?.watch?.length ?? 0) > 0;
        if (reacts && rt.pendingStart && this.due(rt, now)) started.push(this.begin(rt, { kind: "start" }, null));
      }
      await Promise.all(started);
    } catch (err) {
      this.warn(`the scan at start failed, the next phone look scans: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.reactions.close();
    for (const handle of this.valueTimerOf.values()) this.valueTimers.clear(handle);
    this.valueTimerOf.clear();
    // The bridge stops: no run token outlives it (spec 05, decision 2).
    this.runTokens.clear();
  }

  /**
   * The tricks rev the snapshot carries, or undefined to send nothing: while the tricks folder exists, and,
   * on a bridge that runs tricks (no `runsOn`), also while the official list offers something. So a
   * fresh install with no tricks folder shows Settings, Tricks with only the list, and the first add makes
   * the folder (proposal-install.ts `writeNewTrick`), which the next scan reads with no restart.
   */
  rev(): number | undefined {
    // A gated bridge always sends a rev, so Settings, Tricks shows the one line.
    if (this.folderExists || this.gated()) return this.store.rev;
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

  /** The host rules of `deps.platform`: Windows reads environment names without case. */
  private host(): Host {
    return this.deps.platform === undefined ? HOST : hostFor(this.deps.platform);
  }

  /** The PATH a program gets, by the spelling the environment carries (`Path` on Windows). */
  runnerPath(): string {
    const host = this.host();
    return envPath(scrubEnv(this.deps.env, [], { host }), host) ?? "";
  }

  /** Resolves when the immediate start runs going now ({@link startNow}) are done. For a test. */
  async idle(): Promise<void> {
    while (this.soonRuns.size > 0) await Promise.all(this.soonRuns);
  }

  /** How many programs run (or hold a slot) now. For a test. */
  runsHeld(): number {
    return this.slots.held;
  }

  async reply(since: number | undefined, opts?: BoundAsk & { readonly forCli?: boolean }): Promise<TricksReply & CliTricksExtra> {
    if (this.gated()) return { rev: this.store.rev, tricks: [], parts: [], present: [], gate: "windows" };
    await this.refresh();
    this.rebind();
    // A phone's read asks for the repositories' facts (repo-facts.ts): lazily, in the background, within the
    // cap. The host's own CLI shows none, so its read asks for none.
    if (opts?.forCli !== true) this.deps.repoFacts?.want(this.sourceUrls());
    const out = this.store.reply(since, opts?.forCli === true && this.folderExists ? this.runnerPath() : undefined, this.deps.runsOn?.(), { bound: opts?.bound === true });
    // Switched off: the list stays readable, and no part rides along, even one a scan has not dropped yet.
    if (this.switchedOff()) return { ...out, parts: [], present: [], off: true };
    return out;
  }

  sessionPanes(): TrickSessionPanes | undefined {
    if (!this.folderExists || this.gated() || this.switchedOff()) return undefined;
    this.rebind();
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
    if (this.gated()) return { ok: false, code: "trick_off", error: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { ok: false, code: "trick_off", error: TRICKS_OFF_LINE };
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
    if (this.gated()) return Promise.resolve();
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
        // N7: powers an earlier migration stored from the current reader go back to null, once.
        if ([...switches.on.values()].some(holdsMigratedPowers)) {
          const reset = await forgetMigratedPowers(this.deps.stateDir);
          if (reset.length > 0) this.warn(`switches.json: the rights a migration stored for ${reset.join(", ")} were not a person's yes; they read as the old build's rights now`);
          switches = await this.readSwitches();
        }
        const scan = await this.scanner.scan(new Set(switches.on.keys()));
        await this.forgetArrivals(scan, switches);
        // Read after the switch file, so a scan never folds in a switch older than the one it read.
        this.suspended = this.switchedOff();
        this.apply(scan, switches);
        // A snapshot of the runtimes: each step awaits, and the loop must not see the map move under it.
        const runtimes = [...this.runtimes.values()];
        for (const rt of runtimes) await this.ensureApproved(rt);
        for (const rt of runtimes) await this.notePending(rt);
        this.syncMedia();
        this.syncVersions();
        this.syncRights();
        this.syncReactions();
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

  /**
   * A scan other than the first one that sees a trick id this service did not hold before: a trick added at
   * the terminal under the id of an earlier one (`collie trick add` cannot reach this process's memory). It
   * runs the same `forgetTrick` hook an add through the bridge runs (the agent views and the Hill keys of
   * that id), BEFORE {@link apply} lets the trick run, so a session's view of the old trick never carries
   * the new one's rules and an old card never answers to the new program. The first good scan only records
   * the ids it holds; an id whose switch entry holds an approved hash is kept (the folder only vanished for a
   * moment); a kept scan (it ran over, or the folder could not be listed) changes nothing. A hook that throws is logged and the trick still runs: the files are the new trick's, and the next arrival
   * tries again.
   */
  private async forgetArrivals(scan: TricksScan, switches: Switches): Promise<void> {
    if (scan.kept !== undefined) return;
    const first = !this.scannedOnce;
    this.scannedOnce = true;
    if (first || this.deps.forgetTrick === undefined) return;
    for (const found of scan.tricks) {
      if (this.runtimes.has(found.id)) continue;
      // An entry WITH an approved hash is a trick that exists: its folder only vanished for a moment (the
      // swap of `collie trick update`, which leaves the entry). A true leftover had its entry cleared by
      // `forgetLeftovers`, so it arrives with none, or with one that approves nothing.
      if (switches.on.get(found.id)?.hash != null) continue;
      try {
        await this.deps.forgetTrick(found.id);
      } catch (err) {
        this.warn(`the views and Hill keys of a new trick "${found.id}" could not be forgotten: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
        this.runTokens.endTrick(id);
        this.store.removeTrick(host, id);
        this.deps.decisions?.off(this.hillTrick(rt));
        this.deps.inputs?.forget(id);
      }
      // A trick removed while the bridge was down has its open decisions withdrawn too.
      this.deps.decisions?.prune(ids, host);
    }
    for (const found of scan.tricks) this.applyOne(found, this.liveEntry(switches, found.id), switches.on.has(found.id));
    this.tellLocalApi();
  }

  /** Tell `onLocalApi` whether the local API should stand, when that moved. Never throws. */
  private tellLocalApi(): void {
    const wanted = this.localApiWanted();
    if (wanted === this.localApiTold) return;
    this.localApiTold = wanted;
    try {
      this.deps.onLocalApi?.(wanted);
    } catch (err) {
      this.warn(`the local API could not be told: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A trick's switch entry as runs read it: none while tricks are switched off as a whole (`suspended`). */
  private liveEntry(switches: Switches, id: string): SwitchEntry | undefined {
    return this.suspended ? undefined : switches.on.get(id);
  }

  /**
   * Fold one trick folder and its switch entry into its runtime and its list entry. `entry` is the live one
   * ({@link liveEntry}: none while tricks are switched off); `own` is the trick's own switch, kept for its
   * row. A trick's open Decisions are withdrawn when ITS switch goes off, never for the switch of tricks as
   * a whole (the Hill hides them meanwhile).
   */
  private applyOne(found: FoundTrick, entry: SwitchEntry | undefined, own: boolean): void {
    const host = this.deps.memberId;
    const on = entry !== undefined;
    const changed = isChanged(entry, found);
    const old = this.runtimes.get(found.id);
    if (old === undefined) {
      this.runtimes.set(found.id, {
        found,
        on,
        own,
        entry,
        changed,
        approved: null,
        copyProblem: null,
        rightsMoved: null,
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
      // Off at start (switched off while the bridge was down): its open decisions go. Not for a trick that is
      // on while tricks as a whole are off: its Decisions wait, hidden, for the switch.
      if (!own) this.deps.decisions?.off({ id: found.id, name: found.manifest?.name ?? found.id, memberId: host });
      this.publish(found.id);
      this.tellLocalApi();
      return;
    }
    // A change of the folder restarts nothing: the trick runs its approved copy, and a new version waits
    // (notePending). A config.toml edit restarts it once it reaches the copy (ensureApproved).
    old.found = found;
    const switched = old.on !== on;
    // Its own switch went off: its Decisions go, also while tricks as a whole were off and it ran nothing.
    const ownOff = old.own && !own;
    old.on = on;
    old.own = own;
    old.entry = entry;
    old.changed = changed;
    if (switched && !on) {
      // Its run tokens die with its switch (spec 05, decision 2), also while a run of it is still going.
      this.runTokens.endTrick(found.id);
      old.approved = null;
      old.copyProblem = null;
      old.tampered = null;
      old.pending = null;
      old.settle = null;
      this.store.dropParts(host, found.id);
      this.deps.inputs?.forget(found.id);
    }
    if (ownOff) this.deps.decisions?.off(this.hillTrick(old));
    if (switched && on) this.restart(old);
    this.publish(found.id);
    this.tellLocalApi();
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
      rt.rightsMoved = null;
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
          // An approval rewritten at the same hash (a switch on again) may store other powers: check them each pass.
          if (this.rightsMovedOf(rt, loaded) !== null) return this.stopForRights(rt, loaded, `${want}@${rt.entry?.at ?? ""}`);
          await this.syncConfigOf(rt, loaded);
          return;
        }
        rt.approved = null;
      }
      const approval = `${want}@${rt.entry?.at ?? ""}`;
      // A trick stopped for its rights is read again when the powers its entry stores move, whatever wrote them.
      const powersMoved = rt.rightsMoved !== null && rt.rightsMoved.stored !== (rt.entry?.powers ?? null);
      if (rt.tampered === approval && !powersMoved) return;
      let check = await verifyCopy(dir, want);
      // A missing copy of a version the folder still holds is the same bytes: copy it again.
      if (!check.ok && check.missing && rt.found.codeHash === want) {
        const snap = await snapshotTrick({ src: rt.found.dir, parent: approvedTrickDir(this.deps.configDir, id), expect: want, platform: this.deps.platform });
        if (snap.ok) check = await verifyCopy(dir, want);
      }
      if (!check.ok) return this.copyFailed(rt, check.missing ? NOT_APPROVED_LINE : check.link === true ? LINK_LINE : TAMPERED_LINE, check.reason, check.missing ? null : approval);
      await syncConfig(rt.found.dir, dir);
      const found = await scanTrickDir(diskTrickFs, dir, id, undefined);
      const run: ApprovedRun = { hash: want, dir, found, listing: check.listing };
      if (this.rightsMovedOf(rt, run) !== null) return this.stopForRights(rt, run, approval);
      rt.approved = run;
      rt.copyProblem = null;
      rt.tampered = null;
      rt.rightsMoved = null;
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

  /**
   * Fault B: whether the approved copy asks for other rights than its switch entry stores, as this Collie
   * reads its manifest. Stored powers that are unknown (`null`) on an entry `by: "migrated"` (a switch
   * file from before stored powers, migrated at boot, or an undo to such an entry) hold only what that
   * build could show the person (approved.ts `legacyPowersOf`): `env` and the old places. A null on any
   * other entry is a yes given while the manifest did not parse (M2): it holds no right, and the trick
   * stops until a person switches it on. A copy whose manifest is refused does not run anyway.
   */
  private rightsMovedOf(rt: TrickRuntime, run: ApprovedRun): RightsMoved | null {
    const manifest = run.found.manifest;
    if (manifest === undefined) return null;
    const now = powersOf(manifest);
    const stored = rt.entry?.powers ?? null;
    // Null from a migration (a switch file from before stored powers, or an undo to such an entry) holds what
    // that build could show. Any other null (M2, review 11: the manifest did not parse at the yes) holds nothing.
    const held = stored ?? (rt.entry?.by === MIGRATED ? legacyPowersOf(manifest) : null);
    return held === now ? null : { hash: run.hash, stored, now };
  }

  /**
   * Fault B: stop a trick whose approval holds other rights than its copy asks for. No run, no parts, no
   * open Decision, no view; the row says {@link RIGHTS_LINE}, the log says it once per approval, and the
   * Hill card says it once per trick and mismatch (bridge/tricks/rights-card.ts). Not checked again until a
   * new approval, which a switch on writes with the rights read now.
   */
  private stopForRights(rt: TrickRuntime, run: ApprovedRun, approval: string): void {
    const moved = this.rightsMovedOf(rt, run);
    if (moved === null) return;
    const was = rt.rightsMoved;
    const fresh = rt.copyProblem !== RIGHTS_LINE || rt.tampered !== approval || was?.stored !== moved.stored || was.now !== moved.now;
    rt.approved = null;
    rt.tampered = approval;
    rt.copyProblem = RIGHTS_LINE;
    rt.rightsMoved = moved;
    if (!fresh) return;
    const id = rt.found.id;
    this.warn(`${id}: ${RIGHTS_LINE} (approved with powers ${moved.stored ?? "not recorded"}, this Collie reads ${moved.now})`);
    this.deps.audit?.({ action: "trick.rights.moved", detail: { trick: id, hash: moved.hash.slice(0, 16), stored: moved.stored ?? "none", now: moved.now } });
    this.store.dropParts(this.deps.memberId, id);
    this.deps.decisions?.off(this.hillTrick(rt));
    this.publish(id);
  }

  /** The approved copy cannot run: stop the trick with a plain line, once. */
  private copyFailed(rt: TrickRuntime, line: string, why: string, tampered: string | null): void {
    const fresh = rt.copyProblem !== line;
    rt.approved = null;
    rt.tampered = tampered;
    rt.copyProblem = line;
    rt.rightsMoved = null;
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
    // A version whose field list differs does more: it asks the person for something else (review G, point 1).
    const doesMore = after === null || added.length > 0 || fieldsChanged(was, now);
    return now === undefined ? { info, doesMore } : { info, manifest: now, doesMore };
  }

  /** Fault B: tell the rights card every trick that is on and stopped for its rights now. Never throws. */
  private syncRights(): void {
    const port = this.deps.rights;
    if (port === undefined) return;
    const subjects: TrickRightsSubject[] = [];
    const running = new Set<string>();
    for (const rt of this.runtimes.values()) {
      if (this.runnable(rt)) running.add(rt.found.id);
      if (!rt.on || rt.rightsMoved === null) continue;
      subjects.push({ id: rt.found.id, name: this.shownOf(rt).manifest?.name ?? rt.found.id, moved: rt.rightsMoved });
    }
    try {
      port.sync(subjects, running, new Set(this.runtimes.keys()));
    } catch (err) {
      this.warn(`the rights card could not be updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Read the content version of each picture in every runnable trick's approved copy, and publish a row whose
   * versions moved: a picture replaced under the same name takes a new version, so the phone asks for it again.
   * The versions are a name for the phone's cache; no approval or hash reads them. Never throws.
   */
  private syncMedia(): void {
    const dirs = new Set<string>();
    const folders = new Set<string>();
    try {
      for (const rt of this.runtimes.values()) {
        const approved = rt.approved;
        const serves = rt.on && approved !== null && rt.copyProblem === null;
        // Pictures are not code: one changed by hand in the installed folder reaches the approved copy with no new yes.
        if (serves) {
          this.mediaSync.sync(rt.found.dir, approved.dir);
          folders.add(rt.found.dir);
        }
        const next = serves ? this.mediaVersions.of(approved.dir) : {};
        if (serves) dirs.add(approved.dir);
        if (JSON.stringify(next) === JSON.stringify(rt.media ?? {})) continue;
        if (Object.keys(next).length === 0) delete rt.media;
        else rt.media = next;
        this.publish(rt.found.id);
      }
      this.mediaVersions.retain(dirs);
      this.mediaSync.retain(folders);
    } catch (err) {
      this.warn(`the picture versions could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    // Reached only while tricks as a whole are on (every caller asks `switchedOff` first), but folded in the same way.
    this.applyOne(found, this.liveEntry(switches, found.id), switches.on.has(found.id));
    await this.ensureApproved(rt);
    this.publish(found.id);
    this.syncVersions();
    this.syncRights();
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
    if (this.gated()) return { ok: false, code: "windows", message: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { ok: false, code: "tricks-off", message: TRICKS_OFF_LINE };
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
    if (this.switchedOff()) return { ok: false, code: "tricks-off", message: TRICKS_OFF_LINE };
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
    if (this.gated()) return { ok: false, code: "windows", message: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { ok: false, code: "tricks-off", message: TRICKS_OFF_LINE };
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
    if (this.gated()) return { ok: false, code: "windows", message: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { ok: false, code: "tricks-off", message: TRICKS_OFF_LINE };
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
    return rt.found.manifest !== undefined && rt.found.codeHash !== undefined && (!rt.on || rt.changed || rt.rightsMoved !== null);
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

  /**
   * Run the trick's start run again: a new approved copy (a yes, an undo, a switch on), a changed
   * `config.toml` or a changed value. The start run goes at once ({@link startSoon}), not at the next tick,
   * and never waits for the trick's `every`.
   */
  private restart(rt: TrickRuntime): void {
    rt.failures = 0;
    rt.stopped = false;
    rt.pendingStart = true;
    rt.nextAt = 0;
    this.startSoon(rt);
  }

  /**
   * Ask for the start run right after the event that restarted the trick, in the next microtask, so the
   * steps of one event (a scan restarts a trick twice, a promote and its scan) are ONE run. Every gate of
   * {@link tick} holds: a phone must be looking, tricks on as a whole, this bridge scheduling, the trick
   * runnable (an approved copy that holds) and not backing off. Nothing here weakens an approval check:
   * `begin` reads the switch and the copy again right before the program starts, as for any run.
   */
  private startSoon(rt: TrickRuntime): void {
    rt.soon = true;
    if (rt.soonQueued === true) return;
    rt.soonQueued = true;
    queueMicrotask(() => {
      rt.soonQueued = false;
      this.startNow(rt);
    });
  }

  /**
   * The start run {@link startSoon} asked for. A run or a tap ahead of it is never overlapped: the ask is kept
   * and the run's end (`begin`) asks again, so the new code runs right after, not at the next tick. An ask that
   * cannot be served for any other reason is dropped (the next tick decides, as before); that also bounds the
   * loop: one ask is one start run at most.
   */
  private startNow(rt: TrickRuntime): void {
    if (rt.soon !== true) return;
    if (this.runtimes.get(rt.found.id) !== rt) {
      rt.soon = false;
      return;
    }
    if (rt.running !== null || rt.queued !== null || rt.hillQueue.length > 0) return;
    rt.soon = false;
    if (this.gated() || this.deps.active?.() === false || this.switchedOff() || !this.watched()) return;
    if (!rt.pendingStart || !this.due(rt, this.now())) return;
    const run = this.begin(rt, { kind: "start" }, null);
    this.soonRuns.add(run);
    void run.finally(() => this.soonRuns.delete(run));
  }

  /**
   * The one restart a run of value writes asks for, on a timer of its own: {@link VALUE_RESTART_MS} after the
   * last write, so a changed setting shows about a second after the person stops, not at the tick after.
   * Each write moves the timer; `tick` still honours `valueRestartAt` as the fallback.
   */
  private armValueRestart(rt: TrickRuntime, wait = VALUE_RESTART_MS): void {
    const id = rt.found.id;
    const open = this.valueTimerOf.get(id);
    if (open !== undefined) this.valueTimers.clear(open);
    const handle = this.valueTimers.set(() => {
      this.valueTimerOf.delete(id);
      const at = rt.valueRestartAt;
      if (this.runtimes.get(id) !== rt || at === undefined) return;
      // The clock counts too: a timer that fired early (a test, a clock set back) re-arms for the rest.
      if (this.now() < at) return this.armValueRestart(rt, at - this.now());
      delete rt.valueRestartAt;
      this.restart(rt);
    }, wait);
    this.valueTimerOf.set(id, handle);
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
    // Fault B: a trick stopped for its rights is not on for the person. Its switch shows off, and one switch
    // on is the normal approval of the rights the row shows (`approves`, `setSwitch`). The entry stays, so
    // the Hill card and the log keep their one mismatch; the trick runs nothing meanwhile.
    const rightsStop = rt.on && rt.rightsMoved !== null;
    const info: WireTrickInfo = {
      host: this.deps.memberId,
      id,
      name: m?.name ?? id,
      icon: m?.icon ?? "plug",
      // While tricks as a whole are off, the trick's own switch: it runs again once they are on.
      on: rt.on ? !rightsStop : rt.own,
      state: trickStateOf({ on: rt.on, found: shown, stopped: rt.stopped, failures: rt.failures, blocked: blocked && m !== undefined }),
      places: m?.places ?? [],
      provenance: { via: "folder" },
    };
    // The provenance of what runs: the approved copy keeps the origin record of the version approved.
    const origin = shown.origin;
    // The URL leaves the bridge for every paired phone and a crew lead, so it goes only when it passes the
    // one rule the phone holds it to (`isSourceUrl`: https, a host, no user, no password, no query): a
    // credential, an ssh or `git@` form or a local path written by hand into an origin record stays here.
    const url = origin !== undefined && isSourceUrl(origin.url) ? origin.url : undefined;
    if (origin !== undefined) info.provenance = { via: "repo", at: origin.at, repo: originRepoName(origin.url), sha: origin.commit };
    if (url !== undefined && info.provenance !== undefined) info.provenance.url = url;
    // The repository's stars and last commit, from the cache only: the read itself is the list's ask (`reply`).
    const facts = url === undefined ? undefined : this.deps.repoFacts?.facts(url);
    if (facts !== undefined) info.repoFacts = facts;
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
    // A note, not a refusal: nothing was refused, the watch only checks on a clock (the row says it alone).
    if (this.watchPolled.has(id)) info.watchPollSeconds = WATCH_POLL_MS / 1000;
    if (rt.changed) info.changed = true;
    if (rt.pending !== null) info.pending = rt.pending.info;
    if (rt.decides === true) info.decides = true;
    // Fault B: the phone says RIGHTS_LINE in its own words, from this flag.
    if (rightsStop) info.rightsMoved = true;
    if (m?.env !== undefined) info.env = m.env;
    // `on` and `watch` are rights (M105 step one): the row and the card say them in words.
    if (m?.on !== undefined) info.events = m.on;
    if (m?.watch !== undefined) info.watch = m.watch;
    // `access` (M105 spec 04) is a right the row names. An ON trick where the socket does not stand says so once.
    if (m?.access !== undefined) info.access = m.access;
    if (m?.access !== undefined && info.on && (this.deps.localApi?.() ?? null) === null) info.accessOff = true;
    if (m?.inputs !== undefined && m.inputs.length > 0) info.inputs = { globs: m.inputs, crew: this.deps.crewWide?.() ?? false };
    if (m?.description !== undefined) info.description = m.description;
    if (m?.about !== undefined) info.about = m.about;
    if (m?.version !== undefined) info.version = m.version;
    // How the program starts and how often: the run line, masked as a screen read is, and the timer. The
    // About sheet says both in plain words; a trick with no run line (an agent view alone) has neither.
    if (m?.run !== undefined) info.run = redactText(m.run);
    if (m?.run !== undefined && m.everyMs !== undefined) info.everyMs = m.everyMs;
    // Contract 2: an agent view and its rules, whole, for the About sheet; this build draws no view yet.
    const approves = approvesOf(rt);
    if (approves !== undefined) info.approves = approves;
    if (m?.agentView === true) info.agentView = true;
    // Declared in the manifest of what runs, so the phone knows it before any Decision (the token label).
    if (m?.decides === "reply") info.decidesReply = true;
    // And whether its buttons may put text into a reply box: the About sheet's line, and the phone's own check.
    if (m?.drafts === "session") info.draftsSession = true;
    // The versions of the pictures the route would serve (media.ts), so the phone asks again for a replaced one.
    if (rt.media !== undefined && Object.keys(rt.media).length > 0) info.media = rt.media;
    if (m?.rules !== undefined && m.rulesText !== undefined) info.rules = { file: m.rules, text: m.rulesText };
    // A trick with rules never takes a change without asking, whatever an older switch file says.
    if (info.on && rt.entry !== undefined) info.auto = rt.entry.auto && !hasRules(rt);
    // Undo is offered only for a version taken without asking, while the one before it is there.
    if (info.on && rt.entry?.by === "auto" && rt.entry.previous !== undefined) info.autoAt = rt.entry.at;
    const taken = this.warningsOf.get(id);
    if (this.wantsWarnings(rt) && taken !== undefined && taken.codeHash === rt.found.codeHash && taken.warnings.length > 0) info.warnings = taken.warnings;
    // Contract 3: the fields of what runs, the values set, and "Needs setup" (values.ts).
    Object.assign(info, fieldsWire(m, this.values.read(id)));
    this.store.setInfo(info);
  }

  /** The repository URL of every trick that came from one, as its row shows it. */
  private sourceUrls(): string[] {
    const urls: string[] = [];
    for (const rt of this.runtimes.values()) {
      const url = this.shownOf(rt).origin?.url;
      // Only a URL the row may show: a credential or another form is never read for (nor sent).
      if (url !== undefined && isSourceUrl(url)) urls.push(url);
    }
    return urls;
  }

  /** A read of the repository facts changed what they say: every row takes them, and the rev moves once. */
  repoFactsMoved(): void {
    for (const id of this.runtimes.keys()) this.publish(id);
  }

  /** The local API's socket started or stopped: every row takes the note of a trick that reads through it. */
  apiMoved(): void {
    this.repoFactsMoved();
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
    // First, before every gate: `deps.active` can change while the bridge runs (a lead deposed, a deputy
    // crowned), and `localApiWanted` reads it. `tellLocalApi` tells only a change.
    this.tellLocalApi();
    if (this.gated()) return;
    // Read the switch for tricks as a whole on every tick, watched or not, so its listeners hear a move
    // written by the terminal within a second. Off starts nothing.
    const off = this.switchedOff();
    // A peer, a deputy and a deposed lead schedule nothing (`deps.active`), so no trick runs twice in a crew.
    if (!this.watched() || this.deps.active?.() === false || off) return;
    await this.refresh();
    if (this.switchedOff()) return;
    const now = this.now();
    const started: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      // The one restart a run of value writes asked for, once the last write is VALUE_RESTART_MS old.
      if (rt.valueRestartAt !== undefined && now >= rt.valueRestartAt) {
        delete rt.valueRestartAt;
        this.restart(rt);
      }
      if (!this.due(rt, now)) continue;
      const trigger: FactsTrigger = rt.pendingStart ? { kind: "start" } : { kind: "timer" };
      started.push(this.begin(rt, trigger, null));
    }
    // The immediate start runs going now too ({@link startNow}), so what a tick resolves on does not depend on
    // whether a scan before it already started the run.
    await Promise.all([...started, ...this.soonRuns]);
  }

  /**
   * Read one trick again before its program starts. Answers why it may not run, or null. The switch is
   * read again and the approved copy checked (its listing, and its hash when that moved), so a copy that
   * changed on disk stops this very run. A change of the folder does not: the copy runs.
   */
  private async recheck(rt: TrickRuntime): Promise<string | null> {
    const id = rt.found.id;
    // THE CHECK POINT of every run (the switch for tricks as a whole), first, and again after the reads below.
    if (this.switchedOff()) return TRICKS_OFF_LINE;
    if (this.runtimes.get(id) !== rt) return "The trick is gone.";
    const [found, switches] = await Promise.all([this.scanner.one(id), this.readSwitches()]);
    if (found === null) return "The trick's folder could not be read again before the run.";
    if (this.runtimes.get(id) !== rt) return "The trick is gone.";
    if (this.switchedOff()) return TRICKS_OFF_LINE;
    this.applyOne(found, switches.on.get(id), switches.on.has(id));
    await this.ensureApproved(rt);
    if (!rt.on) return "The trick is off.";
    if (rt.approved === null || rt.copyProblem !== null) return rt.copyProblem ?? (rt.pending === null ? NOT_APPROVED_LINE : PENDING_LINE);
    if (rt.approved.found.manifest === undefined) return "The trick's trick.toml is refused. Run `collie trick check` on its folder.";
    return null;
  }

  /**
   * Why a run that passed {@link recheck} may not start after all, or null: the trick is gone (removed or
   * replaced), its own switch is off, or tricks are off as a whole. Synchronous, so nothing moves between this
   * answer and the mint and start that follow it in `runOnce`.
   */
  private goneSinceRecheck(rt: TrickRuntime): string | null {
    if (this.runtimes.get(rt.found.id) !== rt) return "The trick is gone.";
    if (!rt.on) return "The trick is off.";
    if (this.switchedOff()) return TRICKS_OFF_LINE;
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
        // N1 (review 11): a phone's tap was checked when it queued; the run ahead of it may have redrawn the
        // part since. Check it again against the part as drawn NOW, before anything is recorded or run.
        const refused = tap?.phone === undefined ? null : this.tapRefusal(rt.found.id, tap.request, tap.phone.rev);
        if (tap !== null && refused !== null) {
          tap.resolve(this.refusalOf(rt.found.id, tap.request, refused));
          return;
        }
        if (tap !== null) {
          tap.marked = await this.receiptFile.recordFirst(tap.marker);
          if (!tap.marked) {
            tap.resolve({ rid, code: "rejected", message: "The tap could not be recorded, so nothing ran. Try again." });
            return;
          }
        }
        // Review 12 N1: a tap on a row in a session's settings answers under Collie's heading there, so its
        // message passes the rule a row's label passes, or is not sent (the phone says its own line).
        const fromMenu = tap !== null && this.store.held({ host: this.deps.memberId, trick: rt.found.id, part: tap.request.node })?.part.value.at === "menu";
        const reply = await this.runOnce(rt, trigger);
        if (fromMenu && reply.message !== undefined && menuMessageLine(reply.message) === null) delete reply.message;
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
      // The run's own writes are absorbed by the file watch (watch.ts), then the next waiting request goes.
      this.syncReactions();
      this.reactions.ended(rt.found.id);
      this.pump(rt);
      // A restart asked while this run (or a tap) was going: the new code runs now, not at the next tick.
      if (rt.soon === true) this.startSoon(rt);
    });
    return rt.running;
  }

  /** Start the next waiting tap of a trick that runs nothing: a decision answer first, then a phone tap. */
  private pump(rt: TrickRuntime): void {
    if (rt.running !== null) return;
    const next = rt.hillQueue.shift() ?? rt.queued;
    if (next === null) return this.pumpReaction(rt);
    if (next === rt.queued) rt.queued = null;
    void this.begin(rt, tapTrigger(next), next);
  }

  // ── `on` and `watch` (M105 spec 03, decisions 9 to 11): the logic lives in triggers.ts and watch.ts ──────

  /** Whether a request from an event or a watched file may run: the gates of `tick` except the phone, and the trick's own state. */
  private reactAdmit(id: string): Admit {
    const rt = this.runtimes.get(id);
    // No `watched()` here: an event or a file change runs with no phone open (only the timer waits for one),
    // and triggers.ts holds the floor between two such starts.
    // Tricks switched off as a whole drop the request too (never held for the switch): THE CHECK POINT.
    if (rt === undefined || this.deps.active?.() === false || this.gated() || this.switchedOff()) return "drop";
    // A trick that has not had its start run, is stopped, or backs off after a failure takes no request: it is dropped, never held.
    if (!this.runnable(rt) || rt.stopped || rt.pendingStart || rt.approved?.found.manifest?.run === undefined) return "drop";
    if (rt.failures > 0 && this.now() < rt.nextAt) return "drop";
    return rt.running !== null || rt.queued !== null || rt.hillQueue.length > 0 ? "wait" : "now";
  }

  private reactStart(id: string, trigger: ReactTrigger): void {
    const rt = this.runtimes.get(id);
    if (rt !== undefined) void this.begin(rt, trigger, null);
  }

  /** The floor ended for a trick with a waiting request: start it unless a run or a tap is ahead (`pump` takes those first). */
  private reactDue(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt !== undefined) this.pump(rt);
  }

  private reactNote(id: string, why: string | null): void {
    if (why === null) this.watchPolled.delete(id);
    else {
      this.watchPolled.add(id);
      // The system's error code lives in the log only; the row's sentence carries none.
      this.warn(`${id}: could not watch its files (${why}); checking them every ${String(WATCH_POLL_MS / 1000)} seconds`);
    }
    this.publish(id);
  }

  /** What the reactions hold open (bus subscription, watches, timers) and what waits. For a test. */
  reactionCounts(): ReactionCounts {
    return this.reactions.counts();
  }

  /**
   * The waiting event or file request of a trick that runs nothing, after every tap and Hill answer. Admit
   * is asked first, then the request is taken (security read 2, item 2): a refused admit (a backoff, say)
   * leaves the waiting request and the floor as they were, so the next pump still finds it.
   */
  private pumpReaction(rt: TrickRuntime): void {
    if (this.reactAdmit(rt.found.id) !== "now") return;
    const waiting = this.reactions.takeWaiting(rt.found.id);
    if (waiting !== null) void this.begin(rt, waiting, null);
  }

  /** Tell triggers.ts which tricks react now: on, runnable, with a program, on a bridge that schedules. */
  private syncReactions(): void {
    // Tricks switched off as a whole react to nothing: no bus subscription and no file watch stays open.
    const live = !this.gated() && this.deps.active?.() !== false && !this.switchedOff();
    const targets = [...this.runtimes.values()].flatMap((rt) => {
      const manifest = rt.approved?.found.manifest;
      if (!live || !this.runnable(rt) || rt.approved === null || manifest?.run === undefined || (manifest.on === undefined && manifest.watch === undefined)) return [];
      return [{ id: rt.found.id, key: `${rt.approved.hash}:${rt.approved.found.configHash ?? ""}`, events: manifest.on ?? [], watch: manifest.watch ?? [] }];
    });
    this.reactions.sync(targets);
  }

  /**
   * The instance token and the pane's generation (bound.ts, the binding generation) of each agent session
   * of a run's facts, read once, in the same turn as the facts. No token without a registry; a generation
   * null without `generationOf` or for a pane it cannot read.
   */
  private tokensOf(sessions: readonly FactsSession[]): RunBindings {
    const tokens = new Map<string, string>();
    const generations = new Map<string, string | null>();
    for (const session of sessions) {
      if (session.agent === undefined) continue;
      const token = this.deps.instanceOf?.(session.id) ?? null;
      if (token !== null) tokens.set(session.id, token);
      generations.set(session.id, this.deps.generationOf?.(session.id) ?? null);
    }
    return { tokens, generations };
  }

  /** Hold every stored binding to its pane's generation now (store.ts `rebind`), before a list or a tap reads them. */
  private rebind(): void {
    const generationOf = this.deps.generationOf;
    if (generationOf !== undefined) this.store.rebind(generationOf);
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
    // The settings this run reads, to tell afterwards whether they moved while it went (see below).
    const configAtStart = run.found.configHash;
    const state = trickStateDir(this.deps.stateDir, id);
    // The program's own folder under <stateDir>/tricks, owner only like the rest of the state folder.
    await mkdir(state, { recursive: true, mode: 0o700 }).catch(() => {});
    // The program may keep the id in its own state: it is written down before the first run sees it.
    this.deps.keepId?.();
    const world = this.deps.world(host);
    // Review 12 N6: each agent session's instance token and binding generation, read in the same turn as
    // the facts, so a bound part binds to the session the program saw. A pane another session took while
    // the program ran has another generation by then, and the store's `rebind` drops the binding.
    const { tokens, generations } = this.tokensOf(world.sessions);
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
    // Contract 3: the person's values ride in the facts, and nowhere else (values.ts `withValues`).
    const facts = withValues(buildFacts({ memberId: host, ...world }, { id, dir: run.dir, state }, trigger, manifest.contract), manifest, this.values.read(id));
    // Security read of spec 05, item 1: the awaits since `recheck` (the tap's receipt, the state folder, the
    // inputs fetch) leave a gap in which the trick can be switched off, tricks can go off or the trick can be
    // removed. Asked again here, synchronously, right before the token and the start: any of the three refuses
    // the run as `recheck` would, with no token minted and no program started.
    const gone = this.goneSinceRecheck(rt);
    if (gone !== null) return { rid, code: "rejected", message: gone };
    // The local API, for a trick that declares `access`, while its socket stands: the path, the level and this
    // run's token, on stdin only, never an environment variable, an argument or a file (M105 specs 04 and 05).
    // Without the socket there is no `api` and no token, and `t.api` answers an error.
    const socket = manifest.access === undefined ? null : (this.deps.localApi?.() ?? null);
    const runId = randomUUID();
    const token = manifest.access !== undefined && socket !== null ? this.runTokens.mint(id, manifest.access, runId) : null;
    if (manifest.access !== undefined && socket !== null && token !== null) facts.api = { socket, access: manifest.access, token };
    let outcome: RunOutcome;
    try {
      const ran = await (this.deps.run ?? runProgram)({
        command,
        cwd: run.dir,
        env: scrubEnv(this.deps.env, manifest.env ?? [], { host: this.host() }),
        stdin: JSON.stringify(facts),
        platform: this.deps.platform,
        signal: this.runStop.signal,
        ...this.deps.limits,
      });
      // A program that prints its facts back prints its token: the mark stands in its place before the output
      // reaches the problem line, the warning log, the parser, a part or the reply (security read, item 4).
      outcome = maskRunToken(ran, token);
    } catch (err) {
      // A runner that throws is logged by `begin`: its words are masked the same way first.
      if (err instanceof Error) err.message = maskRunTokenText(err.message, token);
      throw err;
    } finally {
      // The token dies with the run, whatever ended it: an exit, a failure, a timeout, a kill or a throw.
      this.runTokens.end(runId);
    }
    rt.lastRunAt = startedAt;
    // A run that was switched off (its own switch or tricks as a whole), removed or changed while it ran
    // leaves nothing behind: no part, no Decision.
    if (this.runtimes.get(id) !== rt || !rt.on || this.switchedOff()) {
      return { rid, code: "rejected", message: "The trick was switched off while it ran." };
    }
    // A copy that stopped while the program ran (it changed on disk) keeps nothing of that run.
    if (!this.runnable(rt)) return { rid, code: "rejected", message: rt.copyProblem ?? NOT_APPROVED_LINE };
    // A yes to a new version, an undo or a changed `config.toml` landed while this run went: what it made
    // is the old code's or the old settings', so nothing of it is kept, and it neither counts as a success
    // (which would clear the restart and make the new code wait for `every`) nor as a failure. The restart
    // that landed asked for the start run, and `begin` starts it as this run ends. A tap's program may have
    // done its work, so a tap says `unknown`.
    if (rt.approved !== run || run.found.configHash !== configAtStart) {
      return { rid, code: trigger.kind === "tap" ? "unknown" : "rejected", message: SUPERSEDED_LINE };
    }
    let problem = outcomeProblem(outcome, 200);
    let parsed: ParsedTrickDocument | null = null;
    let decisionsListed = false;
    if (problem === null && outcome.kind === "exited") {
      // Masked in run.ts already; again here, so no runner behind the seam can hand the parser a key.
      const text = redactText(outcome.stdout);
      // `manifest` is the approved copy's: a Decision with `replyTo` needs `decides = "reply"` there, never in the folder.
      parsed = parseTrickDocumentText(text, { declared: manifest.places, contract: manifest.contract, decidesReply: manifest.decides === "reply", draftsSession: manifest.drafts === "session" });
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
    // Contract 2: a part that names sessions is stamped with each one's instance, against this run's own
    // facts; an id that is gone, or has no instance, is dropped with a note (bound.ts).
    const binding = bindParts(parsed, facts.sessions, (session) => tokens.get(session) ?? null);
    this.store.applyDocument(host, id, binding.parsed, { asOf, fresh: parsed.fresh ?? freshString(freshMs) }, binding.bound, generations);
    // The decisions reach the hill only from a run that succeeded and listed them. A list refused as a
    // whole (over the cap) changes nothing there either: the last good decisions stay, as the last good
    // parts do.
    const listRefused = parsed.refusals.some((refusal) => refusal.path === "/decisions" && refusal.decision === undefined);
    const posted = listRefused || !decisionsListed ? [] : (this.deps.decisions?.sync({ ...this.hillTrick(rt), name: manifest.name }, { decisions: parsed.decisions, refusedKeys: parsed.refusedDecisions, sessions: new Set(facts.sessions.map((session) => session.id)) }) ?? []);
    // An absent `decisions` key leaves the trick's Decisions as they were, so it leaves this as it was too.
    if (!listRefused && decisionsListed) rt.decides = parsed.decisions.length > 0;
    // What the tolerant read left out (a node kind or a place this Collie does not draw) is one note on
    // the trick's row; an ignored key is for `collie trick check` and `dev` only.
    const dropped = [...parsed.notes.filter((note) => note.code === "dropped"), ...binding.notes];
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

  async tap(host: string, id: string, body: JsonValue | undefined, opts?: BoundAsk): Promise<TapAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    const parsed = parseTapRequest(body);
    if (parsed.request === undefined) return { status: 400, body: { error: "tap-invalid", refusals: parsed.refusals } };
    // A decision's answer comes from the hill only (`tapFromHill`), so it is closed and receipted there.
    if (parsed.request.node.startsWith(HILL_NODE_PREFIX)) return { status: 200, body: { rid: parsed.request.rid, code: "rejected", message: HILL_NODE_TAP_REFUSED } };
    // The rev is the phone's claim of what it drew. It is checked here and never reaches the program.
    const answer = await this.runTap(host, id, parsed.request, undefined, { rev: parsed.rev });
    return opts?.bound === true ? answer : this.withoutBound(answer);
  }

  /** A tap's receipt for a phone that did not ask for bound parts: no bound part and no bound key in it. */
  private withoutBound(answer: TapAnswer): TapAnswer {
    if (answer.status !== 200) return answer;
    const body: TrickTapReply = { ...answer.body };
    if (body.parts !== undefined) body.parts = body.parts.filter((part) => part.bound === undefined);
    if (body.present !== undefined) body.present = body.present.filter((key) => !this.store.isBound(key));
    return { status: 200, body };
  }

  /**
   * Why a phone's tap does not name what this bridge drew for the trick, or null when it does (fault A,
   * THE TAP NAMES WHAT WAS DRAWN in the header). The order puts the phone's own race first: a part that is
   * gone, then a rev the part moved past, so an honest phone that tapped a control just redrawn hears
   * `changed`, never a refusal that reads like a forgery.
   */
  private tapRefusal(id: string, request: TapRequest, rev: number | undefined): TapRefusal | null {
    const host = this.deps.memberId;
    this.rebind();
    const held = this.store.held({ host, trick: id, part: request.node });
    // N8 (review 11): a trick that holds no part at all has not drawn since this bridge started (a restart
    // empties the store), so the phone's copy is older than this bridge: `changed`, not the forgery line.
    if (held === undefined) return this.store.trickParts(host, id, -Infinity).parts.length === 0 ? "changed" : "part";
    // A phone that sends no rev predates the check: it cannot say what it drew, so the tap is a race it lost.
    if (rev === undefined || !held.shows(rev)) return "changed";
    const controls = tapControls(held.part.value).filter((control) => control.intent === request.intent);
    if (controls.length === 0) return "intent";
    // A part's control sends one fixed string or nothing; a `{ text }` answer belongs to a decision and matches none.
    if (!controls.some((control) => control.value === request.value)) return "value";
    const session = request.from?.session;
    // A session the tap names must be an agent session open here now: every session, not the facts' first
    // 256 (FACT_SESSIONS_MAX), so a live session past the cap is not refused.
    // N2 (review 11): a crew member's session the lead's last sweep did not reach is not open here now.
    if (session !== undefined && !this.deps.world(host, { all: true }).sessions.some((s) => s.id === session && s.agent !== undefined && s.reachable !== false)) return "session";
    return this.boundRefusal(held.part, session);
  }

  /**
   * Contract 2: the session check of a menu part and of a bound part (bound.ts). A tap on either names its
   * session. A bound part must name that session, and the session's pane must hold the instance it was
   * stamped with, so a pane id the multiplexer handed to a new session taps nothing. An unbound menu part
   * shows only in this machine's own sessions: on a crew member's session a row needs a binding.
   */
  private boundRefusal(part: WireTrickPart, session: string | undefined): TapRefusal | null {
    const menu = part.value.at === "menu";
    if (!menu && part.bound === undefined) return null;
    if (session === undefined) return "session";
    if (part.bound === undefined) return session.startsWith(`${this.deps.memberId}:`) ? null : "session";
    const stamped = part.bound.find((entry) => entry.session === session);
    if (stamped === undefined) return "session";
    if (this.deps.instanceOf?.(session) !== stamped.instance) return "session";
    // The binding generation: another conversation in the pane, or one not known yet, taps nothing bound to the old one.
    const held = this.store.generationAt(partKey(part), session);
    return bindingAgainst(held, held === null ? null : (this.deps.generationOf?.(session) ?? null)) === "same" ? null : "session";
  }

  /** Answer a refused phone tap: one audit line, nothing run, nothing kept. `changed` carries the trick's parts now. */
  private refuseTap(id: string, request: TapRequest, refused: TapRefusal): TapAnswer {
    return { status: 200, body: this.refusalOf(id, request, refused) };
  }

  /** The reply of a refused phone tap, and its one audit line. */
  private refusalOf(id: string, request: TapRequest, refused: TapRefusal): TrickTapReply {
    const host = this.deps.memberId;
    if (this.mayAuditTapRefusal(id, refused)) this.deps.audit?.({ action: "trick.tap.refused", detail: { trick: id, reason: refused, node: request.node, intent: request.intent } });
    const reply: TrickTapReply = { rid: request.rid, code: refused === "changed" ? "changed" : "rejected", refused, message: TAP_REFUSED_LINES[refused] };
    if (refused === "changed") {
      const mine = this.store.trickParts(host, id, -Infinity);
      reply.rev = this.store.rev;
      reply.parts = mine.parts;
      reply.present = mine.present;
    }
    return reply;
  }

  /** Whether a refused tap of this trick and reason may write its audit line now (N5). Records it when so. */
  private mayAuditTapRefusal(id: string, reason: TapRefusal): boolean {
    const key = `${id}\u0000${reason}`;
    const now = this.now();
    const last = this.tapRefusalLines.get(key);
    if (last !== undefined && now - last < TAP_REFUSAL_AUDIT_MS) return false;
    if (last === undefined && this.tapRefusalLines.size >= TAP_REFUSAL_KEYS_MAX) {
      for (const [held, at] of this.tapRefusalLines) if (now - at >= TAP_REFUSAL_AUDIT_MS) this.tapRefusalLines.delete(held);
      if (this.tapRefusalLines.size >= TAP_REFUSAL_KEYS_MAX) return false;
    }
    this.tapRefusalLines.set(key, now);
    return true;
  }

  /**
   * The answer to a trick's decision, from the hill (bridge/index.ts wires it as the hill's `tap`): one
   * tap on `hill/<key>` with the answer's rid, and `seen`, the content hash of the version the person
   * saw. True when the run succeeded; a refused, failed or timed-out run is false, and nothing retries.
   */
  async tapFromHill(host: string, id: string, tap: HillTrickTap, decisionId: string): Promise<boolean> {
    const request: TapRequest = { rid: tap.rid, node: tap.node, intent: tap.intent, value: { text: tap.value.text } };
    const seen = this.deps.decisions?.seenOf(id, decisionId);
    // The Hill routes an answer by trick id only. A card the CURRENT map of this trick does not hold (an
    // earlier trick of the id posted it and its withdraw failed, or the map forgot it) never reaches the
    // program: the new trick did not ask that question. Nothing runs and no receipt is kept.
    if (this.deps.decisions !== undefined && seen === undefined) {
      this.warn(`${id}: ${STALE_CARD_LINE}`);
      return false;
    }
    const answer = await this.runTap(host, id, request, seen);
    return answer.status === 200 && answer.body.code === "ok";
  }

  private loadReceipts(): Promise<void> {
    this.receiptsLoaded ??= this.receiptFile.load().catch(() => {});
    return this.receiptsLoaded;
  }

  /** `phone`: set for a tap from the phone's route, whose part, control, value, rev and session are checked first (fault A). */
  private async runTap(host: string, id: string, request: TapRequest, seen: string | undefined, phone?: { rev: number | undefined }): Promise<TapAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    if (this.gated()) return { status: 200, body: { rid: request.rid, code: "rejected", message: TRICKS_WINDOWS_LINE } };
    // Switched off: nothing runs and no receipt is kept, so the same rid may tap again once tricks are on.
    if (this.switchedOff()) return { status: 200, body: { rid: request.rid, code: "rejected", message: TRICKS_OFF_LINE } };
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
    // An agent view alone draws no part and runs no program: a tap has nothing to reach.
    if (rt.approved.found.manifest.run === undefined) return refuse(NO_PROGRAM_LINE);
    const refused = phone === undefined ? null : this.tapRefusal(id, request, phone.rev);
    if (refused !== null) return this.refuseTap(id, request, refused);
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
    if (queued !== undefined && phone !== undefined) queued.phone = phone;
    if (queued === undefined) throw new Error("the tap promise did not run its executor");
    if (answer) rt.hillQueue.push(queued);
    else rt.queued = queued;
    this.inflight.set(request.rid, { digest, reply });
    this.pump(rt);
    try {
      const body = await reply;
      // A refusal at the run's start (N1) keeps no receipt, as one at the door: the same id may tap again.
      if (body.refused !== undefined) return { status: 200, body };
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
    if (!this.isOwn(host) || this.gated() || this.switchedOff()) return null;
    await this.refresh();
    const rt = this.runtimes.get(id);
    // A trick the person never switched on gets nothing served, whatever its folder holds. The pictures
    // are the approved copy's: its program writes them there.
    if (rt === undefined || !rt.on || rt.approved === null || rt.copyProblem !== null) return null;
    return readTrickMedia(rt.approved.dir, rel);
  }

  async code(host: string, id: string, file: string | null): Promise<CodeAnswer> {
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    if (this.gated()) return { status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } };
    await this.refresh();
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { status: 404, body: { error: "unknown-trick" } };
    // The approved copy while one runs, else what a switch on would approve; code-view.ts says why and checks the bytes.
    const source = codeSource(rt);
    if (source === null) return { status: 409, body: { error: "no-code", message: "This trick has no code that can be read." } };
    const read = file === null ? await codeIndex(source) : await codeFile(source, file);
    if (read.ok) return { status: 200, body: read.body };
    return read.code === "no-file" ? { status: 404, body: { error: "no-file", message: read.message } } : { status: 409, body: { error: read.code, message: read.message } };
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
    if (this.gated()) return { status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } };
    // A trick's own switch waits for the switch of tricks as a whole (the terminal's `collie trick on|off` still writes it).
    if (this.switchedOff()) return { status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } };
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
    // OfficialTricks.install asks `gateLine` before it fetches; this is the second lock on the write.
    if (this.gated()) throw new Error(TRICKS_WINDOWS_LINE);
    if (this.switchedOff()) throw new Error(TRICKS_OFF_LINE);
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
    if (this.gated()) return { kind: "refused", reason: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { kind: "refused", reason: TRICKS_OFF_LINE, code: "no_tricks" };
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
  async installProposed(id: string, files: readonly ProposedFile[], origin: ProposalOrigin, cardHash: string): Promise<ProposalPlaced> {
    if (this.gated()) return { ok: false, message: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { ok: false, message: TRICKS_OFF_LINE };
    // Decision 4 (2026-11-16): the bytes handed in are the card's, or nothing is written.
    if (proposalHash(files) !== cardHash) return { ok: false, message: PROPOSAL_CHANGED };
    return await this.lane(async () => {
      await this.refresh(true);
      if (this.runtimes.has(id)) return { ok: false, message: `A trick named ${id} is here now. Nothing was switched on.` };
      // Decision 3: a trick new to this machine starts from a new state folder, no approved or pending copy of
      // an earlier trick of this id (a copy of equal code would hash the same and be kept as it is, with its old
      // config, origin record and writable folders), a fresh switch entry, and none of its views or Hill keys.
      // Nothing is removed while a folder of this name is there; the write below refuses one anyway.
      await forgetLeftovers({ stateDir: this.deps.stateDir, configDir: this.deps.configDir, id, at: new Date(this.now()).toISOString(), forget: this.deps.forgetTrick });
      // ... and the stage on disk must hash to those same bytes right before it is renamed into place.
      // The code hash reads no picture the proposal brings (propose-wire.ts `splitPictures`).
      const written = await writeProposedTrick(tricksConfigDir(this.deps.configDir), id, files, origin, { expect: codeHashOfFiles(splitPictures(files).code) });
      if (!written.ok) return { ok: false, message: written.code === "mismatch" ? PROPOSAL_CHANGED : written.reason };
      const placed = await this.approveWritten(id, written.codeHash, "The trick was written but changed before it could be approved, so it stays off.", { fresh: true });
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
  async installProposedVersion(id: string, files: readonly ProposedFile[], origin: ProposalOrigin, baseHash: string, cardHash: string): Promise<ProposalPlaced> {
    if (this.gated()) return { ok: false, message: TRICKS_WINDOWS_LINE };
    if (this.switchedOff()) return { ok: false, message: TRICKS_OFF_LINE };
    if (proposalHash(files) !== cardHash) return { ok: false, message: PROPOSAL_CHANGED };
    return await this.lane(async () => {
      await this.refresh(true);
      const target = this.targetOf(id);
      if (target.kind === "refused") return { ok: false, message: target.reason };
      if (target.kind !== "version" || target.baseHash !== baseHash) return { ok: false, message: `${id} changed since this card, so nothing was changed.` };
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      this.scanning = held;
      let placed: ProposalPlaced;
      try {
        const written = await replaceTrickCode(tricksConfigDir(this.deps.configDir), id, files, origin, { expect: codeHashOfFiles(splitPictures(files).code) });
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
  private async approveWritten(id: string, codeHash: string, failed: string, opts: { fresh?: boolean } = {}): Promise<ProposalPlaced> {
    const src = join(tricksConfigDir(this.deps.configDir), id);
    const snap = await snapshotTrick({ src, parent: approvedTrickDir(this.deps.configDir, id), expect: codeHash, platform: this.deps.platform });
    if (!snap.ok) return { ok: false, message: `${failed} ${snap.reason}` };
    const read = await scanTrickDir(diskTrickFs, snap.dir, id, undefined);
    const at = new Date(this.now()).toISOString();
    const approval = { at, hash: snap.hash, by: "proposal", powers: read.manifest === undefined ? null : powersOf(read.manifest) };
    await updateSwitches(this.deps.stateDir, (now) => (opts.fresh === true ? withFreshApproval(now, id, approval) : withApproval(now, id, approval)));
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
    // Fault d: on Windows a shell run line is not switched on (behind the gate in `setSwitch` today).
    const shell = on ? windowsRunProblem((rt.pending?.manifest ?? rt.found.manifest)?.run, this.deps.platform) : null;
    if (shell !== null) return { status: 409, body: { error: "windows-shell", message: shell } };
    // A5: no switch on outside a card of code the About sheet cannot show whole and as it is (code-view.ts).
    if (on && expect !== undefined) {
      const whole = await codeShowsWhole({ dir: rt.pending?.dir ?? rt.found.dir, hash: expect }, id);
      // Bytes that no longer hash to what the row showed read as a move, as above.
      if (!whole.ok) return { status: 409, body: whole.code === "not-whole" ? { error: "not-whole", message: whole.message } : { error: "moved", message: SWITCH_MOVED } };
    }
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

  // ── The values a person keeps (contract 3, values.ts) ─────────────────────────────────────────────
  // One write route (`POST /api/tricks/<host>/<id>/value`, write right). The phone is the only writer in this
  // version: no terminal verb and no socket op (the lead, 2026-11-17). It runs in the lane switch writes take.
  // A write carries a request id: the same id with the same payload is answered with the first receipt and
  // writes nothing; with another payload it is refused. A value that breaks its field's rule is refused with
  // the rule's code and a sentence that names the next step. One audit line per write that took: the trick
  // and the field, NEVER the value. A changed value does not ask again: it restarts the trick once, as a
  // config.toml edit does. The fields are those of what runs (the approved copy while on, else the folder),
  // so a field of a version that waits for a yes cannot be set before that yes.
  //
  // Counsel on Edge build 5 (A7): the restart is one, VALUE_RESTART_MS after the last write; a write reads the
  // one trick, not the folder; the seen ids are bounded (values.ts `SeenWrites`, the oldest out).
  //
  // KNOWN LIMITS (accepted by the lead, 2026-11-17): the seen-id store is memory only, so a bridge restart
  // forgets the ids, and the same id sent again after a restart writes the same value again (no visible
  // change). Value writes are not rate limited, but a run of them restarts
  // the trick once (above), and runs never overlap.

  /**
   * Read ONE trick again (its folder, its switch and its approved copy) for a value write: not every trick
   * of the folder. A trick this service does not hold yet, or a folder that cannot be read, takes the whole
   * scan, which also finds out that it is gone.
   */
  private async rescanOne(id: string): Promise<TrickRuntime | undefined> {
    const known = this.runtimes.get(id);
    const [found, switches] = known === undefined ? [null, null] : await Promise.all([this.scanner.one(id), this.readSwitches()]);
    if (known === undefined || found === null || switches === null) {
      await this.refresh(true);
      return this.runtimes.get(id);
    }
    if (this.runtimes.get(id) !== known) return this.runtimes.get(id);
    this.applyOne(found, this.liveEntry(switches, id), switches.on.has(id));
    await this.ensureApproved(known);
    await this.notePending(known);
    return known;
  }

  async setValue(host: string, id: string, request: ValueRequest): Promise<ValueAnswer> {
    const { rid, key, value: asked } = request;
    if (!this.isOwn(host)) return { status: 404, body: { error: "unknown-host" } };
    if (this.gated()) return { status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } };
    // A value waits for the switch of tricks as a whole, as a trick's own switch does (the lead, 2026-11-17).
    if (this.switchedOff()) return { status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } };
    // In a crew the values live on the lead, where the tricks run: a member keeps none.
    if ((this.deps.runsOn?.() ?? null) !== null) return { status: 409, body: { error: "not-here", message: VALUES_ON_LEAD } };
    if (!isRequestId(rid) || !isTrickId(id) || !isTrickId(key)) return { status: 400, body: { error: "value-invalid" } };
    // JSON tells text "1", the number 1, true and null apart.
    const digest = payloadDigest([id, key, JSON.stringify(asked)]);
    const turn = this.lane(async (): Promise<ValueAnswer> => {
      const seen = this.valueWrites.get(rid);
      if (seen !== undefined) return seen.digest === digest ? seen.answer : { status: 409, body: { error: "request-id-reused", rid } };
      const rt = await this.rescanOne(id);
      if (rt === undefined) return { status: 404, body: { error: "unknown-trick" } };
      const field = this.shownOf(rt).manifest?.fields?.find((one) => one.key === key);
      if (field === undefined) return { status: 400, body: { error: "value-refused", rid, code: "unknown-field", message: `This trick has no setting "${key}". Read its About sheet for the settings it has.` } };
      const problem = asked === null ? undefined : fieldValueProblem(field, asked);
      if (problem !== undefined) return { status: 400, body: { error: "value-refused", rid, code: problem.code, message: problem.reason } };
      // An empty text is no value: it clears the field back to its default, as null does.
      const value = asked === "" && field.kind === "text" ? null : asked;
      const stored = this.values.read(id);
      const next = { ...stored.values };
      if (value === null) delete next[key];
      else next[key] = value;
      const changed = stored.unread || JSON.stringify(stored.values[key] ?? null) !== JSON.stringify(next[key] ?? null);
      if (changed) {
        try {
          this.values.write(id, next);
        } catch (err) {
          // The disk's reason names a path, never the value.
          this.warn(`${id}: a setting could not be saved: ${err instanceof Error ? err.message : String(err)}`);
          return { status: 409, body: { error: "write-failed", message: VALUES_WRITE_FAILED } };
        }
        this.deps.audit?.({ action: "trick.value", detail: { trick: id, field: key, by: "phone" } });
        // A changed value asks nothing again: it runs the trick once more, as a config.toml edit does, one
        // second after the last write (a debounce: `tick` starts the run), so a run of writes costs one run.
        if (rt.on) {
          rt.valueRestartAt = this.now() + VALUE_RESTART_MS;
          this.armValueRestart(rt);
        }
      }
      this.publish(id);
      const info = this.store.reply(this.store.rev).tricks.find((trick) => trick.id === id);
      if (info === undefined) return { status: 404, body: { error: "unknown-trick" } };
      const answer: ValueAnswer = { status: 200, body: { rid, code: "ok", key, changed, info } };
      this.valueWrites.remember(rid, digest, answer);
      return answer;
    });
    return await turn;
  }
}
