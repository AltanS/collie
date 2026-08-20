import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeEtag } from "../http-cache.ts";
import { MAX_UPLOAD_BYTES } from "../uploads.ts";
import {
  apiPathFor,
  forwardAuditAction,
  forwardHeaders,
  forwardKind,
  forwardParams,
  forwardToPeer,
  packRouteFor,
  proxiedResponse,
  type ForwardDeps,
  type ForwardErrorCode,
  type ForwardTransport,
} from "./forward.ts";
import type { PackLink, PeerOutcome } from "./peer-client.ts";
import type { PeerState } from "./registry.ts";

// The lead's forwarding path (PACK_PROTOCOL.md §5, §9.1, §10.3, §12, §13).
//
// All of it is exercised for real — no `Bun.serve`, no socket — because the transport is injected and
// everything else is request-shaping in, response-classification out. That is not an accident of the
// tests; it is the constraint the module was written under (CLAUDE.md: keep new backend logic
// pure/injectable enough for `bun test`).

const LINK: PackLink = { memberId: "laptop", address: "laptop.example:8787" };
const REACHABLE: PeerState = {
  memberId: "laptop",
  health: "reachable",
  lastSeenAt: 1_754_000_000_000,
  reason: null,
  version: "1.0.0-alpha.12",
};
const DEAD: PeerState = {
  memberId: "laptop",
  health: "unreachable",
  lastSeenAt: 1_753_999_000_000,
  reason: "connection refused",
  version: null,
};
const SKEWED: PeerState = {
  memberId: "laptop",
  health: "incompatible",
  lastSeenAt: null,
  reason: "peer speaks 2",
  version: null,
};

/** Records every dial, so "was this attempted?" and "was it retried?" are assertable facts. */
function transportOf(answer: (init: RequestInit) => PeerOutcome<Response>) {
  const calls: { route: string; params: Record<string, string>; init: RequestInit }[] = [];
  const transport: ForwardTransport = async (_link, route, params, init) => {
    calls.push({ route, params, init });
    return answer(init);
  };
  return { transport, calls };
}

function ok(res: Response): PeerOutcome<Response> {
  return { ok: true, value: res, status: res.status, member: "laptop", receivedAt: 1, date: null };
}

function forward(req: Request, url: URL, deps: Partial<ForwardDeps> & { transport: ForwardTransport }) {
  return forwardToPeer(req, url, { link: LINK, state: REACHABLE, ...deps });
}

function get(path: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`https://lead.example${path}`);
  return [new Request(url, { headers }), url];
}

function post(path: string, body: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`https://lead.example${path}`);
  return [new Request(url, { method: "POST", body, headers }), url];
}

// ── The route table is §5's, and it is one table ─────────────────────────────

/**
 * The refusal envelope every lead-generated failure answers with — `forwardError` in forward.ts
 * writes `{ ok, code, error }` plus whichever `extra` the caller passed (`host`, `lastSeenAt`).
 */
interface ForwardFailure {
  ok: boolean;
  code: ForwardErrorCode;
  error: string;
  host?: string;
  lastSeenAt?: number | null;
}

/** Read a refusal body as the envelope forward.ts guarantees for it. */
async function failureBody(res: Response): Promise<ForwardFailure> {
  // SAFETY: every non-2xx from `forward`/`forwardToPeer` comes out of `forwardError`, which is the
  // single writer of this shape; the tests below assert `code` and `error` field by field.
  return (await res.json()) as ForwardFailure;
}

