import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../audit.ts";
import type { SnapshotResponse } from "../types.ts";
import { MEMBER_HEADER } from "./admission.ts";
import { HANDOVER_TTL_MS, mintInvite, type EnrollResponse } from "./enrollment.ts";
import { counterRandom, fp, leadStore, material, member, PACK, peerStore, T0 } from "./fixtures.ts";
import {
  createPackRouter,
  PACK_ENROLL_PATH,
  PACK_HELLO_PATH,
  PACK_LEAD_PATH,
  PACK_LEAVE_PATH,
  PACK_PREFIX,
  PACK_SECRET_PATH,
  PACK_SNAPSHOT_PATH,
  PACK_WARRANT_PATH,
  type SnapshotSource,
} from "./router.ts";
import { signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signing.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo, type Warrant } from "./trust-store.ts";
import { mintWarrant, WARRANT_TTL_MS } from "./warrant.ts";

// The endpoint. It takes a plain `Request` and needs no `Bun.serve`, so unlike the rest of the HTTP
// layer this IS unit-tested for real rather than pinned at the source.

/** Header names+values as a sorted list — `Headers` is not iterable under this tsconfig's lib. */
function headerList(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => out.push(`${key}: ${value}`));
  return out.toSorted();
}

function harness(initial: TrustStoreData) {
  const lines: AuditEntry[] = [];
  let contents: string | null = serializeTrustStore(initial);
  // `writes` counts trips to the disk, not changes to the data — the point of counting is that an
  // unauthenticated caller cannot make the store re-serialize at all (F4), even to the same bytes.
  let writes = 0;
  const io: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      writes += 1;
      contents = d;
    },
  };
  const store = new TrustStore("/unused", io);
  // SAFETY: the appender only ever sees formatAuditLine's own output, so the parse round-trips the
  // AuditEntry the router just recorded.
  const audit = new AuditLog((l) => void lines.push(JSON.parse(l) as AuditEntry), { now: () => T0 });
  return {
    store,
    audit,
    lines,
    data: () => store.current()!,
    writes: () => writes,
    contents: () => contents,
  };
}

function call(
  handler: ReturnType<typeof createPackRouter>,
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const url = new URL(`https://peer.example${path}`);
  return handler(new Request(url, init), url);
}

const authed = { authorization: `Bearer ${PACK.secret}`, "x-pack-protocol": "1" };

/**
 * Sign a §8.6 request as `memberLabel` — whose pinned certificate is `material(memberLabel).certPem`
 * — so a SIGNABLE_PATHS route admits it as that member. Only `leave`, `lead` and `hello` read these.
 */
function signed(memberLabel: string, method: string, path: string, body: string, timestamp: number) {
  return {
    [SIGNATURE_HEADER]: signRequest(material(memberLabel).keyPem, { method, path, body, timestamp }),
    [TIMESTAMP_HEADER]: String(timestamp),
  };
}

/**
 * A signed POST: `Authorization` + protocol + signature headers, and the body they cover. Generic in
 * the body so each call site's own literal type is what gets serialised — several tests post a
 * deliberately partial or wrong one, and that refusal is what they check.
 */
function signedPost<TBody>(memberLabel: string, path: string, body: TBody, timestamp: number): RequestInit {
  const json = JSON.stringify(body);
  return {
    method: "POST",
    headers: { ...authed, "content-type": "application/json", ...signed(memberLabel, "POST", path, json, timestamp) },
    body: json,
  };
}

describe("the prefix", () => {
  test("it is /pack/v1/ and collides with nothing reserved (§5)", () => {
    expect(PACK_PREFIX).toBe("/pack/v1/");
    for (const reserved of ["/auth", "/auth/", "/cdn-cgi/", "/api/"]) {
      expect(PACK_PREFIX.startsWith(reserved)).toBe(false);
      expect(reserved.startsWith(PACK_PREFIX)).toBe(false);
    }
  });

  test("a non-pack path returns null so the ordinary router continues", async () => {
    const h = harness(leadStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    for (const path of ["/", "/api/snapshot", "/auth/", "/packet", "/pack/v2/hello"]) {
      expect(await call(handler, path)).toBeNull();
    }
  });
});

describe("GET /pack/v1/hello — behind both factors", () => {
  const nas = member({ memberId: "nas" });

  test("an admitted lead gets liveness, version and the member id", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    // `hello` travels peer → lead: `nas` signs it, since the lead's front door cannot pin a client cert.
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: 1, member: "desk" });
    expect(res.headers.get("x-pack-protocol")).toBe("1");
    expect(res.headers.get("x-pack-member")).toBe("desk");
  });

  test("this build reports its own version, threaded in at boot (§5, §7.1)", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0,
      // Resolved ONCE by whoever constructs the router (bridge/index.ts) — never read per request.
      version: "1.0.0-alpha.12",
    });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(await res.json()).toEqual({ protocol: 1, member: "desk", version: "1.0.0-alpha.12" });
  });

  test("a router built without a version simply omits the field — absent, never empty (§7.1)", async () => {
    // The optional field's own absent-means-closed rule, applied to the responder: nothing sends
    // `"version": null` or `""`, because a prober reads absence as "older than the amendment" and a
    // present-but-meaningless value would be a claim.
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(Object.hasOwn(await res.json(), "version")).toBe(false);
  });

  test("without a pinned certificate it is 401 — the unwired default admits nobody", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: authed }))!;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("every refusal cause produces the identical response (§8.1)", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    // A stranger's signature — pinned by nobody in this store — so identity never admits either.
    const strangerSig = signed("stranger", "GET", PACK_HELLO_PATH, "", T0);
    const cases: Array<[string, HeadersInit]> = [
      ["no secret", { "x-pack-protocol": "1", ...strangerSig }],
      ["wrong secret", { authorization: "Bearer nope", "x-pack-protocol": "1", ...strangerSig }],
      ["no version", { authorization: `Bearer ${PACK.secret}`, ...strangerSig }],
      ["wrong version", { ...authed, "x-pack-protocol": "9", ...strangerSig }],
    ];
    const unpinned = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const refusals: string[] = [];
    for (const [, headers] of cases) {
      const res = (await call(unpinned, PACK_HELLO_PATH, { headers }))!;
      refusals.push(JSON.stringify({ status: res.status, body: await res.text(), headers: headerList(res) }));
    }
    expect(new Set(refusals).size).toBe(1);
    expect(JSON.parse(refusals[0]!).body).toBe('{"error":"unauthorized"}');
    // Not even a wrong VERSION leaks a 409 to an unpinned caller.
    expect(refusals[0]).not.toContain("protocol_mismatch");
  });

  test("an admitted caller on the wrong version DOES get the legible 409 (§7)", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, "x-pack-protocol": "2", ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "pack protocol mismatch",
      code: "protocol_mismatch",
      expected: 1,
      received: 2,
    });
  });

  test("an unimplemented pack route is a 404 only for an admitted caller, else the same 401", async () => {
    // `/pack/v1/snapshot` is not signable — it travels lead → peer over the pinned handshake — so an
    // admitted caller here is this collie's own PINNED LEAD, not a peer of its own.
    const h = harness(peerStore());
    const admitted = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    expect((await call(admitted, "/pack/v1/snapshot", { headers: authed }))!.status).toBe(404);
    const stranger = createPackRouter({ store: h.store, audit: h.audit });
    expect((await call(stranger, "/pack/v1/snapshot", { headers: authed }))!.status).toBe(401);
  });

  test("a refusal is audited locally with its real cause", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    await call(handler, PACK_HELLO_PATH, { headers: authed });
    await Bun.sleep(5);
    expect(h.lines.map((l) => [l.action, l.detail?.factor])).toEqual([
      ["pack.refused", "certificate"],
    ]);
  });
});

/** A minimal but shape-correct snapshot body — this peer's own view, never a merged one (§9.2). */
function ownSnapshot(over: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return {
    bridge: "connected",
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 0, working: 0, blocked: 0 }],
    ts: T0,
    ...over,
  };
}

