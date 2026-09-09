import { t, tn } from "./i18n";
import type {
  DismissScope,
  UpdateInfo,
  UpdateLinkChange,
  UpdatePeerLeg,
  UpdatePeerLegState,
  UpdateRun,
  UpdateRunState,
} from "./types";

/** What a close sends: the scope it was closed in, and the version it was keyed to. */
export interface Dismissal {
  scope: DismissScope;
  version: string;
}

// ── THE UPDATE BAND, AS A PURE READING ──────────────────────────────────────────────────────────
//
// One top-of-app row carries the whole update subject, and WHICH of its five states is on screen is
// decided here rather than inside the component. Everything below is a pure function of the polled
// snapshot plus two client facts (this tab just posted a confirm; the bundle on screen is stale), so
// the precedence is pinned by unit tests instead of by pulling a DOM apart.
//
// ── THE PRECEDENCE, AND WHY IT IS THIS ORDER ─────────────────────────────────
// A run outranks an offer, a finished run outranks both, peers trail, and an offer is last:
//
//   (s) starting     the confirm was tapped and the status object has not spoken yet
//   (b) updating     the polled run is in flight
//   (c) updated      the run finished and this bundle is behind the bridge
//   (d) peers        the lead finished and a peer is still moving, or one rolled back
//   (a) available    a newer release exists upstream
//
// ── THE BUNDLE AND COLLIE ARE TWO DIFFERENT UPDATES ──────────────────────────
// `lib/self-update.ts` updates the BUNDLE; the update card updates COLLIE. The band renders both,
// and the rule between them is that the band never CHANGES what the self-updater does. `bundleStale`
// is that module's own banner flag, which is true only when it has decided it may not auto-reload
// (a hold is active, or it already spent its one auto-reload for this build). So a band that says
// "Tap to reload" is a band the self-updater was going to ask about anyway; where it would have
// auto-reloaded, `bundleStale` is false and the band says nothing about the bundle at all.
//
// ── THE REASON IS TRUNCATED HERE, NOT IN CSS ─────────────────────────────────
// A rolled-back peer is named with its reason, and the reason is a peer's own prose of unbounded
// length. It is cut on a word boundary to `REASON_BUDGET`, and the Updates page carries it whole.

/**
 * The run states that are somebody still driving it. THE one copy (M20/08).
 *
 * It used to be written out here, in the card and about to be written a third time in the poll
 * cadence. Three copies of one four-word set is three chances for a screen to think a run is over
 * while another thinks it is running, which is the same class of bug as the two clocks spec 04
 * closed. Exported, so a fourth copy has no excuse.
 */
export const RUN_IN_FLIGHT: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "preflight",
  "staging",
  "restarting",
  "verifying",
]);

/** Whether somebody is still driving THIS machine's run. Absent or terminal reads as no. */
export function runInFlight(run: UpdateRun | undefined): boolean {
  return run !== undefined && RUN_IN_FLIGHT.has(run.state);
}

/** A peer leg that went wrong. `rolled-back` is the one the band names; the other two read the same
 *  way to an operator and point at the same page. */
const PEER_FAILED: ReadonlySet<UpdatePeerLegState> = new Set<UpdatePeerLegState>([
  "rolled-back",
  "unreachable",
  "stuck",
  "interrupted",
]);

/**
 * How long a finished run stays the thing the band is about.
 *
 * The run record persists on the snapshot long after the run, so without a window a `done` from
 * three days ago plus an unrelated stale bundle (a web-only rebuild) would print "Updated to 1.5.0"
 * about an update that is not what produced this build. Ten minutes is longer than any restart and
 * far shorter than "still true tomorrow".
 */
export const DONE_WINDOW_MS = 10 * 60_000;

/** How much of a peer's own prose fits the band. The page carries the rest. */
export const REASON_BUDGET = 40;

/** The three words state (b) counts through, mapped off the run state below. */
export type RibbonPhase = "fetching" | "building" | "restarting";

/** What the band is currently about. `silent` renders nothing (the component returns null). */
export type RibbonView =
  | { kind: "silent" }
  | { kind: "starting" }
  | { kind: "updating"; phase: RibbonPhase; version: string }
  | { kind: "updated"; version: string }
  | { kind: "bundle" }
  | {
      kind: "peers";
      names: string[];
      target: string | null;
      /** How long the slowest moving leg has been at it, or null before the patience window. */
      elapsedMs: number | null;
    }
  | { kind: "package-managed"; names: string[]; target: string | null }
  | {
      kind: "peer-failed";
      name: string;
      reason: string;
      /** What the run was heading for, so the operator can put the sentence down. Null when nothing
       *  names a version to key the dismissal to, and the band then stays. */
      target: string | null;
    }
  | { kind: "available"; version: string }
  | { kind: "available-packaged"; version: string; manager: string | null };