describe("which routes cross a link", () => {
  test("the pane family, tabs and workspace map 1:1 onto the pack prefix", () => {
    expect(packRouteFor("/api/pane/w1:p1")).toBe("pane/w1:p1");
    for (const action of ["reply", "keys", "upload", "close", "rename", "history"]) {
      expect(packRouteFor(`/api/pane/w1:p1/${action}`)).toBe(`pane/w1:p1/${action}`);
    }
    expect(packRouteFor("/api/tab")).toBe("tab");
    expect(packRouteFor("/api/tab/w1:t1/rename")).toBe("tab/w1:t1/rename");
    expect(packRouteFor("/api/tab/w1:t1/close")).toBe("tab/w1:t1/close");
    expect(packRouteFor("/api/workspace")).toBe("workspace");
  });

  test("the routes §5 excludes are excluded — and stay that way by construction", () => {
    // Push subscriptions live on the lead, notification policy is one pack-wide setting the lead
    // owns, update checking is per-machine, `config` is consumed not proxied, `snapshot` is merged.
    for (const path of [
      "/api/subscribe",
      "/api/notifications/snooze",
      "/api/notifications/prefs",
      "/api/update/check",
      "/api/config",
      "/api/snapshot",
      "/api/pane/w1:p1/nonsense",
      "/api/pane/w1:p1/upload/read", // §5: "no upload-read route exists on either surface"
      "/api/tab/w1:t1/delete",
      "/pack/v1/hello",
      "/",
    ]) {
      expect(packRouteFor(path)).toBeNull();
    }
  });

  test("no route can escape the prefix by shape", () => {
    expect(packRouteFor("/api/pane/w1:p1/../../etc/passwd")).toBeNull();
    expect(packRouteFor("/api/pane/a/b/c")).toBeNull();
    expect(apiPathFor("../hello")).toBeNull();
    expect(apiPathFor("pane/w1:p1/reply")).toBe("/api/pane/w1:p1/reply");
  });

  test("the grammar matches server.ts's own route literals, character for character", () => {
    // Two grammars that merely *agree* would be two grammars that drift, and a drift here is a route
    // the phone can call locally but not across a link (or, worse, the reverse).
    const server = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const pane = server.match(/^const PANE_ROUTE = (.+);$/m)![1]!;
    const tab = server.match(/^const TAB_ACTION_ROUTE = (.+);$/m)![1]!;
    const alternation = /\(([a-z]+(?:\|[a-z]+)+)\)/;
    const paneActions = pane.match(alternation)![1]!.split("|").toSorted();
    expect(paneActions).toEqual(["close", "history", "keys", "rename", "reply", "upload"]);
    for (const action of paneActions) expect(packRouteFor(`/api/pane/x/${action}`)).toBe(`pane/x/${action}`);
    const tabActions = tab.match(alternation)![1]!.split("|").toSorted();
    expect(tabActions).toEqual(["close", "rename"]);
    for (const action of tabActions) expect(packRouteFor(`/api/tab/x/${action}`)).toBe(`tab/x/${action}`);
  });

  test("read vs write is decided exactly as server.ts decides it — history is a READ", () => {
    expect(forwardKind("pane/w1:p1")).toBe("read");
    expect(forwardKind("pane/w1:p1/history")).toBe("read");
    for (const action of ["reply", "keys", "upload", "close", "rename"]) {
      expect(forwardKind(`pane/w1:p1/${action}`)).toBe("write");
    }
    expect(forwardKind("tab")).toBe("write");
    expect(forwardKind("workspace")).toBe("write");
  });

  test("the audit action a forward records is the one the peer will write", () => {
    expect(forwardAuditAction("pane/w1:p1/reply")).toBe("reply");
    expect(forwardAuditAction("pane/w1:p1/keys")).toBe("keys");
    expect(forwardAuditAction("pane/w1:p1/upload")).toBe("upload");
    expect(forwardAuditAction("pane/w1:p1/close")).toBe("pane.close");
    expect(forwardAuditAction("pane/w1:p1/rename")).toBe("pane.rename");
    expect(forwardAuditAction("tab")).toBe("tab.create");
    expect(forwardAuditAction("tab/w1:t1/rename")).toBe("tab.rename");
    expect(forwardAuditAction("tab/w1:t1/close")).toBe("tab.close");
    expect(forwardAuditAction("workspace")).toBe("workspace.create");
    // Reads are not audited today and do not become audited by crossing a link.
    expect(forwardAuditAction("pane/w1:p1")).toBeNull();
    expect(forwardAuditAction("pane/w1:p1/history")).toBeNull();
  });
});

// ── §9.1 Proxied reads: byte-for-byte, ETag and all ──────────────────────────

