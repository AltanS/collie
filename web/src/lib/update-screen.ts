import { LEG_FAILED, legStillFailed, memberBehind } from "./crew-level";
import { t, tn } from "./i18n";
import { timeAgoShort } from "./format";
import { compareSemver } from "./semver";
import { RUN_IN_FLIGHT, minutesWord } from "./update-ribbon";
import type { UpdateAsk } from "./update-ask";
import type { UpdateClaim } from "./update-ribbon";
import type { UpdateCrewMember, UpdatePeerLeg, UpdatePeerLegState, UpdateRun } from "./types";

// ── UPDATE MODE, AS ONE PURE READING ────────────────────────────────────────────────────────────
//
// A running update puts the phone into update mode (ADR 0064, amending ADR 0044): the app stays in
// view behind a veil and does not take a tap, a band across the top says "Update mode, step N of 7"
// with a clock and doubles as the progress bar, and a panel docked at the bottom walks seven steps:
// Check, Build, Restart, Verify, Other machines, This phone, Done. One row per machine, one for this
// phone. WHICH of that the operator sees is decided here and nowhere else, so the precedence is
// pinned by a table (`update-screen.test.ts`) rather than by pulling a DOM apart.
//
// WHY ONE READING, and not three: `.adr/0044`, which carries the dated incidents three readers of one
// run produced. That rule stands. What 0064 changes is what the one reading says.
//
// ── THE MODE ENDS IN THREE PLACES, AND NEVER ON A TOAST ─────────────────────
// Done, Rolled back and Stuck (a run that stopped reads as Stuck's sibling, "stopped"). Each is a
// screen with "Back to the app", and the app stays locked until the phone's own step is over. The
// old sheet closed itself the moment the lead said `done` while the members still waited, and fired
// "Crew updated" over them: the lead's run is not the update. So `done` on the lead is step 5 while a
// member still moves, step 6 while this phone fetches the new app, and step 7 only after that.
//
// ── THE PHONE IS THE LAST STEP, AND IT RELOADS ONCE ─────────────────────────
// The device that started the run saves its own reload for step 6: `holdsReload` is true until then,
// the hook holds the reload guard on it, and `lib/pwa.ts` pauses its worker check and defers a
// controller swap while it is held. The page that boots after the reload finds the claim this device
// wrote (`lib/update-ribbon.ts`) and reopens here, at step 7, before its first paint.
//
// ── ONLY THE ACTIVE ROW MOVES ───────────────────────────────────────────────
// A row is one of seven statuses. `active` draws the one spinner; `queued` is a still, dimmed circle.
// Every waiting row used to spin, which said "everything is happening" about a queue that moves one
// machine at a time.
//
// ── DISMISSIBILITY IS STILL ONE SENTENCE ────────────────────────────────────
// The app is locked while a run THIS DEVICE STARTED is in flight and the operator has not taken the
// way out a stall offers. `dismissible` is the negation of `locked`, taken here and never re-derived.

// ── EVERY THRESHOLD IS A CONSTANT IN THIS FILE, WITH ITS REASON AT THE LINE ──

/**
 * How long a member may say nothing before its row asks the operator.
 *
 * One sweep plus slack. Past this a quiet member is worth a question rather than a spinner: the row
 * turns to "needs you", and the panel offers "Skip <name>" beside "Keep trying".
 */
export const PEER_UNREACHABLE_MS = 30_000;

/**
 * How long this device's own download may make no progress before the screen offers the app back.
 *
 * Longer than any precache of this bundle on a slow phone: the 2026-09-12 incident's install was 125
 * seconds of an 869 kB chunk and was perfectly healthy. Past this the row says so, "Use the app
 * anyway" appears, and ONE `checkForUpdate()` re-check is fired so a row lying about a worker that
 * already died corrects itself.
 */
export const DOWNLOAD_HUNG_MS = 120_000;

/**
 * How long the lead may hold one run state, or a crew run go without a movement, before the screen
 * offers the app back.
 *
 * Longer than a normal build plus restart plus verify. Past this "Use the app anyway" appears. Nothing
 * about the run is cancelled by taking it.
 */
export const LEAD_STALLED_MS = 180_000;

/**
 * How long step 6 waits for a new app to show up at all before it lets the phone keep the one it has.
 *
 * The bridge names the bundle it serves on every poll, so a new one is normally seen within two poll
 * gaps. A bridge that cannot say (no build stamp) would otherwise hold this screen on step 6 forever.
 */
export const PHONE_WAIT_MS = 60_000;

/** How long "Keep trying" puts the question about one member away before it is asked again. */
export const KEEP_TRYING_MS = 120_000;

/** The seven steps, and how many there are. Step 0 is "Ready to start", before any of them. */
export const STEP_COUNT = 7;

/** How much of the screen the mode takes. `collapsed` is the one-line strip in the band above the
 *  header; `hidden` renders nothing. */
export type UpdateScreenMode = "hidden" | "collapsed" | "expanded";

/** Where the update is. `none` is no update at all; the three after `done` are the other two ends. */
export type UpdatePhase =
  | "none"
  | "ready"
  | "check"
  | "build"
  | "restart"
  | "verify"
  | "members"
  | "phone"
  | "done"
  | "rolled-back"
  | "stuck"
  | "stopped";

/** The step each phase is, 1 to 7. The two failed ends keep the step they stopped on. */
const STEP_OF = {
  none: 0,
  ready: 0,
  check: 1,
  build: 2,
  restart: 3,
  verify: 4,
  members: 5,
  phone: 6,
  done: 7,
  "rolled-back": 4,
  stuck: 3,
  stopped: 2,
} satisfies Record<UpdatePhase, number>;

const IN_FLIGHT: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>([
  "check",
  "build",
  "restart",
  "verify",
  "members",
  "phone",
]);

/** Is this phase one of the seven steps still going? */
export function phaseInFlight(phase: UpdatePhase): boolean {
  return IN_FLIGHT.has(phase);
}

/** The ends that did not arrive. */
export function phaseFailed(phase: UpdatePhase): boolean {
  return phase === "rolled-back" || phase === "stuck" || phase === "stopped";
}

