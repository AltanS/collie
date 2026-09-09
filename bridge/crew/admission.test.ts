import { describe, expect, test } from "bun:test";

import {
  admitCrewRequest,
  factsFrom,
  crewResponseHeaders,
  parseProtocolHeader,
  protocolMismatchResponse,
  unauthorizedResponse,
  type CrewRequestFacts,
} from "./admission.ts";
import { leadStore, material, member, CREW, peerStore } from "./fixtures.ts";

// The two-factor gate (CREW_PROTOCOL.md §8.1) is the whole of federation's security posture, so it
// is tested as a MATRIX rather than as a set of happy paths: every combination of "which factor did
// the caller get right" has a row, and the refusals are compared against each other for
// indistinguishability rather than merely asserted to be 401.

/** Header names+values as a sorted list — `Headers` is not iterable under this tsconfig's lib. */
function headerList(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => out.push(`${key}: ${value}`));
  return out.toSorted();
}

/** The §7 mismatch body: the version the receiver wants, and the one it was actually sent. */
interface ProtocolMismatch {
  received: number | null;
}

const nas = member({ memberId: "nas" });
const store = leadStore({ peers: [nas] });

function facts(over: Partial<CrewRequestFacts> = {}): CrewRequestFacts {
  return {
    transportPinned: false,
    signedMember: "nas",
    // Absent by default, which is every single-anchor peer, every lead and solo: the two fields the
    // 2026-08-20 amendment added read as "one anchor, no dial attestation", i.e. exactly today.
    deputy: null,
    dial: null,
    authorization: `Bearer ${CREW.secret}`,
    protocol: "2",
    ...over,
  };
}

describe("admitCrewRequest — the failure matrix", () => {
  test("both factors correct admits, and names who called", () => {
    const verdict = admitCrewRequest(store, facts());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok || verdict.caller !== "member") throw new Error("unreachable");
    expect(verdict.member.memberId).toBe("nas");
    expect(verdict.self).toBe("desk");
  });

  test("no secret at all is refused", () => {
    expect(admitCrewRequest(store, facts({ authorization: null }))).toEqual({
      ok: false,
      refusal: "unauthorized",
      factor: "secret",
    });
  });

  test("a wrong secret is refused even with a pinned certificate", () => {
    expect(admitCrewRequest(store, facts({ authorization: "Bearer nope" })).ok).toBe(false);
  });

  test("a ROTATED secret — the old value — is refused, with no grace window (§8.4)", () => {
    const rotated = leadStore({ peers: [nas], crew: { ...CREW, secret: "new-secret", secretGeneration: 2 } });
    expect(admitCrewRequest(rotated, facts()).ok).toBe(false);
    expect(admitCrewRequest(rotated, facts({ authorization: "Bearer new-secret" })).ok).toBe(true);
  });

  test("an UNPINNED certificate is refused even with the correct secret", () => {
    expect(admitCrewRequest(store, facts({ signedMember: "stranger" }))).toEqual({
      ok: false,
      refusal: "unauthorized",
      factor: "certificate",
    });
  });

  test("NO certificate is refused — the unwired transport must not degrade to one factor", () => {
    expect(admitCrewRequest(store, facts({ signedMember: null })).ok).toBe(false);
  });

  test("a pinned certificate with a wrong secret is refused — neither factor alone admits", () => {
    expect(admitCrewRequest(store, facts({ authorization: "Bearer wrong" })).ok).toBe(false);
    expect(admitCrewRequest(store, facts({ signedMember: "stranger", authorization: null })).ok).toBe(
      false,
    );
  });

  test("an `unenrolled` member is pinned but refused (dropped by a rotation it missed)", () => {
    const dropped = leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] });
    const verdict = admitCrewRequest(dropped, facts());
    expect(verdict).toEqual({ ok: false, refusal: "unauthorized", factor: "certificate" });
  });

  test("a collie with no trust store, and one with no crew, admit nothing", () => {
    expect(admitCrewRequest(null, facts()).ok).toBe(false);
    expect(admitCrewRequest(leadStore({ crew: null }), facts()).ok).toBe(false);
  });

  test("a peer admits its LEAD — pinning is pairwise and works in both directions", () => {
    const peer = peerStore();
    const verdict = admitCrewRequest(peer, facts({ transportPinned: true, signedMember: null }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok || verdict.caller !== "member") throw new Error("unreachable");
    expect(verdict.member.role).toBe("lead");
  });

  test("a Bearer scheme is required — the raw secret in the header is not a credential", () => {
    expect(admitCrewRequest(store, facts({ authorization: CREW.secret })).ok).toBe(false);
    expect(admitCrewRequest(store, facts({ authorization: `bearer ${CREW.secret}` })).ok).toBe(true);
  });
});

