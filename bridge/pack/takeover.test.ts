import { describe, expect, test } from "bun:test";

import type { JsonObject, JsonValue } from "../json.ts";
import type { PinnedDeputy } from "./admission.ts";
import { fp, leadStore, material, member, peerStore, T0 } from "./fixtures.ts";
import type { PackLink, PeerOutcome } from "./peer-client.ts";
import type { RosterRow, StoredWarrant, TrustStoreData, Warrant } from "./trust-store.ts";
import { signCanonical } from "./signing.ts";
import { canonicalWarrant, mintWarrant, WARRANT_TTL_MS } from "./warrant.ts";
import {
  adoptLeadership,
  checkTakeoverClaim,
  clearRePin,
  commitTakeover,
  parseTakeoverRequest,
  pendingRePin,
  probeAnswer,
  readProbeAnswer,
  rosterRowsOf,
  runTakeover,
  takeoverMessage,
  LEAD_IS_ALIVE,
  type TakeoverBody,
  type TakeoverOutcome,
} from "./takeover.ts";

// The takeover exchange, as data. Every dial is injected, so what is pinned here is RFC §7's decision
// tree — which refusals abort, which failures are merely partial, and what the store looks like on
// each side afterwards — rather than a socket.

const ARM_MS = 30_000;

/** A lead (`desk`) with three peers, having named `laptop` deputy. */
function leadWithDeputy(deputy = "laptop") {
  const base = leadStore({
    peers: [member({ memberId: "laptop" }), member({ memberId: "nas" }), member({ memberId: "attic" })],
  });
  const change = mintWarrant(base, deputy, T0);
  if (change === null) throw new Error("fixture: expected a mint");
  return { data: change.next, warrant: change.result };
}

const stored = (w: Warrant, deputy = "laptop"): StoredWarrant => ({
  warrant: w,
  deputyCertPem: material(deputy).certPem,
});

/** A witness peer (`nas`): pinned to `desk`, anchoring `laptop` as its deputy. */
function witnessStore(over: Partial<TrustStoreData> = {}): TrustStoreData {
  const { warrant } = leadWithDeputy();
  return { ...peerStore({ warrant: stored(warrant) }), ...over };
}

/** A warrant as the JSON document it travels as — field by field, so a test can bend exactly one. */
function wireOf(w: Warrant): JsonObject {
  return {
    packId: w.packId,
    generation: w.generation,
    deputyMemberId: w.deputyMemberId,
    deputyFingerprint: w.deputyFingerprint,
    leadMemberId: w.leadMemberId,
    issuedAt: w.issuedAt,
    refreshedAt: w.refreshedAt,
    signature: w.signature,
  };
}

const deputyCaller: PinnedDeputy = { memberId: "laptop", certPem: material("laptop").certPem };

/** The deputy's own store: a peer of `desk` that holds the warrant naming itself, plus the roster. */
function deputyStore(over: Partial<TrustStoreData> = {}): TrustStoreData {
  const { data, warrant } = leadWithDeputy();
  // `peerStore()` IS `laptop`, so this store's self is the member the warrant names.
  return { ...peerStore({ warrant: stored(warrant) }), standbyRoster: rosterRowsOf(data.peers), ...over };
}

describe("the request body is additive-optional, and absent selects the reading that writes nothing", () => {
  test("no phase at all is a PROBE", () => {
    const { warrant } = leadWithDeputy();
    expect(parseTakeoverRequest({ warrant: wireOf(warrant) })?.phase).toBe("probe");
  });

  test("an unrecognised phase is a PROBE too — a commit must be asked for explicitly", () => {
    const { warrant } = leadWithDeputy();
    const wire = wireOf(warrant);
    const phases: JsonValue[] = ["COMMIT", "", "yes", 1, null];
    for (const phase of phases) {
      expect(parseTakeoverRequest({ warrant: wire, phase })?.phase).toBe("probe");
    }
    expect(parseTakeoverRequest({ warrant: wire, phase: "commit" })?.phase).toBe("commit");
  });

  test("a body with no warrant is not a takeover at all", () => {
    expect(parseTakeoverRequest({ phase: "commit" })).toBeNull();
    expect(parseTakeoverRequest(null)).toBeNull();
    expect(parseTakeoverRequest([])).toBeNull();
  });

  test("an empty address reads as absent, so a commit cannot land a member with nowhere to dial", () => {
    const { warrant } = leadWithDeputy();
    const wire = wireOf(warrant);
    expect(parseTakeoverRequest({ warrant: wire, address: "" })?.address).toBeNull();
    expect(parseTakeoverRequest({ warrant: wire, address: "nas.example:8787" })?.address).toBe("nas.example:8787");
  });
});