/** Everything the reading needs. Two of the four are client facts; the other two are the poll. */
export interface RibbonInput {
  /** The snapshot's update block. Absent on an older bridge, which reads as "nothing to say". */
  update: UpdateInfo | undefined;
  /** When THIS tab posted the confirm, or null if it has not. State (s) is nothing but this. */
  startedAt: number | null;
  /** `useSelfUpdate()`'s banner flag — see the header. Never re-derived here. */
  bundleStale: boolean;
  /**
   * The version whose OFFER the operator closed. A newer one is a different version, so it raises
   * the band again.
   *
   * It comes off the SNAPSHOT (`update.dismissedVersion`), not off this browser: a dismissal is a
   * decision about the machine, and one kept per browser leaves the band up wherever it is read
   * next (M17/08). The component may pass its own optimistic value on top, so the band drops on the
   * tap rather than on the next poll.
   */
  dismissedVersion: string | null;
  /** The version whose quiet CREW notice was closed (`update.dismissedCrewVersion`). A separate
   *  decision, so a separate input — see {@link DismissScope}. */
  dismissedCrewVersion: string | null;
  now: number;
}

/**
 * `preflight` is the fetch, `staging` is the build, `restarting`/`verifying` is the restart.
 *
 * Three words need three sources and the run reports four states. The spec names "staging
 * completing" for *Building*, which the wire does not report as a state of its own; this is the
 * nearest reading that still counts through all three words rather than skipping one.
 */
function phaseOf(state: UpdateRunState): RibbonPhase {
  if (state === "preflight") return "fetching";
  if (state === "staging") return "building";
  return "restarting";
}

/** The leg states that are OVER. `package-managed` joins `done` here: a package manager owns that
 *  machine (ADR 0035), so the run is not waiting on it and never will be. */
const PEER_TERMINAL: ReadonlySet<UpdatePeerLegState> = new Set<UpdatePeerLegState>([
  "done",
  "package-managed",
]);

/** A leg nobody has finished. Written as "not over and not failed" rather than as a set of moving
 *  states, so a state this client has never heard of still counts as moving instead of vanishing. */
function isMoving(leg: UpdatePeerLeg): boolean {
  return !PEER_TERMINAL.has(leg.state) && !PEER_FAILED.has(leg.state);
}

/**
 * EVERY PEER LEG THIS BRIDGE REPORTED, wherever it rode (M20/09).
 *
 * The legs sit on `run.peers` when this machine has a run record and on `update.peers` when it does
 * not. A peers-only run is the second case: "Retry crew update" begins the turn queue and re-sweeps
 * without ever calling the updater here, so `update.json` is never written and `run` is absent for
 * the whole run.
 *
 * THIS IS THE ONLY PLACE EITHER FIELD IS READ. Both surfaces ask here, so neither can be looking at
 * a run the other cannot see — which is precisely how the 2026-09-07 drill produced a band that had
 * gone quiet over a card that had not.
 */
export function peerLegsOf(update: UpdateInfo | undefined, run?: UpdateRun): UpdatePeerLeg[] {
  // THE LIVE STATUS FIRST, and the caller's own record only if the status carries no legs at all
  // (M20/14). `run` is whatever the caller had lying about — on the Updates card that is the freshest
  // of the standby door, the snapshot poll and its OWN `GET /api/update/check`, and that last one is
  // fetched when the card mounts and not again. The two positions above are one bridge answer, taken
  // together, and mixing a cached record's legs into a live status is how the card came to render
  // last run's failures over this run.
  //
  // Measured on the VM crew, on a peers-only retry: the band read "Updating 1 peer: member2" while
  // the card showed both members unreachable from the run before, for the whole run. The card's
  // cached copy of the PREVIOUS run still carried that run's legs, because the legs only move to the
  // top level once a newer run owns them (M20/09) — so the cached copy was not stale in any way a
  // timestamp could see. It was simply the wrong document to read legs out of.
  return update?.run?.peers ?? update?.peers ?? run?.peers ?? [];
}