describe("admitCrewRequest — version negotiation is LAST", () => {
  test("an admitted caller on a wrong version gets the legible mismatch (§7)", () => {
    expect(admitCrewRequest(store, facts({ protocol: "3" }))).toEqual({
      ok: false,
      refusal: "protocol_mismatch",
      received: 3,
    });
  });

  test("a MISSING version header is a mismatch, never a default of 1", () => {
    expect(admitCrewRequest(store, facts({ protocol: null }))).toEqual({
      ok: false,
      refusal: "protocol_mismatch",
      received: null,
    });
  });

  test("an UNAUTHENTICATED caller on a wrong version learns nothing — 401, not 409 (§8.5)", () => {
    // This ordering is the whole reconciliation of §7 (be legible) with §8.5 (no version banner):
    // the 409 exists, but only behind the gate. A prober cannot use it to discover the protocol.
    const verdict = admitCrewRequest(store, facts({ protocol: "2", signedMember: null, authorization: null }));
    expect(verdict).toEqual({ ok: false, refusal: "unauthorized", factor: "certificate" });
  });
});

describe("parseProtocolHeader", () => {
  test("only a bare integer parses", () => {
    expect(parseProtocolHeader("1")).toBe(1);
    expect(parseProtocolHeader(" 2 ")).toBe(2);
    expect(parseProtocolHeader("1.0")).toBeNull();
    expect(parseProtocolHeader("v1")).toBeNull();
    expect(parseProtocolHeader("")).toBeNull();
    expect(parseProtocolHeader(null)).toBeNull();
    expect(parseProtocolHeader("99999")).toBeNull();
  });
});

describe("the refusal is indistinguishable — the RESPONSE, not just the decision", () => {
  test("every 401 is byte-identical in status, body and headers", async () => {
    const causes = [
      facts({ authorization: null }),
      facts({ authorization: "Bearer wrong" }),
      facts({ signedMember: "stranger" }),
      facts({ signedMember: null }),
      facts({ signedMember: "stranger", authorization: null }),
    ];
    const refusals = await Promise.all(
      causes.map(async (f) => {
        expect(admitCrewRequest(store, f).ok).toBe(false);
        const res = unauthorizedResponse();
        return JSON.stringify({
          status: res.status,
          body: await res.text(),
          headers: headerList(res),
        });
      }),
    );
    expect(new Set(refusals).size).toBe(1);
    expect(JSON.parse(refusals[0]!).body).toBe('{"error":"unauthorized"}');
  });

  test("the 401 carries NO crew headers — nothing tells a prober what is listening (§8.5)", () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(headerList(res).filter((h) => h.startsWith("x-crew"))).toEqual([]);
  });

  test("the body has no `code` and no cause — one shape, no hint at which factor failed", async () => {
    expect(Object.keys(await unauthorizedResponse().json())).toEqual(["error"]);
  });
});

describe("the 409 body names both sides", () => {
  test("it matches §7's shape exactly, and does state the version", async () => {
    const res = protocolMismatchResponse(3);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "crew protocol mismatch",
      code: "protocol_mismatch",
      expected: 2,
      received: 3,
    });
    expect(res.headers.get("x-crew-protocol")).toBe("2");
  });

  test("an unreadable version is reported as null rather than guessed", async () => {
    // SAFETY: `protocolMismatchResponse` is the sole writer of this body and always states the
    // version it received (null when it could not be read — which is what this asserts).
    const mismatch = (await protocolMismatchResponse(null).json()) as ProtocolMismatch;
    expect(mismatch.received).toBeNull();
  });
});

describe("the transport seam", () => {
  test("no identity offered refuses everything — no config can make it single-factor", () => {
    const req = new Request("https://peer.example/crew/v1/hello");
    expect(admitCrewRequest(store, factsFrom(req, { transportPinned: false, signedMember: null })).ok).toBe(false);
  });

  test("factsFrom reads only crew headers — never Origin, Host or a device header", () => {
    const req = new Request("https://peer.example/crew/v1/hello", {
      headers: {
        origin: "https://peer.example",
        host: "peer.example",
        "x-tailnet-device": "phone",
        authorization: `Bearer ${CREW.secret}`,
        "x-crew-protocol": "2",
      },
    });
    const f = factsFrom(req, { transportPinned: false, signedMember: "nas" });
    // The two 2026-08-20 fields are here and both default CLOSED — no second anchor, no attestation —
    // which is the reading that leaves a single-anchor peer behaving exactly as it always has.
    expect(Object.keys(f).toSorted()).toEqual([
      "authorization",
      "deputy",
      "dial",
      "protocol",
      "signedMember",
      "transportPinned",
    ]);
    expect(f.deputy).toBeNull();
    expect(f.dial).toBeNull();
    // Browser credentials are present on this request and admit nothing on their own.
    expect(admitCrewRequest(store, { ...f, authorization: null }).ok).toBe(false);
  });
});

