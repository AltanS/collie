import { legStillFailed } from "./crew-level";
import { asJsonBoolean, asJsonNumber, asJsonString, parseJsonObject } from "./json";
import { t, tn } from "./i18n";
import type {
  DismissScope,
  UpdateCrewMember,
  UpdateInfo,
  UpdateLinkChange,
  UpdatePeerLeg,
  UpdatePeerLegState,
  UpdateRun,
  UpdateRunState,
  UpdateUrgent,
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
// ── THE RUN STATES BELONG TO THE SCREEN, NOT TO THE BAND (M28/01) ────────────
// This band used to carry the whole run as well: (s) the confirm just tapped, (b) the run in flight,
// (c) the run finished, (d) the peers trailing it. A running update now owns the screen — one sheet
// with a row per machine and a row for this device's own download (`lib/update-screen.ts`) — and a
// forty-character row counting "Restarting" beside a sheet saying the same thing in full was two
// surfaces about one fact, reconciled twice. So the band keeps only what is NOT a run:
//
//   (f) peer-failed        a terminal leg, after the run is over, with its own reason
//   (i) bundle-installing  THIS document's worker is fetching a new bundle
//   (c) bundle             this bundle is behind the bridge and the page may reload onto it
//   (a) available          a newer release exists upstream
//
// The two download states stay here because they are about the PWA and not about a run: with no run
// to be about, the sheet shows nothing and this row is the whole story (2026-09-12). The sheet shows
// this device's download only as part of a run.
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

/** What the band is currently about. `silent` renders nothing (the component returns null). */
export type RibbonView =
  | { kind: "silent" }
  | { kind: "bundle" }
  | { kind: "bundle-installing" }
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

/** Everything the reading needs. Two are client facts; the rest are the poll. */
export interface RibbonInput {
  /** The snapshot's update block. Absent on an older bridge, which reads as "nothing to say". */
  update: UpdateInfo | undefined;
  /** `useSelfUpdate()`'s banner flag — see the header. Never re-derived here. */
  bundleStale: boolean;
  /**
   * A new bundle is downloading into the precache right now (`lib/pwa.ts`'s update stage).
   *
   * The 2026-09-12 incident's missing word. The band offered "tap to reload", the operator tapped,
   * and the app went on saying the same thing for the two minutes the download took — so the tap
   * looked ignored and the next one was a reload nobody should have made. A download the operator
   * can see is a download the operator waits out.
   */
  bundleInstalling: boolean;
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
  /**
   * The crew census (`GET /api/update/check`'s `crew`, held by `lib/update-run-store.ts`). Read for
   * ONE thing: a failed leg whose member the census now shows level stops being named here (see
   * {@link readRun}). Absent reads as no census, and every failed leg then counts, as before.
   */
  crew?: readonly UpdateCrewMember[];
  now: number;
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
  return legsStillMoving(peerLegsOf(update, run), crewSettledAt(update, run));
}

/**
 * The same question asked of legs already in hand, rather than of an `UpdateInfo` to read them from.
 *
 * `lib/update-run-store.ts` holds the crew's legs RECONCILED from two readings and has no
 * `UpdateInfo` to hand back, so without this it could only ask about the lead's own run — which is
 * exactly the half that is already over while the crew is still moving. Both callers land here, so
 * "is the crew still moving" stays one answer (M20/04) rather than becoming two.
 */
export function legsStillMoving(
  legs: readonly UpdatePeerLeg[],
  settledAt: number | null,
): boolean {
  if (legs.length === 0) return false;
  if (settledAt !== null) return false;
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
  /**
   * The first leg that went wrong, or null. `rolled-back` and its siblings — minus a leg whose member
   * the census now shows at or above this machine's version. The legs outlive their run, so a member
   * that rolled back and then levelled itself would otherwise be named as failed until the next run.
   * The rule is `legStillFailed` in `lib/crew-level.ts`, the same one the button count reads.
   */
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

/** Read one run, once. The ONLY place a run record is interpreted for the UI (M20/04). `crew` is
 *  the census, read only to retire a failed leg its member has since outgrown. */
export function readRun(input: {
  update: UpdateInfo | undefined;
  run?: UpdateRun;
  crew?: readonly UpdateCrewMember[];
  now: number;
}): RunReading {
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
    failed: legs.find((leg) => legStillFailed(leg, input.crew ?? [], input.update?.current ?? "")) ?? null,
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

/**
 * The states put down in THIS DOCUMENT rather than on the bridge (2026-09-12).
 *
 * `bundle-installing` is the only one, and it is not in {@link dismissTarget} on purpose: nothing
 * was declined. The install goes on in the background, the controller swap still reloads the page
 * when it lands, and a version posted to `dismissUpdate` would tell the machine the operator said
 * no to a release they are in fact downloading.
 *
 * It is closable at all because the download is the one band state that can wait forever. A worker
 * stuck in `installing` on a dead link is waited on with no timer and no forced reload — deliberate,
 * since the page must not reload before the new worker is in control — so the escape is the other
 * one: put the row down and keep using the app you already have. The close hides the row for this
 * document only, and a LATER worker raises it again.
 */
export function dismissesLocally(view: RibbonView): boolean {
  return view.kind === "bundle-installing";
}

/** The version a failed leg's close is keyed by: what the run was heading for when a record names it,
 *  else the release upstream is offering. Null when neither exists — nothing to key a dismissal to,
 *  so the band stays. */
function targetOf(input: RibbonInput, to: string | null): string | null {
  return to ?? input.update?.latest ?? null;
}

/** The whole band, decided once. See the precedence in this file's header. */
export function ribbonView(input: RibbonInput): RibbonView {
  const run = input.update?.run;

  // THE DOWNLOAD OUTRANKS THE OFFER IT IS THE ANSWER TO (2026-09-12). Same row, same fact, one step
  // further on: this bundle is behind, and the new one is on its way in.
  if (input.bundleStale && input.bundleInstalling) return { kind: "bundle-installing" };

  // (f) — a terminal leg, named with its reason. No time window and no `finished` gate (M20/04): what
  // ends this branch is `settledAt`, the lead's own answer, stamped when the last leg went terminal.
  // A leg still MOVING is the update screen's business now, and no longer this row's.
  //
  // ONLY WHILE THE MEMBER IS STILL BEHIND. A leg's member that the census now shows level, typically
  // because it levelled itself after the run gave up on it, is not a machine the operator can do
  // anything about, so the sentence goes when the census says so (`readRun`'s `failed`).
  {
    const reading = readRun({ update: input.update, crew: input.crew, now: input.now });
    if (reading.failed !== null) {
      const reason = reading.failed.reason ?? t("settings.updateCard.peer.unknownReason");
      return {
        kind: "peer-failed",
        name: reading.failed.name,
        reason: truncateWords(reason, REASON_BUDGET),
        target: targetOf(input, run?.to ?? null),
      };
    }
  }

  // (c) — a stale bundle is the PWA row exactly as it has always been. Above (a) because it is the
  // same slot, and the tap reloads THIS PAGE onto a bundle that already exists.
  if (input.bundleStale) return { kind: "bundle" };

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
 * THE BAND'S URGENT LABEL, or null when no release in the delta asked for it (ADR 0046).
 *
 * The LABEL only. The release's own sentence is unbounded prose, and the band is one truncating row
 * held to forty characters, so the row says that there is a reason and the tap lands on the Updates
 * card, which prints the sentence whole. Same split the crew-link note takes, for the same reason.
 */
export function urgentBandNote(urgent: UpdateUrgent | null | undefined): string | null {
  return urgent === null || urgent === undefined ? null : t("updateRibbon.urgent");
}

/**
 * The band's one line. Separate from the component so the phrasing is testable without a DOM.
 *
 * `linkChange` and `urgent` each add ONE short note, and only to the offer states: those are the two
 * the operator reads before they confirm, which is the only moment a note can change what they do. A
 * run already in flight is past being told. Urgent goes first, because it is the reason to read the
 * row at all.
 */
export function ribbonText(
  view: RibbonView,
  linkChange: UpdateLinkChange | null = null,
  urgent: UpdateUrgent | null = null,
): string {
  const line = ribbonLine(view);
  if (view.kind !== "available" && view.kind !== "available-packaged") return line;
  const notes = [urgentBandNote(urgent), linkChangeBandNote(linkChange)].filter((n) => n !== null);
  return notes.length === 0 ? line : `${line} ${notes.join(" ")}`;
}

function ribbonLine(view: RibbonView): string {
  switch (view.kind) {
    case "silent":
      return "";
    case "bundle":
      return t("pwa.updateAvailable");
    case "bundle-installing":
      return t("pwa.updateInstalling");
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

// ── "THIS DEVICE STARTED IT" ────────────────────────────────────────────────────────────────────
//
// One fact, and it is the one that decides whether the app is locked. The update screen stamps this
// store on the way out of its own `POST /api/update`; it reads it back, takes the screen, and locks
// the app behind it for as long as the run is in flight.
//
// IT LIVES FOR THE LENGTH OF THE RUN, NOT FOR THE GAP BEFORE IT SPEAKS (M28/01), and since update
// mode (ADR 0064) it outlives the PAGE as well. The phone's own reload is the last step of an update:
// the page that tapped reloads onto the new app, and the document that boots must reopen the screen
// before its first paint, at the step it had reached. A module variable died with the document that
// set it, so the new one met a finished run it had never asked for, and the Done screen never came.
// So the claim is written to `sessionStorage` (this tab only: a second tab is a second device as far
// as this feature is concerned) and read back when this module loads, which is before React renders.
//
// It is spent in one place: the operator's "Back to the app" on the screen's last step
// (`hooks/use-update-screen.ts`), or at once by a failed POST, because nothing was started. A claim
// older than {@link CLAIM_MAX_AGE_MS} is thrown away on load rather than reopening a screen about a
// run nobody is watching.

/** Where the claim lives. Versioned, so a later shape can ignore this one rather than misread it. */
export const CLAIM_KEY = "collie:update-mode:v1";

/**
 * How old a claim may be when a document loads it. Longer than any run, crew and rate limit included
 * (ADR 0062 puts the worst at about 80 minutes), and short enough that a tab left open overnight
 * does not greet the operator with yesterday's update.
 */
export const CLAIM_MAX_AGE_MS = 3 * 60 * 60_000;

/** What this device asked for, as the screen needs it after a reload. */
export interface UpdateClaim {
  /** When the confirm was accepted, on this phone's clock. The screen's clock counts from here. */
  readonly startedAt: number;
  /** The 202's own run id, when the bridge sent one (M16/04). */
  readonly runId: string | null;
  /** The version the run goes to, or null when the ask did not name one. */
  readonly target: string | null;
  /** A run that moves only the members (M32). */
  readonly peersOnly: boolean;
  /** The build id of the bundle that tapped. A document with a different one has reloaded onto the
   *  new app, which is how the phone's own step knows it is done. */
  readonly bundleAtStart: string | null;
  /** Members the operator chose to stop waiting for ("Skip <name>"). */
  readonly skipped: readonly string[];
  /** This machine's name, and its members', as they were at the start. A document that boots with
   *  the claim draws the same rows before its first read answers, so the panel does not grow. */
  readonly lead: string | null;
  readonly members: readonly string[];
  /** The last step the screen showed, so a document that boots mid-run opens on it. */
  readonly lastPhase: string | null;
}

let claim: UpdateClaim | null = loadClaim();
const listeners = new Set<() => void>();

function loadClaim(): UpdateClaim | null {
  try {
    const raw = sessionStorage.getItem(CLAIM_KEY);
    if (raw === null) return null;
    // Parsed at the boundary: this key is written only by `saveClaim` below, but a hand-edited or
    // truncated value must read as no claim rather than as half of one.
    const parsed = parseJsonObject(raw);
    const startedAt = asJsonNumber(parsed?.startedAt);
    if (parsed === undefined || startedAt === undefined) return null;
    if (Date.now() - startedAt > CLAIM_MAX_AGE_MS) {
      sessionStorage.removeItem(CLAIM_KEY);
      return null;
    }
    const skipped = parsed.skipped;
    return {
      startedAt,
      runId: asJsonString(parsed.runId) ?? null,
      target: asJsonString(parsed.target) ?? null,
      peersOnly: asJsonBoolean(parsed.peersOnly) === true,
      bundleAtStart: asJsonString(parsed.bundleAtStart) ?? null,
      skipped: Array.isArray(skipped) ? skipped.flatMap((name) => asJsonString(name) ?? []) : [],
      lead: asJsonString(parsed.lead) ?? null,
      members: Array.isArray(parsed.members) ? parsed.members.flatMap((name) => asJsonString(name) ?? []) : [],
      lastPhase: asJsonString(parsed.lastPhase) ?? null,
    };
  } catch {
    // No storage (private mode, a locked-down embed): the claim lives for this document only, which
    // is what it did before update mode.
    return null;
  }
}

function saveClaim(next: UpdateClaim | null): void {
  claim = next;
  try {
    if (next === null) sessionStorage.removeItem(CLAIM_KEY);
    else sessionStorage.setItem(CLAIM_KEY, JSON.stringify(next));
  } catch {
    /* see loadClaim: the in-memory claim still holds for this document */
  }
  for (const listener of listeners) listener();
}

/**
 * The confirm was tapped and the POST was accepted. Safe to call on every attempt.
 *
 * `runId` is the 202's own run id when the bridge sent one (M16/04). It lets a later reading tell this
 * device's run from somebody else's newer one.
 */
export function noteUpdateStarted(
  at: number = Date.now(),
  runId: string | null = null,
  extra: {
    target?: string | null;
    peersOnly?: boolean;
    bundleAtStart?: string | null;
    lead?: string | null;
    members?: readonly string[];
  } = {},
): void {
  saveClaim({
    startedAt: at,
    runId,
    target: extra.target ?? null,
    peersOnly: extra.peersOnly ?? false,
    bundleAtStart: extra.bundleAtStart ?? null,
    skipped: [],
    lead: extra.lead ?? null,
    members: extra.members ?? [],
    lastPhase: null,
  });
}

/** The step the screen is on, kept with the claim for the next document. Written only on a change. */
export function noteClaimPhase(phase: string): void {
  if (claim === null || claim.lastPhase === phase) return;
  saveClaim({ ...claim, lastPhase: phase });
}

/** The operator chose "Skip <name>": stop waiting for that member. Kept with the claim, so a reload
 *  does not ask again. */
export function noteMemberSkipped(name: string): void {
  if (claim === null || claim.skipped.includes(name)) return;
  saveClaim({ ...claim, skipped: [...claim.skipped, name] });
}

/** The POST failed, or the operator left the screen's last step. Either way the claim is spent. */
export function clearUpdateStarted(): void {
  if (claim === null) return;
  saveClaim(null);
}

/** When this device started the run it is watching, or null. */
export function getUpdateStarted(): number | null {
  return claim?.startedAt ?? null;
}

/** The whole claim, or null. The same object until it changes, so it is safe as a store snapshot. */
export function getUpdateClaim(): UpdateClaim | null {
  return claim;
}

/** The run id this device consented to, when the 202 named one. */
export function getUpdateStartedRun(): string | null {
  return claim?.runId ?? null;
}

export function subscribeUpdateStarted(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
