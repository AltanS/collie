import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";

import { PROTOCOL_HEADER, MEMBER_HEADER, DEVICE_HEADER } from "./admission.ts";
import { leadStore, material, member, PACK, T0 } from "./fixtures.ts";
import { signDial, verifyDial, DIAL_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, type DialParts } from "./signing.ts";
import { mintWarrant } from "./warrant.ts";
import {
  COLD_LINK,
  DEFAULT_PACK_HELLO_TIMEOUT_MS,
  DEFAULT_PACK_TIMEOUT_MS,
  PACK_HELLO_TIMEOUT_ENV,
  PACK_TIMEOUT_ENV,
  PeerClient,
  foldWarmth,
  packHelloBudget,
  packTimeoutBudget,
  packTimeoutClampWarning,
  packUrl,
  sweepPeers,
  takeDataBudget,
  type PackFetch,
  type PackLink,
  type PeerClientDeps,
} from "./peer-client.ts";
import type { PackRequestInit } from "./transport.ts";

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
  over: {
    timeoutMs?: number;
    patientTimeoutMs?: number;
    secret?: string | null;
    device?: string | null;
    sign?: PeerClientDeps["sign"];
    dialSign?: PeerClientDeps["dialSign"];
  } = {},
) {
  return new PeerClient({
    self: "desk",
    secret: () => (over.secret === undefined ? PACK.secret : over.secret),
    timeoutMs: over.timeoutMs ?? 50,
    patientTimeoutMs: over.patientTimeoutMs,
    fetch,
    now: () => 1_000,
    device: over.device === undefined ? undefined : () => over.device ?? null,
    sign: over.sign,
    dialSign: over.dialSign,
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

describe("packTimeoutClampWarning — the clamp stops being silent", () => {
  test("silence when the operator asked for nothing", () => {
    expect(packTimeoutClampWarning(1500, {})).toBeNull();
  });

  test("silence when the poll can afford what they asked for", () => {
    expect(packTimeoutClampWarning(1500, { [PACK_TIMEOUT_ENV]: "1000" })).toBeNull();
    expect(packTimeoutClampWarning(5000, { [PACK_TIMEOUT_ENV]: "3000" })).toBeNull();
  });

  test("the default pair is the trap it warns about, and it names the knob that moves", () => {
    const warning = packTimeoutClampWarning(1500, { [PACK_TIMEOUT_ENV]: "3000" });
    // The whole point: 3000 at a 1500ms poll is 1200ms, i.e. exactly the default it replaced.
    expect(packTimeoutBudget(1500, { [PACK_TIMEOUT_ENV]: "3000" })).toBe(DEFAULT_PACK_TIMEOUT_MS);
    expect(warning).toContain("no effect beyond 1200ms");
    // COLLIE_POLL_MS is the other half, with the value that actually buys the 3000ms asked for.
    expect(warning).toContain("COLLIE_POLL_MS=3750");
    expect(packTimeoutBudget(3750, { [PACK_TIMEOUT_ENV]: "3000" })).toBe(3000);
  });

  test("garbage is not a clamp — it is a value that was never read", () => {
    for (const raw of ["nonsense", "-5", "0", ""]) {
      expect(packTimeoutClampWarning(1500, { [PACK_TIMEOUT_ENV]: raw })).toBeNull();
    }
  });
});

describe("takeDataBudget / foldWarmth — the bootstrap credit", () => {
  test("a cold link's first data request is patient, and the credit is spent at issue", () => {
    const taken = takeDataBudget(COLD_LINK, 1200, 5000);
    expect(taken.budgetMs).toBe(5000);
    expect(taken.next).toEqual({ warm: false, bootstrapSpent: true });
    // Spent: the peer that is genuinely gone falls back to one strict budget per poll.
    expect(takeDataBudget(taken.next, 1200, 5000).budgetMs).toBe(1200);
    expect(takeDataBudget(taken.next, 1200, 5000).next).toEqual(taken.next);
  });

  test("a warm link is strict, always — the patient budget must not leak onto the poll", () => {
    const warm = foldWarmth(COLD_LINK, true);
    expect(warm).toEqual({ warm: true, bootstrapSpent: false });
    expect(takeDataBudget(warm, 1200, 5000).budgetMs).toBe(1200);
  });

  test("a warm link that dies is owed one fresh bootstrap — that is a torn-down pool", () => {
    const died = foldWarmth(foldWarmth(COLD_LINK, true), false);
    expect(died).toEqual({ warm: false, bootstrapSpent: false });
    expect(takeDataBudget(died, 1200, 5000).budgetMs).toBe(5000);
  });

  test("a cold link that fails again is NOT owed another — the patient budget stays bounded", () => {
    const spent = takeDataBudget(COLD_LINK, 1200, 5000).next;
    const failedTwice = foldWarmth(foldWarmth(spent, false), false);
    expect(takeDataBudget(failedTwice, 1200, 5000).budgetMs).toBe(1200);
  });

  test("a patient budget below the strict one is floored, never used to make bootstrap harsher", () => {
    expect(takeDataBudget(COLD_LINK, 1200, 10).budgetMs).toBe(1200);
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
      // `version`, `warrantGeneration` and `warrantActiveGeneration` are all OPTIONAL on the wire and
      // all read as `null` when absent (§7.1, §18.7, §18.17) — never as "up to date" or "armed", which
      // is what makes the lead push rather than assume, what keeps the boot gate from reading a silent
      // member as agreement, and what keeps an absent activation on the ops file's lower bound.
      value: {
        protocol: 1,
        member: "laptop",
        version: null,
        warrantGeneration: null,
        warrantActiveGeneration: null,
        pairingDigest: null, pairingCollision: null,
      },
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
    const outcome = await client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 }).hello(laptop);
    expect(!outcome.ok && outcome.reason).toBe("hello: timed out after 40ms");
  });

  test("a COLD data call gets one patient attempt, and the poll keeps the strict budget after it", async () => {
    const patient = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    // The bootstrap credit: one attempt allowed to pay for a handshake the strict budget cannot.
    const first = await patient.snapshot(laptop);
    expect(!first.ok && first.reason).toBe("snapshot: timed out after 40ms");
    // Spent. Everything after it is strict again, so a host that is genuinely gone still fails fast.
    const second = await patient.snapshot(laptop);
    expect(!second.ok && second.reason).toBe("snapshot: timed out after 5ms");
    const forwarded = await patient.proxy(laptop, "pane/w1:p1/reply", undefined, { method: "POST" });
    expect(!forwarded.ok && forwarded.reason).toBe("pane/w1:p1/reply: timed out after 5ms");
  });

  test("the credit is spent AT ISSUE, so concurrent cold requests never stack patient dials", async () => {
    const patient = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    const [a, b, c] = await Promise.all([
      patient.snapshot(laptop),
      patient.snapshot(laptop),
      patient.snapshot(laptop),
    ]);
    const reasons = [a, b, c].map((o) => (o.ok ? "ok" : o.reason));
    expect(reasons.filter((r) => r === "snapshot: timed out after 40ms")).toHaveLength(1);
    expect(reasons.filter((r) => r === "snapshot: timed out after 5ms")).toHaveLength(2);
  });

  test("a WARM link is strict — and a warm link that dies is granted one fresh patient attempt", async () => {
    // Answers the first dial, stalls forever after it: a peer that was there and then went away.
    let answered = false;
    const oncely: PackFetch = (url, init) => {
      if (answered) return stalling(url, init);
      answered = true;
      return replying({}).fetch(url, init);
    };
    const link = client(oncely, { timeoutMs: 5, patientTimeoutMs: 40 });
    expect((await link.snapshot(laptop)).ok).toBe(true);
    // Warm: the handshake is paid for, so the strict budget is the honest one.
    const missed = await link.snapshot(laptop);
    expect(!missed.ok && missed.reason).toBe("snapshot: timed out after 5ms");
    // …and that failure is exactly the shape of a torn-down pool, so one patient re-bootstrap follows.
    const rebootstrap = await link.snapshot(laptop);
    expect(!rebootstrap.ok && rebootstrap.reason).toBe("snapshot: timed out after 40ms");
    const after = await link.snapshot(laptop);
    expect(!after.ok && after.reason).toBe("snapshot: timed out after 5ms");
  });

  test("with no patient budget wired, every data call is strict — the old behaviour", async () => {
    const strict = client(stalling, { timeoutMs: 5 });
    const first = await strict.snapshot(laptop);
    const second = await strict.snapshot(laptop);
    expect(!first.ok && first.reason).toBe("snapshot: timed out after 5ms");
    expect(!second.ok && second.reason).toBe("snapshot: timed out after 5ms");
  });

  test("a pre-flight refusal never spends the credit — nothing was dialled", async () => {
    const secretless = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40, secret: null });
    expect((await secretless.snapshot(laptop)).ok).toBe(false);
    const dialled = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    const first = await dialled.snapshot(laptop);
    expect(!first.ok && first.reason).toBe("snapshot: timed out after 40ms");
  });

  test("warmth is per ADDRESS: a member that moved starts cold again", async () => {
    const moved: PackLink = { memberId: "laptop", address: "laptop.other:8787" };
    const c = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    expect(!(await c.snapshot(laptop)).ok).toBe(true);
    const there = await c.snapshot(moved);
    expect(!there.ok && there.reason).toBe("snapshot: timed out after 40ms");
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

describe("warrant — the lead's push (§18)", () => {
  const warrant = {
    packId: "pack-1",
    generation: 2,
    deputyMemberId: "nas",
    deputyFingerprint: "a".repeat(64),
    leadMemberId: "desk",
    issuedAt: 1,
    refreshedAt: 2,
    signature: "sig",
  };

  test("POSTs the warrant and the deputy's certificate to /pack/v1/warrant", async () => {
    const { fetch, calls } = replying({ generation: 2, applied: true });
    const outcome = await client(fetch).warrant(laptop, { warrant, deputyCertPem: "PEM" });
    expect(outcome.ok && outcome.value).toEqual({ generation: 2, applied: true });
    expect(calls[0]!.url).toBe("https://laptop.example:8787/pack/v1/warrant");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ warrant, deputyCertPem: "PEM" });
  });

  test("is an ordinary DATA dial: one bootstrap attempt per cold link, strict budget thereafter", async () => {
    const stalled: PackFetch = (_u, init) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    const c = client(stalled, { timeoutMs: 5, patientTimeoutMs: 40 });
    // It never gets `hello`'s standing patient budget — that one belongs to the verdict probe.
    expect(!(await c.warrant(laptop, { warrant })).ok).toBe(true);
    const again = await c.warrant(laptop, { warrant });
    expect(!again.ok && again.reason).toBe("warrant: timed out after 5ms");
  });

  test("a 404 from a pre-amendment member is the ordinary unreachable outcome, never a throw", async () => {
    const { fetch } = replying({ error: "not found" }, { status: 404 });
    const outcome = await client(fetch).warrant(laptop, { warrant });
    expect(!outcome.ok && outcome.state).toBe("unreachable");
    expect(!outcome.ok && outcome.reason).toBe("warrant: HTTP 404");
  });
});

describe("PeerClient — lead_conflict, §10.2's fourth state (§18.10)", () => {
  /** A warrant `desk` really signed naming `nas` — the proof a re-pinned member hands back. */
  const proof = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.result;

  const conflictBody = (over: Record<string, JsonValue | undefined> = {}) => ({
    error: 'this collie follows lead "nas" since warrant generation 1',
    code: "lead_conflict",
    leadMemberId: "nas",
    warrantGeneration: 1,
    warrant: { ...proof },
    ...over,
  });

  test("a 409 with the named code is CONFLICTED, and the warrant comes through intact", async () => {
    const { fetch } = replying(conflictBody(), { status: 409, protocol: "1" });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok) throw new Error("expected a failure");
    if (outcome.state !== "conflicted") throw new Error(`expected conflicted, got ${outcome.state}`);
    expect(outcome.leadMemberId).toBe("nas");
    expect(outcome.warrantGeneration).toBe(1);
    // Parsed, never trusted: the reader verifies it against its OWN certificate before acting.
    expect(outcome.warrant).toEqual(proof);
    // Verbatim, like every other refusal a member composes for an operator to read.
    expect(outcome.reason).toContain('follows lead "nas"');
  });

  test("it is NOT incompatible — this build reads that member's protocol perfectly well", async () => {
    // The two answers share a status, and conflating them would put a member that answered precisely
    // onto §10.2's slow protocol backoff and tell the operator to go update a build.
    const { fetch } = replying(conflictBody(), { status: 409, protocol: "1" });
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok === false && outcome.state).not.toBe("incompatible");
    expect(outcome.ok === false && outcome.state).not.toBe("unreachable");
    expect(outcome.ok === false && outcome.state).not.toBe("refused");
  });

  test("a conflict with no warrant is still a conflict — it just carries no proof", async () => {
    const { fetch } = replying(conflictBody({ warrant: undefined }), { status: 409, protocol: "1" });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok || outcome.state !== "conflicted") throw new Error("expected conflicted");
    expect(outcome.warrant).toBeNull();
  });

  test("a malformed warrant on an otherwise good conflict reads as no proof, never as a broken link", async () => {
    const { fetch } = replying(conflictBody({ warrant: { packId: 7 } }), { status: 409, protocol: "1" });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok || outcome.state !== "conflicted") throw new Error("expected conflicted");
    expect(outcome.warrant).toBeNull();
  });

  test("a 409 that names no lead falls back to the SKEW reading — the closed one", async () => {
    // Without a member id the answer names nothing, and a conflict naming nobody is indistinguishable
    // from a 409 that happened to carry the code.
    const { fetch } = replying(conflictBody({ leadMemberId: "" }), { status: 409, protocol: "1" });
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok === false && outcome.state).toBe("incompatible");
  });

  test("§7's protocol mismatch is untouched — the body is read ONCE and both readings come off it", async () => {
    const { fetch } = replying(
      { error: "pack protocol mismatch", code: "protocol_mismatch", expected: 2, received: 1 },
      { status: 409, protocol: "1" },
    );
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok || outcome.state !== "incompatible") throw new Error("expected incompatible");
    expect(outcome.expected).toBe(2);
  });

  test("hello reads the warrant generation, absent-means-closed", async () => {
    const withGen = replying({ protocol: 1, member: "laptop", warrantGeneration: 4, pairingDigest: null, pairingCollision: null });
    expect((await client(withGen.fetch).hello(laptop)).ok).toBe(true);
    const outcome = await client(withGen.fetch).hello(laptop);
    expect(outcome.ok && outcome.value.warrantGeneration).toBe(4);

    // Anything that is not a safe integer is "reported nothing" — never a reason to refuse a link,
    // and never read as agreement by the boot gate.
    for (const bad of [null, "4", 1.5, {}]) {
      const { fetch } = replying({ protocol: 1, member: "laptop", warrantGeneration: bad });
      const o = await client(fetch).hello(laptop);
      expect(o.ok && o.value.warrantGeneration).toBeNull();
    }
  });
});