describe("GET /pack/v1/snapshot — the one merged route, §9.2", () => {
  // `snapshot` is not signable — it travels lead → peer over the pinned handshake (the lead dials
  // each peer to merge its view). So the admitted caller here is this collie's own PINNED LEAD.

  test("an admitted caller gets the peer's own snapshot body verbatim, with the pack headers", async () => {
    const h = harness(peerStore());
    const body = ownSnapshot();
    const source: SnapshotSource = () => body;
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, snapshot: source });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get("x-pack-protocol")).toBe("1");
    expect(res.headers.get("x-pack-member")).toBe("laptop");
  });

  test("?session= is passed through to the injected source", async () => {
    const h = harness(peerStore());
    const calls: Array<string | undefined> = [];
    const source: SnapshotSource = (session) => {
      calls.push(session);
      return ownSnapshot();
    };
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, snapshot: source });
    await call(handler, `${PACK_SNAPSHOT_PATH}?session=collie-demo`, { headers: authed });
    expect(calls).toEqual(["collie-demo"]);
  });

  test("an unknown session (source returns undefined) is the peer's OWN 404, not the lead's", async () => {
    const h = harness(peerStore());
    const source: SnapshotSource = () => undefined;
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, snapshot: source });
    const res = (await call(handler, `${PACK_SNAPSHOT_PATH}?session=nope`, { headers: authed }))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown session" });
  });

  test("a router built WITHOUT a snapshot dep 404s exactly like any unimplemented route", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("an UNADMITTED caller gets the standard 401 and the snapshot source is NEVER invoked", async () => {
    const h = harness(peerStore());
    let calls = 0;
    const source: SnapshotSource = () => {
      calls += 1;
      return ownSnapshot();
    };
    // transportPinned not set => the unwired default admits nobody, same as the hello tests.
    const handler = createPackRouter({ store: h.store, audit: h.audit, snapshot: source });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("a non-GET method on the path falls through to the ordinary 404, not 405", async () => {
    const h = harness(peerStore());
    const source: SnapshotSource = () => ownSnapshot();
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, snapshot: source });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { method: "POST", headers: authed }))!;
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(405);
  });
});

describe("POST /pack/v1/enroll — admitted by the TOKEN, not by the two factors", () => {
  function invited() {
    const minted = mintInvite(leadStore({ peers: [] }), { now: T0, label: "laptop", random: counterRandom("r") });
    const h = harness(minted.next);
    return { ...h, token: minted.result.token };
  }

  /** The §8.2 enroll body a joiner posts. Every field optional: several tests below post a wrong or
   *  missing one on purpose, and refusing that is what they check. */
  interface EnrollBody {
    protocol?: number;
    fingerprint?: string;
    certPem?: string;
    address?: string;
    label?: string;
    token?: string;
  }

  const body = (over: EnrollBody = {}): EnrollBody => ({
    protocol: 1,
    fingerprint: fp("laptop"),
    certPem: material("laptop").certPem,
    address: "laptop.ts.net:8787",
    label: "laptop",
    ...over,
  });

  test("a valid token enrolls, pins the peer, and returns §8.2's whole transfer", async () => {
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(res.status).toBe(200);
    // SAFETY: a 200 on the enroll route is defined by §8.2 to carry the whole transfer — the router
    // has no other 200 body for this path, and the assertions below check every field of it.
    const payload = (await res.json()) as EnrollResponse;
    expect(payload.memberId).toBe("laptop");
    expect(payload.leadMemberId).toBe("desk");
    expect(payload.leadFingerprint).toBe(fp("desk"));
    expect(payload.packSecret).toBeString();
    // The peer is now pinned on the lead's roster, and the invite is gone.
    expect(h.data().peers.map((p) => [p.memberId, p.fingerprint])).toEqual([["laptop", fp("laptop")]]);
    expect(h.data().invites).toEqual([]);
  });

  test("the token is single-use — the same request twice is refused the second time", async () => {
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    const send = () =>
      call(handler, PACK_ENROLL_PATH, {
        method: "POST",
        headers: { "x-pack-protocol": "1" },
        body: JSON.stringify(body({ token: h.token })),
      });
    expect((await send())!.status).toBe(200);
    expect((await send())!.status).toBe(401);
  });

  test("THE TOKEN IS SPENT EVEN WHEN THE EXCHANGE FAILS AFTERWARDS", async () => {
    // A stolen token must not be retriable against a second failure mode until one sticks.
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    const bad = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "77" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(bad.status).toBe(409);
    expect(h.data().invites).toEqual([]);
    // …and the good request that follows now has nothing to spend.
    const after = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(after.status).toBe(401);
    expect(h.data().peers).toEqual([]);
  });

  test("a wrong token, a malformed body and a GET are all the same 401", async () => {
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    const refusals: string[] = [];
    for (const init of [
      { method: "POST", body: JSON.stringify(body({ token: "wrong" })) },
      { method: "POST", body: "{not json" },
      { method: "POST", body: JSON.stringify({ token: h.token }) },
      { method: "GET" },
    ] satisfies RequestInit[]) {
      const res = (await call(handler, PACK_ENROLL_PATH, { ...init, headers: { "x-pack-protocol": "1" } }))!;
      refusals.push(JSON.stringify({ status: res.status, body: await res.text(), headers: headerList(res) }));
    }
    expect(new Set(refusals).size).toBe(1);
    expect(JSON.parse(refusals[0]!).body).toBe('{"error":"unauthorized"}');
  });

  test("an expired token is refused", async () => {
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 11 * 60 * 1000 });
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(res.status).toBe(401);
  });

  // The two "TLS fingerprint (dis)agrees with the payload's claim" cases that used to live here are
  // gone: the production `enroll()` handler never consults `deps.transportPinned` or a signature at
  // all. "THE CERTIFICATE ARRIVES IN THE PAYLOAD, AND THAT IS THE WHOLE TRUST STORY HERE (§8.2)" —
  // `router.ts`'s own comment on `enroll()` — because the lead's front door terminates TLS, so no
  // client certificate can ever reach this process on this route. What the old tests exercised (a
  // transport-level identity check gating enrollment) is not merely unwired now, it is asserted in
  // the shipping code to not exist on this path.

  test("F4: a junk enroll rewrites NOTHING — no store write, no audit line, unbounded and free to us", async () => {
    // The endpoint is unauthenticated by design, so a no-op spend that still persisted turned every
    // garbage POST into a re-serialize of the file holding the private key and the pack secret.
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    // Load the store once up front so the baseline is "loaded, not written".
    await h.store.load();
    const before = h.contents();
    for (const payload of [{}, body({ token: "bogus" }), { token: "bogus" }, "not-a-json-object"]) {
      const res = (await call(handler, PACK_ENROLL_PATH, {
        method: "POST",
        headers: { "x-pack-protocol": "1" },
        body: JSON.stringify(payload),
      }))!;
      expect(res.status).toBe(401);
    }
    await Bun.sleep(5);
    expect(h.writes()).toBe(0);
    expect(h.contents()).toBe(before);
    // No spend was recorded. The `pack.refused` lines `refuse()` writes are a separate, deliberate
    // record of the refusal itself (see "a refusal is audited locally with its real cause") — what
    // F4 was about is the store write and the spend line that used to accompany it.
    expect(h.lines.map((l) => l.action)).not.toContain("pack.invite.spend");
    // The live invite is untouched: refusing junk must not sweep what has not expired.
    expect(h.data().invites).toHaveLength(1);
  });

  test("F4: the refusal is byte-identical whether the no-op wrote or the sweep did", async () => {
    // Case C (nothing matched, nothing expired → no write) and case B (nothing matched, but an
    // expired invite was swept → a write DID happen) must be indistinguishable from outside, or the
    // fix has traded a write-amplification for an oracle on "is there an expired invite in there".
    const refusals: string[] = [];
    let sweepWrites = 0;
    for (const [at, expectWrite] of [
      [T0 + 1, false],
      [T0 + 11 * 60 * 1000, true],
    ] as const) {
      const h = invited();
      const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => at });
      const res = (await call(handler, PACK_ENROLL_PATH, {
        method: "POST",
        headers: { "x-pack-protocol": "1" },
        body: JSON.stringify(body({ token: "bogus" })),
      }))!;
      refusals.push(JSON.stringify({ status: res.status, body: await res.text(), headers: headerList(res) }));
      expect(h.writes() > 0).toBe(expectWrite);
      sweepWrites += h.writes();
    }
    // The two branches really were different underneath…
    expect(sweepWrites).toBe(1);
    // …and identical on the wire.
    expect(new Set(refusals).size).toBe(1);
    expect(JSON.parse(refusals[0]!).body).toBe('{"error":"unauthorized"}');
  });

  test("F4: a REAL invite still enrolls after the no-op path stopped writing", async () => {
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    for (const junk of [{}, body({ token: "bogus" })]) {
      await call(handler, PACK_ENROLL_PATH, {
        method: "POST",
        headers: { "x-pack-protocol": "1" },
        body: JSON.stringify(junk),
      });
    }
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(res.status).toBe(200);
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["laptop"]);
    expect(h.data().invites).toEqual([]);
  });

  test("enrollment never leaks the token into the audit log", async () => {
    const h = invited();
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
    await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    });
    await Bun.sleep(5);
    expect(h.lines.map((l) => l.action)).toEqual(["pack.invite.spend", "pack.enroll"]);
    expect(JSON.stringify(h.lines)).not.toContain(h.token);
  });
});