describe("the peer's verification matrix (RFC §7.1)", () => {
  const { warrant } = leadWithDeputy();

  test("VALID: the deputy its own lead named, presenting the key the warrant names", () => {
    const verdict = checkTakeoverClaim(witnessStore(), warrant, deputyCaller, T0);
    expect(verdict).toMatchObject({ kind: "accept", fingerprint: fp("laptop") });
  });

  test("WRONG SIGNER: a warrant somebody else signed does not verify against the pinned lead", () => {
    // The identical claim, signed with `attic`'s key instead of the pinned lead's. Every field the
    // peer reads is unchanged, so what refuses it is the signature and nothing else.
    const bent = {
      ...warrant,
      signature: signCanonical(material("attic").keyPem, canonicalWarrant({ ...warrant, signature: "" })),
    };
    expect(checkTakeoverClaim(witnessStore(), bent, deputyCaller, T0)).toEqual({
      kind: "refuse",
      reason: "bad-signature",
    });
  });

  test("NOT THE DEPUTY: the right warrant presented by the wrong machine, and by the wrong key", () => {
    // Right id, wrong certificate — the replay a public object would otherwise buy.
    expect(
      checkTakeoverClaim(witnessStore(), warrant, { memberId: "laptop", certPem: material("attic").certPem }, T0),
    ).toEqual({ kind: "refuse", reason: "not-the-deputy" });
    // Right certificate, wrong id.
    expect(
      checkTakeoverClaim(witnessStore(), warrant, { memberId: "attic", certPem: material("laptop").certPem }, T0),
    ).toEqual({ kind: "refuse", reason: "not-the-deputy" });
  });

  test("GENERATION MISMATCH: a warrant below the one this peer already holds is refused", () => {
    const { data, warrant: gen2 } = (() => {
      const first = leadWithDeputy();
      const second = mintWarrant(first.data, "laptop", T0 + 1000);
      return { data: second!.next, warrant: second!.result };
    })();
    expect(gen2.generation).toBe(2);
    const held = witnessStore({ warrant: stored(gen2) });
    expect(checkTakeoverClaim(held, warrant, deputyCaller, T0)).toEqual({ kind: "refuse", reason: "generation" });
    // …and the current one is fine, so what refused it was the counter and not the shape.
    expect(checkTakeoverClaim(held, gen2, deputyCaller, T0).kind).toBe("accept");
    expect(data.peers).toHaveLength(3);
  });

  test("EXPIRED on this peer's own clock", () => {
    expect(checkTakeoverClaim(witnessStore(), warrant, deputyCaller, T0 + WARRANT_TTL_MS)).toEqual({
      kind: "refuse",
      reason: "expired",
    });
  });

  test("FOREIGN: another pack, or a warrant this peer's lead did not issue", () => {
    const peer = witnessStore();
    expect(checkTakeoverClaim({ ...peer, pack: { ...peer.pack!, packId: "pack-2" } }, warrant, deputyCaller, T0)).toEqual(
      { kind: "refuse", reason: "foreign" },
    );
    expect(
      checkTakeoverClaim(witnessStore({ lead: member({ memberId: "attic", role: "lead" }) }), warrant, deputyCaller, T0),
    ).toEqual({ kind: "refuse", reason: "foreign" });
  });

  test("NOT A PEER: a store with no lead, and no store at all", () => {
    expect(checkTakeoverClaim(null, warrant, deputyCaller, T0)).toEqual({ kind: "refuse", reason: "not-a-peer" });
    expect(checkTakeoverClaim(leadStore(), warrant, deputyCaller, T0)).toEqual({ kind: "refuse", reason: "not-a-peer" });
    expect(
      checkTakeoverClaim(
        witnessStore({ lead: member({ memberId: "desk", role: "lead", status: "unenrolled" }) }),
        warrant,
        deputyCaller,
        T0,
      ),
    ).toEqual({ kind: "refuse", reason: "not-a-peer" });
  });
});