/**
 * One row's status. `active` is the only one that animates; `queued` is still and dimmed; `offline`
 * is the lead during its restart, gone on purpose; `attention` is a member that needs the operator.
 */
export type UpdateRowStatus = "queued" | "active" | "offline" | "ok" | "failed" | "attention" | "skipped";

/** One row. The lead is first, then every member in the order the lead reported them, then this
 *  phone. Every row has the same box: a first line, and one reserved line under it. */
export interface UpdateScreenRow {
  /** Stable across states: `lead`, `peer:<name>` or `phone`. */
  readonly key: string;
  readonly name: string;
  readonly lead: boolean;
  readonly phone: boolean;
  readonly status: UpdateRowStatus;
  /** Drawn at half strength: a row that is waiting its turn in a run. */
  readonly dim: boolean;
  /** The state's own words, after the name. Already translated. */
  readonly word: string;
  /** "1.11.1 → 1.12.0" while it moves, the one version once it has settled, or null. */
  readonly versions: string | null;
  /** The second line: a reason, a limit, a note. Null when the line holds the bar or nothing. */
  readonly detail: string | null;
  /** 0 to 1 on this phone's row while it downloads; null everywhere else. */
  readonly progress: number | null;
}

/** How the run ended, for the hook. `failed` carries a key so a close is spent on that failure only. */
export type UpdateScreenEnd =
  | { readonly kind: "none" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly key: string };

export interface UpdateScreenView {
  readonly mode: UpdateScreenMode;
  /** This device started the run on screen. The strip says "started on another device" otherwise. */
  readonly mine: boolean;
  /** The app behind the panel takes no tap. THE one decision; see this file's header. */
  readonly locked: boolean;
  /** `!locked`, kept by name because every reader since ADR 0044 asks it this way. */
  readonly dismissible: boolean;
  readonly phase: UpdatePhase;
  /** 1 to 7 while a step is on screen, 0 before the first. */
  readonly step: number;
  /** Where the run goes, and where it came from, when anything names them. */
  readonly target: string | null;
  readonly from: string | null;
  /** When the run started (this device's own tap when it has one), and when it ended. The band's
   *  clock is the difference, or the time since the start while it runs. */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The band's clock: from the start to the end, or to now while it runs. Null with no start. */
  readonly elapsedMs: number | null;
  /** One line, at most. */
  readonly heading: string;
  /** Two lines at most, in a box that always holds two. */
  readonly subtitle: string;
  /** What comes next, or why the operator is being asked. Two lines at most, or null. */
  readonly note: string | null;
  readonly rows: readonly UpdateScreenRow[];
  /** A member that needs the operator: "Skip <name>" and "Keep trying". Only on the device that
   *  started the run, and only on step 5. */
  readonly ask: { readonly name: string } | null;
  /** The command a stuck run prints for the operator to run by hand. */
  readonly recovery: string | null;
  /** The members an ended run left behind, for "Try <name> again". */
  readonly retryNames: readonly string[];
  /** A stall: the lead, the crew or this phone's download has gone quiet. "Use the app anyway". */
  readonly canEscape: boolean;
  readonly end: UpdateScreenEnd;
  /** The lead has held one state past {@link LEAD_STALLED_MS}, or a crew run has not moved for that long. */
  readonly leadStalled: boolean;
  /** A re-check is owed, exactly once, because the download looks hung. */
  readonly recheckDownload: boolean;
  /** Step 6 wants the new app and nothing is fetching it yet. The hook asks once. */
  readonly kickPhone: boolean;
  /** Hold this phone's own reload: machines are still moving, and its turn is step 6. */
  readonly holdsReload: boolean;
  /** Which run is on screen: the lead's own, one that moves only the members, or none. */
  readonly inFlight: "lead" | "crew" | null;
}

/**
 * The legs that ride the STATUS rather than the lead's run record (M20/09), as the store holds them.
 * On a peers-only run they are the whole run.
 */
export interface UpdateScreenCrewRun {
  readonly legs: readonly UpdatePeerLeg[];
  readonly settledAt: number | null;
  /** The version the run levels the members to (`peersTo`), or null when the bridge did not say. */
  readonly to: string | null;
  /** The lead's own running version (`current`). */
  readonly current: string;
}

export interface UpdateScreenInput {
  /** The freshest run record the store holds (the standby door, the snapshot, the card's check). */
  readonly run: UpdateRun | undefined;
  /** The crew census, for the names and versions a run record does not carry. */
  readonly crew: readonly UpdateCrewMember[];
  /** What this machine is called on its own row. */
  readonly leadName: string;
  /** The service worker's stage (`lib/pwa.ts`). */
  readonly stage: "idle" | "installing";
  /** Files precached so far, off the worker's own per-file message, or null before the first one. */
  readonly progress: { readonly done: number; readonly total: number; readonly at: number } | null;
  /** When the stage became `installing`. */
  readonly installingSince: number | null;
  /** Did THIS device start the run on screen? Derived from {@link claim} by the hook. */
  readonly startedHere: boolean;
  /** When the controller swapped, or null. */
  readonly controllerChangedAt: number | null;
  /** The operator took "Use the app anyway" for this run. */
  readonly released: boolean;
  /** The legs that ride the status, when there are any (M32). */
  readonly crewRun?: UpdateScreenCrewRun | null;
  readonly now: number;
  /** The card's button was tapped and nothing is started yet: "Ready to start". */
  readonly ask?: UpdateAsk | null;
  /** This device's claim, as it survived any reload. */
  readonly claim?: UpdateClaim | null;
  /** The bundle this document runs. */
  readonly bundle?: { readonly id: string; readonly version: string };
  /** The bridge serves a different bundle than this one. */
  readonly serverStale?: boolean;
  /** "Keep trying", by member, when it was tapped. */
  readonly keptTrying?: ReadonlyMap<string, number>;
  /** Has any source said anything about the run yet? Absent reads as yes. */
  readonly answered?: boolean;
}

/** A leg nobody has finished: not arrived, not package-managed, and not failed. The band's reading. */
function legMoving(leg: UpdatePeerLeg): boolean {
  return leg.state !== "done" && leg.state !== "package-managed" && !LEG_FAILED.has(leg.state);
}

