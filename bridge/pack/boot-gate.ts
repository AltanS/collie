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
//   • **A PROVEN conflicting answer deposes it before it serves a byte** — the answer carries the
//     warrant (§18.10), the warrant verifies against this machine's own certificate, and because it
//     does, the deposition and RFC §8.3's self-heal happen in the SAME boot. A machine that was
//     merely down during a takeover therefore comes back up as a working peer, in one restart,
//     having published nothing in between. That is the common case, and it is the whole reason the
//     gate is at boot rather than at first conflict.
//   • **An UNPROVEN claim warns and publishes.** A member that merely reports a generation ahead of
//     this machine's, or refuses with `lead_conflict` and no warrant, or hands back a warrant that
//     does not verify here, is making a claim it cannot back. It is logged once, loudly, and the
//     lead keeps leading. See the deviation note below.
//   • **Silence from every member publishes anyway.** Fail-open on *no answer* is forced: the common
//     case for "nobody answered" is a lead rebooting first after a power cut, and a lead that refuses
//     to come up because its peers are still booting is an outage manufactured out of a safety check.
//
// ── DEVIATION FROM §18.11, AND WHY ───────────────────────────────────────────
// §18.11 as written deposes on a bare `warrantGeneration` higher than this machine's, and §18.12
// parks the result as *unverifiable*. A real pack showed what that costs. A peer left pack A while
// holding a generation-3 warrant, kept the fields, joined pack B, and the new lead's next boot read
// generation 3 > 0, parked itself `no-proof`, tore down its front door and went dark. Nothing had
// happened to the crown: one stale field on one machine took the pack offline, and recovery was by
// hand on two machines.
//
// So the rule here is narrower than the RFC's: **only a warrant that verifies against this machine's
// own certificate may depose it** — which is exactly §18.12's own "what counts as learning", applied
// at the gate instead of after it. An unproven claim is evidence of a misconfigured peer, not of a
// takeover, and the honest response is to say so and keep serving. Fail-closed on an unproven claim
// turns one peer's stale file into the pack's outage, which is a worse failure than the split brain
// it was guarding against: a split brain still serves the operator's phone from somewhere.
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
  /** The warrant generation this machine holds, or `0`. A member reporting a HIGHER one is a claim. */
  readonly generation: number;
  /** This pack's id, so a warrant stamped with another pack's is named as foreign rather than obeyed. */
  readonly packId: string;
  /**
   * Does this warrant depose THIS machine? `deposed.ts`'s `isDepositionProof`, injected — packId
   * match, `leadMemberId` is this machine, a deputy is named, the generation is not behind, and the
   * signature verifies against this collie's own certificate. Injected rather than imported because
   * the answer is a question about the trust store, and this module is a function of its arguments.
   */
  readonly verifies: (warrant: Warrant) => boolean;
}

/** The gate's answer. Exactly two, because there are exactly two things a boot may do. */
export type BootGateVerdict =
  /**
   * Nothing PROVED this machine wrong. Publish — and print `warnings`, once, so an operator whose
   * peer is claiming something it cannot back reads about it instead of discovering it.
   */
  | { readonly kind: "publish"; readonly warnings: readonly string[] }
  /**
   * A member handed back a warrant that verifies against this machine's own certificate. `proof` is
   * that warrant, and it is never `null`: a deposition without a proof is not a deposition here
   * (see the deviation note above), so RFC §8.3's self-heal always has something to work with.
   */
  | {
      readonly kind: "deposed";
      readonly proof: Warrant;
      readonly from: string;
      readonly reason: string;
    };

/**
 * Ask every member once, concurrently, and read the answers.
 *
 * **A proof deposes; everything else warns.** Two members can both contradict this machine — one
 * with the named `lead_conflict` body carrying a warrant that verifies, one merely reporting a
 * higher generation — and only the first is evidence. The round is collected in full (it is one
 * budget either way, `sweepPeers` runs it concurrently) so every unproven claim still reaches the
 * log, even when a proof was found.
 */
export async function runBootGate(deps: BootGateDeps): Promise<BootGateVerdict> {
  if (deps.links.length === 0) return { kind: "publish", warnings: [] };
  const outcomes = await sweepPeers(deps.links, (link) => deps.hello(link));

  const warnings: string[] = [];
  let deposed: BootGateVerdict | null = null;
  for (const link of deps.links) {
    const outcome = outcomes.get(link.memberId);
    if (outcome === undefined) continue;

    // The named answer of §18.10: this member follows somebody else, and it said so rather than
    // serving a request against a roster that disagrees with the caller.
    if (!outcome.ok && outcome.state === "conflicted") {
      const reason = `"${link.memberId}" follows lead "${outcome.leadMemberId}" (warrant generation ${outcome.warrantGeneration ?? 0})`;
      if (outcome.warrant !== null && deps.verifies(outcome.warrant)) {
        deposed ??= { kind: "deposed", proof: outcome.warrant, from: link.memberId, reason };
        continue;
      }
      warnings.push(conflictWarning(link.memberId, outcome.leadMemberId, outcome.warrant, deps.packId));
      continue;
    }

    // A member holding a generation this machine never minted. The counter lives on the lead and
    // never resets (§18.3), so a member ahead of its own lead has been told something by somebody
    // else — OR it is carrying a field out of a pack it used to belong to, which is the case that
    // took a real pack dark. It carries no warrant either way, so it is a claim and it is logged.
    const reported = outcome.ok ? outcome.value.warrantGeneration : null;
    if (reported !== null && reported > deps.generation) {
      warnings.push(
        `"${link.memberId}" reports warrant generation ${reported}, which this lead never minted; ` +
          "ignoring it. If that machine came from another pack, run `collie pack leave` there and re-join it.",
      );
    }
  }
  return deposed ?? { kind: "publish", warnings };
}

/**
 * The line for a member that refuses this lead but cannot prove it may.
 *
 * A warrant stamped with ANOTHER pack's id gets its own sentence, because it names the remedy: that
 * machine did not leave its old pack cleanly, and no amount of restarting this one will fix it.
 */
function conflictWarning(
  memberId: string,
  leadMemberId: string,
  warrant: Warrant | null,
  packId: string,
): string {
  const tail =
    "ignoring it and continuing to lead. Only a warrant this lead itself signed can depose it.";
  if (warrant === null) {
    return `"${memberId}" says it follows lead "${leadMemberId}", but sent no warrant to prove it; ${tail}`;
  }
  if (warrant.packId !== packId) {
    return (
      `"${memberId}" says it follows lead "${leadMemberId}" under a warrant for pack ` +
      `"${warrant.packId}", which is not this pack; ignoring it. That machine belongs to another ` +
      "pack. Run `collie pack leave` there, then re-join it."
    );
  }
  return `"${memberId}" says it follows lead "${leadMemberId}", but its warrant does not verify here; ${tail}`;
}
