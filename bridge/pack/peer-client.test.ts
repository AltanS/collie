import { describe, expect, test } from "bun:test";

import { PROTOCOL_HEADER, MEMBER_HEADER, DEVICE_HEADER } from "./admission.ts";
import { PACK } from "./fixtures.ts";
import {
  DEFAULT_PACK_TIMEOUT_MS,
  PACK_TIMEOUT_ENV,
  PeerClient,
  packTimeoutBudget,
  packUrl,
  sweepPeers,
  type PackFetch,
  type PackLink,
} from "./peer-client.ts";

// The lead's client, tested against a FAKE fetch rather than a socket (CLAUDE.md: anything needing
// `Bun.serve`/`Bun.connect` is out of `bun test`'s reach, so the transport is a parameter).
//
// The interesting surface is not "does it GET" — it is the verdict matrix: every way a peer can fail
// has to land in exactly one of §10.2's three states, because the phone renders each differently and
// only `incompatible` stops being retried on the poll cadence.

const laptop: PackLink = { memberId: "laptop", address: "laptop.example:8787" };

/** A fetch that answers with `body`, stamped with the pack headers a healthy peer sends. */
function replying(
  body: unknown,
  init: { status?: number; protocol?: string | null; member?: string } = {},
): { fetch: PackFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: PackFetch = async (url, reqInit) => {
    calls.push({ url, init: reqInit });
    const headers = new Headers({ "content-type": "application/json" });
    const protocol = init.protocol === undefined ? "1" : init.protocol;
    if (protocol !== null) headers.set(PROTOCOL_HEADER, protocol);
    headers.set(MEMBER_HEADER, init.member ?? "laptop");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    });
  };
  return { fetch, calls };
}

function client(fetch: PackFetch, over: { timeoutMs?: number; secret?: string | null; device?: string | null } = {}) {
  return new PeerClient({
    self: "desk",
    secret: () => (over.secret === undefined ? PACK.secret : over.secret),
    timeoutMs: over.timeoutMs ?? 50,
    fetch,
    now: () => 1_000,
    device: over.device === undefined ? undefined : () => over.device ?? null,
  });
}

describe("packTimeoutBudget — strictly below the lead's poll (§10.1)", () => {
  test("the documented default pair: 1200 against a 1500 ms poll", () => {
    expect(packTimeoutBudget(1500, {})).toBe(DEFAULT_PACK_TIMEOUT_MS);
    expect(DEFAULT_PACK_TIMEOUT_MS).toBeLessThan(1500);
  });

  test("an operator override is honoured while it fits", () => {
    expect(packTimeoutBudget(1500, { [PACK_TIMEOUT_ENV]: "400" })).toBe(400);
  });

  test("an override that would outlast the poll is clamped, never trusted", () => {
    // The whole point of the budget: one slow peer must not be able to stall the lead's own snapshot.
    expect(packTimeoutBudget(1500, { [PACK_TIMEOUT_ENV]: "9000" })).toBeLessThan(1500);
    expect(packTimeoutBudget(1500, { [PACK_TIMEOUT_ENV]: "9000" })).toBe(1200);
    expect(packTimeoutBudget(600, {})).toBeLessThan(600);
  });

  test("garbage and non-positive values fall back to the default, then clamp", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(packTimeoutBudget(10_000, { [PACK_TIMEOUT_ENV]: raw })).toBe(DEFAULT_PACK_TIMEOUT_MS);
    }
  });
});