/**
 * When the run those legs belong to settled, or null while it is still moving (M20/01).
 *
 * Read from the same two positions as {@link peerLegsOf}, and for the same reason.
 */
export function crewSettledAt(update: UpdateInfo | undefined, run?: UpdateRun): number | null {
  // FROM THE SAME DOCUMENT THE LEGS CAME FROM (M20/14). A settle stamp read out of one answer and
  // legs read out of another is two accounts of one run, which is the whole disease. So if the live
  // status carries legs at all, its settle stamp is the answer — including when it has none, which is
  // what a run still moving looks like.
  if (update?.run?.peers !== undefined || update?.peers !== undefined) {
    return update.run?.settledAt ?? update.settledAt ?? null;
  }
  return run?.settledAt ?? null;
}

/**
 * IS THE CREW STILL MOVING? The one clock the band and the card both read (M20/04).
 *
 * Keyed on `settledAt` from spec 01, which is the lead's own answer rather than a second fold of the
 * rows: the moment every leg went terminal, stamped once. A client that folded the rows itself would
 * be a second opinion about a question the lead has already answered, and two opinions is what the
 * drill produced.
 *
 * `settledAt` absent is NOT "settled". It is what an older bridge sends and what a moving run sends,
 * and both of those must keep a page polling. So the fold below is the fallback, and it errs the
 * same way `isMoving` does: a leg state this client has never heard of counts as moving.
 */
export function crewMoving(update: UpdateInfo | undefined, run?: UpdateRun): boolean {
  const legs = peerLegsOf(update, run);
  if (legs.length === 0) return false;
  if (crewSettledAt(update, run) !== null) return false;
  return legs.some(isMoving);
}

/**
 * How long a crew run runs before the band stops assuming the operator will simply wait (M20/04).
 *
 * On 2026-09-07 an operator watched "Updating 1 peer: minibuch" for twelve minutes with no elapsed
 * time, no reassurance and nothing a tap could change, and did the only thing left: tapped again,
 * many times. Two minutes is longer than every healthy leg the drill has produced and short enough
 * that a stuck one is named while the operator is still looking.
 */
export const CREW_PATIENCE_MS = 2 * 60_000;

/**
 * EVERYTHING THE UI KNOWS ABOUT ONE RUN, read once (M20/04).
 *
 * Two surfaces reading one record with two rules is the bug this closes. The band asked "did the run
 * finish less than ten minutes ago?" and the card asked "does the record still list a moving peer?".
 * Those are different questions, so on 2026-09-07 the band went quiet at ten minutes while the card
 * kept the same peer moving for five more. Neither surface interprets a record any more; both read
 * this.
 */
export interface RunReading {
  /** The record about THIS machine, or undefined when it has none. */
  readonly run: UpdateRun | undefined;
  /** Every peer leg, wherever it rode (see {@link peerLegsOf}). */
  readonly legs: readonly UpdatePeerLeg[];
  /** When the lead stamped the run settled, or null while a leg is open. THE key. */
  readonly settledAt: number | null;
  /** Is the crew still moving? Never a time comparison. */
  readonly moving: boolean;
  /** The legs still moving, in the order the lead reported them. */
  readonly movingLegs: readonly UpdatePeerLeg[];
  /** The first leg that went wrong, or null. `rolled-back` and its siblings. */
  readonly failed: UpdatePeerLeg | null;
  /** The legs a package manager owns. Terminal, and never a failure (ADR 0035). */
  readonly managed: readonly UpdatePeerLeg[];
  /**
   * How long the oldest MOVING leg has held its state, or null when nothing is moving.
   *
   * Off each leg's own `updatedAt`, which the lead passes through from the member's own record, so
   * it is that machine's account of itself and not this browser's guess.
   */
  readonly elapsedMs: number | null;
  /** Has the run run longer than {@link CREW_PATIENCE_MS}? What changes the band's words. */
  readonly slow: boolean;
}

/** How long this leg has held its current state, or null when it carries no stamp. */
export function legElapsedMs(leg: UpdatePeerLeg, now: number): number | null {
  if (leg.updatedAt === undefined) return null;
  const since = now - leg.updatedAt;
  return since < 0 ? 0 : since;
}

