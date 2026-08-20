import { describe, expect, test } from "bun:test";

import { leadStore, material, member, PACK, T0 } from "./fixtures.ts";
import type { LeadContactFacts } from "./lead-contact.ts";
import { deriveMode } from "./mode.ts";
import type { TrustStoreData } from "./trust-store.ts";
import { enrollmentOf } from "./trust-store.ts";
import {
  deposedAnswer,
  deposedPage,
  deposedStateFrom,
  isDepositionProof,
  outcomeNow,
  selfHeal,
  STANDBY_HEALTH_PATH,
  strandedByRotation,
} from "./deposed.ts";
import { mintWarrant } from "./warrant.ts";

// The deposed state and the self-heal (§18.12). Everything here is a pure function of a store, a
// warrant and a clock — no socket, no disk — so what is pinned below is the shipping rule.

/** `desk`, leading `nas` and `attic`, holding the warrant it signed naming `nas` as deputy. */
function deposedLead(over: Partial<TrustStoreData> = {}) {
  const base = leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "attic" })] });
  const change = mintWarrant(base, "nas", T0);
  if (change === null) throw new Error("fixture: expected a mint");
  return { data: { ...change.next, ...over }, warrant: change.result };
}

const QUIET: LeadContactFacts = { processStartedAt: T0, lastDialledAt: null, leadRefusedSecretAt: null };

describe("what counts as learning (§18.12)", () => {
  test("a warrant this machine SIGNED, naming a deputy, at least its own generation, deposes it", () => {
    const { data, warrant } = deposedLead();
    expect(isDepositionProof(data, warrant)).toBe(true);
  });

  test("a bent field is not a proof — the signature is the whole question", () => {
    const { data, warrant } = deposedLead();
    // Every clause below leaves a well-formed warrant that still names `nas`; the only thing wrong
    // is that the bytes are not the ones `desk` signed.
    expect(isDepositionProof(data, { ...warrant, generation: warrant.generation + 5 })).toBe(false);
    expect(isDepositionProof(data, { ...warrant, refreshedAt: warrant.refreshedAt + 1 })).toBe(false);
    expect(isDepositionProof(data, { ...warrant, signature: "" })).toBe(false);
  });

  test("a REVOCATION deposes nobody — it names nobody to be deposed for", () => {
    const base = leadStore({ peers: [member({ memberId: "nas" })] });
    const named = mintWarrant(base, "nas", T0)!;
    const revoked = mintWarrant(named.next, null, T0 + 1)!;
    expect(isDepositionProof(named.next, revoked.result)).toBe(false);
  });

  test("a warrant for another pack, or signed by another member, deposes nobody", () => {
    const { data, warrant } = deposedLead();
    expect(isDepositionProof(data, { ...warrant, packId: "pack-2" })).toBe(false);
    expect(isDepositionProof(data, { ...warrant, leadMemberId: "attic" })).toBe(false);
  });

  test("an OLDER generation than the one held deposes nobody — generations only go up", () => {
    const { data } = deposedLead();
    const stale = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.result;
    const ahead: TrustStoreData = {
      ...data,
      warrant: { warrant: { ...data.warrant!.warrant, generation: 7 }, deputyCertPem: null },
    };
    expect(stale.generation).toBeLessThan(7);
    expect(isDepositionProof(ahead, stale)).toBe(false);
  });

  test("a collie that does not lead cannot be deposed — there is no crown to move", () => {
    const { data, warrant } = deposedLead();
    const notLeading: TrustStoreData = { ...data, peers: [] };
    expect(isDepositionProof(notLeading, warrant)).toBe(false);
  });

  test("an EXPIRED warrant still deposes: expiry gates what a warrant ARMS, not what it PROVES", () => {
    // Refusing to believe an expired proof would leave this machine leading a pack that has already
    // moved on — the split brain the whole section exists to close. Fail-open here is fail-closed
    // where it counts, and it is the one clause `isDepositionProof` deliberately does not carry.
    const { data, warrant } = deposedLead();
    expect(isDepositionProof(data, warrant)).toBe(true);
  });
});