describe("browser credentials admit nothing here", () => {
  test("a same-origin browser request with a device header is still refused", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: {
        origin: "https://peer.example",
        host: "peer.example",
        "x-tailnet-device": "phone",
        "tailscale-user-login": "operator@example.com",
      },
    }))!;
    expect(res.status).toBe(401);
  });
});

// ── §5: the pane/tab/workspace half of the peer surface ──────────────────────
//
// The rule is 1:1 dispatch INTO THE SAME HANDLERS, so what these tests pin is the wiring, not a
// second implementation: which paths reach the injected dispatch, what URL it is handed, what it is
// told about who asked, and what happens to its answer on the way out. What the handlers then DO is
// bridge/server.ts's business and is asserted there.

describe("dispatched routes — the peer runs its own routes for an admitted lead (§5)", () => {
  const nas = member({ memberId: "nas" });

  /** A dispatch that records what it was handed and answers with whatever the test wants. */
  function dispatcher(answer: () => Response) {
    const seen: { path: string; search: string; from: string; method: string }[] = [];
    return {
      seen,
      dispatch: async (req: Request, url: URL, from: string) => {
        seen.push({ path: url.pathname, search: url.search, from, method: req.method });
        return answer();
      },
    };
  }

  // §5 dispatch is not signable — it travels lead → peer over the pinned handshake — so this
  // router models a PEER ("laptop") answering its own admitted LEAD ("desk"), not a lead answering
  // one of its own peers.
  function peerRouter(d?: ReturnType<typeof dispatcher>) {
    const h = harness(peerStore());
    return {
      h,
      handler: createPackRouter(
        // A router built with NO `dispatch` is a different thing from one built with `undefined` —
        // the unwired default is what several tests below exercise — so the key is added, not spread.
        d === undefined
          ? { store: h.store, audit: h.audit, transportPinned: true }
          : { store: h.store, audit: h.audit, transportPinned: true, dispatch: d.dispatch },
      ),
    };
  }

  test("every §5 route reaches the dispatch as its own /api path, verbatim", async () => {
    const d = dispatcher(() => new Response(`{"ok":true}`, { status: 200 }));
    const { handler } = peerRouter(d);
    const routes: Array<[string, string]> = [
      ["pane/w1:p1", "GET"],
      ["pane/w1:p1/history", "GET"],
      ["pane/w1:p1/reply", "POST"],
      ["pane/w1:p1/keys", "POST"],
      ["pane/w1:p1/upload", "POST"],
      ["pane/w1:p1/close", "POST"],
      ["pane/w1:p1/rename", "POST"],
      ["tab", "POST"],
      ["tab/w1:t1/rename", "POST"],
      ["tab/w1:t1/close", "POST"],
      ["workspace", "POST"],
    ];
    for (const [route, method] of routes) {
      // A GET with a `body` key at all is a TypeError from `new Request`, so the key is added only
      // for the POSTs rather than spread in as an empty object.
      const init: RequestInit = { method, headers: authed };
      if (method === "POST") init.body = "{}";
      const res = (await call(handler, `${PACK_PREFIX}${route}`, init))!;
      expect(res.status).toBe(200);
    }
    expect(d.seen.map((s) => s.path)).toEqual(routes.map(([r]) => `/api/${r}`));
    // Who forwarded it — the member the two factors proved, never a header the caller chose.
    expect(new Set(d.seen.map((s) => s.from))).toEqual(new Set(["desk"]));
  });

  test("`?session=` rides through untouched — the PEER's registry resolves it (§5)", async () => {
    const d = dispatcher(() => new Response("{}"));
    const { handler } = peerRouter(d);
    await call(handler, `${PACK_PREFIX}pane/w1:p1?session=work&lines=80`, { headers: authed });
    expect(d.seen[0]!.search).toBe("?session=work&lines=80");
  });

  test("a pack request may NOT name a host — a peer has no peers (§4)", async () => {
    const d = dispatcher(() => new Response("{}"));
    const { handler } = peerRouter(d);
    const res = (await call(handler, `${PACK_PREFIX}pane/w1:p1?host=desk`, { headers: authed }))!;
    expect(res.status).toBe(400);
    // Refused before dispatch: there is no first hop of a chain this protocol does not have.
    expect(d.seen).toEqual([]);
  });

  test("the routes §5 excludes are not reachable across a link, even though they exist locally", async () => {
    const d = dispatcher(() => new Response("{}"));
    const { handler } = peerRouter(d);
    for (const route of ["subscribe", "notifications/snooze", "notifications/prefs", "update/check", "config"]) {
      expect((await call(handler, `${PACK_PREFIX}${route}`, { method: "POST", headers: authed }))!.status).toBe(404);
    }
    expect(d.seen).toEqual([]);
  });

  test("an unadmitted caller never reaches the dispatch — routing happens after both factors", async () => {
    const d = dispatcher(() => new Response("{}"));
    const h = harness(leadStore({ peers: [nas] }));
    const stranger = createPackRouter({ store: h.store, audit: h.audit, dispatch: d.dispatch });
    const res = (await call(stranger, `${PACK_PREFIX}pane/w1:p1/reply`, { method: "POST", headers: authed }))!;
    expect(res.status).toBe(401);
    expect(d.seen).toEqual([]);
  });

  test("the answer keeps its own status and body, and gains the pack headers §6 requires", async () => {
    const d = dispatcher(() => new Response(`{"ok":false,"error":"no such pane"}`, { status: 404 }));
    const { handler } = peerRouter(d);
    const res = (await call(handler, `${PACK_PREFIX}pane/nope`, { headers: authed }))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "no such pane" });
    // Not cosmetic: the lead checks the version BEFORE it reads a byte (§7), so an unstamped
    // response from a perfectly healthy peer would read as a version skew.
    expect(res.headers.get("x-pack-protocol")).toBe("1");
    expect(res.headers.get("x-pack-member")).toBe("laptop");
  });

  test("a 304 survives the peer surface with its ETag and no body (§9.1)", async () => {
    const d = dispatcher(() => new Response(null, { status: 304, headers: { etag: '"peer-etag"' } }));
    const { handler } = peerRouter(d);
    const res = (await call(handler, `${PACK_PREFIX}pane/w1:p1`, {
      headers: { ...authed, "if-none-match": '"peer-etag"' },
    }))!;
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"peer-etag"');
    expect(res.body).toBeNull();
  });

  test("a build with no dispatch wired 404s the whole half of the table", async () => {
    const { handler } = peerRouter();
    expect((await call(handler, `${PACK_PREFIX}pane/w1:p1`, { headers: authed }))!.status).toBe(404);
  });
});

// ── The membership routes (M4/07) ────────────────────────────────────────────
// The receiving halves of `collie pack rotate`, `collie promote` and `collie leave`. Each one is
// behind the same two factors as everything else on the prefix, and each has a role check on top —
// because "an admitted member" and "the member allowed to do THIS" are different questions.

/** A plain (unsigned) JSON POST. Generic in the body for the same reason `signedPost` is. */
/** A refusal body on the prefix: §8.x answers every "no" with a machine-readable `code`. */
interface PackRefusal {
  code: string;
}

