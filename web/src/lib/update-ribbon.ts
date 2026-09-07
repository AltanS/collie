import { t, tn } from "./i18n";
import type {
  DismissScope,
  UpdateInfo,
  UpdatePeerLeg,
  UpdatePeerLegState,
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

/** The run states that are somebody still driving it. Mirrors the card's own set. */
const IN_FLIGHT: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "preflight",
  "staging",
  "restarting",
  "verifying",
]);

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
  | { kind: "peers"; names: string[]; target: string | null }
  | { kind: "package-managed"; names: string[]; target: string | null }
  | { kind: "peer-failed"; name: string; reason: string }
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
  /** The version whose quiet PACK notice was closed (`update.dismissedPackVersion`). A separate
   *  decision, so a separate input — see {@link DismissScope}. */
  dismissedPackVersion: string | null;
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
 * operator can no longer see the end of" — so they carry no close. An offer and the two QUIET pack
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
      return view.target === null ? null : { scope: "pack", version: view.target };
    default:
      return null;
  }
}

/** The version the quiet pack states are keyed by: what the run is heading for when a record names
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
  if (run !== undefined && IN_FLIGHT.has(run.state)) {
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

  // (d) — the lead is done and the pack is not.
  if (finished) {
    const legs = run.peers ?? [];
    const failed = legs.find((leg) => PEER_FAILED.has(leg.state));
    if (failed !== undefined) {
      const reason = failed.reason ?? t("settings.updateCard.peer.unknownReason");
      return { kind: "peer-failed", name: failed.name, reason: truncateWords(reason, REASON_BUDGET) };
    }
    const target = targetOf(input, run.to);
    const quiet = target !== null && target === input.dismissedPackVersion;
    const moving = legs.filter(isMoving).map((leg) => leg.name);
    // A moving peer is undismissable, so its target is null however the pack was closed before: the
    // operator must be able to see the end of a run somebody is still driving.
    if (moving.length > 0) return { kind: "peers", names: moving, target: null };
    // Below the moving peers, never among them: the band's peers line is about what the run is
    // waiting on, and it is waiting on nothing here. Named anyway, so the operator learns why that
    // machine did not move without opening the page to find out — and closable, because a machine
    // a package manager owns can stand behind for weeks and a band nobody can put down is a nag.
    const managed = legs.filter((leg) => leg.state === "package-managed").map((leg) => leg.name);
    if (managed.length > 0 && !quiet) return { kind: "package-managed", names: managed, target };
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

/** The band's one line. Separate from the component so the phrasing is testable without a DOM. */
export function ribbonText(view: RibbonView): string {
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
    case "peers":
      return tn("updateRibbon.peers", view.names.length, { names: view.names.join(", ") });
    case "package-managed":
      return tn("updateRibbon.packageManaged", view.names.length, { names: view.names.join(", ") });
    case "peer-failed":
      return `${t("updateRibbon.peerRolledBack", { name: view.name, reason: view.reason })} ${t("updateRibbon.seeUpdates")}`;
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
