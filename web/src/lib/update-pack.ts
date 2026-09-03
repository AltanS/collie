import { t } from "./i18n";
import type {
  UpdatePackMember,
  UpdatePackVerdict,
  UpdatePeerLeg,
  UpdateRunState,
} from "./types";

// ── THE PACK, AS THE UPDATES PAGE READS IT ──────────────────────────────────────────────────────
//
// Pure functions only, so the ordering, the counting and the four status lines are pinned by unit
// tests rather than by pulling a card apart in the DOM. Two sources feed them and they never
// disagree, because one outranks the other by rule: while a run is in flight the peer's own LEG
// (M16/04) is the fresher fact, and the moment there is no leg the census row (M16/03) is what is
// left. Both are optional on the wire — a solo install and an older bridge send neither, and the
// answer there is an empty list, which is the same screen with no rows on it.
//
// Nothing here decides anything about the pack. It reads what the lead reported and puts the row
// that needs a look at the top.

/** The run states that are somebody still driving it. Mirrors the card's own set. */
const IN_FLIGHT: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "preflight",
  "staging",
  "restarting",
  "verifying",
]);

/** The run states that are a leg having gone wrong. `rolled-back` must carry its reason. */
const FAILED: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "rolled-back",
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
function rankOfVerdict(verdict: UpdatePackVerdict): number {
  if (verdict === "red") return 1;
  if (verdict === "unknown") return 2;
  if (verdict === "amber") return 3;
  return 5;
}

function rankOfState(state: UpdateRunState): number {
  if (FAILED.has(state)) return 0;
  if (IN_FLIGHT.has(state)) return 4;
  return 5;
}

/** The word a run state prints on a peer row — short, because it sits in a `·`-joined line. */
export function peerStateWord(state: UpdateRunState): string {
  switch (state) {
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
    case "stuck":
      return t("settings.updateCard.peer.state.stuck");
    case "interrupted":
      return t("settings.updateCard.peer.state.interrupted");
    case "idle":
      return t("settings.updateCard.peer.state.idle");
  }
}

/** The word a census verdict prints. `unknown` has its own word and is never drawn as green. */
export function peerVerdictWord(verdict: UpdatePackVerdict): string {
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
export function peerRows(pack: UpdatePackMember[] = [], legs: UpdatePeerLeg[] = []): PeerRow[] {
  const byName = new Map<string, PeerRow>();

  for (const member of pack) {
    const bad = member.verdict === "red" || member.verdict === "unknown";
    const stated = member.reasons.join(" · ");
    byName.set(member.name, {
      name: member.name,
      version: member.version,
      word: peerVerdictWord(member.verdict),
      // An unknown with no reason still says why in plain words: the lead asked and heard nothing.
      // A row that says "unknown" and nothing else is the row that reads as fine.
      reason: bad ? stated || t("settings.updateCard.peer.unknownReason") : null,
      asOf: member.asOf,
      rank: rankOfVerdict(member.verdict),
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
export function peersBehind(pack: UpdatePackMember[] = [], current: string): number {
  if (current === "") return 0;
  return pack.filter((m) => m.version !== null && m.version !== current).length;
}

/** A peer that tried and rolled back is the case "Retry pack update" exists for. */
export function peersRolledBack(legs: UpdatePeerLeg[] = []): number {
  return legs.filter((leg) => FAILED.has(leg.state)).length;
}

/** Which of the three labels the page's one action button carries. */
export type PackAction = "update-pack" | "update" | "retry-pack" | "none";

/**
 * The single action button, decided once from the whole picture.
 *
 * The order is the operator's order: if there is a release to take, taking it is the action, and
 * whether it covers peers is a fact about this pack rather than a second choice. Only once this
 * machine is current does a peer left behind become the thing the button is for.
 */
export function packAction(a: {
  releaseAvailable: boolean;
  hasPeers: boolean;
  behind: number;
  rolledBack: number;
}): PackAction {
  if (a.releaseAvailable) return a.hasPeers ? "update-pack" : "update";
  if (a.behind > 0 || a.rolledBack > 0) return "retry-pack";
  return "none";
}

/** The label for that button. `none` never renders, so it has no label to give. */
export function packActionLabel(action: Exclude<PackAction, "none">, version: string): string {
  if (action === "retry-pack") return t("settings.updateCard.retryPack");
  if (action === "update-pack") return t("settings.updateCard.actionPack", { version });
  return t("settings.updateCard.action", { version });
}