/** Read one run, once. The ONLY place a run record is interpreted for the UI (M20/04). */
export function readRun(input: { update: UpdateInfo | undefined; run?: UpdateRun; now: number }): RunReading {
  const legs = peerLegsOf(input.update, input.run);
  const settledAt = crewSettledAt(input.update, input.run);
  const moving = crewMoving(input.update, input.run);
  const movingLegs = moving ? legs.filter(isMoving) : [];
  const stamps = movingLegs.map((leg) => legElapsedMs(leg, input.now)).filter((ms): ms is number => ms !== null);
  const elapsedMs = stamps.length === 0 ? null : Math.max(...stamps);
  return {
    run: input.run ?? input.update?.run,
    legs,
    settledAt,
    moving,
    movingLegs,
    failed: legs.find((leg) => PEER_FAILED.has(leg.state)) ?? null,
    managed: legs.filter((leg) => leg.state === "package-managed"),
    elapsedMs,
    slow: elapsedMs !== null && elapsedMs >= CREW_PATIENCE_MS,
  };
}

/**
 * A duration as whole minutes, for a band that is read at a glance.
 *
 * Rounded DOWN, never up: "3 min" about a run at 3:59 is honest, and "4 min" about one at 3:01 is a
 * claim the operator can catch the screen making. Under a minute reads as "less than a minute"
 * rather than as seconds, because a band that counts seconds is a band that asks to be watched.
 */
export function minutesWord(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? t("updateRibbon.underAMinute") : tn("updateRibbon.minutes", minutes);
}

/** Cut on a word boundary, never mid-word, and mark the cut. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const head = space > 0 ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
}

/**
 * The package manager's NAME, out of the upgrade command the host resolved.
 *
 * The first token that is not `sudo`: `sudo pacman -Syu` is pacman, `nix profile upgrade` is nix,
 * `brew upgrade collie` is brew. Null when there is no command to read — a packaged install under a
 * prefix nobody recognises, where the band has no manager to name (ADR 0035).
 */
export function managerOf(command: string | undefined): string | null {
  const named = (command ?? "").split(/\s+/).find((token) => token !== "" && token !== "sudo");
  return named ?? null;
}

/**
 * What a close on this state records, or null when the state cannot be closed at all.
 *
 * The rule is whether the state describes something that ENDS ON ITS OWN. A run in flight, a
 * finished run, a failed peer and a peer still moving all do, and "a dismissed run is a run the
 * operator can no longer see the end of" — so they carry no close. An offer and the two QUIET crew
 * states describe a standing fact, and a standing fact the operator has read is one they may put
 * down. Keyed by the version, so a newer one raises the band again — and by the SCOPE, so putting
 * down a notice about another machine leaves this host's own offer alone.
 */
export function dismissTarget(view: RibbonView): Dismissal | null {
  switch (view.kind) {
    case "available":
    case "available-packaged":
      return { scope: "offer", version: view.version };
    case "peers":
    case "package-managed":
      return view.target === null ? null : { scope: "crew", version: view.target };
    // A FAILED LEG IS CLOSABLE, and by this rule's own logic (M20/04). The rule is whether the state
    // describes something that ends on its own. A failed leg is the one crew state that does not:
    // it is terminal, the run is over, and the sentence would otherwise stand until another run
    // replaces it. An operator who has read it may put it down.
    case "peer-failed":
      return view.target === null ? null : { scope: "crew", version: view.target };
    default:
      return null;
  }
}

/** The version the quiet crew states are keyed by: what the run is heading for when a record names
 *  it, else the release upstream is offering. Null when neither exists — nothing to key a dismissal
 *  to, so the band stays. */
function targetOf(input: RibbonInput, to: string | null): string | null {
  return to ?? input.update?.latest ?? null;
}