const post = <TBody,>(body: TBody): RequestInit => ({
  method: "POST",
  headers: { ...authed, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /pack/v1/secret — the peer side of rotation (§8.4)", () => {
  // `secret` is not signable — it travels lead → peer over the pinned handshake — so `asLead` admits
  // via `transportPinned`, which resolves to exactly this collie's own pinned lead ("desk").
  const asLead = (h: ReturnType<typeof harness>) =>
    createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, now: () => T0 });

  test("this collie's own lead hands it the new secret and generation", async () => {
    const h = harness(peerStore());
    const res = (await call(asLead(h), PACK_SECRET_PATH, post({ secret: "new-secret-value-xxxxxxxxxxxx", generation: 2 })))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generation: 2, applied: true });
    expect(h.data().pack!.secret).toBe("new-secret-value-xxxxxxxxxxxx");
    expect(h.data().pack!.secretGeneration).toBe(2);
  });

  test("a redelivery answers 200 and applies nothing — the lead's question is still answered", async () => {
    const h = harness(peerStore());
    const res = (await call(asLead(h), PACK_SECRET_PATH, post({ secret: "whatever-value-yyyyyyyyyyyy", generation: 1 })))!;
    expect(await res.json()).toEqual({ generation: 1, applied: false });
    expect(h.data().pack!.secret).toBe(PACK.secret);
  });

  test("a collie that IS the lead has no lead of its own to admit here — this route is peer-only", async () => {
    // `secret` is not signable, and `transportPinned` only ever resolves to `data.lead` (§8.6's
    // comment: a peer's listener pins exactly one certificate, its lead's). A LEAD's own store has no
    // `lead` of its own, so nobody — not even one of its own peers, "nas" — can be admitted here at
    // all: the role check `secret()` still carries (`data.lead.memberId !== from.memberId`) is
    // unreachable from an admitted caller now that the transport enforces it one layer up. This
    // replaces the old "an admitted-but-wrong-member is refused" case, which the new admission model
    // no longer lets a test construct: nothing can present as an identified caller here except a
    // collie's own pinned lead.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_SECRET_PATH, post({ secret: "hostile-value-zzzzzzzzzzzzz", generation: 99 })))!;
    expect(res.status).toBe(401);
    expect(h.data().pack!.secret).toBe(PACK.secret);
    expect(h.lines.map((l) => l.action)).toContain("pack.refused");
  });

  test("an unadmitted caller cannot reach it at all", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    const res = (await call(handler, PACK_SECRET_PATH, post({ secret: "x".repeat(20), generation: 2 })))!;
    expect(res.status).toBe(401);
    expect(h.data().pack!.secret).toBe(PACK.secret);
  });

  test("a body missing either field is a 400, not a half-applied rotation", async () => {
    const h = harness(peerStore());
    for (const body of [{ generation: 2 }, { secret: "x".repeat(20) }, { secret: "", generation: 2 }]) {
      const res = (await call(asLead(h), PACK_SECRET_PATH, post(body)))!;
      expect(res.status).toBe(400);
    }
    expect(h.data().pack!.secretGeneration).toBe(1);
  });
});

describe("POST /pack/v1/lead — the promotion handover (§14)", () => {
  const claim = { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:8787" };

  /** A lead's store with the operator's consent for `memberId` armed on it (§14.1). */
  const approving = (memberId: string, over: Partial<TrustStoreData> = {}): TrustStoreData =>
    leadStore({
      peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })],
      pendingHandover: { memberId, createdAt: T0, expiresAt: T0 + HANDOVER_TTL_MS },
      ...over,
    });

  test("the old lead demotes itself and answers with its roster", async () => {
    // A NEW lead ("nas") claiming the crown travels peer → lead — the old lead ("desk") cannot pin a
    // client certificate, so "nas" proves itself with a §8.6 signature instead. And a signature is
    // not consent (§14): the operator armed an approval on this machine first.
    const h = harness(approving("nas"));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_LEAD_PATH, signedPost("nas", PACK_LEAD_PATH, { lead: claim }, T0)))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      demoted: "desk",
      roster: [{ memberId: "laptop", fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "laptop.example:8787" }],
    });
    expect(h.data().lead).toMatchObject({ memberId: "nas", role: "lead" });
    expect(h.data().peers).toEqual([]);
    // A role change, not a re-enrollment: the pack identity and secret are untouched.
    expect(h.data().pack).toEqual(PACK);
    // The consent was spent in the same write as the role flip — one approval cannot demote twice.
    expect(h.data().pendingHandover).toBeNull();
  });

  test("an UNAPPROVED claim is refused 403, and the store is not written at all", async () => {
    // The F2 case, closed: a §8.6-signed self-claim from an enrolled member, with no operator at the
    // keyboard of the machine being taken from.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    // One write happens before the handler runs, and only one: §8.6's replay floor for this signed
    // membership call. Gate 1 must not compound it — a refusal adds no second write.
    const before = h.writes();
    const res = (await call(handler, PACK_LEAD_PATH, signedPost("nas", PACK_LEAD_PATH, { lead: claim }, T0)))!;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'this lead has not approved "nas" to take over — run `collie pack approve-promote nas` here, then ' +
        "re-run `collie promote` on that machine within 10 minutes",
      code: "handover_not_approved",
    });
    expect(h.writes()).toBe(before + 1);
    // Nothing moved: still the lead, still holding its roster.
    expect(h.data().lead).toBeNull();
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas", "laptop"]);
    expect(h.lines.map((l) => l.action)).toContain("pack.lead.refused");
  });

  test("the refusal is BYTE-IDENTICAL whether nobody or somebody else is approved", async () => {
    // The claimant is never told who *is* approved — that is the operator's business on the lead.
    const bodies: string[] = [];
    for (const store of [
      leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }),
      approving("laptop"),
      // …and an approval for the right member that has aged out of its window.
      approving("nas", { pendingHandover: { memberId: "nas", createdAt: T0 - HANDOVER_TTL_MS, expiresAt: T0 } }),
    ]) {
      const h = harness(store);
      const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
      const res = (await call(handler, PACK_LEAD_PATH, signedPost("nas", PACK_LEAD_PATH, { lead: claim }, T0)))!;
      expect(res.status).toBe(403);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test("consent names the certificate: an approved member claiming under another key is refused", async () => {
    // "nas" is approved and signs as itself, but claims a fingerprint the lead has not pinned for it.
    // Without this clause the old lead would pin whatever certificate the claim carried.
    const h = harness(approving("nas"));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const impostor = { ...claim, fingerprint: fp("laptop"), certPem: material("laptop").certPem };
    const res = (await call(handler, PACK_LEAD_PATH, signedPost("nas", PACK_LEAD_PATH, { lead: impostor }, T0)))!;
    expect(res.status).toBe(403);
    // SAFETY: every §8.x refusal body carries a `code` (this is the shape asserted verbatim in the
    // "every refusal cause produces the identical response" test above).
    expect(((await res.json()) as PackRefusal).code).toBe("handover_not_approved");
    expect(h.data().lead).toBeNull();
    // The consent is NOT spent by a refusal — the operator's ten minutes are still theirs.
    expect(h.data().pendingHandover).toMatchObject({ memberId: "nas" });
  });

  test("a peer re-pins the new lead and answers with an empty roster — it has no peers", async () => {
    // Here the direction reverses: the CURRENT lead ("desk") relays a promotion it already accepted
    // to one of its remaining peers — lead → peer, over the pinned handshake, so `transportPinned`.
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, now: () => T0 });
    const relayed = { memberId: "desk", fingerprint: fp("desk"), certPem: material("desk").certPem, address: "desk.moved:8787" };
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: relayed })))!;
    expect(await res.json()).toEqual({ lead: "desk", applied: true, roster: [] });
    expect(h.data().lead!.address).toBe("desk.moved:8787");
  });

  test("a member may only claim leadership FOR ITSELF — nobody nominates a third party", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: { ...claim, memberId: "nas" } })))!;
    expect(res.status).toBe(400);
    expect(h.data().lead!.memberId).toBe("desk");
  });

  test("an unadmitted caller cannot move the crown", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: claim })))!;
    expect(res.status).toBe(401);
    expect(h.data().lead).toBeNull();
  });

  test("a malformed claim is a 400 on an admitted link — it may say why", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: { memberId: "desk" } })))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a leadership claim needs `lead`" });
  });
});