describe("a proxied read is the peer's response, unmodified (§9.1)", () => {
  test("status, body bytes, content-type and etag all survive the hop", async () => {
    const body = JSON.stringify({ paneId: "w1:p1", lines: ["hello"] });
    const peer = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        etag: '"deadbeef"',
        "cache-control": "no-store",
        vary: "accept-encoding",
        // Link-internal, and a browser must never see it (§6).
        "x-pack-member": "laptop",
      },
    });
    const { transport } = transportOf(() => ok(peer));
    const [req, url] = get("/api/pane/w1:p1?host=laptop");
    const res = await forward(req, url, { transport });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // The peer said `gzip`; the bytes in hand are plain (the runtime decompressed them and left the
    // header behind). Re-emitting it made the phone's `fetch` throw on every peer pane, so the header
    // is dropped: after the identity hop the lead always holds identity bytes.
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("etag")).toBe('"deadbeef"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("x-pack-member")).toBeNull();
  });

  test("the lead never recomputes an ETag — the peer's is the peer's assertion about its own body", async () => {
    const body = JSON.stringify({ paneId: "w1:p1" });
    // Deliberately NOT this build's hash of this body: if the lead were re-hashing, this would come
    // back as `computeEtag(body)` instead, which is the silent corruption §9.1 forbids.
    const peersEtag = '"a-value-only-the-peer-could-have-chosen"';
    expect(peersEtag).not.toBe(computeEtag(body));
    const { transport } = transportOf(() =>
      ok(new Response(body, { status: 200, headers: { etag: peersEtag } })),
    );
    const [req, url] = get("/api/pane/w1:p1/history?host=laptop");
    const res = await forward(req, url, { transport });
    expect(res.headers.get("etag")).toBe(peersEtag);
  });

  test("If-None-Match is passed through, and the peer's 304 comes back as a 304", async () => {
    const { transport, calls } = transportOf(() =>
      ok(new Response(null, { status: 304, headers: { etag: '"same"' } })),
    );
    const [req, url] = get("/api/pane/w1:p1?host=laptop", { "if-none-match": '"same"' });
    const res = await forward(req, url, { transport });

    expect(new Headers(calls[0]!.init.headers).get("if-none-match")).toBe('"same"');
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"same"');
    expect(res.body).toBeNull(); // a 304 carries no body, end to end
  });

  test("the body is streamed, never read on the lead — a 400-turn history is not buffered twice", async () => {
    // A stream that reports when somebody actually asks for bytes. Proxying must not be that
    // somebody: buffering a whole transcript on the lead is what §9.1's "byte-for-byte rather than
    // parse-and-re-emit" is avoiding, and reading it would also be the moment the ETag stopped
    // describing what was sent.
    let pulls = 0;
    const peer = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("a".repeat(100_000)));
          controller.close();
        },
      }),
      { status: 200, headers: { etag: '"big"' } },
    );
    const out = proxiedResponse(peer, null);
    expect(pulls).toBe(0); // the transcript was handed on, not consumed
    expect(await out.text()).toHaveLength(100_000);
    expect(pulls).toBe(1); // …and read exactly once, by the phone's response
  });

  test("a peer's own 404/405 is an ANSWER and reaches the phone as itself", async () => {
    for (const status of [404, 405, 413]) {
      const { transport } = transportOf(() => ok(new Response(`{"error":"x"}`, { status })));
      const [req, url] = get("/api/pane/nope?host=laptop");
      expect((await forward(req, url, { transport })).status).toBe(status);
    }
  });
});

// ── §9.1 Compression is hop-local: the LEAD gzips the phone hop (.adr/0023) ──

