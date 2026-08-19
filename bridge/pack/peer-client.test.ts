import { describe, expect, test } from "bun:test";

import { PROTOCOL_HEADER, MEMBER_HEADER, DEVICE_HEADER } from "./admission.ts";
import { PACK } from "./fixtures.ts";
import {
  DEFAULT_PACK_HELLO_TIMEOUT_MS,
  DEFAULT_PACK_TIMEOUT_MS,
  PACK_HELLO_TIMEOUT_ENV,
  PACK_TIMEOUT_ENV,
  PeerClient,
  packHelloBudget,
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
function replying<TBody>(
  body: TBody,
  init: { status?: number; protocol?: string | null; member?: string } = {},
) {
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

function client(
  fetch: PackFetch,
  over: { timeoutMs?: number; helloTimeoutMs?: number; secret?: string | null; device?: string | null } = {},
) {
  return new PeerClient({
    self: "desk",
    secret: () => (over.secret === undefined ? PACK.secret : over.secret),
    timeoutMs: over.timeoutMs ?? 50,
    helloTimeoutMs: over.helloTimeoutMs,
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

describe("packHelloBudget — the VERDICT budget, which the poll fraction must not clamp (§10.4)", () => {
  test("the default is patient enough for a cold pinned-TLS handshake over a relay", () => {
    // The live finding: a peer behind a DERP relay handshakes in ~1.9 s. A verdict budget below that
    // can only ever say "gone" about a machine that is there.
    expect(packHelloBudget(1500, {})).toBe(DEFAULT_PACK_HELLO_TIMEOUT_MS);
    expect(DEFAULT_PACK_HELLO_TIMEOUT_MS).toBeGreaterThan(1900);
  });

  test("it is NOT clamped by the poll fraction — that clamp is the deadlock", () => {
    // packTimeoutBudget(1500) is 1200. If the probe were clamped the same way, every attempt would
    // abort mid-handshake, leave no pooled connection, and the link would never bootstrap.
    expect(packHelloBudget(1500, {})).toBeGreaterThan(packTimeoutBudget(1500, {}));
    expect(packHelloBudget(300, {})).toBe(DEFAULT_PACK_HELLO_TIMEOUT_MS);
  });

  test("an operator override is honoured, and capped only against a typo", () => {
    expect(packHelloBudget(1500, { [PACK_HELLO_TIMEOUT_ENV]: "20000" })).toBe(20_000);
    expect(packHelloBudget(1500, { [PACK_HELLO_TIMEOUT_ENV]: "50000000" })).toBe(60_000);
  });

  test("it is floored at the data budget: the verdict is never the more impatient of the two", () => {
    expect(packHelloBudget(1500, { [PACK_HELLO_TIMEOUT_ENV]: "10" })).toBe(packTimeoutBudget(1500, {}));
    // …including when the operator has widened the data budget itself.
    const env = { [PACK_TIMEOUT_ENV]: "1400", [PACK_HELLO_TIMEOUT_ENV]: "200" };
    expect(packHelloBudget(2000, env)).toBe(packTimeoutBudget(2000, env));
  });

  test("garbage and non-positive values fall back to the default", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(packHelloBudget(1500, { [PACK_HELLO_TIMEOUT_ENV]: raw })).toBe(DEFAULT_PACK_HELLO_TIMEOUT_MS);
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
      value: { protocol: 1, member: "laptop", version: null },
      status: 200,
      member: "laptop",
      receivedAt: 1_000, // the injected lead clock — never a header from the peer (§6)
      // The far side sent no HTTP `Date`, and an absent one is `null` rather than a guess.
      date: null,
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
        // SAFETY: PeerClient always attaches its budget's AbortSignal before dialling — the
        // cancellation this test is checking for is exactly what that signal carries.
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

  test("a 403 with a `code` is REFUSED — an answer, not a failure to reach (§14.3)", async () => {
    // The state exists so `collie promote` can tell "the lead said no" from "the lead is gone".
    // Collapsing it into `unreachable` is what used to aim the operator at `--force`.
    const { fetch } = replying(
      { error: 'this lead has not approved "nas" to take over — …', code: "handover_not_approved" },
      { status: 403 },
    );
    const outcome = await client(fetch).json(laptop, "lead");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    if (outcome.state !== "refused") throw new Error(`expected refused, got ${outcome.state}`);
    // Verbatim: the far side's sentence names the verb to run and the window, so it is not paraphrased.
    expect(outcome.reason).toBe('this lead has not approved "nas" to take over — …');
    expect(outcome.code).toBe("handover_not_approved");
    expect(outcome.status).toBe(403);
  });

  test("a bare 403 with no `code` stays unreachable — only what the protocol defined is an answer", async () => {
    // A fronting proxy's own 403 must never masquerade as a considered refusal from a member.
    const { fetch } = replying({ error: "Forbidden" }, { status: 403 });
    const outcome = await client(fetch).json(laptop, "lead");
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    expect(outcome.ok === false && outcome.reason).toContain("HTTP 403");
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

  test("`hello`'s optional version is read when the peer reports one (§5)", async () => {
    const { fetch } = replying({ protocol: 1, member: "laptop", version: "1.0.0-alpha.12" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok && outcome.value.version).toBe("1.0.0-alpha.12");
  });

  test("an absent version is `null` and NOTHING else — a build older than the amendment (§7.1)", async () => {
    // Absent-means-closed: the member is read as claiming no version, never as an error and never as
    // a reason to refuse. Reachability is untouched — the protocol integer is the only thing that
    // refuses, and this reply's protocol matched.
    const { fetch } = replying({ protocol: 1, member: "laptop" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.version).toBeNull();
  });

  test("a version that is not a usable string reads as absent, never as a failure (§7.1)", async () => {
    for (const version of [7, null, true, "", { v: "1.0.0" }, ["1.0.0"]]) {
      const { fetch } = replying({ protocol: 1, member: "laptop", version });
      const outcome = await client(fetch).hello(laptop);
      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.value.version).toBeNull();
    }
  });

  test("an old parser ignores a new sibling — this amendment's compatibility claim (§7.1)", async () => {
    // The claim §7.1 makes for every addition inside protocol 1: it is additive-optional, so a NEWER
    // member's reply is read by an OLDER one without incident. `hello` reads `protocol` and `member`
    // by name off a Record and passes unknown keys over without inspecting them — this pins that,
    // with `version` standing in for whatever the next optional field turns out to be.
    const { fetch } = replying({ protocol: 1, member: "laptop", version: "9.9.9", futureField: { any: "shape" } });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.member).toBe("laptop");
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

// ── proxy(): the pass-through variant the per-pane forward uses (§9.1) ───────

describe("proxy — the peer's own status codes are the answer, not a failure", () => {
  test("a 304 comes back as an outcome, not as `unreachable` — the whole conditional-GET win", async () => {
    const { fetch } = replying("", { status: 304 });
    const outcome = await client(fetch).proxy(laptop, "pane/w1:p1");
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.status).toBe(304);
    // `raw` is for bodies the LEAD consumes, where a non-2xx is a broken peer. Same dial, one rule
    // apart, and the difference is exactly who reads the response.
    const consumed = await client(replying("", { status: 304 }).fetch).raw(laptop, "pane/w1:p1");
    expect(consumed.ok).toBe(false);
  });

  test("a peer's 404/405/413 reaches the phone as itself", async () => {
    for (const status of [400, 404, 405, 413, 500]) {
      const { fetch } = replying({ error: "x" }, { status });
      const outcome = await client(fetch).proxy(laptop, "pane/w1:p1/reply", undefined, { method: "POST" });
      expect(outcome.ok && outcome.value.status).toBe(status);
    }
  });

  test("a peer's OWN 403 is passed through — that is its write gate doing its job (§12)", async () => {
    // Stamped with the pack headers, so it is the peer answering rather than the link refusing.
    const { fetch } = replying("device not authorised", { status: 403 });
    const outcome = await client(fetch).proxy(laptop, "pane/w1:p1/keys", undefined, { method: "POST" });
    expect(outcome.ok && outcome.value.status).toBe(403);
  });

  test("an UNSTAMPED 401 is the link refusing us, and is unreachable — never a 401 for the phone", async () => {
    // `unauthorizedResponse()` carries no version banner by construction (§8.5), which is exactly how
    // a rotated secret is told apart from a peer's own refusal. §10.2 files auth failure under
    // `unreachable`, so it stays on the poll cadence rather than the ten-minute skew backoff.
    const { fetch } = replying({ error: "unauthorized" }, { status: 401, protocol: null });
    const outcome = await client(fetch).proxy(laptop, "pane/w1:p1");
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.state).toBe("unreachable");
    expect(!outcome.ok && outcome.reason).toContain("unauthorized");
  });

  test("a version skew is still a skew, before any status or body is looked at (§7)", async () => {
    const { fetch } = replying({ ok: true }, { status: 200, protocol: "2" });
    const outcome = await client(fetch).proxy(laptop, "pane/w1:p1");
    expect(!outcome.ok && outcome.state).toBe("incompatible");
  });

  test("the response body is never read here — an ETag and the bytes survive the hop", async () => {
    const { fetch } = replying({ lines: ["hello"] }, { status: 200 });
    const outcome = await client(fetch).proxy(laptop, "pane/w1:p1");
    expect(outcome.ok && outcome.value.bodyUsed).toBe(false);
    expect(outcome.ok && (await outcome.value.json())).toEqual({ lines: ["hello"] });
  });
});

describe("`attempted` — the input to §10.3's refuse-vs-unknown decision", () => {
  test("a fault that provably never left this process says so", async () => {
    const { fetch } = replying({});
    const noSecret = await client(fetch, { secret: null }).proxy(laptop, "pane/w1:p1/reply");
    expect(!noSecret.ok && noSecret.state === "unreachable" && noSecret.attempted).toBe(false);
    const badAddress = await client(fetch).proxy({ memberId: "x", address: "http://a/b?c=1" }, "pane/p/reply");
    expect(!badAddress.ok && badAddress.state === "unreachable" && badAddress.attempted).toBe(false);
  });

  test("a transport failure does NOT claim it wasn't sent — absence of proof is not proof", async () => {
    // The runtime does not tell us whether the request had been written when the socket died, and a
    // write reported as cleanly-failed is a write the operator sends again (.adr/0010).
    const fetch: PackFetch = () => Promise.reject(new Error("socket hang up"));
    const outcome = await client(fetch).proxy(laptop, "pane/w1:p1/reply", undefined, { method: "POST" });
    expect(!outcome.ok && outcome.state === "unreachable" && outcome.attempted).toBeUndefined();
  });
});

describe("the forwarded device identity (§12)", () => {
  test("a per-request device wins over the client-wide one", async () => {
    const { fetch, calls } = replying({});
    await client(fetch, { device: "process-default" }).proxy(laptop, "pane/w1:p1/reply", undefined, {
      method: "POST",
      headers: { [DEVICE_HEADER]: "phone-7" },
    });
    expect(new Headers(calls[0]!.init.headers).get(DEVICE_HEADER)).toBe("phone-7");
  });

  test("nothing a caller passes can shape the link's own claims", async () => {
    const { fetch, calls } = replying({});
    await client(fetch).proxy(laptop, "pane/w1:p1/reply", undefined, {
      method: "POST",
      headers: { authorization: "Bearer forged", [PROTOCOL_HEADER]: "99", [MEMBER_HEADER]: "not-desk" },
    });
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${PACK.secret}`);
    expect(sent.get(PROTOCOL_HEADER)).toBe("1");
    expect(sent.get(MEMBER_HEADER)).toBe("desk");
  });
});

describe("two budgets, and which call runs on which (§10.4)", () => {
  /** A transport that answers nothing and dies only when the client's own budget aborts it. */
  const stalling: PackFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
    });

  test("`hello` runs on the patient budget and says so in its reason", async () => {
    const outcome = await client(stalling, { timeoutMs: 5, helloTimeoutMs: 40 }).hello(laptop);
    expect(!outcome.ok && outcome.reason).toBe("hello: timed out after 40ms");
  });

  test("every DATA call keeps the strict one — the patient budget must not leak onto the poll", async () => {
    const patient = client(stalling, { timeoutMs: 5, helloTimeoutMs: 40 });
    const snapshot = await patient.snapshot(laptop);
    expect(!snapshot.ok && snapshot.reason).toBe("snapshot: timed out after 5ms");
    const forwarded = await patient.proxy(laptop, "pane/w1:p1/reply", undefined, { method: "POST" });
    expect(!forwarded.ok && forwarded.reason).toBe("pane/w1:p1/reply: timed out after 5ms");
  });

  test("with no patient budget wired, `hello` is as impatient as the poll — the old behaviour", async () => {
    const outcome = await client(stalling, { timeoutMs: 5 }).hello(laptop);
    expect(!outcome.ok && outcome.reason).toBe("hello: timed out after 5ms");
  });

  test("`timedOut` separates our own clock from an answer the world gave us", async () => {
    const budgeted = await client(stalling, { timeoutMs: 5 }).snapshot(laptop);
    expect(!budgeted.ok && budgeted.state === "unreachable" && budgeted.timedOut).toBe(true);
    // A refusal is an answer, not a slow link — and `PackLead` must not re-probe it patiently.
    const refused: PackFetch = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const dead = await client(refused).snapshot(laptop);
    expect(!dead.ok && dead.state === "unreachable" && dead.timedOut).toBe(false);
    expect(!dead.ok && dead.reason).toBe("snapshot: connect ECONNREFUSED");
  });
});