describe("PeerClient — pairing_label_collision, the other 409 (§18.14)", () => {
  const sync = { packId: "pack-1", leadMemberId: "desk", devices: [] };
  const collisionBody = (over: Record<string, JsonValue | undefined> = {}) => ({
    error: 'this machine already has paired devices called "phone" — rename one, or revoke it here',
    code: "pairing_label_collision",
    labels: ["phone"],
    ...over,
  });

  test("it is a REFUSAL that carries the labels, never §7's version skew", async () => {
    const { fetch } = replying(collisionBody(), { status: 409, protocol: "1" });
    const outcome = await client(fetch).pairing(laptop, sync);
    if (outcome.ok) throw new Error("expected a failure");
    if (outcome.state !== "refused") throw new Error(`expected refused, got ${outcome.state}`);
    expect(outcome.code).toBe("pairing_label_collision");
    expect(outcome.labels).toEqual(["phone"]);
    // Verbatim: the labels are that member's OWN device names, and only that member can know them.
    expect(outcome.reason).toContain('already has paired devices called "phone"');
  });

  test("a collision naming no label is still a refusal — with nothing to rename", async () => {
    const { fetch } = replying(collisionBody({ labels: undefined }), { status: 409, protocol: "1" });
    const outcome = await client(fetch).pairing(laptop, sync);
    if (outcome.ok || outcome.state !== "refused") throw new Error("expected refused");
    expect(outcome.labels).toEqual([]);
  });

  test("a label list with junk in it keeps the strings and drops the rest", async () => {
    const { fetch } = replying(collisionBody({ labels: ["phone", 7, null] }), { status: 409, protocol: "1" });
    const outcome = await client(fetch).pairing(laptop, sync);
    if (outcome.ok || outcome.state !== "refused") throw new Error("expected refused");
    expect(outcome.labels).toEqual(["phone"]);
  });

  test("a 409 without the code is untouched — it still reads as the skew, the closed reading", async () => {
    const { fetch } = replying(collisionBody({ code: undefined }), { status: 409, protocol: "1" });
    const outcome = await client(fetch).pairing(laptop, sync);
    expect(outcome.ok === false && outcome.state).toBe("incompatible");
  });
});