describe("admitted responses state their version and who answered (§6)", () => {
  test("crewResponseHeaders carries the protocol and the member id", () => {
    expect(crewResponseHeaders("desk")).toEqual({
      "content-type": "application/json; charset=utf-8",
      "x-crew-protocol": "2",
      "x-crew-member": "desk",
    });
  });
});

describe("a two-anchored peer resolves its caller by SIGNATURE, never by the TLS boolean (§8.1, 2026-08-20)", () => {
  const peer = peerStore();
  const deputy = { memberId: "nas", certPem: material("nas").certPem };
  /** Facts as they arrive at a peer dialled over a pin-enforcing handshake, with no attestation. */
  const dialled = (over: Partial<CrewRequestFacts> = {}): CrewRequestFacts =>
    facts({ transportPinned: true, signedMember: null, ...over });

  test("ONE anchor: an unsigned dial is still admitted as the lead — today, byte for byte", () => {
    const verdict = admitCrewRequest(peer, dialled());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok || verdict.caller !== "member") throw new Error("unreachable");
    expect(verdict.member.memberId).toBe("desk");
  });

  test("TWO anchors: an UNSIGNED dial is refused — a listener that cannot tell must not guess", () => {
    // This is the whole closure. Without it the boolean resolves to the lead, and a compromised
    // deputy that completed the handshake would be read as the lead on every route.
    expect(admitCrewRequest(peer, dialled({ deputy }))).toEqual({
      ok: false,
      refusal: "unauthorized",
      factor: "certificate",
    });
  });

  test("TWO anchors: a LEAD-attested dial is admitted, and resolves to the lead", () => {
    const verdict = admitCrewRequest(peer, dialled({ deputy, dial: { memberId: "desk", isDeputy: false } }));
    if (!verdict.ok || verdict.caller !== "member") throw new Error("expected the lead");
    expect(verdict.member.memberId).toBe("desk");
    expect(verdict.member.role).toBe("lead");
  });

  test("TWO anchors: a DEPUTY-attested dial is admitted AS THE DEPUTY, never as the lead", () => {
    const verdict = admitCrewRequest(peer, dialled({ deputy, dial: { memberId: "nas", isDeputy: true } }));
    if (!verdict.ok || verdict.caller !== "deputy") throw new Error("expected the deputy");
    expect(verdict.deputy).toEqual(deputy);
    // It is NOT a roster member and no roster entry is invented for it: this peer never enrolled it.
    expect(peer.peers).toEqual([]);
  });

  test("an attestation naming a member this collie does not pin admits nothing", () => {
    expect(admitCrewRequest(peer, dialled({ deputy, dial: { memberId: "attic", isDeputy: false } })).ok).toBe(false);
    // …and a deputy-shaped claim with no second anchor to back it is nobody at all.
    expect(admitCrewRequest(peer, dialled({ dial: { memberId: "nas", isDeputy: true } })).ok).toBe(false);
  });

  test("the §8.6 request signature still wins outright — the more specific claim is checked first", () => {
    const verdict = admitCrewRequest(peer, dialled({ deputy, signedMember: "desk" }));
    if (!verdict.ok || verdict.caller !== "member") throw new Error("expected the lead");
    expect(verdict.member.memberId).toBe("desk");
  });

  test("an attestation admits nothing WITHOUT the handshake — it is a second factor, not a first", () => {
    // A lead pins nothing inbound, so `transportPinned` is false there; an attestation alone must not
    // become a way in. §8.6's request signature is the peer→lead mechanism and it is unchanged.
    expect(admitCrewRequest(peer, facts({ transportPinned: false, signedMember: null, deputy, dial: { memberId: "desk", isDeputy: false } })).ok).toBe(false);
  });

  test("the secret is still required of both — one factor never admits anything", () => {
    const attested = dialled({ deputy, dial: { memberId: "desk", isDeputy: false }, authorization: null });
    expect(admitCrewRequest(peer, attested)).toEqual({ ok: false, refusal: "unauthorized", factor: "secret" });
  });
});