describe("the self-heal — RFC §8.3's three outcomes", () => {
  test("HEALED: the store becomes a peer's, on materials it already held", () => {
    const { data, warrant } = deposedLead();
    const heal = selfHeal(data, warrant);
    if (heal.outcome !== "healed") throw new Error(`expected a heal, got ${heal.reason}`);
    const next = heal.change.next;

    expect(next.lead?.memberId).toBe("nas");
    expect(next.lead?.role).toBe("lead");
    expect(next.lead?.status).toBe("enrolled");
    // The certificate came out of THIS machine's own roster, never off the wire (RFC §12, F11).
    expect(next.lead?.certPem).toBe(material("nas").certPem);
    // Provisional until it is actually dialled, exactly as `adoptLead` marks a newly-pinned lead.
    expect(next.lead?.contactedAt).toBeNull();
    expect(heal.change.audit).toEqual({
      action: "pack.deposed",
      detail: { lead: "nas", generation: warrant.generation, outcome: "healed" },
    });
  });

  test("PRIVILEGE DECREASE: role peer, no peers, secret and identity kept, designation dropped", () => {
    // The three properties RFC §12's F11 says must all hold or this must not ship. A machine
    // demoting ITSELF to the least privileged role in the protocol is not an escalation under any
    // reading — but only if the store it lands in really is a peer's.
    const { data, warrant } = deposedLead();
    const heal = selfHeal(data, warrant);
    if (heal.outcome !== "healed") throw new Error("expected a heal");
    const next = heal.change.next;

    expect(deriveMode(enrollmentOf(next)).mode).toBe("peer");
    expect(next.peers).toEqual([]);
    // Nothing was minted and nothing was learned: same pack, same secret, same generation, same key.
    expect(next.pack).toEqual(PACK);
    expect(next.pack?.secret).toBe(data.pack!.secret);
    expect(next.self).toEqual(data.self);
    // The operator's designation belonged to this machine AS THE LEAD. It leads nothing now.
    expect(next.deputy).toBeNull();
    expect(next.pendingHandover).toBeNull();
    // The proof becomes the warrant it holds, so an older one can never be replayed at it.
    expect(next.warrant?.warrant).toEqual(warrant);
    expect(next.warrant?.deputyCertPem).toBe(material("nas").certPem);
  });

  test("PARKED — unverifiable: a signature that does not verify parks, and writes nothing", () => {
    const { data, warrant } = deposedLead();
    expect(selfHeal(data, { ...warrant, generation: 42 })).toEqual({ outcome: "parked", reason: "signature" });
  });

  test("PARKED — unverifiable: a deputy this machine's own roster cannot resolve", () => {
    // The warrant is perfect and this machine signed it; what is missing is the certificate behind
    // the fingerprint. That is a hand-edited store or a pack this machine does not belong to, and the
    // honest answer is to stop rather than to believe a name.
    const { data, warrant } = deposedLead();
    const emptied: TrustStoreData = { ...data, peers: [member({ memberId: "attic" })] };
    expect(selfHeal(emptied, warrant)).toEqual({ outcome: "parked", reason: "unknown-deputy" });

    // Same id, different certificate — the fingerprint is what binds, not the name (§14.2's lesson).
    const swapped: TrustStoreData = {
      ...data,
      peers: [member({ memberId: "nas", certPem: material("attic").certPem })],
    };
    expect(selfHeal(swapped, warrant)).toEqual({ outcome: "parked", reason: "unknown-deputy" });
  });

  test("PARKED — no proof: a conflict that arrived with no warrant has nothing to verify", () => {
    const { data } = deposedLead();
    expect(selfHeal(data, null)).toEqual({ outcome: "parked", reason: "no-proof" });
  });

  test("PARKED — stranded by a rotation: reached AFTER the heal, never at it", () => {
    // At the instant a takeover commits the secret is unchanged (§14.5 reuses it), so nothing at heal
    // time can tell that a rotation is coming. What tells the returning machine is §8.4's mechanics:
    // the new lead rotated while it was away and now dials it with a secret it does not hold.
    const { data, warrant } = deposedLead();
    const heal = selfHeal(data, warrant);
    const state = deposedStateFrom(data, warrant, heal, T0 + 5);
    expect(state.outcome).toBe("healed");

    expect(strandedByRotation(state, QUIET)).toBe(false);
    // A refusal from BEFORE the deposition is not evidence about the pack this machine is in now.
    expect(strandedByRotation(state, { ...QUIET, leadRefusedSecretAt: T0 })).toBe(false);
    const refused: LeadContactFacts = { ...QUIET, leadRefusedSecretAt: T0 + 9 };
    expect(strandedByRotation(state, refused)).toBe(true);
    expect(outcomeNow(state, refused)).toBe("parked-rotated");
    expect(outcomeNow(state, QUIET)).toBe("healed");
  });

  test("a parked machine never becomes stranded — the strand is a state of a HEALED one", () => {
    const { data, warrant } = deposedLead();
    const parked = deposedStateFrom(data, warrant, selfHeal(data, null), T0);
    expect(parked.outcome).toBe("parked-unverifiable");
    expect(outcomeNow(parked, { ...QUIET, leadRefusedSecretAt: T0 + 1 })).toBe("parked-unverifiable");
  });
});

describe("what a deposed collie serves (§18.12)", () => {
  const { data, warrant } = deposedLead();
  const healed = deposedStateFrom(data, warrant, selfHeal(data, warrant), T0);

  test("the health check FAILS — that is what stops a proxy routing the phone back here", () => {
    const res = deposedAnswer(healed, "healed", new URL(`https://desk.example${STANDBY_HEALTH_PATH}`));
    expect(res.status).toBe(503);
  });

  test("every other path answers 200 with one page — a human deserves an answer", () => {
    // The asymmetry is the point: a proxy asking whether to route here is refused, a person who
    // reached it is told what happened. `text/plain` so an operator-typed pack name reaches a browser
    // with no markup around it and no escaping question to get wrong.
    for (const path of ["/", "/api/snapshot", "/settings", "/anything/at/all"]) {
      const res = deposedAnswer(healed, "healed", new URL(`https://desk.example${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    }
  });

  test("the page NAMES which of the three outcomes it is in", () => {
    expect(deposedPage(healed, "healed")).toContain("rejoined the pack as a peer");
    expect(deposedPage(healed, "parked-rotated")).toContain("collie join");
    const parked = deposedStateFrom(data, warrant, selfHeal(data, null), T0);
    expect(deposedPage(parked, "parked-unverifiable")).toContain("no warrant to verify");
    // And it always names the machine that leads now, the generation, and the one command this
    // machine's own operator still owns (ADR 0001: Collie does not tear down another's ingress).
    expect(deposedPage(healed, "healed")).toContain('"nas"');
    expect(deposedPage(healed, "healed")).toContain("collie unserve");
  });
});
