import type { PackChange } from "./enrollment.ts";
import { isLeading } from "./enrollment.ts";
import { fingerprintOfCert } from "./identity.ts";
import type { LeadContactFacts } from "./lead-contact.ts";
import type { TrustedMember, TrustStoreData, Warrant } from "./trust-store.ts";
import { currentWarrant, verifyWarrantSignature } from "./warrant.ts";

// The deposed state and the self-heal that ends it (RFC §8, PACK_PROTOCOL.md §18.11–§18.12).
//
// **A former lead that learns the crown has moved stops being a lead, loudly** — and then, in the
// ordinary case, finishes its own demotion all the way to `peer` on materials both machines already
// hold: no SSH, no token, no operator step and, decisively, **no new trust**.
//
// ── WHAT COUNTS AS LEARNING (RFC §8.1) ───────────────────────────────────────
// Exactly one thing: a warrant of a generation at least as high as its own, naming a deputy other
// than nobody, **verified against its own certificate's public key**. A lead can verify its own
// signature, and that is the whole reason the warrant is signed by the lead rather than attested by
// the deputy: what deposes a machine is its own past consent handed back to it. Nothing else does —
// not a peer refusing it, not an unreachable roster, not a timeout.
//
// ── WHY AN AUTOMATIC TRANSITION IS ALLOWED HERE AT ALL ───────────────────────
// Three properties, all of which must hold or this must not ship (RFC §12, F11):
//   1. It is strictly privilege-DECREASING — `lead` (§8.5's "everything, on every member") to
//      `peer` (its own terminals and nothing else). A machine demoting ITSELF to the least
//      privileged role in the protocol is not an escalation under any reading.
//   2. It is driven by a proof the machine itself signed.
//   3. It creates no trust that did not exist before: the new lead's certificate is read out of
//      **this machine's own roster** and never off the wire, so a fingerprint is only ever a pin if
//      the certificate behind it was already held.
// `deposed.test.ts` asserts (1) and (3) as a privilege-decrease check on the healed store.
//
// PURE, like `enrollment.ts` and `warrant.ts`: every function here is a function of data. Nothing
// reads a clock, a disk or a request — the caller supplies `now` and the caller writes the store.

/** Which of RFC §8.3's three outcomes a deposed machine is in. `pack status` must name it. */
export type DeposedOutcome =
  /** The warrant verified and the roster held the deputy's certificate. Transitional. */
  | "healed"
  /** The proof did not verify, or the roster names no such certificate. **Terminal.** */
  | "parked-unverifiable"
  /** Healed, but the pack secret rotated while this machine was away (§8.4). **Terminal.** */
  | "parked-rotated";

/** Why a deposition could not become a self-heal. Local vocabulary; the wire says none of this. */
export type ParkReason =
  /** The warrant's signature does not verify against this machine's own certificate. */
  | "signature"
  /** No certificate in this machine's own roster matches the warrant's `deputyFingerprint`. */
  | "unknown-deputy"
  /** A conflict was reported but no warrant came with it, so there is nothing to verify. */
  | "no-proof";

/**
 * What a deposed collie is, as one value. Held in memory by the process that learned it (there is
 * nothing to persist beyond the trust store the self-heal already wrote) and read by the one page
 * this machine still serves and by the health check that must now fail.
 */
export interface DeposedState {
  readonly outcome: DeposedOutcome;
  /** The member that leads the pack now, or `null` when the proof never named one we could resolve. */
  readonly leadMemberId: string | null;
  /** The generation that deposed this machine. `0` when a conflict arrived with no warrant. */
  readonly generation: number;
  /** When this machine learned, on its own clock. */
  readonly at: number;
  /** The operator-facing pack name, for the page. */
  readonly packName: string | null;
  /** Why it parked, when it did. `null` on `healed`. */
  readonly reason: ParkReason | null;
}

/**
 * Is this warrant a proof that THIS machine has been deposed? (RFC §8.1.)
 *
 * Every clause is a question about material this collie already holds — its own certificate, its
 * own pack id, its own generation counter — so nothing here is decided by the caller.
 *
 * **Expiry is deliberately NOT a clause.** A warrant's 30 days gate what it may *arm* (RFC §4.5),
 * not what it *proves*: a machine that refused to believe an expired proof would keep leading a pack
 * that has already moved on, which is the split brain this whole section exists to close. Fail-open
 * on expiry here is fail-closed on the thing that matters.
 */
export function isDepositionProof(data: TrustStoreData, warrant: Warrant): boolean {
  if (data.pack === null || !isLeading(data)) return false;
  if (warrant.packId !== data.pack.packId) return false;
  if (warrant.leadMemberId !== data.self.memberId) return false;
  if (warrant.deputyMemberId === null || warrant.deputyFingerprint === null) return false;
  if (warrant.generation < (currentWarrant(data)?.warrant.generation ?? 0)) return false;
  return verifyWarrantSignature(warrant, data.self.certPem);
}