/** The one arrow every row uses between two versions. */
function versionsOf(from: string | null | undefined, to: string | null | undefined): string | null {
  if (from && to && from !== to) return `${from} → ${to}`;
  return to ?? from ?? null;
}

/** `m:ss`. The band's clock. Tabular digits at the call site, so it does not jitter. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return t("updateScreen.list.two", { a: names[0] ?? "", b: names[1] ?? "" });
  return t("updateScreen.list.many", { head: names.slice(0, -1).join(", "), last: names.at(-1) ?? "" });
}

/** This bundle is at or above the target. A dev build's `-dev` stamp is not a prerelease. */
function bundleAtLeast(version: string, target: string): boolean {
  const bare = version.replace(/-dev$/, "");
  try {
    return compareSemver(bare, target) >= 0;
  } catch {
    return false;
  }
}

/** A version the run did not name. */
function unknownVersion(): string {
  return t("updateScreen.versionUnknown");
}

// ── THE ROWS ─────────────────────────────────────────────────────────────────────────────────────

interface MemberContext {
  readonly input: UpdateScreenInput;
  readonly lead: string;
  readonly target: string | null;
  readonly phase: UpdatePhase;
  readonly skipped: ReadonlySet<string>;
}

/** Why a waiting member is not moving yet, when the lead knows (ADR 0062). */
function limited(leg: UpdatePeerLeg): boolean {
  return leg.state === "waiting" && leg.reason !== undefined && leg.reason !== "";
}

/** How long a moving member has said nothing, or null when it carries no stamp. */
function silence(leg: UpdatePeerLeg, input: UpdateScreenInput): number | null {
  const stamp = leg.updatedAt ?? input.crew.find((m) => m.name === leg.name)?.asOf ?? null;
  return stamp === null ? null : Math.max(0, input.now - stamp);
}

/** One member's row, off its leg. */
function legRow(leg: UpdatePeerLeg, ctx: MemberContext): UpdateScreenRow {
  const { input, target, phase } = ctx;
  const census = input.crew.find((m) => m.name === leg.name);
  const version = leg.version ?? census?.version ?? null;
  const base = { key: `peer:${leg.name}`, name: leg.name, lead: false, phone: false, progress: null } as const;
  if (leg.state === "done") {
    return { ...base, status: "ok", dim: false, word: t("updateScreen.row.on", { version: version ?? target ?? unknownVersion() }), versions: version ?? target, detail: null };
  }
  if (leg.state === "package-managed") {
    return { ...base, status: "skipped", dim: false, word: t("updateScreen.row.packageManaged"), versions: version, detail: t("updateScreen.peer.packageManagedNote") };
  }
  if (LEG_FAILED.has(leg.state)) {
    const word =
      leg.state === "rolled-back"
        ? t("updateScreen.row.backOn", { version: version ?? unknownVersion() })
        : leg.state === "unreachable"
          ? t("updateScreen.row.noAnswer")
          : t("updateScreen.row.stopped");
    return { ...base, status: "failed", dim: false, word, versions: version, detail: leg.reason ?? null };
  }
  if (ctx.skipped.has(leg.name)) {
    return { ...base, status: "skipped", dim: false, word: t("updateScreen.row.skipped"), versions: version, detail: t("updateScreen.row.stillOn", { version: version ?? unknownVersion() }) };
  }
  const versions = versionsOf(version, target);
  // Before step 5 every member waits for the lead, whatever its leg says.
  if (phase !== "members") {
    return { ...base, status: "queued", dim: true, word: t("updateScreen.row.waitsFor", { name: ctx.lead }), versions, detail: null };
  }
  if (limited(leg)) {
    return { ...base, status: "attention", dim: false, word: t("updateScreen.row.limited"), versions, detail: leg.reason ?? null };
  }
  const quiet = silence(leg, input);
  if (quiet !== null && quiet >= PEER_UNREACHABLE_MS) {
    const stamp = leg.updatedAt ?? census?.asOf ?? null;
    return {
      ...base,
      status: "attention",
      dim: false,
      word: t("updateScreen.row.quiet", { elapsed: minutesWord(quiet) }),
      versions,
      detail: stamp === null ? null : t("updateScreen.peer.lastSeen", { ago: timeAgoShort(stamp, input.now) }),
    };
  }
  if (leg.state === "waiting" || leg.state === "idle") {
    return { ...base, status: "queued", dim: true, word: t("updateScreen.row.nextInLine"), versions, detail: null };
  }
  return { ...base, status: "active", dim: false, word: memberWord(leg.state), versions, detail: null };
}

/** A moving member's word. The lead reports `updating` for all four of a member's run states. */
function memberWord(state: UpdatePeerLegState): string {
  switch (state) {
    case "preflight":
      return t("updateScreen.state.preflight");
    case "staging":
      return t("updateScreen.state.staging");
    case "restarting":
      return t("updateScreen.state.restarting");
    case "verifying":
      return t("updateScreen.state.verifying");
    default:
      return t("updateScreen.state.updating");
  }
}

/** A census member no leg named yet. At or above the target it has nothing to do. */
function censusRow(member: UpdateCrewMember, ctx: MemberContext): UpdateScreenRow {
  const base = { key: `peer:${member.name}`, name: member.name, lead: false, phone: false, progress: null } as const;
  const target = ctx.target;
  if (target !== null && member.version !== null && !memberBehind(member, target)) {
    return { ...base, status: "ok", dim: false, word: t("updateScreen.row.on", { version: member.version }), versions: member.version, detail: null };
  }
  if (ctx.skipped.has(member.name)) {
    return { ...base, status: "skipped", dim: false, word: t("updateScreen.row.skipped"), versions: member.version, detail: t("updateScreen.row.stillOn", { version: member.version ?? unknownVersion() }) };
  }
  const word = ctx.phase === "members" ? t("updateScreen.row.nextInLine") : t("updateScreen.row.waitsFor", { name: ctx.lead });
  return { ...base, status: "queued", dim: true, word, versions: versionsOf(member.version, target), detail: null };
}