describe("the lead compresses the phone hop itself (.adr/0023)", () => {
  // The whole decision rests on this primitive existing in the runtime the bridge ships on. Asserted
  // rather than assumed: without it the compressed branch would throw inside a request path whose
  // stated contract is "never throws".
  test("the runtime has CompressionStream, and it really deflates", async () => {
    const plain = "collie ".repeat(500);
    const out = new Response(plain).body!.pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(out).arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(plain.length / 10);
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(plain);
  });

  /** A peer answer big enough that gzip is plainly doing work, in the shape a pane read has. */
  function peerJson(headers: Record<string, string> = {}): [string, Response] {
    const body = JSON.stringify({ paneId: "w1:p1", lines: Array.from({ length: 200 }, () => "peer pane output") });
    return [
      body,
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", etag: '"deadbeef"', ...headers },
      }),
    ];
  }

  async function forwardWithAccept(peer: Response, accept: string | null): Promise<Response> {
    const { transport } = transportOf(() => ok(peer));
    const [req, url] = get("/api/pane/w1:p1?host=laptop", accept === null ? {} : { "accept-encoding": accept });
    return await forward(req, url, { transport });
  }

  test("the phone asked for gzip, so the BYTES are gzip and they inflate back to the peer's JSON", async () => {
    const [body, peer] = peerJson();
    const res = await forwardWithAccept(peer, "gzip, deflate, br");

    expect(res.headers.get("content-encoding")).toBe("gzip");
    // Bytes, not headers: a header that merely claims gzip is the exact bug beta.9 fixed, and the
    // only assertion that can tell the two apart is decoding what was actually written.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x1f); // gzip magic
    expect(bytes[1]).toBe(0x8b);
    expect(bytes.byteLength).toBeLessThan(body.length);
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(body);
    // The ETag names the IDENTITY bytes, on both sides of the lead — so compressing this hop cannot
    // invalidate it, exactly as `gzipJsonResponse` intends on a local route.
    expect(res.headers.get("etag")).toBe('"deadbeef"');
    // A transform cannot know its own output length, and the emitting server frames what it writes.
    expect(res.headers.get("content-length")).toBeNull();
  });

  test("the phone did not ask, so the body is the peer's bytes verbatim and no encoding is claimed", async () => {
    const [body, peer] = peerJson();
    const res = await forwardWithAccept(peer, null);

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(body);
    expect(res.headers.get("etag")).toBe('"deadbeef"');
  });

  test("an `identity`-only phone is not gzipped either", async () => {
    const [body, peer] = peerJson();
    const res = await forwardWithAccept(peer, "identity");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(body);
  });

  test("`vary` is MERGED with the peer's, never clobbered — and set when the peer sent none", async () => {
    const [, withVary] = peerJson({ vary: "x-collie-seen" });
    expect((await forwardWithAccept(withVary, "gzip")).headers.get("vary")).toBe("x-collie-seen, accept-encoding");

    // Already varying on it (what a peer's own gzip branch declares): kept, not doubled.
    const [, already] = peerJson({ vary: "accept-encoding" });
    expect((await forwardWithAccept(already, "gzip")).headers.get("vary")).toBe("accept-encoding");

    const [, none] = peerJson();
    expect((await forwardWithAccept(none, "gzip")).headers.get("vary")).toBe("accept-encoding");
  });

  test("a 304 and a 204 pass through untouched — no body to transform, so no encoding claimed", async () => {
    for (const status of [304, 204]) {
      const peer = new Response(null, {
        status,
        headers: { "content-type": "application/json; charset=utf-8", etag: '"same"' },
      });
      const res = await forwardWithAccept(peer, "gzip, deflate, br");
      expect(res.status).toBe(status);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.body).toBeNull();
      expect(res.headers.get("etag")).toBe('"same"');
    }
  });

  test("a non-compressible content-type streams through unchanged even when the phone asked", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const peer = new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png", etag: '"png"' },
    });
    const res = await forwardWithAccept(peer, "gzip, deflate, br");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("etag")).toBe('"png"');
  });

  test("the peer hop stays identity no matter what the phone asked for (the beta.9 invariant)", async () => {
    const [, peer] = peerJson();
    const { transport, calls } = transportOf(() => ok(peer));
    const [req, url] = get("/api/pane/w1:p1?host=laptop", { "accept-encoding": "gzip, deflate, br, zstd" });
    await forward(req, url, { transport });
    expect(new Headers(calls[0]!.init.headers).get("accept-encoding")).toBe("identity");
  });
});

// ── The forwarded request: what the peer sees, and what it must never see ────