describe("packUrl — an address is a machine, never a URL with extras", () => {
  test("a bare host:port becomes an https pack URL", () => {
    expect(packUrl("laptop.example:8787", "hello")).toBe("https://laptop.example:8787/pack/v1/hello");
  });

  test("an explicit scheme is kept; params ride the query", () => {
    expect(packUrl("http://127.0.0.1:8787", "snapshot", { session: "work" })).toBe(
      "http://127.0.0.1:8787/pack/v1/snapshot?session=work",
    );
  });

  test("an address carrying a path, query, fragment or credentials is refused", () => {
    for (const bad of [
      "laptop.example:8787/evil",
      "https://laptop.example/?x=1",
      "https://laptop.example/#f",
      "https://user:pw@laptop.example",
      "",
      "https://",
      "not a url",
    ]) {
      expect(packUrl(bad, "hello")).toBeNull();
    }
  });

  test("a route cannot climb out of the pack prefix", () => {
    // `new URL` normalises `..` away, so this asserts the post-normalisation pathname — the only
    // check that can actually catch an escape.
    expect(packUrl("laptop.example", "../../api/snapshot")).toBeNull();
    expect(packUrl("laptop.example", "/pane/w1:p1/reply")).toBe("https://laptop.example/pack/v1/pane/w1:p1/reply");
  });
});

describe("PeerClient — the request the lead sends (§6)", () => {
  test("carries both factors' bearer half, the protocol version and who is speaking", async () => {
    const { fetch, calls } = replying({ protocol: 1, member: "laptop" });
    await client(fetch).hello(laptop);
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe("https://laptop.example:8787/pack/v1/hello");
    expect(headers.get("authorization")).toBe(`Bearer ${PACK.secret}`);
    expect(headers.get(PROTOCOL_HEADER)).toBe("1");
    expect(headers.get(MEMBER_HEADER)).toBe("desk");
    expect(headers.get(DEVICE_HEADER)).toBeNull();
  });

  test("forwards the operator's device id when the lead's device gate is on", async () => {
    const { fetch, calls } = replying({ protocol: 1, member: "laptop" });
    await client(fetch, { device: "phone-1" }).hello(laptop);
    expect(new Headers(calls[0]!.init.headers).get(DEVICE_HEADER)).toBe("phone-1");
  });

  test("with no pack secret nothing is sent at all — an unauthenticated probe is never made", async () => {
    const { fetch, calls } = replying({ protocol: 1, member: "laptop" });
    const outcome = await client(fetch, { secret: null }).hello(laptop);
    expect(calls).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
  });

  test("`snapshot` names the session only when there is one — absent means the peer's primary", async () => {
    const { fetch, calls } = replying({});
    const c = client(fetch);
    await c.snapshot(laptop);
    await c.snapshot(laptop, "");
    await c.snapshot(laptop, "work");
    expect(calls.map((c2) => c2.url)).toEqual([
      "https://laptop.example:8787/pack/v1/snapshot",
      "https://laptop.example:8787/pack/v1/snapshot",
      "https://laptop.example:8787/pack/v1/snapshot?session=work",
    ]);
  });
});