describe("POST /pack/v1/leave — the caller drops ITSELF (§8.4)", () => {
  // `leave` travels peer → lead — the lead cannot pin a client certificate — so every admitted call
  // here is a §8.6 signature from the leaving member.

  test("an admitted member removes its own roster entry and nothing else", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_LEAVE_PATH, signedPost("nas", PACK_LEAVE_PATH, { member: "laptop" }, T0)))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "nas" });
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["laptop"]);
  });

  test("leaving twice is 200 both times — the operator's question has the same answer", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    expect((await call(handler, PACK_LEAVE_PATH, signedPost("nas", PACK_LEAVE_PATH, {}, T0)))!.status).toBe(200);
    // "nas" is no longer in the roster at all — its signature can no longer be verified against
    // anything pinned, so the second call is refused rather than re-admitted.
    expect((await call(handler, PACK_LEAVE_PATH, signedPost("nas", PACK_LEAVE_PATH, {}, T0)))!.status).toBe(401);
  });

  test("an unadmitted caller removes nobody", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    expect((await call(handler, PACK_LEAVE_PATH, post({})))!.status).toBe(401);
    expect(h.data().peers).toHaveLength(1);
  });
});

// ── The change this process persisted but did not wire ───────────────────────
// A membership change arriving over the wire lands in the store of a RUNNING bridge that read its
// roster at boot and does not re-read it. Nothing re-wires in place (bridge/pack/staleness.ts says
// why); what the router owes is a notification, so the process can say so in its own journal.

describe("onMembershipChange", () => {
  const claim = { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:8787" };

  test("the FIRST enrollment fires it — the lead persisted a peer it is not serving", async () => {
    const minted = mintInvite(leadStore({ peers: [] }), { now: T0, label: "laptop", random: counterRandom("r") });
    const h = harness(minted.next);
    let fired = 0;
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0 + 1,
      onMembershipChange: () => void fired++,
    });
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pack-protocol": "1" },
      body: JSON.stringify({
        protocol: 1,
        token: minted.result.token,
        fingerprint: fp("laptop"),
        certPem: material("laptop").certPem,
        address: "laptop.ts.net:8787",
        label: "laptop",
      }),
    }))!;
    expect(res.status).toBe(200);
    expect(fired).toBe(1);
  });

  test("a REFUSED enrollment does not — nothing changed, so nothing is stale", async () => {
    const h = harness(leadStore({ peers: [] }));
    let fired = 0;
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0,
      onMembershipChange: () => void fired++,
    });
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pack-protocol": "1" },
      body: JSON.stringify({ protocol: 1, token: "nope", fingerprint: fp("laptop") }),
    }))!;
    expect(res.status).toBe(401);
    expect(fired).toBe(0);
  });

  test("a demotion fires it — the process is still a lead in every way but the store", async () => {
    const h = harness(
      leadStore({
        peers: [member({ memberId: "nas" })],
        // The operator's consent, armed here first — a demotion has no other way to happen (§14).
        pendingHandover: { memberId: "nas", createdAt: T0, expiresAt: T0 + HANDOVER_TTL_MS },
      }),
    );
    let fired = 0;
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0,
      onMembershipChange: () => void fired++,
    });
    const res = (await call(handler, PACK_LEAD_PATH, signedPost("nas", PACK_LEAD_PATH, { lead: claim }, T0)))!;
    expect(res.status).toBe(200);
    expect(fired).toBe(1);
    // …and the router itself did NOT act on it: no restart, no re-wire, no front-door change.
    expect(h.data().lead!.memberId).toBe("nas");
  });
});

// ── Each factor, refused ALONE, on the routes that would otherwise write ─────
//
// `admission.test.ts` pins the DECISION matrix; what these pin is what the HANDLER does with a
// refusal. Every case below satisfies one factor completely and fails the other, so the thing being
// measured is the surviving factor carrying the refusal on its own — never the two of them failing
// together, which is what the older "an unadmitted caller …" tests exercise (they carry the correct
// secret and no certificate at all).
//
// And the assertion is the THREAT PROPERTY, not the status code. Alongside the 401, each test proves
// the store did not move: nothing pinned, nothing rotated, no crown moved, no roster entry dropped,
// no §8.6 replay floor advanced — and, in `h.writes()`, not one trip to the disk. That last one is
// the same shape as F4 and as `audit.test.ts`'s "a flood of refusals stays bounded": a caller who
// cannot pass both factors must not be able to make this process re-serialize the file holding its
// private key and the pack secret, however many times it asks.
//
// All material here is fixture-minted and obviously fake — `wrong-secret`, an all-zero fingerprint,
// a `stranger` label no store in this file pins.

/** A secret no pack could have minted. `PACK.secret` is the only correct value in this file. */
const WRONG_SECRET = "wrong-secret";

/**
 * A §8.6-signed POST whose credential is chosen by the caller: `secret: null` omits `Authorization`
 * entirely. `signedPost` always sends the correct one, which is exactly what these tests must vary.
 */
function signedPostWith<TBody>(
  memberLabel: string,
  path: string,
  body: TBody,
  timestamp: number,
  secret: string | null,
  claimedMember?: string,
): RequestInit {
  const json = JSON.stringify(body);
  const base = {
    "x-pack-protocol": "1",
    "content-type": "application/json",
    ...signed(memberLabel, "POST", path, json, timestamp),
  };
  const claiming = claimedMember === undefined ? base : { ...base, [MEMBER_HEADER]: claimedMember };
  const headers = secret === null ? claiming : { ...claiming, authorization: `Bearer ${secret}` };
  return { method: "POST", headers, body: json };
}

/** The `Authorization`-carrying half of `authed`, replaced with a value of the test's choosing. */
const withSecret = (secret: string) => ({
  "x-pack-protocol": "1",
  "content-type": "application/json",
  authorization: `Bearer ${secret}`,
});

describe("N1 — the pack secret alone: a wrong or missing one refuses, and changes nothing", () => {
  const claim = { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:8787" };

  test("a correctly-signed `leave` with the WRONG secret removes nobody, and never touches the disk", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    // Load once up front so the baseline is "loaded, not written" — the same framing as F4's.
    await h.store.load();
    const before = h.contents();
    const res = (await call(handler, PACK_LEAVE_PATH, signedPostWith("nas", PACK_LEAVE_PATH, {}, T0, WRONG_SECRET)))!;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // The roster is exactly as it was, and so are the bytes on disk. This is the strong half: the
    // signature verified, so §8.6's replay floor was one line away from being committed — but the
    // floor advances only AFTER admission, so a caller refused on the secret cannot move it either.
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas", "laptop"]);
    expect(h.writes()).toBe(0);
    expect(h.contents()).toBe(before);
    await Bun.sleep(5);
    // One audit line, and it is the refusal — no membership line claiming a change that did not happen.
    expect(h.lines.map((l) => [l.action, l.detail?.factor])).toEqual([["pack.refused", "secret"]]);
  });

  test("NO secret at all is the same refusal, with the same nothing behind it", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    await h.store.load();
    const res = (await call(handler, PACK_LEAVE_PATH, signedPostWith("nas", PACK_LEAVE_PATH, {}, T0, null)))!;
    expect(res.status).toBe(401);
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas"]);
    expect(h.writes()).toBe(0);
    // …and the honest call that follows still works, so the refusal is the secret and nothing else.
    const ok = (await call(handler, PACK_LEAVE_PATH, signedPost("nas", PACK_LEAVE_PATH, {}, T0)))!;
    expect(ok.status).toBe(200);
    expect(h.data().peers).toEqual([]);
  });

  test("this collie's own lead, on the PINNED transport, cannot rotate the secret without it (§8.4)", async () => {
    // Factor 1 is satisfied the strongest way this surface allows — the request arrived on a listener
    // BoringSSL built pin-enforcing, so the caller can only be this peer's lead — and it is still
    // refused. A rotation is the one route where a single-factor slip would hand the pack away.
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, now: () => T0 });
    await h.store.load();
    const res = (await call(handler, PACK_SECRET_PATH, {
      method: "POST",
      headers: withSecret(WRONG_SECRET),
      body: JSON.stringify({ secret: "attacker-chosen-value-000000", generation: 99 }),
    }))!;
    expect(res.status).toBe(401);
    expect(h.data().pack!.secret).toBe(PACK.secret);
    expect(h.data().pack!.secretGeneration).toBe(1);
    expect(h.writes()).toBe(0);
  });

  test("an APPROVED handover still needs the secret — the operator's consent is not a factor (§14)", async () => {
    // Everything else about this request is right: the operator armed the approval on this machine,
    // the claimant is pinned, and it signed for itself. The secret is the only thing missing.
    const h = harness(
      leadStore({
        peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })],
        pendingHandover: { memberId: "nas", createdAt: T0, expiresAt: T0 + HANDOVER_TTL_MS },
      }),
    );
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    await h.store.load();
    const res = (await call(
      handler,
      PACK_LEAD_PATH,
      signedPostWith("nas", PACK_LEAD_PATH, { lead: claim }, T0, WRONG_SECRET),
    ))!;
    // Not even §14.3's legible 403 — that one is for a caller who cleared both factors. This is the
    // uniform 401, and the crown did not move.
    expect(res.status).toBe(401);
    expect(h.data().lead).toBeNull();
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas", "laptop"]);
    // The ten minutes are still the operator's: a refused claim does not spend the consent.
    expect(h.data().pendingHandover).toMatchObject({ memberId: "nas" });
    expect(h.writes()).toBe(0);
  });

  test("a wrong secret never reaches the dispatched handlers — nothing types into a terminal", async () => {
    // The §5 half. `reply` and `keys` end at a real PTY, so "refused before dispatch" is the property
    // that keeps a one-factor caller off the pane surface entirely.
    const h = harness(peerStore());
    const seen: string[] = [];
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      dispatch: (_req, url) => {
        seen.push(url.pathname);
        return Promise.resolve(new Response("{}"));
      },
    });
    for (const route of ["pane/w1:p1", "pane/w1:p1/reply", "pane/w1:p1/keys"]) {
      const init: RequestInit = { method: "POST", headers: withSecret(WRONG_SECRET), body: "{}" };
      expect((await call(handler, `${PACK_PREFIX}${route}`, init))!.status).toBe(401);
    }
    expect(seen).toEqual([]);
    expect(h.writes()).toBe(0);
  });
});

