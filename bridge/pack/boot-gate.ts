import { sweepPeers, type HelloResult, type PackLink, type PeerOutcome } from "./peer-client.ts";
import type { Warrant } from "./trust-store.ts";

// The boot-time gate against a split brain (RFC §8.4, PACK_PROTOCOL.md §18.11).
//
// ── THE FAILURE THIS CLOSES ──────────────────────────────────────────────────
// The old lead was down during a takeover, so nobody could tell it anything. It comes back up hours
// later, reads a trust store that still says `lead`, publishes, answers the failover proxy's health
// check with `200` — and the proxy swings the operator's phone back onto a machine with a stale
// roster and no knowledge of what happened since.
//
// So: **a collie booting into `lead` mode with a non-empty roster asks its members before it
// publishes anything.** One concurrent round, on §10.4's patient budget, once.
//
//   • **A conflicting answer deposes it before it serves a byte** — and because the answer carries
//     the warrant (§18.10), the deposition and RFC §8.3's self-heal happen in the SAME boot. A
//     machine that was merely down during a takeover therefore comes back up as a working peer, in
//     one restart, having published nothing in between. That is the common case, and it is the whole
//     reason the gate is at boot rather than at first conflict.
//   • **Silence from every member publishes anyway.** Fail-open on *no answer* is forced: the common
//     case for "nobody answered" is a lead rebooting first after a power cut, and a lead that refuses
//     to come up because its peers are still booting is an outage manufactured out of a safety check.
//     Fail-closed on a *conflicting answer* is the point: an answer is evidence, silence is not.
//
// **This is not a peer-side timer and it is not an election.** It arms nothing, it repeats never, and
// it changes no state on any machine it asks — §15's non-goal is untouched. It is boot-only: search
// this file for `setInterval`/`setTimeout`, the absence is the feature.

export interface BootGateDeps {
  /** The members to ask — this lead's own enrolled roster, as links. Empty ⇒ nothing is asked. */
  readonly links: readonly PackLink[];
  /**
   * `PeerClient.hello`, on the patient budget (§10.4). Injected for the reason every other pack
   * transport is: the decision has to be exercisable without a socket.
   */
  readonly hello: (link: PackLink) => Promise<PeerOutcome<HelloResult>>;
  /** The warrant generation this machine holds, or `0`. A member reporting a HIGHER one is evidence. */
  readonly generation: number;
}

/** The gate's answer. Exactly two, because there are exactly two things a boot may do. */
export type BootGateVerdict =
  /** Nothing contradicted this machine. Publish. */
  | { readonly kind: "publish" }
  /**
   * A member contradicted it. `proof` is the warrant that came with the answer, or `null` when the
   * contradiction was only a higher generation — which deposes just the same (RFC §8.4) but cannot
   * be self-healed, because there is nothing to verify (RFC §8.3's *parked — unverifiable*).
   */
  | {
      readonly kind: "deposed";
      readonly proof: Warrant | null;
      readonly from: string;
      readonly reason: string;
    };

/**
 * Ask every member once, concurrently, and read the answers.
 *
 * **An answer with a proof beats one without.** Two members can both contradict this machine — one
 * with the named `lead_conflict` body carrying the warrant, one merely reporting a higher generation
 * — and taking the first would turn a healable deposition into a parked one for no reason but arrival
 * order. So the round is collected in full (it is one budget either way, `sweepPeers` runs it
 * concurrently) and the strongest evidence is what the boot acts on.
 */
export async function runBootGate(deps: BootGateDeps): Promise<BootGateVerdict> {
  if (deps.links.length === 0) return { kind: "publish" };
  const outcomes = await sweepPeers(deps.links, (link) => deps.hello(link));

  let weak: BootGateVerdict | null = null;
  for (const link of deps.links) {
    const outcome = outcomes.get(link.memberId);
    if (outcome === undefined) continue;

    // The named answer of §18.10: this member follows somebody else, and it said so rather than
    // serving a request against a roster that disagrees with the caller.
    if (!outcome.ok && outcome.state === "conflicted") {
      const reason = `"${link.memberId}" follows lead "${outcome.leadMemberId}" (warrant generation ${outcome.warrantGeneration ?? 0})`;
      if (outcome.warrant !== null) return { kind: "deposed", proof: outcome.warrant, from: link.memberId, reason };
      weak ??= { kind: "deposed", proof: null, from: link.memberId, reason };
      continue;
    }

    // A member holding a generation this machine never minted. The counter lives on the lead and
    // never resets (§18.3), so a member ahead of its own lead has been told something by somebody
    // else — which is a conflict even though this answer carries no warrant to prove it.
    const reported = outcome.ok ? outcome.value.warrantGeneration : null;
    if (reported !== null && reported > deps.generation) {
      weak ??= {
        kind: "deposed",
        proof: null,
        from: link.memberId,
        reason: `"${link.memberId}" holds warrant generation ${reported}, ahead of this machine's ${deps.generation}`,
      };
    }
  }
  return weak ?? { kind: "publish" };
}