describe("the probe answers one factual question and changes nothing", () => {
  test("silent past the threshold: a witness", () => {
    expect(probeAnswer(ARM_MS, ARM_MS)).toEqual({ ok: true, witness: "silent", lastDialledAgoMs: ARM_MS });
  });

  test("called inside the window: lead_is_alive, which is decisive", () => {
    expect(probeAnswer(2000, ARM_MS)).toEqual({ ok: false, code: LEAD_IS_ALIVE, lastDialledAgoMs: 2000 });
  });

  test("the answer is read tolerantly — an unreadable body says nothing rather than vetoing", () => {
    expect(readProbeAnswer({ ok: true, lastDialledAgoMs: 5 })).toEqual({
      ok: true,
      code: undefined,
      lastDialledAgoMs: 5,
    });
    expect(readProbeAnswer({ ok: false, code: LEAD_IS_ALIVE })!.lastDialledAgoMs).toBe(0);
    const unreadable: JsonValue[] = [null, [], { ok: "yes" }, "no"];
    for (const bad of unreadable) {
      expect(readProbeAnswer(bad)).toBeNull();
    }
  });
});

describe("the peer's commit: a role change, not a re-enrollment", () => {
  const { warrant } = leadWithDeputy();

  test("the lead is re-pinned to the ANCHORED certificate, and everything else survives", () => {
    const before = witnessStore();
    const claim = checkTakeoverClaim(before, warrant, deputyCaller, T0);
    if (claim.kind !== "accept") throw new Error("fixture");
    const change = commitTakeover(before, claim, "laptop.example:8787", T0 + 5);
    expect(change).not.toBeNull();
    const after = change!.next;
    expect(after.lead).toMatchObject({
      memberId: "laptop",
      fingerprint: fp("laptop"),
      certPem: material("laptop").certPem,
      address: "laptop.example:8787",
      role: "lead",
      status: "enrolled",
      contactedAt: null,
      signedAt: 0,
    });
    // The pack identity, the secret and this collie's own key material are untouched (§14.5).
    expect(after.pack).toEqual(before.pack);
    expect(after.self).toEqual(before.self);
    expect(after.peers).toEqual([]);
    expect(after.pendingHandover).toBeNull();
    // The presented warrant becomes the one held, which is what stops the exchange being re-run with
    // an older proof (RFC §4.4).
    expect(after.warrant!.warrant.generation).toBe(warrant.generation);
    expect(after.warrant!.deputyCertPem).toBe(material("laptop").certPem);
  });

  test("what is pinned is the certificate this listener anchored, never one off the wire", () => {
    const before = witnessStore();
    const claim = checkTakeoverClaim(before, warrant, deputyCaller, T0);
    if (claim.kind !== "accept") throw new Error("fixture");
    // The verdict carried the ANCHOR's certificate through; nothing in the body could substitute one.
    expect(claim.deputy.certPem).toBe(material("laptop").certPem);
    expect(commitTakeover(before, claim, "x:1", T0)!.next.lead!.certPem).toBe(material("laptop").certPem);
  });
});

describe("the deputy's commit: adopting leadership (RFC §7.1's (c), §7.4)", () => {
  test("the roster that rode the warrant push becomes this lead's roster", () => {
    const data = deputyStore();
    const change = adoptLeadership(data, { roster: data.standbyRoster!, confirmed: new Set(["nas"]), now: T0 });
    const after = change!.next;
    expect(after.lead).toBeNull();
    // The old lead first, then every other member — and never this machine itself.
    expect(after.peers.map((p) => p.memberId)).toEqual(["desk", "nas", "attic"]);
    expect(after.peers.map((p) => p.memberId)).not.toContain("laptop");
    // The warrant was SPENT: the pack designates nobody, but the signed object stays for the counter
    // and because it IS the proof handed to every pending member.
    expect(after.deputy).toBeNull();
    expect(after.warrant!.warrant.generation).toBe(1);
    expect(after.pack).toEqual(data.pack);
  });

  test("PARTIAL SUCCESS is representable: everything unconfirmed is pending, and that is not a failure", () => {
    const data = deputyStore();
    const change = adoptLeadership(data, { roster: data.standbyRoster!, confirmed: new Set(["nas"]), now: T0 });
    expect(change!.result.pending).toEqual(["desk", "attic"]);
    expect(pendingRePin(change!.next)).toEqual(new Set(["desk", "attic"]));
    // The OLD LEAD is always pending: it has been told nothing, and being told is what deposes it.
    expect(change!.next.peers.find((p) => p.memberId === "desk")!.rePinPending).toBe(true);
    expect(change!.next.peers.find((p) => p.memberId === "nas")!.rePinPending).toBe(false);
  });

  test("one contact clears one member, and clearing an already-clear member writes nothing", () => {
    const data = deputyStore();
    const led = adoptLeadership(data, { roster: data.standbyRoster!, confirmed: new Set(), now: T0 })!.next;
    const cleared = clearRePin(led, "desk");
    expect(cleared).not.toBeNull();
    expect(pendingRePin(cleared!.next)).toEqual(new Set(["nas", "attic"]));
    expect(clearRePin(cleared!.next, "desk")).toBeNull();
    expect(clearRePin(cleared!.next, "nobody")).toBeNull();
  });

  test("a store with no lead, or no pack, adopts nothing", () => {
    expect(adoptLeadership(leadStore(), { roster: [], confirmed: new Set(), now: T0 })).toBeNull();
    const noPack = { ...deputyStore(), pack: null };
    expect(adoptLeadership(noPack, { roster: [], confirmed: new Set(), now: T0 })).toBeNull();
  });

  test("a fresh store owes nobody — `rePinPending` is absent-means-closed", () => {
    expect(pendingRePin(peerStore())).toEqual(new Set());
    expect(pendingRePin(null)).toEqual(new Set());
  });
});

