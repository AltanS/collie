import { t } from "./i18n";
import type {
  UpdateCrewMember,
  UpdateCrewVerdict,
  UpdatePeerLeg,
  UpdatePeerLegState,
} from "./types";

// ── THE CREW, AS THE UPDATES PAGE READS IT ──────────────────────────────────────────────────────
//
// Pure functions only, so the ordering, the counting and the four status lines are pinned by unit
// tests rather than by pulling a card apart in the DOM. Two sources feed them and they never
// disagree, because one outranks the other by rule: while a run is in flight the peer's own LEG
// (M16/04) is the fresher fact, and the moment there is no leg the census row (M16/03) is what is
// left. Both are optional on the wire — a solo install and an older bridge send neither, and the
// answer there is an empty list, which is the same screen with no rows on it.
//
// Nothing here decides anything about the crew. It reads what the lead reported and puts the row
// that needs a look at the top.

/** The leg states that are somebody still driving it. `updating` is the lead's own word for all
 *  four of the run states it cannot tell apart across the link (M16/04). */
const IN_FLIGHT: ReadonlySet<UpdatePeerLegState> = new Set<UpdatePeerLegState>([
  "updating",
  "preflight",
  "staging",
  "restarting",
  "verifying",
]);

/** The leg states that are a leg having gone wrong. `rolled-back` must carry its reason. */
const FAILED: ReadonlySet<UpdatePeerLegState> = new Set<UpdatePeerLegState>([
  "rolled-back",
  "unreachable",
  "stuck",
  "interrupted",
]);

/** One line in the card's peer list: name · version · verdict-or-state · reason when it is bad. */
export interface PeerRow {
  name: string;
  /** The version that peer runs, or null when nobody could learn it. */
  version: string | null;
  /** The third column, already resolved to the word the row prints. */
  word: string;
  /** Printed only when the row is red, unknown or a failed leg. Null on every other row. */
  reason: string | null;
  /** When the fact was taken (epoch ms), or null when the source carried no stamp. */
  asOf: number | null;
  /** Worst first: 0 is the row the operator has to read. Exported so the test can name it. */
  rank: number;
  /** True while this peer is moving — the row draws a spinner rather than a dot. */
  inFlight: boolean;
}

/** How loudly a row asks to be read. Lower sorts first. */
function rankOfVerdict(verdict: UpdateCrewVerdict): number {
  if (verdict === "red") return 1;
  if (verdict === "unknown") return 2;
  if (verdict === "amber") return 3;
  return 5;
}

function rankOfState(state: UpdatePeerLegState): number {
  if (FAILED.has(state)) return 0;
  if (IN_FLIGHT.has(state)) return 4;
  // `package-managed` lands here with `done`: neutral weight, bottom of the list. It is a state, not
  // a failure — nothing is wrong with a machine whose package manager owns it (ADR 0035).
  return 5;
}

/** The word a run state prints on a peer row — short, because it sits in a `·`-joined line. */
export function peerStateWord(state: UpdatePeerLegState): string {
  switch (state) {
    case "waiting":
      return t("settings.updateCard.peer.state.waiting");
    case "updating":
      return t("settings.updateCard.peer.state.updating");
    case "unreachable":
      return t("settings.updateCard.peer.state.unreachable");
    case "preflight":
      return t("settings.updateCard.peer.state.preflight");
    case "staging":
      return t("settings.updateCard.peer.state.staging");
    case "restarting":
      return t("settings.updateCard.peer.state.restarting");
    case "verifying":
      return t("settings.updateCard.peer.state.verifying");
    case "done":
      return t("settings.updateCard.peer.state.done");
    case "rolled-back":
      return t("settings.updateCard.peer.state.rolledBack");
    case "package-managed":
      return t("settings.updateCard.peer.state.packageManaged");
    case "stuck":
      return t("settings.updateCard.peer.state.stuck");
    case "interrupted":
      return t("settings.updateCard.peer.state.interrupted");
    case "idle":
      return t("settings.updateCard.peer.state.idle");
  }
}

/** The word a census verdict prints. `unknown` has its own word and is never drawn as green. */
export function peerVerdictWord(verdict: UpdateCrewVerdict): string {
  switch (verdict) {
    case "green":
      return t("settings.updateCard.peer.verdict.green");
    case "amber":
      return t("settings.updateCard.peer.verdict.amber");
    case "red":
      return t("settings.updateCard.peer.verdict.red");
    case "unknown":
      return t("settings.updateCard.peer.verdict.unknown");
  }
}

/**
 * The card's peer lines, worst first.
 *
 * A leg outranks a census row for the same machine: while the peer is moving, "updating" is the
 * true third column and its six-hour-old preflight verdict is not. A name that appears only as a
 * leg still gets a row — a peer the census missed but the run is driving is exactly the row nobody
 * may lose.
 */