/** Every member's row: the legs first, then any census member no leg named. */
function memberRows(legs: readonly UpdatePeerLeg[], ctx: MemberContext): UpdateScreenRow[] {
  const rows = legs.map((leg) => legRow(leg, ctx));
  for (const member of ctx.input.crew) {
    if (member.name === ctx.input.leadName) continue;
    if (legs.some((leg) => leg.name === member.name)) continue;
    rows.push(censusRow(member, ctx));
  }
  return rows;
}

/** Which member needs the operator, if any. The first one, in the lead's order. */
function askOf(rows: readonly UpdateScreenRow[], legs: readonly UpdatePeerLeg[], input: UpdateScreenInput): { name: string; note: string } | null {
  for (const row of rows) {
    if (row.status !== "attention") continue;
    const kept = input.keptTrying?.get(row.name);
    if (kept !== undefined && input.now - kept < KEEP_TRYING_MS) continue;
    const leg = legs.find((l) => l.name === row.name);
    if (leg !== undefined && limited(leg)) {
      return { name: row.name, note: t("updateScreen.ask.limited", { name: row.name }) };
    }
    const quiet = leg === undefined ? null : silence(leg, input);
    return {
      name: row.name,
      note: t("updateScreen.ask.quiet", { name: row.name, elapsed: minutesWord(quiet ?? PEER_UNREACHABLE_MS) }),
    };
  }
  return null;
}

// ── THIS PHONE ───────────────────────────────────────────────────────────────────────────────────

type PhoneState =
  | { kind: "waiting" }
  | { kind: "looking"; kick: boolean }
  | { kind: "downloading"; done: number; total: number; hung: boolean }
  | { kind: "switching" }
  | { kind: "done" }
  | { kind: "kept" }
  | { kind: "untouched" };

/** Where this phone's own step is, once the machines are done. See this file's header. */
function phoneOf(input: UpdateScreenInput, target: string | null, since: number): PhoneState {
  const bundle = input.bundle;
  const claim = input.claim ?? null;
  // A DIFFERENT BUNDLE THAN THE ONE THAT TAPPED is this phone having reloaded onto the new app.
  if (bundle !== undefined && claim?.bundleAtStart && bundle.id !== claim.bundleAtStart) return { kind: "done" };
  if (bundle !== undefined && target !== null && bundleAtLeast(bundle.version, target)) return { kind: "done" };
  if (input.stage === "installing") {
    const at = input.progress?.at ?? input.installingSince;
    const hung = at !== null && input.now - at >= DOWNLOAD_HUNG_MS;
    const done = input.progress?.done ?? 0;
    const total = input.progress?.total ?? 0;
    if (total > 0 && done >= total) return { kind: "switching" };
    return { kind: "downloading", done, total, hung };
  }
  if (input.controllerChangedAt !== null) return { kind: "switching" };
  if (input.serverStale === true) return { kind: "looking", kick: true };
  // Nothing new is being served, and nothing is coming. Past the wait, the phone keeps its app.
  if (input.now - since >= PHONE_WAIT_MS) return { kind: "kept" };
  return { kind: "looking", kick: false };
}

function phoneRow(state: PhoneState, input: UpdateScreenInput, target: string | null): UpdateScreenRow {
  const version = input.bundle?.version.replace(/-dev$/, "") ?? null;
  const base = { key: "phone", name: t("updateScreen.phone"), lead: false, phone: true } as const;
  switch (state.kind) {
    case "waiting":
      return { ...base, status: "queued", dim: true, word: t("updateScreen.row.phoneWaits"), versions: versionsOf(version, target), detail: null, progress: null };
    case "looking":
      return { ...base, status: "active", dim: false, word: t("updateScreen.row.phoneLooking"), versions: versionsOf(version, target), detail: null, progress: null };
    case "downloading": {
      if (state.hung) {
        return { ...base, status: "attention", dim: false, word: t("updateScreen.row.phoneHung"), versions: versionsOf(version, target), detail: t("updateScreen.device.hung"), progress: null };
      }
      const word = state.total > 0 ? t("updateScreen.row.files", { done: String(state.done), total: String(state.total) }) : t("updateScreen.row.phoneDownloading");
      return { ...base, status: "active", dim: false, word, versions: versionsOf(version, target), detail: null, progress: state.total > 0 ? Math.min(1, state.done / state.total) : 0 };
    }
    case "switching":
      return { ...base, status: "active", dim: false, word: t("updateScreen.row.phoneReloading"), versions: versionsOf(version, target), detail: null, progress: 1 };
    case "done":
      return { ...base, status: "ok", dim: false, word: t("updateScreen.row.on", { version: target ?? version ?? unknownVersion() }), versions: target ?? version, detail: null, progress: null };
    case "kept":
      return { ...base, status: "skipped", dim: false, word: t("updateScreen.row.phoneKept"), versions: version, detail: t("updateScreen.row.phoneKeptNote"), progress: null };
    case "untouched":
      return { ...base, status: "skipped", dim: false, word: t("updateScreen.row.untouched"), versions: version, detail: null, progress: null };
  }
}

// ── THE READING ──────────────────────────────────────────────────────────────────────────────────

/** Nothing on screen. */
function noneView(): UpdateScreenView {
  return {
    mode: "hidden",
    mine: false,
    locked: false,
    dismissible: true,
    phase: "none",
    step: 0,
    target: null,
    from: null,
    startedAt: null,
    endedAt: null,
    elapsedMs: null,
    heading: "",
    subtitle: "",
    note: null,
    rows: [],
    ask: null,
    recovery: null,
    retryNames: [],
    canEscape: false,
    end: { kind: "none" },
    leadStalled: false,
    recheckDownload: false,
    kickPhone: false,
    holdsReload: false,
    inFlight: null,
  };
}

/**
 * THE WHOLE SCREEN, DECIDED ONCE.
 *
 * Pure: no React, no `Date.now()`, no store read. Every fact it needs is an input.
 */