describe("PeerClient — the verdict matrix (§7, §10.2)", () => {
  test("reachable: the body, the peer's id, and the LEAD's receipt time", async () => {
    const { fetch } = replying({ protocol: 1, member: "laptop" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome).toEqual({
      ok: true,
      value: { protocol: 1, member: "laptop" },
      status: 200,
      member: "laptop",
      receivedAt: 1_000, // the injected lead clock — never a header from the peer (§6)
    });
  });

  test("a connection that never opens is unreachable, not an exception", async () => {
    const fetch: PackFetch = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    expect(outcome.ok === false && outcome.reason).toContain("ECONNREFUSED");
  });

  test("a peer slower than the budget is unreachable, and its request is CANCELLED", async () => {
    let aborted = false;
    const fetch: PackFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const started = Date.now();
    const outcome = await client(fetch, { timeoutMs: 25 }).snapshot(laptop);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    expect(outcome.ok === false && outcome.reason).toContain("timed out after 25ms");
  });

  test("an auth failure is unreachable — §10.2's table, not a fourth state", async () => {
    const { fetch } = replying({ error: "unauthorized" }, { status: 401 });
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    expect(outcome.ok === false && outcome.reason).toContain("HTTP 401");
  });

  test("a peer's 409 is INCOMPATIBLE and carries the reason verbatim, with both versions", async () => {
    const { fetch } = replying(
      { error: "pack protocol mismatch", code: "protocol_mismatch", expected: 2, received: 1 },
      { status: 409, protocol: "1" },
    );
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    if (outcome.state !== "incompatible") throw new Error(`expected incompatible, got ${outcome.state}`);
    expect(outcome.reason).toContain("pack protocol mismatch");
    expect(outcome.expected).toBe(2);
    expect(outcome.received).toBe(1);
  });

  test("a RESPONSE with the wrong version is incompatible — a mismatch, never a parse error (§7)", async () => {
    // The body is perfectly well-formed v2 JSON. Reading it first would report "malformed body" and
    // hide the real cause, which is the failure mode §7 names explicitly.
    const { fetch } = replying({ some: "v2 shape" }, { protocol: "2" });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok) throw new Error("expected a failure");
    if (outcome.state !== "incompatible") throw new Error(`expected incompatible, got ${outcome.state}`);
    expect(outcome.received).toBe(2);
    expect(outcome.expected).toBe(1);
  });

  test("a response with NO version header is incompatible, never defaulted to 1", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok) throw new Error("expected a failure");
    if (outcome.state !== "incompatible") throw new Error(`expected incompatible, got ${outcome.state}`);
    expect(outcome.received).toBeNull();
  });

  test("a matching version with an unparseable body is unreachable, not incompatible", async () => {
    const { fetch } = replying("{not json", {});
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    expect(outcome.ok === false && outcome.reason).toContain("malformed response body");
  });

  test("an unusable stored address fails as unreachable without dialling anything", async () => {
    const { fetch, calls } = replying({});
    const outcome = await client(fetch).snapshot({ memberId: "nas", address: "nas.example/evil" });
    expect(calls).toEqual([]);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
  });

  test("no reason string ever contains the pack secret", async () => {
    const failures = [
      await client(() => Promise.reject(new Error("connect ECONNREFUSED"))).snapshot(laptop),
      await client(replying({}, { status: 500 }).fetch).snapshot(laptop),
      await client(replying({}, { protocol: "7" }).fetch).snapshot(laptop),
      await client(replying("nope").fetch).snapshot(laptop),
    ];
    for (const f of failures) {
      expect(f.ok).toBe(false);
      expect(f.ok === false && f.reason.includes(PACK.secret)).toBe(false);
    }
  });

  test("`raw` hands the Response back unread, so a proxied read keeps its bytes and its ETag", async () => {
    const fetch: PackFetch = async () =>
      new Response("mirror bytes", { status: 200, headers: { [PROTOCOL_HEADER]: "1", etag: 'W/"abc"' } });
    const outcome = await client(fetch).raw(laptop, "pane/w1:p1");
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.value.bodyUsed).toBe(false);
    expect(outcome.value.headers.get("etag")).toBe('W/"abc"');
    expect(await outcome.value.text()).toBe("mirror bytes");
  });
});

describe("sweepPeers — concurrent, never serial (§10.1)", () => {
  test("every peer's call is in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const links: PackLink[] = ["a", "b", "c"].map((id) => ({ memberId: id, address: `${id}.example` }));
    const sweep = sweepPeers(links, async (link) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return link.memberId.toUpperCase();
    });
    // Every call must have started before any of them is allowed to finish; a serial implementation
    // deadlocks here rather than merely being slow, which is the assertion worth having.
    while (release.length < links.length) await Promise.resolve();
    for (const r of release) r();
    expect(peak).toBe(3);
    expect([...(await sweep)]).toEqual([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ]);
  });

  test("one sick peer never costs a healthy one its answer", async () => {
    const links: PackLink[] = [
      { memberId: "up", address: "up.example" },
      { memberId: "down", address: "down.example" },
    ];
    const fetch: PackFetch = async (url) => {
      if (url.includes("down")) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { [PROTOCOL_HEADER]: "1" } });
    };
    const c = client(fetch);
    const results = await sweepPeers(links, (link) => c.snapshot(link));
    expect(results.get("up")?.ok).toBe(true);
    expect(results.get("down")?.ok).toBe(false);
  });

  test("a solo lead sweeps nothing", async () => {
    let ran = 0;
    const results = await sweepPeers([], async () => ran++);
    expect(results.size).toBe(0);
    expect(ran).toBe(0);
  });
});
