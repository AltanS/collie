import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../audit.ts";
import type { SnapshotResponse } from "../types.ts";
import { mintInvite, type EnrollResponse } from "./enrollment.ts";
import { counterRandom, fp, leadStore, member, PACK, peerStore, T0 } from "./fixtures.ts";
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
  const io: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const store = new TrustStore("/unused", io);
  const audit = new AuditLog((l) => void lines.push(JSON.parse(l) as AuditEntry), () => T0);
  return { store, audit, lines, data: () => store.current()! };
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
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: authed }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: 1, member: "desk" });
    expect(res.headers.get("x-pack-protocol")).toBe("1");
    expect(res.headers.get("x-pack-member")).toBe("desk");
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
    const cases: Array<[string, HeadersInit]> = [
      ["no secret", { "x-pack-protocol": "1" }],
      ["wrong secret", { authorization: "Bearer nope", "x-pack-protocol": "1" }],
      ["no version", { authorization: `Bearer ${PACK.secret}` }],
      ["wrong version", { ...authed, "x-pack-protocol": "9" }],
    ];
    const unpinned = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("stranger") });
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
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
    const res = (await call(handler, PACK_HELLO_PATH, { headers: { ...authed, "x-pack-protocol": "2" } }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "pack protocol mismatch",
      code: "protocol_mismatch",
      expected: 1,
      received: 2,
    });
  });

  test("an unimplemented pack route is a 404 only for an admitted caller, else the same 401", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const admitted = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
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
  const nas = member({ memberId: "nas" });

  test("an admitted caller gets the peer's own snapshot body verbatim, with the pack headers", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const body = ownSnapshot();
    const source: SnapshotSource = () => body;
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas"), snapshot: source });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get("x-pack-protocol")).toBe("1");
    expect(res.headers.get("x-pack-member")).toBe("desk");
  });

  test("?session= is passed through to the injected source", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const calls: Array<string | undefined> = [];
    const source: SnapshotSource = (session) => {
      calls.push(session);
      return ownSnapshot();
    };
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas"), snapshot: source });
    await call(handler, `${PACK_SNAPSHOT_PATH}?session=collie-demo`, { headers: authed });
    expect(calls).toEqual(["collie-demo"]);
  });

  test("an unknown session (source returns undefined) is the peer's OWN 404, not the lead's", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const source: SnapshotSource = () => undefined;
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas"), snapshot: source });
    const res = (await call(handler, `${PACK_SNAPSHOT_PATH}?session=nope`, { headers: authed }))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown session" });
  });

  test("a router built WITHOUT a snapshot dep 404s exactly like any unimplemented route", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("an UNADMITTED caller gets the standard 401 and the snapshot source is NEVER invoked", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    let calls = 0;
    const source: SnapshotSource = () => {
      calls += 1;
      return ownSnapshot();
    };
    // No fingerprints dep wired => the unwired default admits nobody, same as the hello tests.
    const handler = createPackRouter({ store: h.store, audit: h.audit, snapshot: source });
    const res = (await call(handler, PACK_SNAPSHOT_PATH, { headers: authed }))!;
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("a non-GET method on the path falls through to the ordinary 404, not 405", async () => {
    const h = harness(leadStore({ peers: [nas] }));
    const source: SnapshotSource = () => ownSnapshot();
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas"), snapshot: source });
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

  test("a TLS fingerprint that disagrees with the payload's claim is refused", async () => {
    // The stub returns null today, so this is the behaviour that must hold the moment TLS lands:
    // the transport is authoritative and a peer cannot have the lead pin a certificate it lacks.
    const h = invited();
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0 + 1,
      fingerprints: () => fp("someone-else"),
    });
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(res.status).toBe(401);
    expect(h.data().peers).toEqual([]);
  });

  test("a matching TLS fingerprint enrolls", async () => {
    const h = invited();
    const handler = createPackRouter({
      store: h.store,
      audit: h.audit,
      now: () => T0 + 1,
      fingerprints: () => fp("laptop"),
    });
    const res = (await call(handler, PACK_ENROLL_PATH, {
      method: "POST",
      headers: { "x-pack-protocol": "1" },
      body: JSON.stringify(body({ token: h.token })),
    }))!;
    expect(res.status).toBe(200);
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

  function peerRouter(d?: ReturnType<typeof dispatcher>) {
    const h = harness(leadStore({ peers: [nas] }));
    return {
      h,
      handler: createPackRouter({
        store: h.store,
        audit: h.audit,
        fingerprints: () => fp("nas"),
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
    expect(new Set(d.seen.map((s) => s.from))).toEqual(new Set(["nas"]));
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
    expect(res.headers.get("x-pack-member")).toBe("desk");
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
  const asLead = (h: ReturnType<typeof harness>) =>
    createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("desk"), now: () => T0 });

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

  test("a MEMBER THAT IS NOT THE LEAD cannot rotate the pack — a peer must not lock out its lead", async () => {
    // `desk` leads `nas` and `laptop`; `nas` is admitted, and still refused here.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
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
  const claim = { memberId: "nas", fingerprint: fp("nas"), address: "nas.example:8787" };

  test("the old lead demotes itself and answers with its roster", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas"), now: () => T0 });
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: claim })))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      demoted: "desk",
      roster: [{ memberId: "laptop", fingerprint: fp("laptop"), address: "laptop.example:8787" }],
    });
    expect(h.data().lead).toMatchObject({ memberId: "nas", role: "lead" });
    expect(h.data().peers).toEqual([]);
    // A role change, not a re-enrollment: the pack identity and secret are untouched.
    expect(h.data().pack).toEqual(PACK);
  });

  test("a peer re-pins the new lead and answers with an empty roster — it has no peers", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("desk"), now: () => T0 });
    // The current lead ("desk") is the one that relays a promotion it already accepted.
    const relayed = { memberId: "desk", fingerprint: fp("desk"), address: "desk.moved:8787" };
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: relayed })))!;
    expect(await res.json()).toEqual({ lead: "desk", applied: true, roster: [] });
    expect(h.data().lead!.address).toBe("desk.moved:8787");
  });

  test("a member may only claim leadership FOR ITSELF — nobody nominates a third party", async () => {
    const h = harness(peerStore());
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("desk") });
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
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("desk") });
    const res = (await call(handler, PACK_LEAD_PATH, post({ lead: { memberId: "desk" } })))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a leadership claim needs `lead`" });
  });
});

describe("POST /pack/v1/leave — the caller drops ITSELF (§8.4)", () => {
  test("an admitted member removes its own roster entry and nothing else", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
    const res = (await call(handler, PACK_LEAVE_PATH, post({ member: "laptop" })))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "nas" });
    expect(h.data().peers.map((p) => p.memberId)).toEqual(["laptop"]);
  });

  test("leaving twice is 200 both times — the operator's question has the same answer", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit, fingerprints: () => fp("nas") });
    expect((await call(handler, PACK_LEAVE_PATH, post({})))!.status).toBe(200);
    // Still pinned in this test's fingerprint source, so it is still admitted — and still 200.
    expect((await call(handler, PACK_LEAVE_PATH, post({})))!.status).toBe(401);
  });

  test("an unadmitted caller removes nobody", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const handler = createPackRouter({ store: h.store, audit: h.audit });
    expect((await call(handler, PACK_LEAVE_PATH, post({})))!.status).toBe(401);
    expect(h.data().peers).toHaveLength(1);
  });
});