describe("N2 — the pinned certificate alone: an identity this collie does not pin refuses", () => {
  // The TLS handshake itself needs a live `Bun.serve` and cannot run here (bridge/pack/transport.ts
  // records why Bun exposes no way to read a presented certificate at all). So the factor is pinned
  // where it is DECIDED instead, in two places that between them cover both directions:
  //   • peer → lead, the direction that cannot pin at the transport: §8.6's signature, verified
  //     against the pinned member's certificate (`verifyRequestSignature`, signing.test.ts pins that
  //     another member's certificate does not verify one). What is added here is the ROUTER path that
  //     consumes it — a wrong key refuses, and writes nothing.
  //   • lead → peer: the boolean attestation the pin-enforcing listener sets. `transportPinned`
  //     defaults to FALSE and is settable only by the code that built the listener, so a peer whose
  //     pin could not be built is down rather than single-factor (transport.test.ts pins the `null`).

  test("a signature from a certificate this collie does not pin admits nothing, and writes nothing", async () => {
    // `stranger` is real, well-formed, self-consistent material. It is simply not in the roster —
    // which is the whole of what "pinned" means here.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    await h.store.load();
    const before = h.contents();
    const res = (await call(
      handler,
      PACK_LEAVE_PATH,
      signedPostWith("stranger", PACK_LEAVE_PATH, {}, T0, PACK.secret),
    ))!;
    expect(res.status).toBe(401);
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas", "laptop"]);
    expect(h.writes()).toBe(0);
    expect(h.contents()).toBe(before);
    await Bun.sleep(5);
    expect(h.lines.map((l) => [l.action, l.detail?.factor])).toEqual([["pack.refused", "certificate"]]);
  });

  test("`X-Pack-Member` is a hint, never an identity — naming a pinned member does not admit a stranger", async () => {
    // The header narrows which pinned key is TRIED first (§6). A claim that names an enrolled member
    // while the signature was made by a key nobody pins must fall through to the same refusal.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    await h.store.load();
    const res = (await call(
      handler,
      PACK_LEAVE_PATH,
      signedPostWith("stranger", PACK_LEAVE_PATH, {}, T0, PACK.secret, "nas"),
    ))!;
    expect(res.status).toBe(401);
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas"]);
    expect(h.writes()).toBe(0);
  });

  test("the admitted member is the KEY that signed, never the member the header claims", async () => {
    // The positive control for the test above, and a threat property in its own right: "laptop" signs
    // and names "nas", and what leaves the roster is LAPTOP. A member can drop itself and nobody else,
    // so the header cannot be turned into a remote eviction of a third party.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(
      handler,
      PACK_LEAVE_PATH,
      signedPostWith("laptop", PACK_LEAVE_PATH, {}, T0, PACK.secret, "nas"),
    ))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "laptop" });
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas"]);
  });

  test("an `unenrolled` pin is not an identity — a member dropped by a rotation cannot sign its way back", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    await h.store.load();
    const res = (await call(handler, PACK_LEAVE_PATH, signedPost("nas", PACK_LEAVE_PATH, {}, T0)))!;
    expect(res.status).toBe(401);
    // The tombstone survives — a refusal must not quietly tidy the roster it was refused against.
    expect(h.data().peers.map((p) => [p.memberId, p.status])).toEqual([["nas", "unenrolled"]]);
    expect(h.writes()).toBe(0);
  });

  test("an unpinned transport admits nobody, however correct the secret — and a pinned one admits", async () => {
    // `transportPinned: false` is what `peerListenerTls` returning `null` becomes at the router, i.e.
    // "the pin could not be built". Fail-closed: the correct pack secret buys nothing on its own.
    const h = harness(peerStore());
    await h.store.load();
    const unpinned = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const rotation = {
      method: "POST",
      headers: withSecret(PACK.secret),
      body: JSON.stringify({ secret: "would-be-new-value-0000000", generation: 2 }),
    } satisfies RequestInit;
    expect((await call(unpinned, PACK_SECRET_PATH, rotation))!.status).toBe(401);
    expect(h.data().pack!.secret).toBe(PACK.secret);
    expect(h.writes()).toBe(0);
    // The one difference between refused and admitted is the attestation the listener sets — nothing
    // on the request, and nothing configurable.
    const pinned = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, now: () => T0 });
    expect((await call(pinned, PACK_SECRET_PATH, rotation))!.status).toBe(200);
    expect(h.data().pack!.secret).toBe("would-be-new-value-0000000");
  });

  test("a valid token cannot pin a certificate that does not hash to the claimed fingerprint (§8.2)", async () => {
    // Enrollment is the one route where the certificate arrives in the PAYLOAD, so the cross-check
    // `fingerprint === sha256(certPem)` is the whole of factor 1 at that instant. A joiner that could
    // have the lead pin fingerprint A while presenting certificate B would be pinned to nothing real.
    for (const wrong of ["0".repeat(64), fp("nas")]) {
      const minted = mintInvite(leadStore({ peers: [] }), { now: T0, label: "laptop", random: counterRandom("r") });
      const h = harness(minted.next);
      const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 + 1 });
      await h.store.load();
      const res = (await call(handler, PACK_ENROLL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pack-protocol": "1" },
        body: JSON.stringify({
          protocol: 1,
          token: minted.result.token,
          fingerprint: wrong,
          certPem: material("laptop").certPem,
          address: "laptop.ts.net:8787",
          label: "laptop",
        }),
      }))!;
      expect(res.status).toBe(401);
      // Nothing was pinned — not the claimed fingerprint, not the certificate that came with it.
      expect(h.data().peers).toEqual([]);
      // The cross-check lives in `parseEnrollRequest`, which is what "SPEND FIRST" spends AGAINST:
      // a payload that will not parse yields no token to consume, so this lands on F4's no-op path —
      // 401, no store write, and the operator's live invite still there to be used honestly. (The
      // spend-on-failure rule covers failures AFTER the parse, e.g. the version mismatch above.)
      expect(h.writes()).toBe(0);
      expect(h.data().invites).toHaveLength(1);
    }
  });
});