describe("running the exchange (RFC §7.1's three steps)", () => {
  const { data: leadData, warrant } = leadWithDeputy();
  const roster: readonly RosterRow[] = rosterRowsOf(leadData.peers);
  const witnesses: PackLink[] = roster
    .filter((r) => r.memberId !== "laptop")
    .map((r) => ({ memberId: r.memberId, address: r.address }));

  const ok = <T,>(value: T): PeerOutcome<T> => ({
    ok: true,
    value,
    status: 200,
    member: null,
    receivedAt: T0,
    date: null,
  });
  const down = (): PeerOutcome<never> => ({
    ok: false,
    state: "unreachable",
    reason: "timed out",
    receivedAt: T0,
  });

  interface Script {
    readonly leadAnswers?: boolean;
    readonly probes?: Record<string, JsonValue | "down">;
    readonly commits?: Record<string, "ok" | "down">;
  }

  function run(script: Script, commit?: TakeoverDepsCommit) {
    const asked: string[] = [];
    const deps = {
      warrant: () => warrant,
      leadLink: () => ({ memberId: "desk", address: "desk.example:8787" }),
      witnesses: () => witnesses,
      address: () => "laptop.example:8787",
      hello: async () => (script.leadAnswers === true ? ok({}) : down()),
      ask: async (link: PackLink, body: TakeoverBody) => {
        asked.push(`${link.memberId}:${body.phase}`);
        if (body.phase === "probe") {
          const scripted = script.probes?.[link.memberId] ?? { ok: true, witness: "silent", lastDialledAgoMs: 90_000 };
          return scripted === "down" ? down() : ok(scripted);
        }
        const answer: JsonValue = { ok: true, adopted: true, restartRequired: true };
        return (script.commits?.[link.memberId] ?? "ok") === "ok" ? ok(answer) : down();
      },
      commit: commit ?? (async (confirmed: ReadonlySet<string>) => ({ kind: "committed" as const, pending: [...confirmed].length === 2 ? [] : ["attic"] })),
      now: () => T0,
    };
    return { outcome: runTakeover(deps), asked };
  }
  type TakeoverDepsCommit = (confirmed: ReadonlySet<string>) => Promise<
    | { kind: "committed"; pending: readonly string[] }
    | { kind: "refused"; reason: "no-roster" | "commit-failed" }
    | { kind: "refused"; reason: "pairing-collision"; labels: readonly string[] }
  >;

  test("(a) THE LEAD ANSWERS: refused, and nothing else is even dialled", async () => {
    const r = run({ leadAnswers: true });
    expect(await r.outcome).toMatchObject({ kind: "refused", reason: "lead-alive" });
    expect(r.asked).toEqual([]);
  });

  test("(b) A WITNESS SAYS THE LEAD IS ALIVE: aborted, before a byte moved", async () => {
    let committed = false;
    const r = run(
      { probes: { nas: { ok: false, code: LEAD_IS_ALIVE, lastDialledAgoMs: 2000 } } },
      async () => {
        committed = true;
        return { kind: "committed", pending: [] };
      },
    );
    const outcome = await r.outcome;
    expect(outcome).toEqual({ kind: "refused", reason: "witness", witness: "nas", agoMs: 2000 });
    // No commit round ran anywhere, and the local commit never ran either.
    expect(r.asked.filter((a) => a.endsWith(":commit"))).toEqual([]);
    expect(committed).toBe(false);
  });

  test("the happy path: probe everyone, then commit to everyone that answered", async () => {
    const r = run({});
    expect(await r.outcome).toEqual({ kind: "committed", repinned: ["nas", "attic"], pending: [] });
    expect(r.asked).toEqual(["nas:probe", "attic:probe", "nas:commit", "attic:commit"]);
  });

  test("A WITNESS THAT IS DOWN is pending, never a veto — partial success is not a failure", async () => {
    const r = run({ probes: { attic: "down" } });
    expect(await r.outcome).toEqual({ kind: "committed", repinned: ["nas"], pending: ["attic"] });
    expect(r.asked).toEqual(["nas:probe", "attic:probe", "nas:commit"]);
  });

  test("a witness that fails its COMMIT is pending too, and the takeover still lands", async () => {
    const r = run({ commits: { attic: "down" } });
    expect(await r.outcome).toMatchObject({ kind: "committed", repinned: ["nas"] });
  });

  test("a TWO-MACHINE pack has no witness, and is allowed anyway (RFC §16, decision 8)", async () => {
    const outcome = await runTakeover({
      warrant: () => warrant,
      leadLink: () => ({ memberId: "desk", address: "desk.example:8787" }),
      witnesses: () => [],
      address: () => "laptop.example:8787",
      hello: async () => down(),
      ask: async () => {
        throw new Error("nothing to ask");
      },
      commit: async () => ({ kind: "committed", pending: ["desk"] }),
      now: () => T0,
    });
    expect(outcome).toEqual({ kind: "committed", repinned: [], pending: ["desk"] });
  });

  test("no warrant, and no lead to ask, each refuse before anything is dialled", async () => {
    const base = {
      leadLink: () => ({ memberId: "desk", address: "d:1" }),
      witnesses: () => [],
      address: () => "x:1",
      hello: async () => down(),
      ask: async () => down(),
      commit: async () => ({ kind: "committed" as const, pending: [] }),
      now: () => T0,
    };
    expect(await runTakeover({ ...base, warrant: () => null })).toEqual({ kind: "refused", reason: "no-warrant" });
    expect(await runTakeover({ ...base, warrant: () => warrant, leadLink: () => null })).toEqual({
      kind: "refused",
      reason: "no-roster",
    });
  });

  test("a LOCAL commit that refuses is the exchange's answer, verbatim", async () => {
    const r = run({}, async () => ({ kind: "refused", reason: "pairing-collision", labels: ["phone"] }));
    expect(await r.outcome).toEqual({ kind: "refused", reason: "pairing-collision", labels: ["phone"] });
  });
});