export function updateScreenView(input: UpdateScreenInput): UpdateScreenView {
  const run = input.run;
  const state = run?.state ?? "idle";
  const runActive = run !== undefined && RUN_IN_FLIGHT.has(state);
  const crewActive = input.crewRun != null && crewOnlyRun(input.crewRun) !== null && crewLive(input.crewRun);

  // A DOCUMENT THAT BOOTS HOLDING A CLAIM opens the panel before its first read answers, on the step
  // it last showed, with the rows it started with. This is the page after this phone's own reload, and
  // the page reloaded by hand mid-run: the mode is back before the first paint, not a poll later.
  if (input.startedHere && input.claim != null && input.answered === false && run === undefined && input.crewRun == null) {
    return provisionalView(input, input.claim);
  }

  // "READY TO START" comes first while nothing is running: the operator just asked for it.
  if (input.ask != null && !runActive && !crewActive) return readyView(input, input.ask);

  // A RUN THE LEAD TAKES NO PART IN (M32). Only when the lead's own run is not in flight.
  // A device that asked for a FULL run and holds its claim reads the lead's record to the end, even
  // once the lead is current and a status leg would pass for a crew-only one.
  const fullClaim = input.startedHere && input.claim != null && !input.claim.peersOnly && run !== undefined && state !== "idle";
  const crewOnly = runActive || fullClaim ? null : crewOnlyRun(input.crewRun ?? null);
  if (crewOnly !== null && (crewLive(crewOnly) || (input.startedHere && input.claim?.peersOnly === true))) {
    return crewOnlyView(input, crewOnly);
  }
  if (run === undefined || state === "idle") return noneView();
  return leadView(input, run);
}

/** A crew-only run with a leg still moving, or none yet in the beat after this device's confirm. */
function crewLive(crew: UpdateScreenCrewRun): boolean {
  return crew.settledAt === null && (crew.legs.length === 0 || crew.legs.some(legMoving));
}

/** The legs on the status, when they are a run that moves ONLY the members; null otherwise. */
function crewOnlyRun(crew: UpdateScreenCrewRun | null): UpdateScreenCrewRun | null {
  if (crew === null || crew.to === null || crew.current === "") return null;
  return compareSemver(crew.to, crew.current) === 0 ? crew : null;
}

/** The legs of the lead's own run: on its record, or still on the status in the beat before the
 *  record lands them (M20/09), when the status names the same target. */
/** A run's member legs and when they settled, from whichever document carries them. */
interface LegReading {
  readonly legs: readonly UpdatePeerLeg[];
  readonly settledAt: number | null;
}

function leadLegs(run: UpdateRun, crew: UpdateScreenCrewRun | null | undefined): LegReading {
  if (run.peers !== undefined && run.peers.length > 0) return { legs: run.peers, settledAt: run.settledAt ?? null };
  if (crew != null && crew.to !== null && run.to !== null && crew.to === run.to && crew.to !== crew.current) {
    return { legs: crew.legs, settledAt: crew.settledAt };
  }
  return { legs: run.peers ?? [], settledAt: run.settledAt ?? null };
}

/** Which phase the lead's record puts the run in, before the members and the phone are asked. */
function leadPhaseOf(state: UpdateRun["state"]): UpdatePhase {
  switch (state) {
    case "preflight":
      return "check";
    case "staging":
      return "build";
    case "restarting":
      return "restart";
    case "verifying":
      return "verify";
    case "rolled-back":
      return "rolled-back";
    case "stuck":
      return "stuck";
    case "interrupted":
      return "stopped";
    case "done":
      return "done";
    case "idle":
      return "none";
  }
}

function leadView(input: UpdateScreenInput, run: UpdateRun): UpdateScreenView {
  const claim = input.claim ?? null;
  const lead = input.leadName;
  const target = run.to ?? claim?.target ?? null;
  const from = run.from;
  const skipped = new Set(claim?.skipped ?? []);
  const { legs, settledAt } = leadLegs(run, input.crewRun);
  // A NEWER RUN THAN THE ONE THIS DEVICE ASKED FOR is somebody else's: it gets the strip, never the lock.
  const mine =
    input.startedHere &&
    !(claim !== null && claim.peersOnly) &&
    !(claim?.runId != null && run.runId !== undefined && run.runId !== claim.runId);

  let phase = leadPhaseOf(run.state);
  const membersMoving = settledAt === null && legs.some((leg) => legMoving(leg) && !skipped.has(leg.name));
  let phone: PhoneState = { kind: "waiting" };
  if (phase === "done") {
    if (membersMoving) phase = "members";
    else if (mine) {
      phone = phoneOf(input, target, Math.max(run.updatedAt, settledAt ?? 0));
      if (phone.kind !== "done" && phone.kind !== "kept") phase = "phone";
    }
  } else if (phaseFailed(phase)) {
    phone = { kind: "untouched" };
  }
  if (phase === "done" && phone.kind === "waiting") phone = { kind: "done" };

  const ctx: MemberContext = { input, lead, target, phase, skipped };
  // A FAILED RUN NEVER REACHED a member still waiting its turn: that row says "not touched".
  const members = phaseFailed(phase)
    ? memberRows(legs, ctx).map((row) => (row.status === "queued" ? untouched(row) : row))
    : memberRows(legs, ctx);
  const rows: UpdateScreenRow[] = [leadRow(run, phase, lead, target, input), ...members, phoneRow(phone, input, target)];

  const inFlight = phaseInFlight(phase);
  const leadStalled = RUN_IN_FLIGHT.has(run.state) && run.updatedAt > 0 && input.now - run.updatedAt >= LEAD_STALLED_MS;
  const stamps = legs.filter((leg) => legMoving(leg) && !skipped.has(leg.name)).map((leg) => leg.updatedAt).filter((at): at is number => at !== undefined);
  const membersStalled = phase === "members" && stamps.length > 0 && input.now - Math.max(...stamps) >= LEAD_STALLED_MS;
  const hung = phone.kind === "downloading" && phone.hung;
  const stalled = leadStalled || membersStalled || hung;
  const locked = mine && inFlight && !input.released;
  const ask = mine && phase === "members" ? askOf(rows, legs, input) : null;

  const startedAt = mine && claim !== null ? claim.startedAt : run.startedAt;
  const endedAt = inFlight ? null : Math.min(input.now, Math.max(run.updatedAt, settledAt ?? 0, input.controllerChangedAt ?? 0));
  const failedKey = `run:${run.runId ?? ""}:${run.startedAt}:${run.state}`;
  const end: UpdateScreenEnd = phaseFailed(phase)
    ? { kind: "failed", key: failedKey }
    : phase === "done"
      ? { kind: "done" }
      : { kind: "none" };

  let mode: UpdateScreenMode;
  if (inFlight) mode = locked ? "expanded" : "collapsed";
  else if (phase === "done") mode = mine ? "expanded" : "hidden";
  else mode = "expanded";

  const managed = managedNames(legs);
  const retryNames =
    phase === "done" ? rows.filter((row) => row.key.startsWith("peer:") && behindRow(row, managed)).map((row) => row.name) : [];
  const words = copyOf({ phase, lead, target, from, rows, phone, managed });

  return {
    mode,
    mine,
    locked,
    dismissible: !locked,
    phase,
    step: STEP_OF[phase],
    target,
    from,
    startedAt,
    endedAt,
    elapsedMs: elapsedOf(startedAt, endedAt, input.now),
    heading: words.heading,
    subtitle: words.subtitle,
    note: ask?.note ?? words.note,
    rows,
    ask: ask === null ? null : { name: ask.name },
    recovery: phase === "stuck" ? (run.recovery ?? null) : null,
    retryNames,
    canEscape: mine && inFlight && stalled && !input.released,
    end,
    leadStalled: leadStalled || membersStalled,
    recheckDownload: hung,
    kickPhone: mine && phase === "phone" && phone.kind === "looking" && phone.kick,
    holdsReload: inFlight && phase !== "phone",
    inFlight: inFlight ? "lead" : null,
  };
}

