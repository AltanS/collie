import { describe, expect, test } from "bun:test";

import {
  admitPackRequest,
  factsFrom,
  packResponseHeaders,
  parseProtocolHeader,
  protocolMismatchResponse,
  unauthorizedResponse,
  unwiredFingerprints,
  type PackRequestFacts,
} from "./admission.ts";
import { fp, leadStore, member, PACK, peerStore } from "./fixtures.ts";

// The two-factor gate (PACK_PROTOCOL.md §8.1) is the whole of federation's security posture, so it
// is tested as a MATRIX rather than as a set of happy paths: every combination of "which factor did
// the caller get right" has a row, and the refusals are compared against each other for
// indistinguishability rather than merely asserted to be 401.

/** Header names+values as a sorted list — `Headers` is not iterable under this tsconfig's lib. */
function headerList(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => out.push(`${key}: ${value}`));
  return out.sort();
}

const nas = member({ memberId: "nas" });
const store = leadStore({ peers: [nas] });

function facts(over: Partial<PackRequestFacts> = {}): PackRequestFacts {
  return {
    presentedFingerprint: fp("nas"),
    authorization: `Bearer ${PACK.secret}`,
    protocol: "1",
    ...over,
  };
}

describe("admitPackRequest — the failure matrix", () => {
  test("both factors correct admits, and names who called", () => {
    const verdict = admitPackRequest(store, facts());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.member.memberId).toBe("nas");
    expect(verdict.self).toBe("desk");
  });

  test("no secret at all is refused", () => {
    expect(admitPackRequest(store, facts({ authorization: null }))).toEqual({
      ok: false,
      refusal: "unauthorized",
      factor: "secret",
    });
  });

  test("a wrong secret is refused even with a pinned certificate", () => {
    expect(admitPackRequest(store, facts({ authorization: "Bearer nope" })).ok).toBe(false);
  });

  test("a ROTATED secret — the old value — is refused, with no grace window (§8.4)", () => {
    const rotated = leadStore({ peers: [nas], pack: { ...PACK, secret: "new-secret", secretGeneration: 2 } });
    expect(admitPackRequest(rotated, facts()).ok).toBe(false);
    expect(admitPackRequest(rotated, facts({ authorization: "Bearer new-secret" })).ok).toBe(true);
  });

  test("an UNPINNED certificate is refused even with the correct secret", () => {
    expect(admitPackRequest(store, facts({ presentedFingerprint: fp("stranger") }))).toEqual({
      ok: false,
      refusal: "unauthorized",
      factor: "certificate",
    });
  });

  test("NO certificate is refused — the unwired transport must not degrade to one factor", () => {
    expect(admitPackRequest(store, facts({ presentedFingerprint: null })).ok).toBe(false);
  });

  test("a pinned certificate with a wrong secret is refused — neither factor alone admits", () => {
    expect(admitPackRequest(store, facts({ authorization: "Bearer wrong" })).ok).toBe(false);
    expect(admitPackRequest(store, facts({ presentedFingerprint: fp("stranger"), authorization: null })).ok).toBe(
      false,
    );
  });

  test("an `unenrolled` member is pinned but refused (dropped by a rotation it missed)", () => {
    const dropped = leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] });
    const verdict = admitPackRequest(dropped, facts());
    expect(verdict).toEqual({ ok: false, refusal: "unauthorized", factor: "certificate" });
  });

  test("a collie with no trust store, and one with no pack, admit nothing", () => {
    expect(admitPackRequest(null, facts()).ok).toBe(false);
    expect(admitPackRequest(leadStore({ pack: null }), facts()).ok).toBe(false);
  });

  test("a peer admits its LEAD — pinning is pairwise and works in both directions", () => {
    const peer = peerStore();
    const verdict = admitPackRequest(peer, facts({ presentedFingerprint: fp("desk") }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.member.role).toBe("lead");
  });

  test("a Bearer scheme is required — the raw secret in the header is not a credential", () => {
    expect(admitPackRequest(store, facts({ authorization: PACK.secret })).ok).toBe(false);
    expect(admitPackRequest(store, facts({ authorization: `bearer ${PACK.secret}` })).ok).toBe(true);
  });
});

