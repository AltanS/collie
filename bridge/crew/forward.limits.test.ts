// The crew body-limit and redirect cases of forward.test.ts (CREW_PROTOCOL.md §9.1, ADR 0161), split
// out so that file stays under its test file size ceiling (scripts/test-file-size.test.ts).

import { describe, expect, test } from "bun:test";

import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";
import {
  forwardToPeer,
  LARGE_MASKED_BYTES,
  mergeAskRequest,
  type ForwardDeps,
  type ForwardErrorCode,
  type ForwardTransport,
} from "./forward.ts";
import { PROTOCOL_HEADER } from "./admission.ts";
import { CREW_PROTOCOL_VERSION } from "./enrollment.ts";
import { BodyRefused, WHOLE_ANSWER_DEADLINE_MS } from "./guarded-body.ts";
import { leadRowCarry } from "./launcher-rows.ts";
import { PeerClient, type CrewLink, type CrewParams, type PeerOutcome } from "./peer-client.ts";
import type { PeerState } from "./registry.ts";
import type { CrewRequestInit } from "./transport.ts";

// The crew body-limit and redirect cases of forward.test.ts, split out for the test file size cap
// (scripts/test-file-size.test.ts). The helpers below are small copies of that file's own.

const LINK: CrewLink = { memberId: "laptop", address: "laptop.example:8787" };
const REACHABLE: PeerState = {
  memberId: "laptop",
  health: "reachable",
  lastSeenAt: 1_754_000_000_000,
  reason: null,
  version: "1.0.0-alpha.12",
  conflict: null,
  preflight: null,
};

/** Records every dial, so "was this attempted?" and "was it retried?" are assertable facts. */
function transportOf(answer: (init: CrewRequestInit) => PeerOutcome<Response>) {
  const calls: {
    route: string;
    params: CrewParams;
    init: CrewRequestInit;
    budgetMs: number | undefined;
  }[] = [];
  const transport: ForwardTransport = async (_link, route, params, init, budgetMs) => {
    calls.push({ route, params, init, budgetMs });
    return answer(init);
  };
  return { transport, calls };
}

function ok(res: Response): PeerOutcome<Response> {
  return { ok: true, value: res, status: res.status, member: "laptop", receivedAt: 1, date: null };
}

function forward(req: Request, url: URL, deps: Partial<ForwardDeps> & { transport: ForwardTransport }) {
  return forwardToPeer(req, url, {
    link: LINK,
    state: REACHABLE,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    ...deps,
  });
}

function get(path: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`https://lead.example${path}`);
  return [new Request(url, { headers }), url];
}

function post(path: string, body: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`https://lead.example${path}`);
  return [new Request(url, { method: "POST", body, headers }), url];
}

/** The refusal envelope every lead-generated failure answers with (`forwardError` in forward.ts). */
interface ForwardFailure {
  ok: boolean;
  code: ForwardErrorCode;
  error: string;
  host?: string;
  lastSeenAt?: number | null;
  memberVersion?: string;
}