describe("request shaping", () => {
  test("`host=` is dropped and every other parameter — `session=` above all — rides through", () => {
    const url = new URL("https://lead.example/api/pane/w1:p1?host=laptop&session=work&lines=80");
    expect(forwardParams(url)).toEqual({ session: "work", lines: "80" });
  });

  test("headers are an allowlist: seen + conditional + content-type, and nothing of the browser's", () => {
    const req = new Request("https://lead.example/api/pane/w1:p1", {
      headers: {
        "if-none-match": '"e"',
        "x-collie-seen": "1",
        "content-type": "multipart/form-data; boundary=xyz",
        "accept-encoding": "gzip",
        cookie: "session=hunter2",
        origin: "https://lead.example",
        authorization: "Bearer a-browser-credential",
        "x-tailnet-device": "phone",
      },
    });
    const headers = forwardHeaders(req, "phone-7");
    expect(headers.get("if-none-match")).toBe('"e"');
    expect(headers.get("x-collie-seen")).toBe("1");
    expect(headers.get("content-type")).toBe("multipart/form-data; boundary=xyz");
    // §12: the device is forwarded as the pack header, resolved by the LEAD's own deviceAuth.
    expect(headers.get("x-pack-device")).toBe("phone-7");
    // A browser credential must never become a second, unaudited basis for a decision on the peer.
    for (const banned of ["cookie", "origin", "authorization", "x-tailnet-device"]) {
      expect(headers.get(banned)).toBeNull();
    }
    // Identity bytes only, and ASKED FOR rather than merely not-forwarded: Bun's `fetch` supplies its
    // own `accept-encoding: gzip, …` when the init carries none, so an absent header is a gzipped hop.
    expect(headers.get("accept-encoding")).toBe("identity");
  });

  test("no device header at all when the lead's device gate is off", () => {
    const req = new Request("https://lead.example/api/pane/w1:p1");
    expect(forwardHeaders(req, null).get("x-pack-device")).toBeNull();
    expect(forwardHeaders(req).get("x-pack-device")).toBeNull();
  });
});

// ── §10.3 Writes: refuse before attempting, never retry an ambiguous one ─────