/** The self-heal's verdict: one committed transition, or a named terminal park. */
export type SelfHeal =
  | {
      readonly outcome: "healed";
      readonly change: PackChange<{ readonly lead: string; readonly generation: number }>;
    }
  | { readonly outcome: "parked"; readonly reason: ParkReason };

/**
 * RFC §8.3's four steps, minus the restart: resolve the new lead from **this machine's own roster**,
 * then rewrite the trust store as a peer's in one transition.
 *
 * Step 1 is the security property. The warrant names a *fingerprint*; the certificate behind it comes
 * off this machine's own disk, because a fingerprint is only a pin if the certificate was already
 * held. An attacker who could not forge a warrant before this feature cannot forge one now, and one
 * who can already holds the lead's private key — which is game over by §8.5's own account.
 *
 * **Why a failed proof parks rather than retries.** A warrant that does not verify is not a stale
 * message; it is a machine being told something by someone who cannot prove they may say it, and
 * retrying is how a refusal becomes a poll. A warrant naming a deputy this machine never enrolled is
 * either a hand-edited store or a pack it does not belong to. Either way the honest answer is to stop.
 */
export function selfHeal(data: TrustStoreData, warrant: Warrant | null): SelfHeal {
  if (warrant === null) return { outcome: "parked", reason: "no-proof" };
  if (!isDepositionProof(data, warrant)) return { outcome: "parked", reason: "signature" };
  if (data.pack === null) return { outcome: "parked", reason: "signature" };

  // Step 1 — the new lead comes out of the roster this machine already pinned, never off the wire.
  const deputy = data.peers.find(
    (p) => p.memberId === warrant.deputyMemberId && fingerprintOfCert(p.certPem) === warrant.deputyFingerprint,
  );
  if (deputy === undefined) return { outcome: "parked", reason: "unknown-deputy" };

  // Step 2 — one write. The pack identity, the pack secret, this collie's own member id and its own
  // key material are ALL untouched: §14.5's "a role change, not a re-enrollment", reached from the
  // other direction. `signedAt` is carried over rather than reset, because §8.6's replay floor is
  // per member and must never walk backwards on a role change.
  const lead: TrustedMember = {
    ...deputy,
    role: "lead",
    status: "enrolled",
    secretGeneration: data.pack.secretGeneration,
    // Provisional until this machine is actually dialled by it, exactly as `adoptLead` marks a
    // newly-pinned lead. It is not a claim about contact; it is the absence of one.
    contactedAt: null,
  };
  return {
    outcome: "healed",
    change: {
      next: {
        ...data,
        lead,
        // A peer has no peers (§4), and a store holding both resolves to the conflict mode.
        peers: [],
        // A consent minted here is void the instant this machine stops being the lead — the same
        // reason `demoteSelf` spends it in the transition rather than beside it.
        pendingHandover: null,
        // The operator's designation belonged to this machine AS THE LEAD. It leads nothing now, so
        // it designates nobody; the warrant below still carries the generation counter.
        deputy: null,
        // The proof becomes the warrant this collie holds, which is what advances the generation so
        // an older one can never be replayed at it (RFC §4.4). The deputy's certificate comes from
        // the roster entry that was just verified against the fingerprint — the same bytes, checked.
        warrant: { warrant, deputyCertPem: deputy.certPem },
      },
      result: { lead: lead.memberId, generation: warrant.generation },
      audit: {
        action: "pack.deposed",
        detail: { lead: lead.memberId, generation: warrant.generation, outcome: "healed" },
      },
    },
  };
}

/**
 * The state to hold after one deposition attempt. `selfHeal`'s two outcomes, plus the facts the page
 * needs.
 */
export function deposedStateFrom(
  data: TrustStoreData,
  warrant: Warrant | null,
  heal: SelfHeal,
  now: number,
): DeposedState {
  return {
    outcome: heal.outcome === "healed" ? "healed" : "parked-unverifiable",
    leadMemberId: heal.outcome === "healed" ? heal.change.result.lead : (warrant?.deputyMemberId ?? null),
    generation: warrant?.generation ?? 0,
    at: now,
    packName: data.pack?.name ?? null,
    reason: heal.outcome === "healed" ? null : heal.reason,
  };
}

/**
 * RFC §8.3's third outcome, and it is reached **after** the heal rather than at it.
 *
 * At the instant a takeover commits the secret is unchanged (§14.5 reuses it), so nothing at heal
 * time can tell that a rotation is coming. What tells the returning machine is §8.4's own mechanics
 * running their course: the new lead rotated while it was away, marked it `unenrolled`, and now
 * dials it with a secret it does not hold — so the lead is **identified and refused on the second
 * factor**, over and over. That refusal is the signal, and `lead-contact.ts` records it.
 *
 * It is named rather than mistaken for a failure: this is not "unreachable" (§10.2's three states are
 * not to be conflated) and it is not a self-heal that went wrong. The remedy is `collie join`.
 */
