import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../audit.ts";
import type { SnapshotResponse } from "../types.ts";
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
  type SnapshotSource,
} from "./router.ts";
import { signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signing.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo } from "./trust-store.ts";

// The endpoint. It takes a plain `Request` and needs no `Bun.serve`, so unlike the rest of the HTTP
// layer this IS unit-tested for real rather than pinned at the source.

/** Header names+values as a sorted list — `Headers` is not iterable under this tsconfig's lib. */
function headerList(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => out.push(`${key}: ${value}`));
  return out.sort();
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
function signed(memberLabel: string, method: string, path: string, body: string, timestamp: number): Record<string, string> {
  return {
    [SIGNATURE_HEADER]: signRequest(material(memberLabel).keyPem, { method, path, body, timestamp }),
    [TIMESTAMP_HEADER]: String(timestamp),
  };
}

/** A signed POST: `Authorization` + protocol + signature headers, and the body they cover. */
function signedPost(memberLabel: string, path: string, body: unknown, timestamp: number): RequestInit {
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
    const body = (await res.json()) as Record<string, unknown>;
    expect("version" in body).toBe(false);
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
    const shapes: string[] = [];
    for (const [, headers] of cases) {
      const res = (await call(unpinned, PACK_HELLO_PATH, { headers }))!;
      shapes.push(JSON.stringify({ status: res.status, body: await res.text(), headers: headerList(res) }));
    }
    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0]!).body).toBe('{"error":"unauthorized"}');
    // Not even a wrong VERSION leaks a 409 to an unpinned caller.
    expect(shapes[0]).not.toContain("protocol_mismatch");
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
    expect(h.lines.map((l) => [l.action, (l.detail as Record<string, unknown>).factor])).toEqual([
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

  const body = (over: Record<string, unknown> = {}) => ({
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
    const shapes: string[] = [];
    for (const init of [
      { method: "POST", body: JSON.stringify(body({ token: "wrong" })) },
      { method: "POST", body: "{not json" },
      { method: "POST", body: JSON.stringify({ token: h.token }) },
      { method: "GET" },
    ] satisfies RequestInit[]) {
      const res = (await call(handler, PACK_ENROLL_PATH, { ...init, headers: { "x-pack-protocol": "1" } }))!;
      shapes.push(JSON.stringify({ status: res.status, body: await res.text(), headers: headerList(res) }));
    }
    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0]!).body).toBe('{"error":"unauthorized"}');
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
    const shapes: string[] = [];
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
      shapes.push(JSON.stringify({ status: res.status, body: await res.text(), headers: headerList(res) }));
      expect(h.writes() > 0).toBe(expectWrite);
      sweepWrites += h.writes();
    }
    // The two branches really were different underneath…
    expect(sweepWrites).toBe(1);
    // …and identical on the wire.
    expect(new Set(shapes).size).toBe(1);
    expect(JSON.parse(shapes[0]!).body).toBe('{"error":"unauthorized"}');
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
      handler: createPackRouter({
        store: h.store,
        audit: h.audit,
        transportPinned: true,
        ...(d === undefined ? {} : { dispatch: d.dispatch }),
      }),
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
      const res = (await call(handler, `${PACK_PREFIX}${route}`, {
        method,
        headers: authed,
        ...(method === "POST" ? { body: "{}" } : {}),
      }))!;
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

const post = (body: unknown): RequestInit => ({
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
    expect(((await res.json()) as { code: string }).code).toBe("handover_not_approved");
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