export function peerRows(crew: UpdateCrewMember[] = [], legs: UpdatePeerLeg[] = []): PeerRow[] {
  const byName = new Map<string, PeerRow>();

  for (const member of crew) {
    const bad = member.verdict === "red" || member.verdict === "unknown";
    const stated = member.reasons.join(" · ");
    // A packaged member says what it is WAITING ON rather than what its preflight thought. Its
    // preflight is green by design, and "green" on that row would read as "about to move".
    const managed = member.installKind === "packaged";
    byName.set(member.name, {
      name: member.name,
      version: member.version,
      word: managed ? peerStateWord("package-managed") : peerVerdictWord(member.verdict),
      // An unknown with no reason still says why in plain words: the lead asked and heard nothing.
      // A row that says "unknown" and nothing else is the row that reads as fine.
      reason: bad && !managed ? stated || t("settings.updateCard.peer.unknownReason") : null,
      asOf: member.asOf,
      rank: managed ? rankOfState("package-managed") : rankOfVerdict(member.verdict),
      inFlight: false,
    });
  }

  for (const leg of legs) {
    const census = byName.get(leg.name);
    const failed = FAILED.has(leg.state);
    byName.set(leg.name, {
      name: leg.name,
      version: leg.version ?? census?.version ?? null,
      word: peerStateWord(leg.state),
      reason: failed ? (leg.reason ?? t("settings.updateCard.peer.unknownReason")) : null,
      asOf: leg.updatedAt ?? census?.asOf ?? null,
      rank: rankOfState(leg.state),
      inFlight: IN_FLIGHT.has(leg.state),
    });
  }

  return [...byName.values()].toSorted((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/**
 * How many peers are not on the version this lead runs. A peer whose version nobody could learn is
 * NOT counted behind — an unknown is reported as unknown on its own row, and inflating a count with
 * it would send the operator to a button that cannot help.
 */
export function peersBehind(crew: UpdateCrewMember[] = [], current: string): number {
  if (current === "") return 0;
  // A packaged member is left out for the same reason an unknown is: the operator cannot clear it
  // from here. The tap the count sends them to refuses on that machine (ADR 0035), so counting it
  // would be a nag with no button behind it. Its row still says what it is waiting on.
  return crew.filter((m) => m.installKind !== "packaged" && m.version !== null && m.version !== current).length;
}

/** A peer that tried and rolled back is the case "Retry crew update" exists for. */
export function peersRolledBack(legs: UpdatePeerLeg[] = []): number {
  return legs.filter((leg) => FAILED.has(leg.state)).length;
}

/** Which of the three labels the page's one action button carries. */
export type CrewAction = "update-crew" | "update" | "retry-crew" | "none";

/**
 * The single action button, decided once from the whole picture.
 *
 * The order is the operator's order: if there is a release to take, taking it is the action, and
 * whether it covers peers is a fact about this crew rather than a second choice. Only once this
 * machine is current does a peer left behind become the thing the button is for.
 *
 * **`leadCanTake` YIELDS the release branch to the peers, and only when there are peers to yield
 * it to.** A packaged install never takes a release from the phone (ADR 0035) — but levelling
 * the peers is a different act, and it still works: the run pushes the build this lead ALREADY
 * runs, which is why the bridge decides the peers-only start ABOVE its own packaged refusal
 * (`bridge/update-action.ts`). Without this, the release short-circuit reached `update-crew`, the
 * card disabled it, and a packaged lead with a peer a version behind had no working button at all.
 *
 * The branch is skipped, never relabelled: `update-crew` means "this machine and then the peers",
 * and a tap that quietly did half of that would be the button saying one thing and doing another.
 *
 * And it is skipped only when `behind`/`rolledBack` says a peers-only run has something to do.
 * With no peer to level, the disabled release button is the card's ONLY way to say that a release
 * exists and this machine is not the one that takes it — dropping it would answer a real question
 * with a blank space.
 */
export function crewAction(a: {
  releaseAvailable: boolean;
  hasPeers: boolean;
  behind: number;
  rolledBack: number;
  /** False when this machine cannot take a release itself. Absent ⇒ it can, the ordinary install. */
  leadCanTake?: boolean;
}): CrewAction {
  const peersNeedLevelling = a.behind > 0 || a.rolledBack > 0;
  // `a.hasPeers` is asserted here rather than assumed. Today `behind`/`rolledBack` can only be
  // nonzero when there IS a peer to count, because the one caller derives all three from the same
  // census — but that is an invariant of the caller, not of this function, and a future caller that
  // computed them from a different source would otherwise see `crewAction` yield to peers that do
  // not exist.
  const yieldToPeers = a.hasPeers && a.leadCanTake === false && peersNeedLevelling;
  if (a.releaseAvailable && !yieldToPeers) return a.hasPeers ? "update-crew" : "update";
  if (peersNeedLevelling) return "retry-crew";
  return "none";
}

/** The label for that button. `none` never renders, so it has no label to give. */
export function crewActionLabel(action: Exclude<CrewAction, "none">, version: string): string {
  if (action === "retry-crew") return t("settings.updateCard.retryCrew");
  if (action === "update-crew") return t("settings.updateCard.actionCrew", { version });
  return t("settings.updateCard.action", { version });
}