describe("admitPackRequest — version negotiation is LAST", () => {
  test("an admitted caller on a wrong version gets the legible mismatch (§7)", () => {
    expect(admitPackRequest(store, facts({ protocol: "2" }))).toEqual({
      ok: false,
      refusal: "protocol_mismatch",
      received: 2,
    });
  });

  test("a MISSING version header is a mismatch, never a default of 1", () => {
    expect(admitPackRequest(store, facts({ protocol: null }))).toEqual({
      ok: false,
      refusal: "protocol_mismatch",
      received: null,
    });
  });

  test("an UNAUTHENTICATED caller on a wrong version learns nothing — 401, not 409 (§8.5)", () => {
    // This ordering is the whole reconciliation of §7 (be legible) with §8.5 (no version banner):
    // the 409 exists, but only behind the gate. A prober cannot use it to discover the protocol.
    const verdict = admitPackRequest(store, facts({ protocol: "2", presentedFingerprint: null, authorization: null }));
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
      facts({ presentedFingerprint: fp("stranger") }),
      facts({ presentedFingerprint: null }),
      facts({ presentedFingerprint: fp("stranger"), authorization: null }),
    ];
    const shapes = await Promise.all(
      causes.map(async (f) => {
        expect(admitPackRequest(store, f).ok).toBe(false);
        const res = unauthorizedResponse();
        return JSON.stringify({
          status: res.status,
          body: await res.text(),
          headers: headerList(res),
        });
      }),
    );
    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0]!).body).toBe('{"error":"unauthorized"}');
  });

  test("the 401 carries NO pack headers — nothing tells a prober what is listening (§8.5)", () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(headerList(res).filter((h) => h.startsWith("x-pack"))).toEqual([]);
  });

  test("the body has no `code` and no cause — one shape, no hint at which factor failed", async () => {
    const body = (await unauthorizedResponse().json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
  });
});

describe("the 409 body names both sides", () => {
  test("it matches §7's shape exactly, and does state the version", async () => {
    const res = protocolMismatchResponse(2);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "pack protocol mismatch",
      code: "protocol_mismatch",
      expected: 1,
      received: 2,
    });
    expect(res.headers.get("x-pack-protocol")).toBe("1");
  });

  test("an unreadable version is reported as null rather than guessed", async () => {
    expect(((await protocolMismatchResponse(null).json()) as { received: unknown }).received).toBeNull();
  });
});

describe("the transport seam", () => {
  test("the default fingerprint source refuses everything — no config can make it single-factor", () => {
    const req = new Request("https://peer.example/pack/v1/hello");
    expect(unwiredFingerprints(req)).toBeNull();
    expect(admitPackRequest(store, factsFrom(req, unwiredFingerprints)).ok).toBe(false);
  });

  test("factsFrom reads only pack headers — never Origin, Host or a device header", () => {
    const req = new Request("https://peer.example/pack/v1/hello", {
      headers: {
        origin: "https://peer.example",
        host: "peer.example",
        "x-tailnet-device": "phone",
        authorization: `Bearer ${PACK.secret}`,
        "x-pack-protocol": "1",
      },
    });
    const f = factsFrom(req, () => fp("nas"));
    expect(Object.keys(f).sort()).toEqual(["authorization", "presentedFingerprint", "protocol"]);
    // Browser credentials are present on this request and admit nothing on their own.
    expect(admitPackRequest(store, { ...f, authorization: null }).ok).toBe(false);
  });
});

describe("admitted responses state their version and who answered (§6)", () => {
  test("packResponseHeaders carries the protocol and the member id", () => {
    expect(packResponseHeaders("desk")).toEqual({
      "content-type": "application/json; charset=utf-8",
      "x-pack-protocol": "1",
      "x-pack-member": "desk",
    });
  });
});