/** The band's clock, never negative. */
function elapsedOf(startedAt: number | null, endedAt: number | null, now: number): number | null {
  if (startedAt === null) return null;
  return Math.max(0, (endedAt ?? now) - startedAt);
}

/** The members a package manager owns. Never offered a retry and never "did not update" (ADR 0035). */
function managedNames(legs: readonly UpdatePeerLeg[]): ReadonlySet<string> {
  return new Set(legs.filter((leg) => leg.state === "package-managed").map((leg) => leg.name));
}

/** A member row the run left behind: failed, or skipped by the operator. */
function behindRow(row: UpdateScreenRow, managed: ReadonlySet<string>): boolean {
  return !row.phone && !row.lead && (row.status === "failed" || row.status === "skipped") && !managed.has(row.name);
}

/** A member a failed run never reached. */
function untouched(row: UpdateScreenRow): UpdateScreenRow {
  // The version it still runs: the left side of a "from → to" pair.
  const versions = row.versions?.split(" → ")[0] ?? null;
  return { ...row, status: "skipped", dim: false, word: t("updateScreen.row.untouched"), versions, detail: null };
}

function leadRow(run: UpdateRun, phase: UpdatePhase, lead: string, target: string | null, input: UpdateScreenInput): UpdateScreenRow {
  const base = { key: "lead", name: lead, lead: true, phone: false, progress: null } as const;
  const moving = versionsOf(run.from, target);
  switch (phase) {
    case "check":
      return { ...base, status: "active", dim: false, word: t("updateScreen.state.preflight"), versions: moving, detail: null };
    case "build":
      return { ...base, status: "active", dim: false, word: t("updateScreen.row.building", { version: target ?? unknownVersion() }), versions: moving, detail: null };
    case "restart":
      return {
        ...base,
        status: "offline",
        dim: false,
        word: t("updateScreen.row.restarting", { elapsed: formatClock(input.now - run.updatedAt) }),
        versions: moving,
        detail: t("updateScreen.row.restartingNote"),
      };
    case "verify":
      return { ...base, status: "active", dim: false, word: t("updateScreen.state.verifying"), versions: moving, detail: null };
    case "rolled-back":
      return { ...base, status: "failed", dim: false, word: t("updateScreen.row.backOn", { version: run.from ?? unknownVersion() }), versions: run.from, detail: run.reason ?? null };
    case "stuck":
      return { ...base, status: "failed", dim: false, word: t("updateScreen.row.stuck"), versions: run.from, detail: run.reason ?? null };
    case "stopped":
      return { ...base, status: "failed", dim: false, word: t("updateScreen.row.stopped"), versions: run.from, detail: run.reason ?? null };
    default:
      return { ...base, status: "ok", dim: false, word: t("updateScreen.row.on", { version: target ?? unknownVersion() }), versions: target, detail: null };
  }
}

/** The panel's three runs of text for one phase. */
interface PhaseCopy {
  readonly heading: string;
  readonly subtitle: string;
  readonly note: string | null;
}

/** The heading, the subtitle and the next line for a phase. */
function copyOf(a: {
  phase: UpdatePhase;
  lead: string;
  target: string | null;
  from: string | null;
  rows: readonly UpdateScreenRow[];
  phone: PhoneState;
  managed: ReadonlySet<string>;
}): PhaseCopy {
  const version = a.target ?? unknownVersion();
  const from = a.from ?? unknownVersion();
  const hasMembers = a.rows.some((row) => !row.lead && !row.phone);
  switch (a.phase) {
    case "check":
      return { heading: t("updateScreen.check.heading", { lead: a.lead }), subtitle: t("updateScreen.check.subtitle"), note: t("updateScreen.check.next", { version, lead: a.lead }) };
    case "build":
      return { heading: t("updateScreen.build.heading", { version, lead: a.lead }), subtitle: t("updateScreen.build.subtitle"), note: t("updateScreen.build.next", { lead: a.lead }) };
    case "restart":
      return { heading: t("updateScreen.restart.heading", { lead: a.lead }), subtitle: t("updateScreen.restart.subtitle", { lead: a.lead }), note: t("updateScreen.restart.next", { lead: a.lead }) };
    case "verify":
      return {
        heading: t("updateScreen.verify.heading", { lead: a.lead }),
        subtitle: t("updateScreen.verify.subtitle", { lead: a.lead, from }),
        note: hasMembers ? t("updateScreen.verify.nextMembers") : t("updateScreen.verify.nextPhone"),
      };
    case "members":
      return { heading: t("updateScreen.members.heading"), subtitle: t("updateScreen.members.subtitle"), note: t("updateScreen.members.next") };
    case "phone":
      return phoneCopy(a.phone, version, a.lead);
    case "done":
      return { heading: t("updateScreen.done.heading"), subtitle: doneSummary(a.rows, version, a.managed), note: null };
    case "rolled-back":
      return { heading: t("updateScreen.rolledBack.heading", { lead: a.lead, from }), subtitle: t("updateScreen.rolledBack.subtitle", { lead: a.lead, from }), note: null };
    case "stuck":
      return { heading: t("updateScreen.stuck.heading", { lead: a.lead }), subtitle: t("updateScreen.stuck.subtitle", { lead: a.lead }), note: null };
    case "stopped":
      return { heading: t("updateScreen.stuck.heading", { lead: a.lead }), subtitle: t("updateScreen.stopped.subtitle", { lead: a.lead, from }), note: null };
    case "ready":
    case "none":
      return { heading: "", subtitle: "", note: null };
  }
}

