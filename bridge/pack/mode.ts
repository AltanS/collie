import type { PackMode } from "../types.ts";

// The mode seam. PACK_PROTOCOL.md §3: "A collie runs in exactly one mode, decided by its enrollment
// state, not by a flag the operator maintains by hand." Everything federation-shaped hangs off the
// value this file computes, so "does a solo user pay for this?" is answerable by reading one file
// instead of auditing a feature.
//
// This module is PURE. It reads no filesystem, no environment and no clock — the trust store
// (M4/02) is the sole source of enrollment, and it is handed in. That is not stylistic: it is what
// makes the zero-tax gate checkable, because a solo instance's mode is computed from `null` and
// therefore cannot touch a byte of disk (PACK_PROTOCOL.md §11, "Files written": no key, no
// certificate, no trust store, no roster).

export type { PackMode };

/** One enrolled member as the trust store records it. Widened by M4/02; only the id matters here. */
export interface EnrolledMember {
  /** The member id minted by the lead — `[a-z0-9][a-z0-9-]{0,62}` (PACK_PROTOCOL.md §4). */
  readonly memberId: string;
}

/**
 * The enrollment state this collie persists, as read from the trust store (M4/02).
 *
 * `null` — the value a solo instance always produces — means *no trust store exists at all*, which
 * is a different statement from "a trust store that happens to be empty". Both resolve to `solo`;
 * only the first is the untaxed, nothing-was-ever-written case.
 */
export interface Enrollment {
  /** Peers this collie has enrolled, i.e. members it leads. Empty on a peer and on a solo lead. */
  readonly peers: readonly EnrolledMember[];
  /** The lead that enrolled this collie, or `null` if nobody has. */
  readonly lead: EnrolledMember | null;
}

/**
 * The resolved mode plus, when the enrollment state is self-contradictory, a one-line explanation
 * fit for `pack status` and a startup warning.
 *
 * A conflict is never silent and never fatal: the bridge must still come up, because a peer's own
 * operator is not to be locked out of their own machine by a bad roster (spec requirement, "A peer
 * that cannot reach its lead keeps working locally").
 */
export interface ModeResolution {
  readonly mode: PackMode;
  /** `null` when the enrollment state is coherent. */
  readonly conflict: string | null;
}

/**
 * Derive the mode from enrollment state. The whole decision table:
 *
 * | Enrollment                        | Mode   |
 * |-----------------------------------|--------|
 * | no trust store (`null`)           | `solo` |
 * | trust store, no lead, no peers    | `solo` |
 * | trust store, no lead, ≥1 peer     | `lead` |
 * | trust store, a lead, no peers     | `peer` |
 * | trust store, a lead AND ≥1 peer   | `peer` + conflict |
 *
 * **v1 answers the "can one collie be lead of one pack and peer of another?" question with no.**
 * A pack is a star with one lead (§1), and the two roles disagree about the front door: a lead keeps
 * `tailscale serve`, a peer publishes nothing. There is no coherent front-door answer for an
 * instance holding both, so the ambiguous input resolves toward **peer** — the mode that publishes
 * less. Failing closed here means a corrupted or hand-edited roster can never *open* a front door;
 * the worst it can do is withhold one, which the conflict line explains.
 *
 * **A peer never self-demotes.** This function takes no clock and no reachability signal on purpose:
 * a peer whose lead has been gone for a month is still a peer. The alternative — demoting to solo
 * after some timeout — would have an unattended machine re-publish a front door nobody asked for,
 * which is exactly the surface ADR 0001 exists to keep singular. Leaving the pack is an operator
 * action (`collie leave`), i.e. it empties the trust store; it is not a timeout.
 */
export function deriveMode(enrollment: Enrollment | null): ModeResolution {
  if (enrollment === null) return { mode: "solo", conflict: null };
  const { peers, lead } = enrollment;
  if (lead !== null && peers.length > 0) {
    return {
      mode: "peer",
      conflict:
        `enrolled by lead "${lead.memberId}" while also leading ${peers.length} peer(s) — ` +
        `a collie may be a lead or a peer, never both. Staying a peer (publishing nothing) until ` +
        `one side of the roster is cleared with \`collie leave\`.`,
    };
  }
  if (lead !== null) return { mode: "peer", conflict: null };
  if (peers.length > 0) return { mode: "lead", conflict: null };
  return { mode: "solo", conflict: null };
}

/**
 * The mode as `/api/config` reports it: `undefined` for solo, the literal otherwise.
 *
 * Optional-and-absent, for the reason PACK_PROTOCOL.md §11 gives for `servers`: an always-present
 * field changes every solo response body exactly once, for a uniformity nothing needs. Absent means
 * "no pack", which is precisely true. A client reads `mode ?? "solo"` — that is a declared contract,
 * not the behaviour-probing the spec rules out.
 */
export function modeForWire(mode: PackMode): PackMode | undefined {
  return mode === "solo" ? undefined : mode;
}
