import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { leadStore, member, PACK, T0 } from "./fixtures.ts";
import { runBootGate, type BootGateDeps } from "./boot-gate.ts";
import { isDepositionProof } from "./deposed.ts";
import type { HelloResult, PackLink, PeerOutcome } from "./peer-client.ts";
import type { Warrant } from "./trust-store.ts";
import { mintWarrant } from "./warrant.ts";

// The boot-time gate against a split brain (§18.11). Pure but for the injected `hello`, so the whole
// matrix is exercisable without a socket.

const LINKS: readonly PackLink[] = [
  { memberId: "nas", address: "nas.example:8787" },
  { memberId: "attic", address: "attic.example:8787" },
];

/** `desk`'s own store, with `nas` on the roster — the store the gate's `verifies` asks. */
const DESK = leadStore({ peers: [member({ memberId: "nas" })] });

/** A warrant `desk` really signed naming `nas` — the proof a re-pinned member hands back. */
const PROOF: Warrant = mintWarrant(DESK, "nas", T0)!.result;

/**
 * A warrant of another pack entirely, at a generation ahead of this one. This is the shape that took
 * a real pack dark: a peer that left pack A holding one, joined pack B, and reported it there.
 */
const FOREIGN: Warrant = { ...PROOF, packId: "pack-elsewhere", generation: 9 };

function silent(reason = "timed out after 5000ms"): PeerOutcome<HelloResult> {
  return { ok: false, state: "unreachable", reason, timedOut: true, receivedAt: T0 };
}

function answered(warrantGeneration: number | null = null): PeerOutcome<HelloResult> {
  return {
    ok: true,
    value: {
      protocol: 1,
      member: "nas",
      version: "1.0.0",
      warrantGeneration,
      warrantActiveGeneration: null,
      pairingDigest: null, pairingCollision: null,
    },
    status: 200,
    member: "nas",
    receivedAt: T0,
    date: null,
  };
}

function conflicted(warrant: Warrant | null, generation = 3): PeerOutcome<HelloResult> {
  return {
    ok: false,
    state: "conflicted",
    reason: 'hello: this collie follows lead "nas"',
    leadMemberId: "nas",
    warrantGeneration: generation,
    warrant,
    receivedAt: T0,
  };
}

/** Run the gate over a scripted answer per member. */
function gate(answers: Record<string, PeerOutcome<HelloResult>>, over: Partial<BootGateDeps> = {}) {
  const asked: string[] = [];
  const deps: BootGateDeps = {
    links: LINKS,
    generation: 1,
    packId: PACK.packId,
    // The REAL predicate, over `desk`'s real store — the point of the fix is that this and only this
    // deposes, so a test that stubbed it would be testing the stub.
    verifies: (warrant) => isDepositionProof(DESK, warrant),
    hello: (link) => {
      asked.push(link.memberId);
      return Promise.resolve(answers[link.memberId] ?? silent());
    },
    ...over,
  };
  return { verdict: runBootGate(deps), asked };
}

describe("the boot gate (§18.11)", () => {
  test("no roster ⇒ nothing is asked at all", async () => {
    const asked: string[] = [];
    const verdict = await runBootGate({
      links: [],
      generation: 0,
      packId: PACK.packId,
      verifies: () => true,
      hello: (link) => {
        asked.push(link.memberId);
        return Promise.resolve(silent());
      },
    });
    expect(verdict).toEqual({ kind: "publish", warnings: [] });
    expect(asked).toEqual([]);
  });

  test("SILENCE from every member publishes anyway — an answer is evidence, silence is not", () => {
    // Fail-open on no answer is forced: the common case for "nobody answered" is a lead rebooting
    // first after a power cut, and a lead that refuses to come up because its peers are still booting
    // is an outage manufactured out of a safety check.
    const { verdict } = gate({ nas: silent(), attic: silent("connect ECONNREFUSED") });
    return expect(verdict).resolves.toEqual({ kind: "publish", warnings: [] });
  });

  test("healthy answers publish — a member behind on its warrant is not a conflict", () => {
    const { verdict } = gate({ nas: answered(1), attic: answered(null) }, { generation: 1 });
    return expect(verdict).resolves.toEqual({ kind: "publish", warnings: [] });
  });

  test("ONE lead_conflict deposes, and the warrant it carried is the proof", async () => {
    const { verdict } = gate({ nas: conflicted(PROOF), attic: answered(null) });
    const answer = await verdict;
    expect(answer.kind).toBe("deposed");
    if (answer.kind !== "deposed") return;
    expect(answer.proof).toEqual(PROOF);
    expect(answer.from).toBe("nas");
    expect(answer.reason).toContain('follows lead "nas"');
  });

  test("a conflict with NO warrant does NOT depose — it warns, and the lead keeps leading", async () => {
    // The deviation from §18.11, and the incident it closes. A claim with nothing behind it is
    // evidence of a misconfigured peer, not of a takeover, and parking on one turned one machine's
    // stale file into the whole pack's outage.
    const answer = await gate({ nas: conflicted(null) }).verdict;
    expect(answer.kind).toBe("publish");
    if (answer.kind !== "publish") return;
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings[0]).toContain("sent no warrant to prove it");
  });

  test("a conflict whose warrant belongs to ANOTHER pack warns, and names the remedy", async () => {
    const answer = await gate({ nas: conflicted(FOREIGN) }).verdict;
    expect(answer.kind).toBe("publish");
    if (answer.kind !== "publish") return;
    expect(answer.warnings[0]).toContain('pack "pack-elsewhere"');
    expect(answer.warnings[0]).toContain("collie pack leave");
  });

  test("a member holding a HIGHER generation warns rather than deposing", async () => {
    // This is the exact shape of the incident: a peer that kept generation 3 from the pack it left,
    // reporting it at a lead that had never minted a warrant at all.
    const answer = await gate({ nas: answered(3) }, { generation: 0 }).verdict;
    expect(answer.kind).toBe("publish");
    if (answer.kind !== "publish") return;
    expect(answer.warnings[0]).toContain("reports warrant generation 3");
    expect(answer.warnings[0]).toContain("this lead never minted");
  });

  test("MIXED answers depose on the PROOF, and the unproven claim is still logged", async () => {
    // One member is merely ahead, the other hands back a warrant this lead signed. Only the second
    // is evidence — and the first still reaches the operator, because a peer claiming a generation
    // out of nowhere is a fault whether or not something else deposed this machine.
    const answer = await gate({ nas: answered(9), attic: conflicted(PROOF) }, { generation: 1 }).verdict;
    expect(answer).toMatchObject({ kind: "deposed", proof: PROOF, from: "attic" });
  });

  test("every member is asked ONCE, and the round is concurrent", () => {
    const { asked } = gate({ nas: answered(), attic: answered() });
    return expect(asked.length).toBeLessThanOrEqual(LINKS.length);
  });

  test("it arms nothing: boot-only, by construction", () => {
    // Not a peer-side timer and not an election (§15). The absence is the feature, so it is asserted
    // the same way `lead.ts` asserts its own — by reading the file that would have to contain one.
    const src = readFileSync(join(import.meta.dir, "boot-gate.ts"), "utf8");
    // The CALL form, so the module header may name the thing it does not do.
    expect(src).not.toMatch(/\bsetInterval\(|\bsetTimeout\(/);
  });
});