function phoneCopy(phone: PhoneState, version: string, lead: string): PhaseCopy {
  if (phone.kind === "switching") {
    return { heading: t("updateScreen.switch.heading", { version }), subtitle: t("updateScreen.switch.subtitle"), note: null };
  }
  if (phone.kind === "downloading" && phone.hung) {
    return { heading: t("updateScreen.phone.heading"), subtitle: t("updateScreen.phone.hung"), note: t("updateScreen.phone.next") };
  }
  if (phone.kind === "downloading" && phone.total > 0) {
    return {
      heading: t("updateScreen.phone.heading"),
      subtitle: t("updateScreen.phone.subtitle", { done: String(phone.done), total: String(phone.total) }),
      note: t("updateScreen.phone.next"),
    };
  }
  return { heading: t("updateScreen.phone.heading"), subtitle: t("updateScreen.phone.looking", { lead }), note: t("updateScreen.phone.next") };
}

/** "bluefin, minibuch and this phone run 1.12.0. cellar did not update." */
function doneSummary(rows: readonly UpdateScreenRow[], version: string, managed: ReadonlySet<string>): string {
  const arrived = rows.filter((row) => row.status === "ok").map((row) => (row.phone ? t("updateScreen.thisPhone") : row.name));
  const behind = rows.filter((row) => behindRow(row, managed)).map((row) => row.name);
  const parts: string[] = [];
  if (arrived.length > 0) parts.push(tn("updateScreen.done.arrived", arrived.length, { names: joinNames(arrived), version }));
  if (behind.length > 0) parts.push(tn("updateScreen.done.behind", behind.length, { names: joinNames(behind) }));
  return parts.join(" ");
}

// ── A RUN THAT MOVES ONLY THE MEMBERS (M32) ──────────────────────────────────────────────────────

function crewOnlyView(input: UpdateScreenInput, crew: UpdateScreenCrewRun): UpdateScreenView {
  const lead = input.leadName;
  const claim = input.claim ?? null;
  const skipped = new Set(claim?.skipped ?? []);
  const live = crewLive(crew) && !(crew.settledAt === null && crew.legs.length > 0 && !crew.legs.some((leg) => legMoving(leg) && !skipped.has(leg.name)));
  const phase: UpdatePhase = live ? "members" : "done";
  const mine = input.startedHere && (claim === null || claim.peersOnly);
  if (!live && !mine) return noneView();

  const ctx: MemberContext = { input, lead, target: crew.current, phase, skipped };
  const managed = managedNames(crew.legs);
  const version = input.bundle?.version.replace(/-dev$/, "") ?? null;
  const rows: UpdateScreenRow[] = [
    {
      key: "lead",
      name: lead,
      lead: true,
      phone: false,
      status: "ok",
      dim: false,
      word: t("updateScreen.row.already", { version: crew.current }),
      versions: crew.current,
      detail: null,
      progress: null,
    },
    ...memberRows(crew.legs, ctx),
    {
      key: "phone",
      name: t("updateScreen.phone"),
      lead: false,
      phone: true,
      status: "ok",
      dim: false,
      word: t("updateScreen.row.phoneKeeps"),
      versions: version,
      detail: null,
      progress: null,
    },
  ];

  // THE STALL, on the run's last movement: the newest stamp any moving leg carries.
  const stamps = crew.legs.filter((leg) => legMoving(leg) && !skipped.has(leg.name)).map((leg) => leg.updatedAt).filter((at): at is number => at !== undefined);
  const movedAt = stamps.length === 0 ? null : Math.max(...stamps);
  const stalled = live && movedAt !== null && input.now - movedAt >= LEAD_STALLED_MS;
  // A RUN WITH LEGS AND NO CLOCK NEVER TAKES THE APP AWAY: the stall is the only way out of the lock,
  // and it needs a stamp. `updatedAt` is backfilled on every leg (crew/follow.ts, M20/12), so this is
  // a guard on an invariant rather than a case the bridge produces.
  const unclocked = crew.legs.length > 0 && crew.legs.every((leg) => leg.updatedAt === undefined);
  const locked = mine && live && !input.released && !unclocked;
  const ask = mine && live ? askOf(rows, crew.legs, input) : null;
  const words = live
    ? { heading: t("updateScreen.members.heading"), subtitle: t("updateScreen.members.subtitle"), note: t("updateScreen.members.nextCrewOnly") }
    : { heading: t("updateScreen.done.heading"), subtitle: doneSummary(rows, crew.current, managed), note: null };
  // A failed leg whose member the census now shows level is not left behind (`lib/crew-level.ts`).
  const retryNames = live
    ? []
    : rows
        .filter((row) => row.key.startsWith("peer:") && behindRow(row, managed))
        .filter((row) => skipped.has(row.name) || crew.legs.some((leg) => leg.name === row.name && legStillFailed(leg, input.crew, crew.current)))
        .map((row) => row.name);

  let mode: UpdateScreenMode;
  if (live) mode = locked ? "expanded" : "collapsed";
  else mode = "expanded";
  const crewStart = claim?.startedAt ?? movedAt ?? null;
  const crewEnd = live ? null : Math.min(input.now, crew.settledAt ?? movedAt ?? input.now);

  return {
    mode,
    mine,
    locked,
    dismissible: !locked,
    phase,
    step: STEP_OF[phase],
    target: crew.current,
    from: null,
    startedAt: crewStart,
    endedAt: crewEnd,
    elapsedMs: elapsedOf(crewStart, crewEnd, input.now),
    heading: words.heading,
    subtitle: words.subtitle,
    note: ask?.note ?? words.note,
    rows,
    ask: ask === null ? null : { name: ask.name },
    recovery: null,
    retryNames,
    canEscape: mine && live && stalled && !input.released,
    end: live ? { kind: "none" } : { kind: "done" },
    leadStalled: stalled,
    recheckDownload: false,
    kickPhone: false,
    holdsReload: live,
    inFlight: live ? "crew" : null,
  };
}