/** The whole band, decided once. See the precedence in this file's header. */
export function ribbonView(input: RibbonInput): RibbonView {
  const run = input.update?.run;
  // "The status object has spoken": a record exists and it is about a run, not the idle placeholder.
  const spoke = run !== undefined && run.state !== "idle";

  // (s) — the gap between the 202 and the first status the detached process writes.
  if (input.startedAt !== null && !spoke) return { kind: "starting" };

  // (b) — a run in flight. A failed poll during `restarting` simply leaves the last record in place,
  // so this branch keeps saying "Restarting" rather than becoming an error.
  if (run !== undefined && RUN_IN_FLIGHT.has(run.state)) {
    return {
      kind: "updating",
      phase: phaseOf(run.state),
      version: run.to ?? input.update?.latest ?? "",
    };
  }

  const finished =
    run !== undefined && run.state === "done" && input.now - run.updatedAt < DONE_WINDOW_MS;

  // (c) — the bridge answers with the new version and this bundle is behind it.
  if (finished && input.bundleStale && run.to !== null) return { kind: "updated", version: run.to };

  // (c)'s other half: a stale bundle with no Collie update behind it is the PWA row exactly as it
  // has always been, with its own words. Above (d) and (a) because it is the same slot.
  if (input.bundleStale) return { kind: "bundle" };

  // (d) — the crew is not done. NO TIME WINDOW, and no `finished` gate (M20/04).
  //
  // It used to hang off `finished`, so a moving peer inherited (c)'s ten-minute window and the band
  // fell silent at ten minutes over a card that was still counting. It also required a `done` record
  // on THIS machine, so a peers-only run — which writes none — was invisible to the band entirely
  // (M20/09). Both gates are gone. What ends this branch is `settledAt`, the lead's own answer,
  // stamped once when the last leg went terminal.
  {
    const reading = readRun({ update: input.update, now: input.now });
    const target = targetOf(input, run?.to ?? null);
    if (reading.failed !== null) {
      const reason = reading.failed.reason ?? t("settings.updateCard.peer.unknownReason");
      return {
        kind: "peer-failed",
        name: reading.failed.name,
        reason: truncateWords(reason, REASON_BUDGET),
        target,
      };
    }
    const quiet = target !== null && target === input.dismissedCrewVersion;
    // A moving peer is undismissable, so its target is null however the crew was closed before: the
    // operator must be able to see the end of a run somebody is still driving.
    if (reading.movingLegs.length > 0) {
      return {
        kind: "peers",
        names: reading.movingLegs.map((leg) => leg.name),
        target: null,
        // Past the patience window the band stops assuming the operator will simply wait: it says
        // how long, and it says nobody has to do anything. Before it, the words are unchanged.
        elapsedMs: reading.slow ? reading.elapsedMs : null,
      };
    }
    // Below the moving peers, never among them: the band's peers line is about what the run is
    // waiting on, and it is waiting on nothing here. Named anyway, so the operator learns why that
    // machine did not move without opening the page to find out — and closable, because a machine
    // a package manager owns can stand behind for weeks and a band nobody can put down is a nag.
    // Still gated on `finished`: it is a QUIET standing fact, not a run in progress, and raising it
    // about a run nobody started would be a nag with no run behind it.
    const managed = reading.managed.map((leg) => leg.name);
    if (finished && managed.length > 0 && !quiet) return { kind: "package-managed", names: managed, target };
  }

  // (a) — an offer, and only an offer. The tap navigates; nothing here starts anything.
  const latest = input.update?.latest ?? null;
  if (input.update?.releaseAvailable === true && latest !== null && latest !== input.dismissedVersion) {
    // A PACKAGED host cannot take the tap: `collie update` refuses there and the page shows a
    // command where the button would be (ADR 0035). So the band says what is true on that machine
    // and names the manager that owns it, rather than offering an update it cannot perform.
    if (input.update.installKind === "packaged") {
      return { kind: "available-packaged", version: latest, manager: managerOf(input.update.packageCommand) };
    }
    return { kind: "available", version: latest };
  }

  return { kind: "silent" };
}

/**
 * THE SENTENCE ABOUT THE CREW LINK, or null when there is none (M27/06).
 *
 * The bridge has already decided whether there is one: `linkChange` is set only when this install
 * is in a crew and the release ahead speaks a different wire version. Nothing is re-derived here —
 * a client comparing numbers would be a second opinion about a question the host has answered.
 *
 * This is the CARD's cut, whole. The band takes {@link linkChangeBandNote}.
 */
export function linkChangeNote(linkChange: UpdateLinkChange | null | undefined): string | null {
  return linkChange === null || linkChange === undefined ? null : t("settings.updateCard.linkChange");
}

/**
 * THE BAND'S CUT OF THE SAME FACT, or null when there is none.
 *
 * The band is one truncating row held to forty characters in all seven locales
 * (`i18n/update-ribbon-budget.test.ts`), and the whole sentence does not fit one. So the row states
 * what changes and the tap lands on the Updates card, which carries the rest of it above the
 * confirm. Two keys, one fact, and neither surface truncates the other's words.
 */