describe("PeerClient — every dial is attested (§8.6)", () => {
  const key = material("desk").keyPem;
  const withDial = (over: { sign?: PeerClientDeps["sign"] } = {}) => ({
    dialSign: (parts: DialParts) => signDial(key, parts),
    ...over,
  });

  test("the header rides EVERY route, not a closed set — and names the member being dialled", async () => {
    const { fetch, calls } = replying({ protocol: 1, member: "laptop" });
    const c = client(fetch, withDial());
    await c.hello(laptop);
    await c.snapshot(laptop);
    await c.proxy(laptop, "pane/w1:p1");
    expect(calls).toHaveLength(3);
    for (const sent of calls) {
      const headers = new Headers(sent.init.headers);
      const signature = headers.get(DIAL_HEADER);
      const timestamp = Number(headers.get(TIMESTAMP_HEADER));
      expect(signature).not.toBeNull();
      // It verifies against the LEAD's certificate over this exact method, path and receiver — which
      // is what a two-anchored peer checks, and what a captured dial cannot be moved away from.
      const path = new URL(sent.url).pathname;
      expect(
        verifyDial(material("desk").certPem, signature!, { method: sent.init.method ?? "GET", path, timestamp, to: "laptop" }),
      ).toBe(true);
      // …and NOT for another receiver, which is the field the request signature does not have.
      expect(
        verifyDial(material("desk").certPem, signature!, { method: sent.init.method ?? "GET", path, timestamp, to: "nas" }),
      ).toBe(false);
    }
  });

  test("it never touches the body — a streamed upload stays a stream", async () => {
    // The whole reason this is not `canonicalRequest`: hashing would mean buffering every proxied
    // upload in the lead's memory, on the security path.
    const { fetch, calls } = replying({ ok: true });
    const body = new ReadableStream<Uint8Array>({ start: (ctrl) => ctrl.close() });
    const init: PackRequestInit = { method: "POST", body };
    await client(fetch, withDial()).proxy(laptop, "pane/w1:p1/upload", undefined, init);
    expect(calls[0]!.init.body).toBe(body);
    expect(new Headers(calls[0]!.init.headers).get(DIAL_HEADER)).not.toBeNull();
  });

  test("both signatures share ONE timestamp — one request makes one freshness claim", async () => {
    const { fetch, calls } = replying({ protocol: 1, member: "laptop" });
    await client(fetch, withDial({ sign: () => "request-signature" })).hello(laptop);
    const headers = new Headers(calls[0]!.init.headers);
    const timestamp = Number(headers.get(TIMESTAMP_HEADER));
    expect(headers.get(SIGNATURE_HEADER)).toBe("request-signature");
    expect(
      verifyDial(material("desk").certPem, headers.get(DIAL_HEADER)!, {
        method: "GET",
        path: "/pack/v1/hello",
        timestamp,
        to: "laptop",
      }),
    ).toBe(true);
  });

  test("a client with no key sends no header at all — absent, never empty", async () => {
    const { fetch, calls } = replying({ protocol: 1, member: "laptop" });
    await client(fetch).hello(laptop);
    expect(new Headers(calls[0]!.init.headers).get(DIAL_HEADER)).toBeNull();
  });
});