describe("POST /pack/v1/warrant — the receiving half of the deputy designation (§18)", () => {
  // Lead → peer over the pinned handshake, like `secret`: `asLead` admits via `transportPinned`,
  // which resolves to exactly this collie's own pinned lead ("desk").
  const asLead = (h: ReturnType<typeof harness>, now = T0) =>
    createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, now: () => now });

  /** A warrant minted on `desk` naming `nas`, plus the body its lead would push. */
  function warrantFor(deputy: string | null, at = T0) {
    const lead = leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "attic" })] });
    const change = mintWarrant(lead, deputy, at);
    if (change === null) throw new Error("fixture: expected a mint");
    return change.result;
  }

  const pushBody = (w: Warrant, certLabel: string | null = w.deputyMemberId) =>
    certLabel === null ? { warrant: w } : { warrant: w, deputyCertPem: material(certLabel).certPem };

  test("this collie's own lead delivers one, and it lands on disk with the deputy's certificate", async () => {
    const h = harness(peerStore());
    const w = warrantFor("nas");
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(w))))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generation: 1, applied: true });
    expect(h.data().warrant?.warrant).toEqual(w);
    // The certificate is what phase 2 needs: BoringSSL anchors on certificates, never on hashes.
    expect(h.data().warrant?.deputyCertPem).toBe(material("nas").certPem);
    expect(h.lines.map((l) => l.action)).toContain("pack.warrant.stored");
  });

  test("a redelivery answers 200, applies nothing, and does not touch the disk twice", async () => {
    const h = harness(peerStore());
    const w = warrantFor("nas");
    await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(w)));
    const before = h.writes();
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(w))))!;
    expect(await res.json()).toEqual({ generation: 1, applied: false });
    expect(h.writes()).toBe(before);
  });

  test("an OLD generation is refused, and the newer one it holds is what it reports", async () => {
    const h = harness(peerStore());
    const first = warrantFor("nas");
    const lead = leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "attic" })] });
    const second = mintWarrant(mintWarrant(lead, "nas", T0)!.next, "attic", T0 + 5)!.result;
    await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(second)));
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(first))))!;
    expect(await res.json()).toEqual({ generation: 2, applied: false });
    expect(h.data().warrant?.warrant.deputyMemberId).toBe("attic");
  });

  test("a certificate that is not the one the fingerprint names is a 400, and nothing is stored", async () => {
    const h = harness(peerStore());
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(warrantFor("nas"), "attic"))))!;
    expect(res.status).toBe(400);
    expect(h.data().warrant).toBeUndefined();
    expect(h.writes()).toBe(0);
  });

  test("a tampered warrant is the uniform 401 — a bad signature is told nothing more", async () => {
    const h = harness(peerStore());
    const w = warrantFor("nas");
    const forged: Warrant = { ...w, deputyMemberId: "attic", deputyFingerprint: fp("attic") };
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(forged))))!;
    expect(res.status).toBe(401);
    expect(h.data().warrant).toBeUndefined();
    expect(h.writes()).toBe(0);
    expect(h.lines.map((l) => l.action)).toContain("pack.refused");
  });

  test("one past its 30 days is refused on THIS collie's clock, however well it verifies", async () => {
    const h = harness(peerStore());
    const res = (await call(asLead(h, T0 + WARRANT_TTL_MS), PACK_WARRANT_PATH, post(pushBody(warrantFor("nas")))))!;
    expect(res.status).toBe(400);
    expect(h.data().warrant).toBeUndefined();
  });

  test("a revocation names nobody, carries nothing, and still lands", async () => {
    const h = harness(peerStore());
    const lead = leadStore({ peers: [member({ memberId: "nas" })] });
    const revoked = mintWarrant(mintWarrant(lead, "nas", T0)!.next, null, T0 + 5)!.result;
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post({ warrant: revoked })))!;
    expect(await res.json()).toEqual({ generation: 2, applied: true });
    expect(h.data().warrant?.warrant.deputyMemberId).toBeNull();
    expect(h.data().warrant?.deputyCertPem).toBeNull();
    // A peer records the warrant, never the DESIGNATION — that field is the lead's own.
    expect(h.data().deputy).toBeUndefined();
  });

  test("a malformed body is a 400 and writes nothing", async () => {
    const h = harness(peerStore());
    for (const body of [{}, { warrant: "nope" }, { warrant: { generation: 1 } }]) {
      const res = (await call(asLead(h), PACK_WARRANT_PATH, post(body)))!;
      expect(res.status).toBe(400);
    }
    expect(h.writes()).toBe(0);
  });

  test("an admitted member that is NOT this collie's lead cannot push one", async () => {
    // A lead has no lead of its own, so nothing can present as an identified caller here — the same
    // shape `/pack/v1/secret` has, and for the same reason (the transport pins exactly one member).
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const res = (await call(asLead(h), PACK_WARRANT_PATH, post(pushBody(warrantFor("nas")))))!;
    expect(res.status).toBe(401);
    expect(h.data().warrant).toBeUndefined();
  });

  test("an unadmitted caller cannot reach it at all", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    const res = (await call(handler, PACK_WARRANT_PATH, post(pushBody(warrantFor("nas")))))!;
    expect(res.status).toBe(401);
    expect(h.writes()).toBe(0);
  });

  test("a GET on the path falls through to the ordinary 404 — the route is POST-only", async () => {
    const h = harness(peerStore());
    const res = (await call(asLead(h), PACK_WARRANT_PATH, { headers: authed }))!;
    expect(res.status).toBe(404);
  });
});

describe("what a member reports about the warrant it holds (§18, RFC §11.2)", () => {
  const nas = member({ memberId: "nas" });

  /** A store already holding generation 1 of a warrant naming `nas`. */
  function holding(base: TrustStoreData): TrustStoreData {
    const lead = leadStore({ peers: [nas] });
    const w = mintWarrant(lead, "nas", T0)!.result;
    return { ...base, warrant: { warrant: w, deputyCertPem: material("nas").certPem } };
  }

  test("hello carries the generation and the refresh when there is one", async () => {
    const h = harness(holding(leadStore({ peers: [nas] })));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(await res.json()).toEqual({ protocol: 1, member: "desk", warrantGeneration: 1, warrantRefreshedAt: T0 });
  });

  test("hello OMITS both fields when there is no warrant — absent, never zero (§7.1)", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(await res.json()).toEqual({ protocol: 1, member: "desk" });
  });

  test("snapshot carries them BESIDE the body, never inside the browser's own shape", async () => {
    const h = harness(holding(peerStore()));
    const body = ownSnapshot();
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      snapshot: () => body,
    });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(await res.json()).toEqual({ ...body, warrantGeneration: 1, warrantRefreshedAt: T0 });
    // The injected source is the very closure this collie serves its browser from, and it is not
    // mutated by being read for the pack: a pack-only field never leaks into the local snapshot.
    expect(body).toEqual(ownSnapshot());
  });

  test("snapshot omits them when there is no warrant, and the body is byte-identical", async () => {
    const h = harness(peerStore());
    const body = ownSnapshot();
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      snapshot: () => body,
    });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(await res.json()).toEqual(body);
  });
});

describe("Gap A — a peer knows when its lead last called (§18.9)", () => {
  test("every ADMITTED call from the lead is a receipt: a poll, a proxied read, a forwarded write", async () => {
    const h = harness(peerStore());
    const dialled: number[] = [];
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      now: () => T0 + 7,
      snapshot: () => ownSnapshot(),
      onLeadDialled: (at) => dialled.push(at),
    });
    await call(handler, PACK_HELLO_PATH, { headers: authed });
    await call(handler, PACK_SNAPSHOT_PATH, { headers: authed });
    // Stamped on THIS collie's clock, never from a header the caller sent (§6, §10.2).
    expect(dialled).toEqual([T0 + 7, T0 + 7]);
  });

  test("a REFUSED call is no receipt — the lead has to be admitted before it has landed", async () => {
    const h = harness(peerStore());
    const dialled: number[] = [];
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      onLeadDialled: (at) => dialled.push(at),
    });
    // Right identity, wrong secret: §8.1's second factor, and nothing landed.
    await call(handler, PACK_HELLO_PATH, { headers: { authorization: "Bearer nope", "x-pack-protocol": "1" } });
    expect(dialled).toEqual([]);
  });

  test("a refusal on the SECRET is recorded separately — §8.4's rotation, from the dropped side", async () => {
    // The identity was fine (a `secret` factor says so), and on a peer the only identity the
    // transport can attest is its lead's. So this is precisely "my lead is calling me and I no
    // longer hold the pack secret" — the fact that lets RFC §8.3's *stranded by a rotation* be
    // named rather than mistaken for silence. The request is still refused, exactly as before.
    const h = harness(peerStore());
    const refused: number[] = [];
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      now: () => T0 + 3,
      onLeadRefused: (at) => refused.push(at),
    });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { authorization: "Bearer rotated-away", "x-pack-protocol": "1" },
    }))!;
    expect(res.status).toBe(401);
    expect(refused).toEqual([T0 + 3]);
  });

  test("a solo-shaped wiring records nothing: no lead, no receipts", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const dialled: number[] = [];
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      onLeadDialled: (at) => dialled.push(at),
    });
    await call(handler, PACK_HELLO_PATH, {
      headers: { ...authed, ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    });
    expect(dialled).toEqual([]);
  });
});