export function linkChangeBandNote(linkChange: UpdateLinkChange | null | undefined): string | null {
  return linkChange === null || linkChange === undefined ? null : t("updateRibbon.linkChangeShort");
}

/**
 * The band's one line. Separate from the component so the phrasing is testable without a DOM.
 *
 * `linkChange` adds ONE sentence, and only to the offer states: those are the two the operator
 * reads before they confirm, which is the only moment the sentence can change what they do. A run
 * already in flight is past being told.
 */
export function ribbonText(view: RibbonView, linkChange: UpdateLinkChange | null = null): string {
  const line = ribbonLine(view);
  if (view.kind !== "available" && view.kind !== "available-packaged") return line;
  const note = linkChangeBandNote(linkChange);
  return note === null ? line : `${line} ${note}`;
}

function ribbonLine(view: RibbonView): string {
  switch (view.kind) {
    case "silent":
      return "";
    case "starting":
      return t("updateRibbon.starting");
    case "updating":
      if (view.phase === "fetching") return t("updateRibbon.fetching", { version: view.version });
      if (view.phase === "building") return t("updateRibbon.building", { version: view.version });
      return t("updateRibbon.restarting", { version: view.version });
    case "updated":
      return t("updateRibbon.updated", { version: view.version });
    case "bundle":
      return t("pwa.updateAvailable");
    case "peers": {
      const line = tn("updateRibbon.peers", view.names.length, { names: view.names.join(", ") });
      // PAST THE PATIENCE WINDOW THE BAND NAMES THE TIME (M20/04). Before it, the words are exactly
      // what they were. After it, the one fact the operator does not have is how long this has been
      // going, and on 2026-09-07 not having it is what turned a wait into a dozen taps.
      //
      // The reassurance sentence that goes with it — "No action needed, this finishes on its own" —
      // lives on the Updates CARD and not here. This band is one truncating row about forty
      // characters wide (`i18n/update-ribbon-budget.test.ts` enforces it over all seven locales), and
      // a sentence that long would be a sentence nobody reads the end of. A tap lands on the card,
      // which is where there is room to say it.
      if (view.elapsedMs === null) return line;
      return tn("updateRibbon.peersSlow", view.names.length, {
        names: view.names.join(", "),
        elapsed: minutesWord(view.elapsedMs),
      });
    }
    case "package-managed":
      return tn("updateRibbon.packageManaged", view.names.length, { names: view.names.join(", ") });
    case "peer-failed":
      // ONE SENTENCE FOR ALL FOUR FAILED STATES (M20/04). It used to say "rolled back" about every
      // one of them, which is a specific and often false claim: an `unreachable` peer did not roll
      // back, nobody heard from it. "Could not update" is true of all four, and the reason that
      // follows is where the specifics belong.
      return `${t("updateRibbon.peerFailed", { name: view.name, reason: view.reason })} ${t("updateRibbon.seeUpdates")}`;
    case "available":
      return t("updateRibbon.available", { version: view.version });
    case "available-packaged":
      // No manager to name is the packaged install under a prefix Collie does not recognise. The
      // version is still true and the page still carries the boundary sentence, so the band states
      // the one and points at the other.
      if (view.manager === null) {
        return `${t("updateRibbon.availablePackagedUnnamed", { version: view.version })} ${t("updateRibbon.seeUpdates")}`;
      }
      return t("updateRibbon.availablePackaged", { version: view.version, manager: view.manager });
  }
}

// ── "THIS TAB JUST POSTED" ──────────────────────────────────────────────────────────────────────
//
// `POST /api/update` returns immediately and hands off to a detached process, so there is a window
// between the confirm and the first status the run record reports. An empty band there says "nothing
// happened" about the thing the operator just consented to. The card stamps this store on the way
// out of its own POST; the band reads it, and the moment the status object speaks the reading above
// stops using it. Module-scoped for the same reason every other cross-surface flag in this app is:
// the band is mounted at the root and the card is a route away.

let startedAt: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The confirm was tapped and the POST was accepted. Safe to call on every attempt. */
export function noteUpdateStarted(at: number = Date.now()): void {
  startedAt = at;
  emit();
}

/** The POST failed, or the status object has spoken — either way (s) is over. */
export function clearUpdateStarted(): void {
  if (startedAt === null) return;
  startedAt = null;
  emit();
}

export function getUpdateStarted(): number | null {
  return startedAt;
}

export function subscribeUpdateStarted(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