export function strandedByRotation(state: DeposedState, facts: LeadContactFacts): boolean {
  if (state.outcome !== "healed") return false;
  return facts.leadRefusedSecretAt !== null && facts.leadRefusedSecretAt >= state.at;
}

/** {@link DeposedState} with {@link strandedByRotation} applied — the outcome as of `now`. */
export function outcomeNow(state: DeposedState, facts: LeadContactFacts): DeposedOutcome {
  return strandedByRotation(state, facts) ? "parked-rotated" : state.outcome;
}

// ── What a deposed collie SERVES ─────────────────────────────────────────────

/**
 * The path a failover proxy health-checks (RFC §14.2), answered here so a deposed machine can fail
 * it. It is the same path the standby door answers on a deputy — one name for one question ("should
 * anything route here?"), asked of both backends behind one hostname.
 */
export const STANDBY_HEALTH_PATH = "/standby/health";

/**
 * A deposed collie's whole browser surface: **one page, at every path, at `200`, and a health check
 * that FAILS** (RFC §8.2).
 *
 * The asymmetry is deliberate and is the property this state exists for. A proxy asking whether to
 * route here deserves a refusal — that is what stops the operator's phone being swung back onto a
 * machine with a stale roster, *before* anybody notices. A human who reaches the page deserves an
 * answer, so they get a sentence rather than a 503 they have to interpret.
 *
 * **`text/plain`, not HTML.** The page interpolates an operator-typed pack name and a member id onto
 * a surface a browser will render; plain text has no markup, so there is no escaping question to get
 * wrong on a machine that is already in a degraded state. A route that cannot be mis-gated is ADR
 * 0013's own argument, applied one layer down.
 *
 * The front door is NOT torn down here (RFC §8.2): `tailscale serve` is a publishing act owned by
 * `collie serve`/`unserve` and by the operator of THIS machine (ADR 0001), who may be elsewhere.
 * Failing the health check is what makes the un-torn-down door harmless in the meantime, and the page
 * names the command.
 */
export function deposedPage(state: DeposedState, outcome: DeposedOutcome): string {
  const pack = state.packName === null ? "this pack" : `"${state.packName}"`;
  const lead = state.leadMemberId === null ? "another machine" : `"${state.leadMemberId}"`;
  const when = new Date(state.at).toISOString();
  const lines = [
    `This machine was the lead of pack ${pack} until ${when}.`,
    `The pack is now led by ${lead} (warrant generation ${state.generation}).`,
    "Nothing here is live.",
    "",
    ...outcomeLines(state, outcome),
    "",
    "Its front door is still published — run `collie unserve` on this machine to take it down.",
  ];
  return `${lines.join("\n")}\n`;
}

/** The one paragraph that differs per outcome, so a human never has to guess what is expected. */
function outcomeLines(state: DeposedState, outcome: DeposedOutcome): string[] {
  if (outcome === "healed") {
    return [
      "This machine has rejoined the pack as a peer. It takes effect at its next restart —",
      "run `herdr plugin action invoke restart --plugin herdr.collie` here. Nothing else is needed:",
      "the new lead already dials this machine, and its agents reappear on its first sweep.",
    ];
  }
  if (outcome === "parked-rotated") {
    return [
      "This machine demoted itself correctly, but the pack secret was rotated while it was away,",
      "so it is no longer enrolled. Re-join it with a fresh token: `collie join <lead> <token>`.",
    ];
  }
  return [
    `This machine could not rejoin by itself (${parkText(state.reason)}).`,
    "Recover it with `collie pack add` from the new lead, or `collie join` with a fresh token.",
  ];
}

function parkText(reason: ParkReason | null): string {
  if (reason === "unknown-deputy") return "its roster holds no certificate matching the warrant";
  if (reason === "no-proof") return "the conflict arrived with no warrant to verify";
  return "the warrant did not verify against this machine's own certificate";
}

/**
 * The deposed answer for one request, or `null` when this collie is not deposed.
 *
 * Mounted in `bridge/server.ts` **after** the pack surface and before everything else: `/pack/v1/*`
 * keeps answering, because the new lead must still be able to reach a machine it has just deposed
 * (RFC §8.1, path 1), while the app, the PWA and `/api/*` are gone.
 */
export function deposedAnswer(state: DeposedState, outcome: DeposedOutcome, url: URL): Response {
  if (url.pathname === STANDBY_HEALTH_PATH) {
    return new Response(JSON.stringify({ state: "deposed", outcome }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(deposedPage(state, outcome), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