describe("Gap B — lead_conflict, the named answer (§18.10)", () => {
  /** A peer that has re-pinned to `nas`, still holding the warrant `desk` signed naming `nas`. */
  function rePinned(): TrustStoreData {
    const w = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.result;
    return {
      ...peerStore({ lead: member({ memberId: "nas", role: "lead" }) }),
      warrant: { warrant: w, deputyCertPem: material("nas").certPem },
    };
  }

  const dialledBy = (who: string) => ({ ...authed, [MEMBER_HEADER]: who });

  test("an old lead dialling a re-pinned peer gets 409 + the warrant that deposed it", async () => {
    const h = harness(rePinned());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: dialledBy("desk") }))!;
    expect(res.status).toBe(409);
    const held = h.data().warrant!.warrant;
    expect(await res.json()).toEqual({
      error: 'this collie follows lead "nas" since warrant generation 1',
      code: "lead_conflict",
      leadMemberId: "nas",
      warrantGeneration: 1,
      // The proof rides along, and that is what turns a deposition into a self-heal, not a park.
      // It names the new lead's member id and NOTHING else — no address, no certificate: the
      // answering peer is not a directory, and `toEqual` is what pins the absence of both.
      warrant: { ...held },
    });
    expect(held.deputyMemberId).toBe("nas");
    expect(held.leadMemberId).toBe("desk");
  });

  test("it carries the §6 headers, so the dialler reads it as an answer and not as a skew", async () => {
    // The status is shared with §7's protocol mismatch. A 409 with no version banner would be read
    // as "this member speaks a protocol I cannot", which is the one reading it must never get.
    const h = harness(rePinned());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: dialledBy("desk") }))!;
    expect(res.headers.get("x-pack-protocol")).toBe("1");
    expect(res.headers.get(MEMBER_HEADER)).toBe("laptop");
  });

  test("this collie's own lead is never told it conflicts", async () => {
    const h = harness(rePinned());
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: dialledBy("nas") }))!;
    expect(res.status).toBe(200);
    // …and neither is a caller that named nobody: an absent hint is not a claim to disagree with.
    expect((await call(handler, PACK_HELLO_PATH, { headers: authed }))!.status).toBe(200);
  });

  test("a LEAD never answers it — its members are each a legitimate caller", async () => {
    // The same comparison on a lead would refuse the whole roster, so the answer is a peer's only.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "attic" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, now: () => T0 });
    const res = (await call(handler, PACK_HELLO_PATH, {
      headers: { ...dialledBy("nas"), ...signed("nas", "GET", PACK_HELLO_PATH, "", T0) },
    }))!;
    expect(res.status).toBe(200);
  });

  test("no warrant, or one naming somebody else, still conflicts — but hands over no proof", async () => {
    const bare: TrustStoreData = peerStore({ lead: member({ memberId: "nas", role: "lead" }) });
    const h = harness(bare);
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: dialledBy("desk") }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'this collie follows lead "nas" since warrant generation 0',
      code: "lead_conflict",
      leadMemberId: "nas",
      warrantGeneration: 0,
    });
  });

  test("it refuses BEFORE dispatch — a member that follows somebody else is answered, not served", async () => {
    const h = harness(rePinned());
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      transportPinned: true,
      snapshot: () => ownSnapshot(),
    });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: dialledBy("desk") }))!;
    expect(res.status).toBe(409);
    expect(h.writes()).toBe(0);
  });
});

describe("POST /pack/v1/warrant at a collie that still believes it leads — the deposition (§18.12)", () => {
  /** `desk`, leading `nas` and `attic`, holding the warrant it signed naming `nas`. */
  function stale(nas = member({ memberId: "nas" })) {
    const base = leadStore({ peers: [nas, member({ memberId: "attic" })] });
    const change = mintWarrant(base, "nas", T0)!;
    return { data: change.next, warrant: change.result };
  }

  const router = (h: ReturnType<typeof harness>, deposedSeen: unknown[] = []) =>
    createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0 + 100,
      onDeposed: (state) => deposedSeen.push(state),
    });

  test("the new lead hands the warrant back, and the old one self-heals to a peer of it", async () => {
    const { data, warrant } = stale();
    const h = harness(data);
    const seen: unknown[] = [];
    const body = { warrant };
    const res = (await call(h.store && router(h, seen), PACK_WARRANT_PATH, signedPost("nas", PACK_WARRANT_PATH, body, T0 + 100)))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deposed: "desk", lead: "nas", outcome: "healed" });
    expect(h.data().lead?.memberId).toBe("nas");
    expect(h.data().peers).toEqual([]);
    expect(h.lines.map((l) => l.action)).toContain("pack.deposed");
    expect(seen).toHaveLength(1);
  });

  test("a member that is NOT the one the warrant names proves nothing — a warrant is public", async () => {
    // Anyone who ever held one could replay it (RFC §12, F6), so the presenter must be the named
    // deputy. `attic` presents a perfectly valid warrant naming `nas`; nothing happens.
    const { data, warrant } = stale();
    const h = harness(data);
    const res = (await call(router(h), PACK_WARRANT_PATH, signedPost("attic", PACK_WARRANT_PATH, { warrant }, T0 + 100)))!;
    expect(res.status).toBe(401);
    expect(h.data().lead).toBeNull();
  });

  test("a warrant this collie did NOT sign is the uniform 401, and the store is untouched", async () => {
    const { data, warrant } = stale();
    const h = harness(data);
    const forged: Warrant = { ...warrant, generation: warrant.generation + 3 };
    const res = (await call(router(h), PACK_WARRANT_PATH, signedPost("nas", PACK_WARRANT_PATH, { warrant: forged }, T0 + 100)))!;
    expect(res.status).toBe(401);
    // The ONLY write is §8.6's replay floor, which committed before this handler ran. The roster,
    // the role and the warrant are exactly what they were: a refusal costs no membership write.
    expect(h.data().lead).toBeNull();
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["nas", "attic"]);
    expect(h.data().warrant?.warrant).toEqual(warrant);
  });

  test("a deputy the roster cannot resolve PARKS — announced, and nothing is written", async () => {
    // The warrant names a fingerprint this machine's roster cannot produce a certificate for — a
    // hand-edited store or a pack it does not belong to. `nas` is still pinned and still signs
    // perfectly well, so this is the SELF-HEAL failing rather than the admission.
    const { data, warrant } = stale(member({ memberId: "nas", fingerprint: fp("attic") }));
    expect(warrant.deputyFingerprint).toBe(fp("attic"));
    const h = harness(data);
    const seen: unknown[] = [];
    const res = (await call(router(h, seen), PACK_WARRANT_PATH, signedPost("nas", PACK_WARRANT_PATH, { warrant }, T0 + 100)))!;
    expect(await res.json()).toEqual({ deposed: "desk", lead: "nas", outcome: "parked-unverifiable" });
    expect(h.writes()).toBe(1); // the §8.6 replay floor only — the roster itself is untouched
    expect(h.data().lead).toBeNull();
    expect(h.lines.map((l) => l.action)).toContain("pack.deposed");
    expect(seen).toHaveLength(1);
  });

  test("an UNSIGNED push cannot depose: a lead's listener pins nothing inbound (§8.1)", async () => {
    // This is why the route joined SIGNABLE_PATHS. Without a signature the old lead cannot identify
    // the caller at all, so the request is the uniform 401 and no deposition is even considered.
    const { data, warrant } = stale();
    const h = harness(data);
    const res = (await call(router(h), PACK_WARRANT_PATH, post({ warrant })))!;
    expect(res.status).toBe(401);
    expect(h.data().lead).toBeNull();
  });

  test("a PEER is unaffected: the same route still stores rather than deposes", async () => {
    // One object, two kinds of recipient — exactly as `/pack/v1/lead` is (§14). A peer's reading of
    // a warrant push is unchanged by any of this.
    const h = harness(peerStore());
    const w = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.result;
    const handler = createPackRouter({ store: h.store, audit: h.audit, transportPinned: true, now: () => T0 });
    const res = (await call(handler, PACK_WARRANT_PATH, post({ warrant: w, deputyCertPem: material("nas").certPem })))!;
    expect(await res.json()).toEqual({ generation: 1, applied: true });
  });
});