describe("the lead compresses the phone hop itself (.adr/0023)", () => {
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

  test("the phone's accept-encoding never reaches the member hop (the beta.9 invariant, ADR 0161)", async () => {
    // The dial sets the member hop's own `accept-encoding: gzip` (peer-client.test.ts); the forward
    // passes none of the phone's value on.
    const [, peer] = peerJson();
    const { transport, calls } = transportOf(() => ok(peer));
    const [req, url] = get("/api/pane/w1:p1?host=laptop", { "accept-encoding": "gzip, deflate, br, zstd" });
    await forward(req, url, { transport });
    expect(new Headers(calls[0]!.init.headers).get("accept-encoding")).toBeNull();
  });

  test("a streamed answer the lead's bounds cut off: the phone's read fails, and the lead's lines say so (V3)", async () => {
    const cut = () =>
      ok(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(8));
            },
            pull(c) {
              c.error(new BodyRefused("the answer passed 10 bytes", false));
            },
          }),
          { status: 200, headers: { "content-type": "application/octet-stream" } },
        ),
      );
    const lines: string[] = [];
    const audit: { outcome: string }[] = [];
    // A read: no audit line, one log line.
    const [req, url] = get("/api/blobs/abc?host=laptop");
    const res = await forward(req, url, { transport: transportOf(cut).transport, log: (l) => lines.push(l), audit: (e) => audit.push(e) });
    expect(res.status).toBe(200);
    expect(await res.arrayBuffer().then(() => "whole", () => "error")).toBe("error");
    expect(lines).toEqual(["[crew] laptop: the answer to blobs/abc broke off after http 200: the answer passed 10 bytes"]);
    expect(audit).toEqual([]);
    // A write: its audit line first says `http 200`, then a second line says the body was cut.
    const write = new Request("https://lead.example/api/pane/w1:p1/reply?host=laptop", { method: "POST", body: "{}" });
    const res2 = await forward(write, new URL(write.url), { transport: transportOf(cut).transport, log: (l) => lines.push(l), audit: (e) => audit.push(e) });
    await res2.arrayBuffer().catch(() => null);
    expect(audit.map((e) => e.outcome)).toEqual(["http 200", "http 200, body cut: the answer passed 10 bytes"]);
  });

  test("the phone's signal reaches the dial: a forward, a merged ask and a carried launch all abort with the phone (review round 9)", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const { transport } = transportOf((init) => {
      seen.push(init.signal);
      return ok(Response.json({ ok: true }));
    });
    // A plain forward.
    const phone = new AbortController();
    const [req, url] = get("/api/launchers?host=laptop");
    const plain = new Request(req, { signal: phone.signal });
    await forward(plain, url, { transport });
    // The launcher merge's own ask (bridge/server.ts), built from the phone's request.
    const merged = mergeAskRequest(new URL("https://lead.example/api/launchers?host=laptop&scope=member"), plain);
    await forward(merged, new URL(merged.url), { transport });
    // A launch the lead's row carry rebuilt.
    const launch = new Request("https://lead.example/api/launch?host=laptop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "make serve" }), signal: phone.signal });
    const carried = await leadRowCarry(() => Promise.resolve([{ command: "make serve", label: "Serve", cwd: "/srv/site", noPrompts: true }]), "/var/home/op").request(launch);
    expect(carried.request).not.toBe(launch);
    await forward(carried.request, new URL(carried.request.url), { transport });
    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal !== undefined && signal !== null && !signal.aborted)).toBe(true);
    phone.abort();
    expect(seen.map((signal) => signal?.aborted)).toEqual([true, true, true]);
  });

  test("a download streams with no total deadline; every other forward is read in full and has one", async () => {
    const { transport, calls } = transportOf(() => ok(peerJson()[1]));
    const routes = ["blobs/abc", "pane/w1:p1/files/image", "project-picture/0123456789ab0123456789ab", "pane/w1:p1", "pane/w1:p1/history"];
    for (const route of routes) {
      const [req, url] = get(`/api/${route}?host=laptop`);
      await forward(req, url, { transport });
    }
    expect(calls.map((call) => [call.route, call.init.bodyDeadlineMs])).toEqual([
      ["blobs/abc", undefined],
      ["pane/w1:p1/files/image", undefined],
      ["project-picture/0123456789ab0123456789ab", undefined],
      ["pane/w1:p1", WHOLE_ANSWER_DEADLINE_MS],
      ["pane/w1:p1/history", WHOLE_ANSWER_DEADLINE_MS],
    ]);
  });
});

describe("a write to a member that is not reachable (§10.3)", () => {
  test("a write the phone left is still write_outcome_unknown to the phone, and the audit names the phone, not the link (review round 10)", async () => {
    const { transport } = transportOf(() => ({ ok: false, state: "unreachable", reason: "the caller went away", callerLeft: true, receivedAt: 2 }));
    const audit: { reason?: string; outcome?: string }[] = [];
    const [req, url] = post("/api/pane/w1:p1/reply?host=laptop", `{"text":"hi"}`);
    const res = await forward(req, url, { transport, audit: (entry) => audit.push(entry) });
    const body: unknown = await res.json();
    expect(typeof body === "object" && body !== null && "code" in body ? body.code : null).toBe("write_outcome_unknown");
    expect(audit.map((entry) => [entry.outcome, entry.reason])).toEqual([["unknown", "caller_left"]]);
  });

  test("a streamed answer the phone left mid-body is logged and audited as the phone leaving, not as a cut (review round 10)", async () => {
    const leaving = new AbortController();
    const { transport } = transportOf((init) => {
      // The dial's own abort, which the phone's signal drives, errors the member's body.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return ok(new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    });
    const audit: { outcome?: string; reason?: string }[] = [];
    const lines: string[] = [];
    const [plain, url] = post("/api/pane/w1:p1/reply?host=laptop", `{"text":"hi"}`);
    const req = new Request(plain, { signal: leaving.signal });
    const res = await forward(req, url, { transport, audit: (entry) => audit.push(entry), log: (line) => lines.push(line) });
    const reader = res.body!.getReader();
    await reader.read();
    leaving.abort();
    await reader.read().catch(() => null);
    expect(audit.map((entry) => [entry.outcome, entry.reason])).toEqual([["http 200", undefined], ["http 200, caller left", "caller_left"]]);
    expect(lines).toEqual(["[crew] laptop: the phone left before the answer to pane/w1:p1/reply ended (http 200)"]);
  });
});

// ── A member that redirects is a member out of reach, to the phone (§9.1) ─────
// Through the real dial: `PeerClient.proxy` with a real `fetch` is the transport, as the lead wires it.

describe("a redirect on a forwarded read answers the phone as a member out of reach does", () => {
  function realTransport(): ForwardTransport {
    const peers = new PeerClient({ self: "desk", secret: () => "s", timeoutMs: 5_000, fetch: (url, init) => fetch(url, init), now: () => 1_000 });
    return (link, route, params, init, budgetMs) => peers.proxy(link, route, params, init, budgetMs);
  }

  /** What the phone sees, minus the sentence: the status, the code, and every header. */
  async function seenByPhone(res: Response) {
    // SAFETY: both answers are lead refusals, and a lead refusal is `forwardError`'s JSON, `{ ok, code, error, host }`.
    const body = (await res.json()) as ForwardFailure;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== "content-length") headers[k] = v;
    });
    return { status: res.status, ok: body.ok, code: body.code, headers };
  }

  test("a 302 to another origin: the same 503 host_unreachable as a closed port, and the target is never asked", async () => {
    const seen: string[] = [];
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (seen.push(req.url), new Response("stolen")) });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${String(target.port)}/x`, [PROTOCOL_HEADER]: String(CREW_PROTOCOL_VERSION) } }),
    });
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const closedPort = closed.port;
    await closed.stop(true);
    try {
      const transport = realTransport();
      const [req, url] = get("/api/pane/t4?host=laptop&lines=60");
      const redirected = await forward(req, url, { transport, link: { memberId: "laptop", address: `http://127.0.0.1:${String(redirector.port)}` } });
      const [req2, url2] = get("/api/pane/t4?host=laptop&lines=60");
      const gone = await forward(req2, url2, { transport, link: { memberId: "laptop", address: `http://127.0.0.1:${String(closedPort)}` } });
      expect(redirected.headers.get("location")).toBeNull();
      expect(await seenByPhone(redirected)).toEqual(await seenByPhone(gone));
      expect(redirected.status).toBe(503);
      expect(seen).toHaveLength(0);
    } finally {
      await redirector.stop(true);
      await target.stop(true);
    }
  });
});

