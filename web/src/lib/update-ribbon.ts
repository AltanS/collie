import { t, tn } from "./i18n";
import type { UpdateInfo, UpdatePeerLeg, UpdateRunState } from "./types";

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
const PEER_FAILED: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "rolled-back",
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
  | { kind: "peers"; names: string[] }
  | { kind: "peer-failed"; name: string; reason: string }
  | { kind: "available"; version: string };

/** Everything the reading needs. Two of the four are client facts; the other two are the poll. */
export interface RibbonInput {
  /** The snapshot's update block. Absent on an older bridge, which reads as "nothing to say". */
  update: UpdateInfo | undefined;
  /** When THIS tab posted the confirm, or null if it has not. State (s) is nothing but this. */
  startedAt: number | null;
  /** `useSelfUpdate()`'s banner flag — see the header. Never re-derived here. */
  bundleStale: boolean;
  /** The version whose offer the operator dismissed. A newer one is a different version. */
  dismissedVersion: string | null;
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

/** A leg nobody has finished. Written as "not done and not failed" rather than as a set of moving
 *  states, so a state this client has never heard of still counts as moving instead of vanishing. */
function isMoving(leg: UpdatePeerLeg): boolean {
  return leg.state !== "done" && !PEER_FAILED.has(leg.state);
}

/** Cut on a word boundary, never mid-word, and mark the cut. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const head = space > 0 ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
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
    const moving = legs.filter(isMoving).map((leg) => leg.name);
    if (moving.length > 0) return { kind: "peers", names: moving };
  }

  // (a) — an offer, and only an offer. The tap navigates; nothing here starts anything.
  const latest = input.update?.latest ?? null;
  if (input.update?.releaseAvailable === true && latest !== null && latest !== input.dismissedVersion) {
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
    case "peer-failed":
      return `${t("updateRibbon.peerRolledBack", { name: view.name, reason: view.reason })} ${t("updateRibbon.seeUpdates")}`;
    case "available":
      return t("updateRibbon.available", { version: view.version });
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