describe("a write to a member that is not reachable (§10.3)", () => {
  test("it is refused BEFORE it is attempted, naming the member and its lastSeenAt", async () => {
    const { transport, calls } = transportOf(() => ok(new Response("{}")));
    const [req, url] = post("/api/pane/w1:p1/reply?host=laptop", `{"text":"hi"}`);
    const res = await forward(req, url, { transport, state: DEAD });

    expect(res.status).toBe(503);
    const body = await failureBody(res);
    expect(body.code).toBe("host_unreachable");
    expect(body.host).toBe("laptop");
    expect(body.lastSeenAt).toBe(DEAD.lastSeenAt);
    expect(String(body.error)).toContain("laptop");
    expect(String(body.error)).toContain("connection refused");
    // NOTHING WAS SENT. That is the whole difference between this and the unknown-outcome case.
    expect(calls).toHaveLength(0);
  });

  test("an incompatible member is refused with the protocol-mismatch reason", async () => {
    const { transport, calls } = transportOf(() => ok(new Response("{}")));
    const [req, url] = post("/api/pane/w1:p1/keys?host=laptop", `{"keys":["Enter"]}`);
    const res = await forward(req, url, { transport, state: SKEWED });
    expect(res.status).toBe(503);
    expect((await failureBody(res)).code).toBe("host_incompatible");
    expect(calls).toHaveLength(0);
  });

  test("a READ to a dead member is still attempted — a stale mirror is worth asking for", async () => {
    const { transport, calls } = transportOf(() => ok(new Response(`{"lines":[]}`)));
    const [req, url] = get("/api/pane/w1:p1?host=laptop");
    expect((await forward(req, url, { transport, state: DEAD })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("an attempted write whose outcome is unknown (§10.3, .adr/0010 over a lossier link)", () => {
  test("a timeout is reported as UNKNOWN — not failure, not success, and not retried", async () => {
    const { transport, calls } = transportOf(() => ({
      ok: false,
      state: "unreachable",
      reason: "pane/w1:p1/reply: timed out after 1200ms",
      receivedAt: 2,
    }));
    const [req, url] = post("/api/pane/w1:p1/reply?host=laptop", `{"text":"deploy prod"}`);
    const res = await forward(req, url, { transport });

    expect(res.status).toBe(504);
    const body = await failureBody(res);
    expect(body.code).toBe("write_outcome_unknown");
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("outcome is unknown");
    expect(String(body.error)).toContain("re-read the pane");
    expect(String(body.error)).toContain("will not retry");
    // ONE dial. A retry here types "deploy prod" into a real terminal twice.
    expect(calls).toHaveLength(1);
  });

  test("a connection error mid-flight is ALSO unknown — the runtime cannot prove nothing was sent", async () => {
    const { transport } = transportOf(() => ({
      ok: false,
      state: "unreachable",
      reason: "pane/w1:p1/keys: socket hang up",
      receivedAt: 2,
    }));
    const [req, url] = post("/api/pane/w1:p1/keys?host=laptop", `{"keys":["ctrl+c"]}`);
    expect((await forward(req, url, { transport })).status).toBe(504);
  });

  test("a fault that PROVABLY never left this process is a hard refusal, not an ambiguity", async () => {
    const { transport } = transportOf(() => ({
      ok: false,
      state: "unreachable",
      reason: "no pack secret",
      attempted: false,
      receivedAt: 2,
    }));
    const [req, url] = post("/api/pane/w1:p1/reply?host=laptop", `{"text":"hi"}`);
    const res = await forward(req, url, { transport });
    expect(res.status).toBe(503);
    expect((await failureBody(res)).code).toBe("host_unreachable");
  });

  test("a failed READ never becomes an unknown outcome — nothing changed, so nothing is ambiguous", async () => {
    const { transport } = transportOf(() => ({
      ok: false,
      state: "unreachable",
      reason: "pane/w1:p1/history: timed out after 1200ms",
      receivedAt: 2,
    }));
    const [req, url] = get("/api/pane/w1:p1/history?host=laptop");
    const res = await forward(req, url, { transport });
    expect(res.status).toBe(503);
    expect((await failureBody(res)).code).toBe("host_unreachable");
  });

  test("no failure is ever a bare 500, and every one carries a renderable code", async () => {
    for (const state of [DEAD, SKEWED, REACHABLE]) {
      const { transport } = transportOf(() => ({
        ok: false,
        state: "unreachable",
        reason: "down",
        receivedAt: 2,
      }));
      const [req, url] = post("/api/tab?host=laptop", "{}");
      const res = await forward(req, url, { transport, state });
      expect(res.status).not.toBe(500);
      expect((await failureBody(res)).code).toBeString();
    }
  });
});

// ── §12 The lead's own record of the forward ─────────────────────────────────

describe("the lead audits the forward, and the peer audits the action (§12)", () => {
  test("one line, `action` unchanged, plus the target host", async () => {
    const lines: unknown[] = [];
    const { transport } = transportOf(() => ok(new Response(`{"ok":true}`)));
    const [req, url] = post("/api/pane/w1:p1/reply?host=laptop&session=work", `{"text":"hi"}`);
    await forward(req, url, { transport, audit: (e) => void lines.push(e) });

    expect(lines).toEqual([
      { action: "reply", host: "laptop", paneId: "w1:p1", session: "work", outcome: "http 200" },
    ]);
  });

  test("an unknown outcome is the single most important line in the log, so it is logged", async () => {
    const lines: { outcome: string }[] = [];
    const { transport } = transportOf(() => ({
      ok: false,
      state: "unreachable",
      reason: "timed out after 1200ms",
      receivedAt: 2,
    }));
    const [req, url] = post("/api/pane/w1:p1/reply?host=laptop", `{"text":"hi"}`);
    await forward(req, url, { transport, audit: (e) => void lines.push(e) });
    expect(lines.map((l) => l.outcome)).toEqual(["unknown"]);
  });

  test("a read is not audited on the lead — crossing a link does not make it a write", async () => {
    const lines: unknown[] = [];
    const { transport } = transportOf(() => ok(new Response(`{"lines":[]}`)));
    for (const path of ["/api/pane/w1:p1?host=laptop", "/api/pane/w1:p1/history?host=laptop"]) {
      const [req, url] = get(path);
      await forward(req, url, { transport, audit: (e) => void lines.push(e) });
    }
    expect(lines).toEqual([]);
  });
});

// ── §13 Uploads ──────────────────────────────────────────────────────────────

describe("uploads land on the owning host (§13)", () => {
  test("the size bound is enforced BEFORE forwarding — the peer's uplink is never spent on a reject", async () => {
    const { transport, calls } = transportOf(() => ok(new Response(`{"ok":true}`)));
    const url = new URL("https://lead.example/api/pane/w1:p1/upload?host=laptop");
    const req = new Request(url, {
      method: "POST",
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=b", "content-length": String(50 * 1024 * 1024) },
    });
    const res = await forwardToPeer(req, url, { link: LINK, state: REACHABLE, transport });

    expect(res.status).toBe(413);
    const body = await failureBody(res);
    expect(body.code).toBe("image_too_large");
    expect(body.error).toBe("image too large (max 10 MB)");
    expect(calls).toHaveLength(0);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  test("a legal multipart body is forwarded with its boundary, and the peer's own path comes back", async () => {
    // The path is peer-local and absolute on the PEER's filesystem — that is the requirement, not a
    // leak: Herdr on that machine is what has to open it. The lead never rewrites it.
    const peerPath = "/home/you/.local/state/collie/uploads/w1_p1-abc.png";
    const { transport, calls } = transportOf(() =>
      ok(new Response(JSON.stringify({ ok: true, path: peerPath }), { status: 200 })),
    );
    const url = new URL("https://lead.example/api/pane/w1:p1/upload?host=laptop");
    const req = new Request(url, {
      method: "POST",
      body: "--b\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nPNG\r\n--b--",
      headers: { "content-type": "multipart/form-data; boundary=b" },
    });
    const res = await forwardToPeer(req, url, { link: LINK, state: REACHABLE, transport });

    expect(calls[0]!.route).toBe("pane/w1:p1/upload");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("multipart/form-data; boundary=b");
    expect(calls[0]!.init.body).not.toBeUndefined();
    expect(await res.json()).toEqual({ ok: true, path: peerPath });
  });
});

// ── The lead never reads a peer's disk ───────────────────────────────────────

describe("journal, uploads and state stay host-local", () => {
  test("nothing on the lead's forwarding path can touch a filesystem", () => {
    // The spec asks for this to be asserted "with an injected fs that fails on any call". There is
    // no fs to inject, and that IS the assertion: the whole lead-side path — the forward, the peer
    // client, the registry, the lead runtime — imports no filesystem module and no journal module,
    // so a peer's history CANNOT be resolved to a path here even by mistake. `bridge/journal/` stays
    // the only thing in the bridge that touches a disk (CLAUDE.md), on the machine that owns the log.
    for (const file of ["forward.ts", "peer-client.ts", "registry.ts", "lead.ts", "merge.ts"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toMatch(/from "node:fs/);
      expect(src).not.toMatch(/from "\.\.\/journal\//);
      expect(src).not.toMatch(/containedRealpath|journalRoots|readFile|realpath/);
    }
  });

  test("a peer-scoped history request is one HTTP call and nothing else", async () => {
    const transcript = JSON.stringify({ turns: [{ role: "user", text: "hi" }] });
    const { transport, calls } = transportOf(() =>
      ok(new Response(transcript, { status: 200, headers: { etag: '"peer-history"' } })),
    );
    const [req, url] = get("/api/pane/w1:p1/history?host=laptop&limit=200");
    const res = await forward(req, url, { transport });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.route).toBe("pane/w1:p1/history");
    expect(calls[0]!.params).toEqual({ limit: "200" });
    expect(await res.text()).toBe(transcript);
    expect(res.headers.get("etag")).toBe('"peer-history"');
  });
});