describe("the sentence the page prints (RFC §14.3 step 5)", () => {
  test("a refusal because the lead is alive reads as the feature it is", () => {
    expect(takeoverMessage({ kind: "refused", reason: "lead-alive", agoMs: 400 })).toBe(
      "Your lead answered 0.4 s ago; it is alive. Nothing was changed.",
    );
  });

  test("a witness refusal names the witness and what it said", () => {
    expect(takeoverMessage({ kind: "refused", reason: "witness", witness: "nas", agoMs: 2000 })).toBe(
      'Peer "nas" says the lead called it 2.0 s ago; you are probably the one who is cut off. Nothing was changed.',
    );
  });

  test("every refusal ends with the same promise, and it is the true one", () => {
    for (const outcome of [
      { kind: "refused", reason: "lead-alive", agoMs: 1 },
      { kind: "refused", reason: "witness", witness: "nas", agoMs: 1 },
      { kind: "refused", reason: "no-warrant" },
      { kind: "refused", reason: "no-roster" },
      { kind: "refused", reason: "pairing-collision", labels: ["phone"] },
      { kind: "refused", reason: "commit-failed" },
    ] satisfies TakeoverOutcome[]) {
      expect(takeoverMessage(outcome)).toContain("Nothing was changed.");
    }
  });

  test("success names what is left to do, and does not pretend it is nothing", () => {
    expect(takeoverMessage({ kind: "committed", repinned: ["nas"], pending: [] })).toBe(
      "This machine is the lead now. Restarting — reload in a moment.",
    );
    expect(takeoverMessage({ kind: "committed", repinned: [], pending: ["desk", "attic"] })).toContain(
      "2 machines could not be reached (desk, attic) and will be brought over automatically",
    );
  });
});

test("rosterRowsOf carries public material only, and drops tombstones", () => {
  const rows = rosterRowsOf([
    member({ memberId: "nas" }),
    member({ memberId: "attic", status: "unenrolled" }),
  ]);
  expect(rows).toEqual([
    { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:8787" },
  ]);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE KEY");
});