// ── BEFORE THE FIRST READ ────────────────────────────────────────────────────────────────────────

const PHASES: readonly UpdatePhase[] = ["check", "build", "restart", "verify", "members", "phone"];

/** A row whose state no source has told this document yet. */
function readingRow(key: string, name: string, extra: Partial<UpdateScreenRow> = {}): UpdateScreenRow {
  return {
    key,
    name,
    lead: false,
    phone: false,
    status: "queued",
    dim: true,
    word: t("updateScreen.row.reading"),
    versions: null,
    detail: null,
    progress: null,
    ...extra,
  };
}

function provisionalView(input: UpdateScreenInput, claim: UpdateClaim): UpdateScreenView {
  const reloaded = input.bundle !== undefined && claim.bundleAtStart !== null && input.bundle.id !== claim.bundleAtStart;
  const last = PHASES.find((phase) => phase === claim.lastPhase);
  const phase: UpdatePhase = reloaded ? "phone" : (last ?? "check");
  const lead = claim.lead ?? input.leadName;
  const rows = [
    readingRow("lead", lead, { lead: true }),
    ...claim.members.map((name) => readingRow(`peer:${name}`, name)),
    readingRow("phone", t("updateScreen.phone"), { phone: true }),
  ];
  const words = copyOf({ phase, lead, target: claim.target, from: null, rows, phone: { kind: "waiting" }, managed: new Set() });
  return {
    ...noneView(),
    mode: "expanded",
    mine: true,
    locked: true,
    dismissible: false,
    phase,
    step: STEP_OF[phase],
    target: claim.target,
    startedAt: claim.startedAt,
    elapsedMs: elapsedOf(claim.startedAt, null, input.now),
    heading: words.heading,
    subtitle: t("updateScreen.reading.subtitle"),
    note: words.note,
    rows,
    holdsReload: phase !== "phone",
    inFlight: claim.peersOnly ? "crew" : "lead",
  };
}

// ── READY TO START ───────────────────────────────────────────────────────────────────────────────

function readyView(input: UpdateScreenInput, ask: UpdateAsk): UpdateScreenView {
  const lead = input.leadName;
  const members = input.crew.filter((member) => member.name !== lead);
  const version = input.bundle?.version.replace(/-dev$/, "") ?? null;
  const base = { lead: false, phone: false, dim: false, progress: null } as const;
  let rows: UpdateScreenRow[];
  let heading: string;
  let subtitle: string;
  if (ask.peersOnly) {
    rows = [
      { ...base, key: "lead", name: lead, lead: true, status: "ok", word: t("updateScreen.row.already", { version: ask.current }), versions: ask.current, detail: null },
      ...members.map((m): UpdateScreenRow =>
        m.version !== null && !memberBehind(m, ask.current)
          ? { ...base, key: `peer:${m.name}`, name: m.name, status: "ok", word: t("updateScreen.row.on", { version: m.version }), versions: m.version, detail: null }
          : { ...base, key: `peer:${m.name}`, name: m.name, status: "queued", word: t("updateScreen.ready.memberRetry", { version: ask.current }), versions: versionsOf(m.version, ask.current), detail: t("updateScreen.ready.memberNote") },
      ),
      { ...base, key: "phone", name: t("updateScreen.phone"), phone: true, status: "ok", word: t("updateScreen.row.phoneKeeps"), versions: version, detail: null },
    ];
    const names = ask.names ?? [];
    heading = names.length === 1 ? t("updateScreen.ready.retryOne", { name: names[0] ?? "" }) : t("updateScreen.ready.retryMany", { version: ask.version });
    subtitle = t("updateScreen.ready.retrySubtitle", { lead, version: ask.current });
  } else {
    rows = [
      { ...base, key: "lead", name: lead, lead: true, status: "queued", word: t("updateScreen.ready.lead"), versions: versionsOf(ask.current, ask.version), detail: t("updateScreen.ready.leadNote") },
      ...members.map((m): UpdateScreenRow => ({ ...base, key: `peer:${m.name}`, name: m.name, status: "queued", word: t("updateScreen.ready.member"), versions: versionsOf(m.version, ask.version), detail: t("updateScreen.ready.memberNote") })),
      { ...base, key: "phone", name: t("updateScreen.phone"), phone: true, status: "queued", word: t("updateScreen.ready.phone"), versions: versionsOf(version, ask.version), detail: t("updateScreen.ready.phoneNote") },
    ];
    heading = ask.major ? t("updateScreen.ready.majorHeading", { version: ask.version }) : t("updateScreen.ready.heading", { version: ask.version });
    subtitle = ask.major
      ? t("updateScreen.ready.majorSubtitle", { version: ask.version })
      : members.length === 0
        ? t("updateScreen.ready.solo", { lead })
        : tn("updateScreen.ready.crew", members.length + 1);
  }
  return {
    ...noneView(),
    mode: "expanded",
    mine: true,
    phase: "ready",
    target: ask.version,
    from: ask.current,
    heading,
    subtitle,
    note: ask.peersOnly ? t("updateScreen.ready.noteCrewOnly") : t("updateScreen.ready.note"),
    rows,
  };
}