// ── One large masked read at a time (round 16) ──────────────────────────────────────────────────
// Past LARGE_MASKED_BYTES a masked answer takes the lead's one large-read slot before it reads on, and
// keeps it until its mask is done. A small answer never waits, and a phone that leaves stops the wait.
describe("a large masked answer waits for the one before it", () => {
  const MB = 1024 * 1024;
  /** A member body of `chunks` MB, one MB per pull; `hold` (if given) stops it after `holdAt` MB. */
  function body(chunks: number, hold?: { at: number; until: Promise<void> }) {
    const seen = { pulls: 0 };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (hold !== undefined && seen.pulls === hold.at) await hold.until;
        if (seen.pulls === chunks) {
          controller.close();
          return;
        }
        seen.pulls += 1;
        controller.enqueue(new Uint8Array(MB).fill(0x61));
      },
    }, { highWaterMark: 0 });
    return { stream, seen };
  }
  const viaLead = (stream: ReadableStream<Uint8Array>, signal?: AbortSignal) => {
    const url = new URL("https://lead.example/api/pane/w1:p1/history?host=laptop");
    const transport = async (): Promise<PeerOutcome<Response>> => ({ ok: true, value: new Response(stream, { status: 200 }), status: 200, member: "laptop", receivedAt: 1, date: null });
    return forwardToPeer(new Request(url, signal === undefined ? {} : { signal }), url, {
      link: LINK,
      state: REACHABLE,
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      transport,
      mask: (_answer, raw) => raw,
    });
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  };

  test("the second large read pauses past 4 MB until the first is masked; a small one never waits", async () => {
    expect(LARGE_MASKED_BYTES).toBe(4 * MB);
    let open = () => {};
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = body(6, { at: 5, until: held });
    const firstDone = viaLead(first.stream);
    await until(() => first.seen.pulls === 5);

    const second = body(6);
    const secondDone = viaLead(second.stream);
    await until(() => second.seen.pulls === 5);
    await Bun.sleep(50);
    // Past 4 MB it waits for the slot: no sixth pull while the first holds it.
    expect(second.seen.pulls).toBe(5);

    // A small answer passes at once, the slot taken or not.
    const small = body(1);
    const smallRes = await viaLead(small.stream);
    expect(smallRes.status).toBe(200);
    expect((await smallRes.text()).length).toBe(MB);

    open();
    const [a, b] = await Promise.all([firstDone, secondDone]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(second.seen.pulls).toBe(6);
    expect((await b.text()).length).toBe(6 * MB);
  });

  test("a phone that leaves while its large read waits gets no answer held for it, and the slot moves on", async () => {
    let open = () => {};
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = body(6, { at: 5, until: held });
    const firstDone = viaLead(first.stream);
    await until(() => first.seen.pulls === 5);

    const phone = new AbortController();
    const waiting = body(6);
    const waitingDone = viaLead(waiting.stream, phone.signal);
    await until(() => waiting.seen.pulls === 5);
    phone.abort();
    expect((await waitingDone).status).toBe(503);
    expect(waiting.seen.pulls).toBe(5);

    open();
    expect((await firstDone).status).toBe(200);
    // The slot is free again: the next large read runs through.
    const next = body(6);
    expect((await viaLead(next.stream)).status).toBe(200);
  });
});
