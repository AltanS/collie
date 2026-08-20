import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { leadStore, member, T0 } from "./fixtures.ts";
import { runBootGate, type BootGateDeps } from "./boot-gate.ts";
import type { HelloResult, PackLink, PeerOutcome } from "./peer-client.ts";
import type { Warrant } from "./trust-store.ts";
import { mintWarrant } from "./warrant.ts";

// The boot-time gate against a split brain (§18.11). Pure but for the injected `hello`, so the whole
// matrix is exercisable without a socket.

const LINKS: readonly PackLink[] = [
  { memberId: "nas", address: "nas.example:8787" },
  { memberId: "attic", address: "attic.example:8787" },
];

/** A warrant `desk` really signed naming `nas` — the proof a re-pinned member hands back. */
const PROOF: Warrant = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.result;

function silent(reason = "timed out after 5000ms"): PeerOutcome<HelloResult> {
  return { ok: false, state: "unreachable", reason, timedOut: true, receivedAt: T0 };
}

function answered(warrantGeneration: number | null = null): PeerOutcome<HelloResult> {
  return {
    ok: true,
    value: { protocol: 1, member: "nas", version: "1.0.0", warrantGeneration, pairingDigest: null },
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
      hello: (link) => {
        asked.push(link.memberId);
        return Promise.resolve(silent());
      },
    });
    expect(verdict).toEqual({ kind: "publish" });
    expect(asked).toEqual([]);
  });

  test("SILENCE from every member publishes anyway — an answer is evidence, silence is not", () => {
    // Fail-open on no answer is forced: the common case for "nobody answered" is a lead rebooting
    // first after a power cut, and a lead that refuses to come up because its peers are still booting
    // is an outage manufactured out of a safety check.
    const { verdict } = gate({ nas: silent(), attic: silent("connect ECONNREFUSED") });
    return expect(verdict).resolves.toEqual({ kind: "publish" });
  });

  test("healthy answers publish — a member behind on its warrant is not a conflict", () => {
    const { verdict } = gate({ nas: answered(1), attic: answered(null) }, { generation: 1 });
    return expect(verdict).resolves.toEqual({ kind: "publish" });
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

  test("a conflict with NO warrant still deposes — but carries nothing to heal with", async () => {
    // §18.11 deposes on the answer; §18.12 heals on the proof. A conflict without one is RFC §8.3's
    // *parked — unverifiable*, which is the honest terminal state and not a reason to keep leading.
    const answer = await gate({ nas: conflicted(null) }).verdict;
    expect(answer).toMatchObject({ kind: "deposed", proof: null, from: "nas" });
  });

  test("a member holding a HIGHER generation deposes, even with no conflict body", async () => {
    // The counter lives on the lead and never resets (§18.3), so a member ahead of its own lead has
    // been told something by somebody else.
    const answer = await gate({ nas: answered(9) }, { generation: 4 }).verdict;
    expect(answer).toMatchObject({ kind: "deposed", proof: null, from: "nas" });
    if (answer.kind === "deposed") expect(answer.reason).toContain("generation 9");
  });

  test("MIXED answers depose, and the strongest evidence wins over arrival order", async () => {
    // Two members contradict this machine — one with a proof, one merely ahead. Taking the first
    // would turn a healable deposition into a parked one for no reason but the order they answered.
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
