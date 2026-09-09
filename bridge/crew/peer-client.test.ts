import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import { NARROW_VIEW } from "../sessions.ts";

import { PROTOCOL_HEADER, MEMBER_HEADER, DEVICE_HEADER } from "./admission.ts";
import { CREW_PROTOCOL_VERSION } from "./enrollment.ts";
// REMOVE_IN_1_9_0 — the overlap's shape rule, asserted as a table below.
import { routesNoCrewV1 } from "./v1-overlap.ts";
import { leadStore, material, member, muxCaps, CREW, T0 } from "./fixtures.ts";
import { signDial, verifyDial, DIAL_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, type DialParts } from "./signing.ts";
import { SWEEP_VIEW } from "./merge.ts";
import { mintWarrant } from "./warrant.ts";
import {
  COLD_LINK,
  DEFAULT_CREW_HELLO_TIMEOUT_MS,
  DEFAULT_CREW_TIMEOUT_MS,
  CREW_HELLO_TIMEOUT_ENV,
  CREW_TIMEOUT_ENV,
  LEGACY_CREW_HELLO_TIMEOUT_ENV,
  LEGACY_CREW_TIMEOUT_ENV,
  crewEnvFallbackWarning,
  PeerClient,
  foldWarmth,
  operatorReason,
  crewHelloBudget,
  crewTimeoutBudget,
  crewTimeoutClampWarning,
  crewUrl,
  parseMuxReport,
  parsePeerVersion,
  sweepPeers,
  takeDataBudget,
  HEADERLESS_PATIENCE_MS,
  WRITE_BUDGET_MS,
  type CrewFetch,
  type CrewLink,
  type PeerClientDeps,
} from "./peer-client.ts";
import type { CrewRequestInit } from "./transport.ts";

// The lead's client, tested against a FAKE fetch rather than a socket (CLAUDE.md: anything needing
// `Bun.serve`/`Bun.connect` is out of `bun test`'s reach, so the transport is a parameter).
//
// The interesting surface is not "does it GET" — it is the verdict matrix: every way a peer can fail
// has to land in exactly one of §10.2's three states, because the phone renders each differently and
// only `incompatible` stops being retried on the poll cadence.

const laptop: CrewLink = { memberId: "laptop", address: "laptop.example:8787" };

/** A fetch that answers with `body`, stamped with the crew headers a healthy peer sends. */
function replying<TBody>(
  body: TBody,
  init: { status?: number; protocol?: string | null; member?: string } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: CrewFetch = async (url, reqInit) => {
    calls.push({ url, init: reqInit });
    const headers = new Headers({ "content-type": "application/json" });
    const protocol = init.protocol === undefined ? String(CREW_PROTOCOL_VERSION) : init.protocol;
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
  fetch: CrewFetch,
  over: {
    timeoutMs?: number;
    patientTimeoutMs?: number;
    secret?: string | null;
    device?: string | null;
    sign?: PeerClientDeps["sign"];
    dialSign?: PeerClientDeps["dialSign"];
    now?: () => number;
    log?: (line: string) => void;
    toldVersion1?: Set<string>;
  } = {},
) {
  return new PeerClient({
    self: "desk",
    // REMOVE_IN_1_9_0: silenced by default so the overlap's line does not litter every run. A case
    // that asserts the line passes its own sink.
    log: over.log ?? (() => undefined),
    // REMOVE_IN_1_9_0: absent ⇒ a fresh set per client, which is what every case but the shared one
    // wants. The shared case hands the same set to two clients.
    toldVersion1: over.toldVersion1,
    secret: () => (over.secret === undefined ? CREW.secret : over.secret),
    timeoutMs: over.timeoutMs ?? 50,
    patientTimeoutMs: over.patientTimeoutMs,
    fetch,
    now: over.now ?? (() => 1_000),
    device: over.device === undefined ? undefined : () => over.device ?? null,
    sign: over.sign,
    dialSign: over.dialSign,
  });
}

describe("crewTimeoutBudget — strictly below the lead's poll (§10.1)", () => {
  test("the documented default pair: 1200 against a 1500 ms poll", () => {
    expect(crewTimeoutBudget(1500, {})).toBe(DEFAULT_CREW_TIMEOUT_MS);
    expect(DEFAULT_CREW_TIMEOUT_MS).toBeLessThan(1500);
  });

  test("an operator override is honoured while it fits", () => {
    expect(crewTimeoutBudget(1500, { [CREW_TIMEOUT_ENV]: "400" })).toBe(400);
  });

  test("an override that would outlast the poll is clamped, never trusted", () => {
    // The whole point of the budget: one slow peer must not be able to stall the lead's own snapshot.
    expect(crewTimeoutBudget(1500, { [CREW_TIMEOUT_ENV]: "9000" })).toBeLessThan(1500);
    expect(crewTimeoutBudget(1500, { [CREW_TIMEOUT_ENV]: "9000" })).toBe(1200);
    expect(crewTimeoutBudget(600, {})).toBeLessThan(600);
  });

  test("garbage and non-positive values fall back to the default, then clamp", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(crewTimeoutBudget(10_000, { [CREW_TIMEOUT_ENV]: raw })).toBe(DEFAULT_CREW_TIMEOUT_MS);
    }
  });
});

describe("crewTimeoutClampWarning — the clamp stops being silent", () => {
  test("silence when the operator asked for nothing", () => {
    expect(crewTimeoutClampWarning(1500, {})).toBeNull();
  });

  test("silence when the poll can afford what they asked for", () => {
    expect(crewTimeoutClampWarning(1500, { [CREW_TIMEOUT_ENV]: "1000" })).toBeNull();
    expect(crewTimeoutClampWarning(5000, { [CREW_TIMEOUT_ENV]: "3000" })).toBeNull();
  });

  test("the default pair is the trap it warns about, and it names the knob that moves", () => {
    const warning = crewTimeoutClampWarning(1500, { [CREW_TIMEOUT_ENV]: "3000" });
    // The whole point: 3000 at a 1500ms poll is 1200ms, i.e. exactly the default it replaced.
    expect(crewTimeoutBudget(1500, { [CREW_TIMEOUT_ENV]: "3000" })).toBe(DEFAULT_CREW_TIMEOUT_MS);
    expect(warning).toContain("no effect beyond 1200ms");
    // COLLIE_POLL_MS is the other half, with the value that actually buys the 3000ms asked for.
    expect(warning).toContain("COLLIE_POLL_MS=3750");
    expect(crewTimeoutBudget(3750, { [CREW_TIMEOUT_ENV]: "3000" })).toBe(3000);
  });

  test("garbage is not a clamp — it is a value that was never read", () => {
    for (const raw of ["nonsense", "-5", "0", ""]) {
      expect(crewTimeoutClampWarning(1500, { [CREW_TIMEOUT_ENV]: raw })).toBeNull();
    }
  });
});

describe("the 1.7.0 env keys, read as a fallback (REMOVE_IN_1_9_0)", () => {
  test("the crew keys are the names, and the pack keys are the fallback", () => {
    expect(CREW_TIMEOUT_ENV).toBe("COLLIE_CREW_TIMEOUT_MS");
    expect(CREW_HELLO_TIMEOUT_ENV).toBe("COLLIE_CREW_HELLO_TIMEOUT_MS");
    expect(LEGACY_CREW_TIMEOUT_ENV).toBe("COLLIE_PACK_TIMEOUT_MS");
    expect(LEGACY_CREW_HELLO_TIMEOUT_ENV).toBe("COLLIE_PACK_HELLO_TIMEOUT_MS");
  });

  test("the new key is read, and says nothing", () => {
    expect(crewTimeoutBudget(5000, { [CREW_TIMEOUT_ENV]: "3000" })).toBe(3000);
    expect(crewHelloBudget(1500, { [CREW_HELLO_TIMEOUT_ENV]: "20000" })).toBe(20_000);
    expect(crewEnvFallbackWarning({ [CREW_TIMEOUT_ENV]: "3000" })).toBeNull();
    expect(crewEnvFallbackWarning({ [CREW_HELLO_TIMEOUT_ENV]: "20000" })).toBeNull();
    expect(crewEnvFallbackWarning({})).toBeNull();
  });

  test("the old key still buys the budget it always did, and is named once", () => {
    expect(crewTimeoutBudget(5000, { [LEGACY_CREW_TIMEOUT_ENV]: "3000" })).toBe(3000);
    expect(crewHelloBudget(1500, { [LEGACY_CREW_HELLO_TIMEOUT_ENV]: "20000" })).toBe(20_000);
    // The clamp warning reads the same value through the same fallback, so an operator on the old
    // key is told about the clamp too — in the NEW key's words, because that is the one to write.
    const clamped = crewTimeoutClampWarning(1500, { [LEGACY_CREW_TIMEOUT_ENV]: "3000" });
    expect(clamped).toContain("COLLIE_CREW_TIMEOUT_MS=3000");

    const warning = crewEnvFallbackWarning({ [LEGACY_CREW_TIMEOUT_ENV]: "3000" });
    expect(warning).toContain("COLLIE_PACK_TIMEOUT_MS");
    expect(warning).toContain("COLLIE_CREW_TIMEOUT_MS");
    expect(warning).toContain("1.9.0");
    // ONE line, for both keys — a per-read warning would flood the journal on every poll.
    const both = crewEnvFallbackWarning({
      [LEGACY_CREW_TIMEOUT_ENV]: "3000",
      [LEGACY_CREW_HELLO_TIMEOUT_ENV]: "20000",
    });
    expect(both?.split("\n")).toHaveLength(1);
    expect(both).toContain("COLLIE_PACK_HELLO_TIMEOUT_MS");
  });

  test("both keys set: the crew key wins and nothing is said about the one it shadows", () => {
    const env = { [CREW_TIMEOUT_ENV]: "3000", [LEGACY_CREW_TIMEOUT_ENV]: "400" };
    expect(crewTimeoutBudget(5000, env)).toBe(3000);
    expect(crewEnvFallbackWarning(env)).toBeNull();
    const hello = { [CREW_HELLO_TIMEOUT_ENV]: "20000", [LEGACY_CREW_HELLO_TIMEOUT_ENV]: "7000" };
    expect(crewHelloBudget(1500, hello)).toBe(20_000);
    expect(crewEnvFallbackWarning(hello)).toBeNull();
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

describe("crewHelloBudget — the VERDICT budget, which the poll fraction must not clamp (§10.4)", () => {
  test("the default is patient enough for a cold pinned-TLS handshake over a relay", () => {
    // The live finding: a peer behind a DERP relay handshakes in ~1.9 s. A verdict budget below that
    // can only ever say "gone" about a machine that is there.
    expect(crewHelloBudget(1500, {})).toBe(DEFAULT_CREW_HELLO_TIMEOUT_MS);
    expect(DEFAULT_CREW_HELLO_TIMEOUT_MS).toBeGreaterThan(1900);
  });

  test("it is NOT clamped by the poll fraction — that clamp is the deadlock", () => {
    // crewTimeoutBudget(1500) is 1200. If the probe were clamped the same way, every attempt would
    // abort mid-handshake, leave no pooled connection, and the link would never bootstrap.
    expect(crewHelloBudget(1500, {})).toBeGreaterThan(crewTimeoutBudget(1500, {}));
    expect(crewHelloBudget(300, {})).toBe(DEFAULT_CREW_HELLO_TIMEOUT_MS);
  });

  test("an operator override is honoured, and capped only against a typo", () => {
    expect(crewHelloBudget(1500, { [CREW_HELLO_TIMEOUT_ENV]: "20000" })).toBe(20_000);
    expect(crewHelloBudget(1500, { [CREW_HELLO_TIMEOUT_ENV]: "50000000" })).toBe(60_000);
  });

  test("it is floored at the data budget: the verdict is never the more impatient of the two", () => {
    expect(crewHelloBudget(1500, { [CREW_HELLO_TIMEOUT_ENV]: "10" })).toBe(crewTimeoutBudget(1500, {}));
    // …including when the operator has widened the data budget itself.
    const env = { [CREW_TIMEOUT_ENV]: "1400", [CREW_HELLO_TIMEOUT_ENV]: "200" };
    expect(crewHelloBudget(2000, env)).toBe(crewTimeoutBudget(2000, env));
  });

  test("garbage and non-positive values fall back to the default", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(crewHelloBudget(1500, { [CREW_HELLO_TIMEOUT_ENV]: raw })).toBe(DEFAULT_CREW_HELLO_TIMEOUT_MS);
    }
  });
});

describe("crewUrl — an address is a machine, never a URL with extras", () => {
  test("a bare host:port becomes an https crew URL", () => {
    expect(crewUrl("laptop.example:8787", "hello")).toBe("https://laptop.example:8787/crew/v1/hello");
  });

  test("an explicit scheme is kept; params ride the query", () => {
    expect(crewUrl("http://127.0.0.1:8787", "snapshot", { session: "work" })).toBe(
      "http://127.0.0.1:8787/crew/v1/snapshot?session=work",
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
      expect(crewUrl(bad, "hello")).toBeNull();
    }
  });

  test("a route cannot climb out of the crew prefix", () => {
    // `new URL` normalises `..` away, so this asserts the post-normalisation pathname — the only
    // check that can actually catch an escape.
    expect(crewUrl("laptop.example", "../../api/snapshot")).toBeNull();
    expect(crewUrl("laptop.example", "/pane/w1:p1/reply")).toBe("https://laptop.example/crew/v1/pane/w1:p1/reply");
  });
});

describe("PeerClient — the request the lead sends (§6)", () => {
  test("carries both factors' bearer half, the protocol version and who is speaking", async () => {
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
    await client(fetch).hello(laptop);
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe("https://laptop.example:8787/crew/v1/hello");
    expect(headers.get("authorization")).toBe(`Bearer ${CREW.secret}`);
    expect(headers.get(PROTOCOL_HEADER)).toBe("2");
    expect(headers.get(MEMBER_HEADER)).toBe("desk");
    expect(headers.get(DEVICE_HEADER)).toBeNull();
  });

  test("forwards the operator's device id when the lead's device gate is on", async () => {
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
    await client(fetch, { device: "phone-1" }).hello(laptop);
    expect(new Headers(calls[0]!.init.headers).get(DEVICE_HEADER)).toBe("phone-1");
  });

  test("with no crew secret nothing is sent at all — an unauthenticated probe is never made", async () => {
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
    const outcome = await client(fetch, { secret: null }).hello(laptop);
    expect(calls).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
  });

  // ── §20's TWO REQUEST HEADERS (M16/04) ─────────────────────────────────────
  // Both additive-optional, both on the sweep the lead already makes, and both absent by default —
  // which is every sweep of every crew until an operator confirms an update.

  test("X-Crew-Lead-Release rides the sweep, and is absent unless the lead states something", async () => {
    const { fetch, calls } = replying({});
    const c = client(fetch);
    await c.snapshot(laptop);
    expect(new Headers(calls[0]!.init.headers).get("X-Crew-Lead-Release")).toBeNull();
    await c.snapshot(laptop, NARROW_VIEW, false, { leadRelease: "1.5.0" });
    expect(new Headers(calls[1]!.init.headers).get("X-Crew-Lead-Release")).toBe("1.5.0");
    // The protocol integer does not move for an additive-optional field (§7.1).
    expect(new Headers(calls[1]!.init.headers).get(PROTOCOL_HEADER)).toBe("2");
  });

  test("a lead mid-run states nothing: a null release sends no header at all", async () => {
    const { fetch, calls } = replying({});
    await client(fetch).snapshot(laptop, NARROW_VIEW, false, { leadRelease: null, turn: null });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Crew-Lead-Release")).toBeNull();
    expect(headers.get("X-Crew-Update-Turn")).toBeNull();
  });

  test("the turn names no code — a member and a run id, and it goes to one member at a time", async () => {
    const { fetch, calls } = replying({});
    const c = client(fetch);
    await c.snapshot(laptop, NARROW_VIEW, false, { leadRelease: "1.5.0", turn: "laptop;r-7" });
    await c.snapshot(laptop, NARROW_VIEW, false, { leadRelease: "1.5.0" });
    const first = new Headers(calls[0]!.init.headers).get("X-Crew-Update-Turn");
    expect(first).toBe("laptop;r-7");
    // No version, no ref, no URL, no command.
    expect(first).not.toContain("1.5.0");
    expect(first).not.toContain("http");
    expect(first).not.toContain("refs/");
    // The second member of the same sweep gets the release and no turn.
    expect(new Headers(calls[1]!.init.headers).get("X-Crew-Update-Turn")).toBeNull();
  });

  test("the follow headers do not buy the patient budget — only §19's fresh does", async () => {
    const { fetch, calls } = replying({});
    const c = client(fetch);
    await c.snapshot(laptop, NARROW_VIEW, false, { leadRelease: "1.5.0", turn: "laptop;r-7" });
    // A lead with something to state must not become a lead that polls more slowly (§10.1).
    expect(calls[0]!.init.headers).toBeDefined();
    expect(new Headers(calls[0]!.init.headers).get("X-Crew-Preflight")).toBeNull();
  });

  test("`snapshot` names the session only when there is one — absent means the peer's primary", async () => {
    const { fetch, calls } = replying({});
    const c = client(fetch);
    await c.snapshot(laptop);
    await c.snapshot(laptop, { session: "", widen: false });
    await c.snapshot(laptop, { session: "work", widen: false });
    expect(calls.map((c2) => c2.url)).toEqual([
      "https://laptop.example:8787/crew/v1/snapshot",
      "https://laptop.example:8787/crew/v1/snapshot",
      "https://laptop.example:8787/crew/v1/snapshot?session=work",
    ]);
  });

  // M22/06: the widening switch, additive and optional. The lead's sweep sends it on every dial; a
  // member too old to read it answers with its primary session and nothing refuses.
  test("`snapshot` asks for every session only when the view widens, and never as a host", async () => {
    const { fetch, calls } = replying({});
    const c = client(fetch);
    await c.snapshot(laptop, SWEEP_VIEW);
    await c.snapshot(laptop, { session: "work", widen: true });
    await c.snapshot(laptop, NARROW_VIEW);
    expect(calls.map((c2) => c2.url)).toEqual([
      "https://laptop.example:8787/crew/v1/snapshot?sessions=all",
      "https://laptop.example:8787/crew/v1/snapshot?session=work&sessions=all",
      // A narrow ask puts the same bytes on the wire it always has.
      "https://laptop.example:8787/crew/v1/snapshot",
    ]);
    // The protocol integer does not move for an additive-optional parameter (§7.1)…
    expect(new Headers(calls[0]!.init.headers).get(PROTOCOL_HEADER)).toBe("2");
    // …and widening travels as a session dimension, never as a host: a peer has no peers (§4).
    expect(calls.map((c2) => c2.url).join(" ")).not.toContain("host=");
  });
});

describe("PeerClient — the verdict matrix (§7, §10.2)", () => {
  test("reachable: the body, the peer's id, and the LEAD's receipt time", async () => {
    const { fetch } = replying({ protocol: 2, member: "laptop" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome).toEqual({
      ok: true,
      // `version`, `warrantGeneration`, `warrantActiveGeneration` and `mux` are all OPTIONAL on the
      // wire and all read as `null` when absent (§7.1, §18.7, §18.17, M22/03) — never as "up to date",
      // "armed" or "every capability present", which is what makes the lead push rather than assume,
      // what keeps the boot gate from reading a silent member as agreement, what keeps an absent
      // activation on the ops file's lower bound, and what makes an absent block mean "the lead's".
      value: {
        protocol: 2,
        member: "laptop",
        version: null,
        warrantGeneration: null,
        warrantActiveGeneration: null,
        pairingDigest: null, pairingCollision: null,
        mux: null,
      },
      status: 200,
      member: "laptop",
      receivedAt: 1_000, // the injected lead clock — never a header from the peer (§6)
      // The far side sent no HTTP `Date`, and an absent one is `null` rather than a guess.
      date: null,
    });
  });

  test("a connection that never opens is unreachable, not an exception", async () => {
    const fetch: CrewFetch = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    // F18: the runtime's own words never reach a surface. `ECONNREFUSED` — and Bun's browser-voiced
    // "Is the computer able to access the url?", which is the same event — arrive as one sentence.
    expect(outcome.ok === false && outcome.reason).toBe("snapshot: nothing accepted a connection at this address");
  });

  test("a peer slower than the budget is unreachable, and its request is CANCELLED", async () => {
    let aborted = false;
    const fetch: CrewFetch = (_url, init) =>
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
      { error: "crew protocol mismatch", code: "protocol_mismatch", expected: 2, received: 1 },
      { status: 409, protocol: "1" },
    );
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    if (outcome.state !== "incompatible") throw new Error(`expected incompatible, got ${outcome.state}`);
    expect(outcome.reason).toContain("crew protocol mismatch");
    expect(outcome.expected).toBe(2);
    expect(outcome.received).toBe(1);
  });

  test("a RESPONSE with the wrong version is incompatible — a mismatch, never a parse error (§7)", async () => {
    // The body is perfectly well-formed JSON from a version this build does not speak. Reading it
    // first would report "malformed body" and hide the real cause, which is the failure mode §7 names
    // explicitly. Version 3 rather than 1: version 1 is a 1.7.0 lead, and that one falls back (§0.1).
    const { fetch } = replying({ some: "a foreign shape" }, { protocol: "3" });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok) throw new Error("expected a failure");
    if (outcome.state !== "incompatible") throw new Error(`expected incompatible, got ${outcome.state}`);
    expect(outcome.received).toBe(3);
    expect(outcome.expected).toBe(2);
  });

  test("a response with NO version header is never defaulted to a version", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.state).toBe("unreachable");
  });

  // A MISSING header and a FOREIGN header are two different findings (§7). Missing says the lead
  // learned nothing about this peer's version; foreign says the lead learned it cannot speak to it.
  // Filing the first as the second put a peer that was merely restarting on the 30/120/600 s ladder.
  for (const status of [200, 404, 502, 503]) {
    test(`a headerless ${status} is unreachable, and the reason names the status`, async () => {
      const { fetch } = replying({ ok: true }, { protocol: null, status });
      const outcome = await client(fetch).snapshot(laptop);
      if (outcome.ok) throw new Error("expected a failure");
      if (outcome.state !== "unreachable") throw new Error(`expected unreachable, got ${outcome.state}`);
      expect(outcome.reason).toContain(`peer answered ${status} with no crew protocol header`);
      // The peer DID answer, so this is not the clock firing and §10.4 must not read it as a slow link.
      expect(outcome.timedOut ?? false).toBe(false);
    });
  }

  // The bound is a DURATION and not a count of answers, because the cadence between two answers is
  // anywhere from 1.5 s to 12 s and this client also carries `hello`, the phone's proxied reads and
  // the warrant push. A count is tightest exactly when the operator is watching (counsel 2026-09-08).
  test("patience is measured in SECONDS, not in answers — twenty dials inside the window stay unreachable", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null, status: 502 });
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    for (let i = 0; i < 20; i += 1) {
      clock += 1_500; // the active sweep, i.e. a phone is open
      const outcome = await peer.snapshot(laptop);
      expect(outcome.ok === false && outcome.state).toBe("unreachable");
    }
  });

  test("past the patience window the member falls back onto the incompatible ladder", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null, status: 502 });
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    const first = await peer.snapshot(laptop);
    expect(first.ok === false && first.state).toBe("unreachable");
    clock += HEADERLESS_PATIENCE_MS;
    const past = await peer.snapshot(laptop);
    if (past.ok) throw new Error("expected a failure");
    if (past.state !== "incompatible") throw new Error(`expected incompatible, got ${past.state}`);
    expect(past.reason).toContain("for over 60s");
    expect(past.received).toBeNull();
    expect(past.expected).toBe(CREW_PROTOCOL_VERSION);
  });

  test("the reason names the time already spent, so the move onto the ladder is not a surprise", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null, status: 503 });
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    await peer.snapshot(laptop);
    clock += 41_000;
    const later = await peer.snapshot(laptop);
    expect(later.ok === false && later.reason).toContain("41s so far");
  });

  test("an answer that carries a header clears the headerless run", async () => {
    let protocol: string | null = null;
    const fetch: CrewFetch = async () => {
      const headers = new Headers({ "content-type": "application/json" });
      if (protocol !== null) headers.set(PROTOCOL_HEADER, protocol);
      headers.set(MEMBER_HEADER, "laptop");
      return new Response("{}", { status: protocol === null ? 502 : 200, headers });
    };
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    await peer.snapshot(laptop);
    clock += HEADERLESS_PATIENCE_MS - 1_000;
    // The peer finished its restart and answers properly. That is what resets the run, and the NEXT
    // outage must get a fresh patient minute rather than land on the ladder on its first answer.
    protocol = "1";
    await peer.snapshot(laptop);
    protocol = null;
    clock += 2_000;
    const after = await peer.snapshot(laptop);
    expect(after.ok === false && after.state).toBe("unreachable");
  });

  test("two members are patient independently — one spent run does not ladder the other", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null, status: 502 });
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    await peer.snapshot(laptop);
    clock += HEADERLESS_PATIENCE_MS;
    const spent = await peer.snapshot(laptop);
    expect(spent.ok === false && spent.state).toBe("incompatible");
    // The other member has answered nothing yet. Its window opens now, on its own clock.
    const desk: CrewLink = { memberId: "desk-2", address: "desk2.example:8787" };
    const other = await peer.snapshot(desk);
    expect(other.ok === false && other.state).toBe("unreachable");
  });

  test("a connection failure between two headerless answers neither spends the window nor renews it", async () => {
    let dead = false;
    const fetch: CrewFetch = async () => {
      if (dead) throw new Error("connect ECONNREFUSED");
      const headers = new Headers({ "content-type": "application/json" });
      headers.set(MEMBER_HEADER, "laptop");
      return new Response("{}", { status: 502, headers });
    };
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    await peer.snapshot(laptop);
    // A dead socket says nothing about a header, so the window it opened keeps running.
    dead = true;
    clock += 30_000;
    expect((await peer.snapshot(laptop)).ok === false).toBe(true);
    dead = false;
    clock += 31_000;
    const past = await peer.snapshot(laptop);
    expect(past.ok === false && past.state).toBe("incompatible");
  });

  test("a bare 401 keeps its own reason and never opens a headerless window", async () => {
    const { fetch } = replying({}, { protocol: null, status: 401 });
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    for (let i = 0; i < 8; i += 1) {
      clock += 30_000;
      const outcome = await peer.snapshot(laptop);
      expect(outcome.ok === false && outcome.state).toBe("unreachable");
      expect(outcome.ok === false && outcome.reason).toContain("refused by the peer (unauthorized)");
      // The peer ANSWERED, and it said no. `authRefused` is the one bit the transport carries for
      // §10.2's presentation split, so the operator is told to fix the secret rather than to wait.
      expect(outcome.ok === false && outcome.state === "unreachable" && outcome.authRefused).toBe(true);
    }
  });

  test("a timeout carries no `authRefused` — absent means 'not that', as `timedOut`'s absence does", async () => {
    const fetch: CrewFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const outcome = await client(fetch, { timeoutMs: 10 }).snapshot(laptop);
    expect(outcome.ok === false && outcome.state === "unreachable" && outcome.authRefused).toBeUndefined();
    expect(outcome.ok === false && outcome.state === "unreachable" && outcome.timedOut).toBe(true);
  });

  test("`forget` drops the window, so a member that rejoins under the same id is patient again", async () => {
    const { fetch } = replying({ ok: true }, { protocol: null, status: 502 });
    let clock = 1_000;
    const peer = client(fetch, { now: () => clock });
    await peer.snapshot(laptop);
    clock += HEADERLESS_PATIENCE_MS;
    const laddered = await peer.snapshot(laptop);
    expect(laddered.ok === false && laddered.state).toBe("incompatible");
    peer.forget(laptop.memberId);
    const rejoined = await peer.snapshot(laptop);
    expect(rejoined.ok === false && rejoined.state).toBe("unreachable");
  });

  test("a NAMED foreign version is incompatible on the very first answer", async () => {
    const { fetch } = replying({ some: "a foreign shape" }, { protocol: "3" });
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok) throw new Error("expected a failure");
    if (outcome.state !== "incompatible") throw new Error(`expected incompatible, got ${outcome.state}`);
    expect(outcome.received).toBe(3);
  });

  test("a matching version with an unparseable body is unreachable, not incompatible", async () => {
    const { fetch } = replying("{not json", {});
    const outcome = await client(fetch).snapshot(laptop);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
    expect(outcome.ok === false && outcome.reason).toContain("malformed response body");
  });

  test("`hello`'s optional version is read when the peer reports one (§5)", async () => {
    const { fetch } = replying({ protocol: 2, member: "laptop", version: "1.0.0-alpha.12" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok && outcome.value.version).toBe("1.0.0-alpha.12");
  });

  test("an absent version is `null` and NOTHING else — a build older than the amendment (§7.1)", async () => {
    // Absent-means-closed: the member is read as claiming no version, never as an error and never as
    // a reason to refuse. Reachability is untouched — the protocol integer is the only thing that
    // refuses, and this reply's protocol matched.
    const { fetch } = replying({ protocol: 2, member: "laptop" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.version).toBeNull();
  });

  test("a version that is not a usable string reads as absent, never as a failure (§7.1)", async () => {
    for (const version of [7, null, true, "", { v: "1.0.0" }, ["1.0.0"]]) {
      const { fetch } = replying({ protocol: 2, member: "laptop", version });
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
    const { fetch } = replying({ protocol: 2, member: "laptop", version: "9.9.9", futureField: { any: "shape" } });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.member).toBe("laptop");
  });

  test("M22's own `mux` block changes nothing an older lead reads off `hello` (§7.1, §16 skew leg)", async () => {
    // The stand-in above pins the CLASS. This pins THE FIELD this milestone actually added, because
    // the version-skew leg (CREW_PROTOCOL.md §16, 2026-09-08) measured a real 1.6.0 lead reading a
    // real current-tree peer's `hello` — a body carrying the full capability table, `listSessions`
    // included — and it has to keep behaving exactly as it does with a 1.6.0 member. A 1.6.0 lead
    // has no reader for `mux` at all, so what must hold is that the block is INERT: every field an
    // older parser does read comes back the same with it and without it. That is the property, not
    // "no exception was thrown" — so it is asserted as an equality between the two answers.
    const bare = { protocol: 2, member: "laptop", version: "9.9.9" };
    const withMux = {
      ...bare,
      mux: {
        name: "tmux",
        capabilities: muxCaps({ listSessions: false, paneGrid: true }),
        unsupportedKeys: [],
        notes: { listSessions: "tmux has no instance registry" },
        spaces: "many",
        topologyLatency: { kind: "push" },
      },
    };
    const [plain, decorated] = await Promise.all([
      client(replying(bare).fetch).hello(laptop),
      client(replying(withMux).fetch).hello(laptop),
    ]);
    if (!plain.ok || !decorated.ok) throw new Error("both hellos answer 200; the assertions below need their values");
    // THIS build reads the block (`parseMuxReport`, M22/03) and so gains one field. A 1.6.0 build
    // has no such reader, and the older reading is what this asserts: blank out the one field only
    // this milestone knows about, and the two answers are the same object.
    expect({ ...decorated.value, mux: null }).toEqual({ ...plain.value, mux: null });
    expect(decorated.value.mux?.name).toBe("tmux");
    expect(plain.value.mux).toBeNull();
  });

  test("an unusable stored address fails as unreachable without dialling anything", async () => {
    const { fetch, calls } = replying({});
    const outcome = await client(fetch).snapshot({ memberId: "nas", address: "nas.example/evil" });
    expect(calls).toEqual([]);
    expect(outcome.ok === false && outcome.state).toBe("unreachable");
  });

  test("no reason string ever contains the crew secret", async () => {
    const failures = [
      await client(() => Promise.reject(new Error("connect ECONNREFUSED"))).snapshot(laptop),
      await client(replying({}, { status: 500 }).fetch).snapshot(laptop),
      await client(replying({}, { protocol: "7" }).fetch).snapshot(laptop),
      await client(replying("nope").fetch).snapshot(laptop),
    ];
    for (const f of failures) {
      expect(f.ok).toBe(false);
      expect(f.ok === false && f.reason.includes(CREW.secret)).toBe(false);
    }
  });

  test("`raw` hands the Response back unread, so a proxied read keeps its bytes and its ETag", async () => {
    const fetch: CrewFetch = async () =>
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
    const links: CrewLink[] = ["a", "b", "c"].map((id) => ({ memberId: id, address: `${id}.example` }));
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
    const links: CrewLink[] = [
      { memberId: "up", address: "up.example" },
      { memberId: "down", address: "down.example" },
    ];
    const fetch: CrewFetch = async (url) => {
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
    // Stamped with the crew headers, so it is the peer answering rather than the link refusing.
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
    const { fetch } = replying({ ok: true }, { status: 200, protocol: "3" });
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
    const fetch: CrewFetch = () => Promise.reject(new Error("socket hang up"));
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
    expect(sent.get("authorization")).toBe(`Bearer ${CREW.secret}`);
    expect(sent.get(PROTOCOL_HEADER)).toBe("2");
    expect(sent.get(MEMBER_HEADER)).toBe("desk");
  });
});

describe("two budgets, and which call runs on which (§10.4)", () => {
  /** A transport that answers nothing and dies only when the client's own budget aborts it. */
  const stalling: CrewFetch = (_url, init) =>
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
    const oncely: CrewFetch = (url, init) => {
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
    const moved: CrewLink = { memberId: "laptop", address: "laptop.other:8787" };
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
    // A refusal is an answer, not a slow link — and `CrewLead` must not re-probe it patiently.
    const refused: CrewFetch = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const dead = await client(refused).snapshot(laptop);
    expect(!dead.ok && dead.state === "unreachable" && dead.timedOut).toBe(false);
    expect(!dead.ok && dead.reason).toBe("snapshot: nothing accepted a connection at this address");
  });
});

// ── The third budget: a forwarded WRITE (§10.1, amended 2026-09-08) ──────────

describe("a forwarded write's own budget (§10.1)", () => {
  /** Stalls until the client's own budget aborts it, so the reason names the deadline that fired. */
  const stalling: CrewFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
    });

  test("`proxy` runs on the budget it is given, and says which one fired", async () => {
    const c = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    const written = await c.proxy(laptop, "launch", undefined, { method: "POST" }, 90);
    expect(!written.ok && written.reason).toBe("launch: timed out after 90ms");
  });

  test("an explicit budget spends NO bootstrap credit — the sweep's accounting is untouched", async () => {
    const c = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    // Two forwarded writes on a cold link, both on their own budget.
    expect(!(await c.proxy(laptop, "launch", undefined, { method: "POST" }, 90)).ok).toBe(true);
    expect(!(await c.proxy(laptop, "launch", undefined, { method: "POST" }, 90)).ok).toBe(true);
    // The credit is still there for the sweep, which is the call the poll fraction is sized for.
    const sweep = await c.snapshot(laptop);
    expect(!sweep.ok && sweep.reason).toBe("snapshot: timed out after 40ms");
  });

  test("a forwarded READ keeps the poll budget and the credit, unchanged", async () => {
    const c = client(stalling, { timeoutMs: 5, patientTimeoutMs: 40 });
    const first = await c.proxy(laptop, "pane/w1:p1", undefined, {});
    expect(!first.ok && first.reason).toBe("pane/w1:p1: timed out after 40ms");
    const second = await c.proxy(laptop, "pane/w1:p1", undefined, {});
    expect(!second.ok && second.reason).toBe("pane/w1:p1: timed out after 5ms");
  });

  test("on the real clock: 2 s of work misses the poll budget and fits inside WRITE_BUDGET_MS", async () => {
    // The measured case, on real timers rather than modelled: a launch onto a zellij member spawns a
    // process and has the multiplexer build a tab. Around 2 s — under 1200 ms it is an abort the lead
    // can only report as ambiguous (§10.3), and under 5000 ms it is the peer's own answer.
    const slow: CrewFetch = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        setTimeout(() => void replying({ ok: true }).fetch(url, init).then(resolve, reject), 2000);
      });
    // No patient budget wired, so the poll budget is the honest comparison and not the credit.
    const c = client(slow, { timeoutMs: crewTimeoutBudget(1500, {}) });
    const missed = await c.proxy(laptop, "launch", undefined, { method: "POST" });
    expect(!missed.ok && missed.reason).toBe(`launch: timed out after ${DEFAULT_CREW_TIMEOUT_MS}ms`);
    const landed = await c.proxy(laptop, "launch", undefined, { method: "POST" }, WRITE_BUDGET_MS);
    expect(landed.ok).toBe(true);
    expect(landed.ok && landed.status).toBe(200);
  }, 10_000);
});

// ── F18: the runtime's voice never reaches an operator ───────────────────────

describe("operatorReason — one runtime failure, said once, in Collie's words", () => {
  const BUN_CONNECT = "Unable to connect. Is the computer able to access the url?";

  test("Bun's browser-voiced connection error becomes a statement about the far side", () => {
    // "the computer", "the url", and a question — a browser console's words, in a CLI that
    // elsewhere writes very carefully. It reached `crew status`, the 503 body and `leave`.
    expect(operatorReason(BUN_CONNECT)).toBe("nothing accepted a connection at this address");
    expect(operatorReason(BUN_CONNECT)).not.toContain("computer");
    expect(operatorReason(BUN_CONNECT)).not.toContain("url");
  });

  test("the distinctions an operator acts on are kept apart", () => {
    // Each answer sends them somewhere different: the service, the address, the pin, the network.
    expect(operatorReason("connect ECONNREFUSED 10.0.0.2:8787")).toBe("nothing accepted a connection at this address");
    expect(operatorReason("getaddrinfo ENOTFOUND nas.example")).toBe("this address does not resolve");
    expect(operatorReason("unable to verify the first certificate")).toBe("the TLS certificate was not accepted");
    expect(operatorReason("unknown certificate verification error")).toBe("the TLS certificate was not accepted");
    expect(operatorReason("connect EHOSTUNREACH")).toBe("there is no route to this address");
    expect(operatorReason("The socket connection was closed unexpectedly")).toBe(
      "the connection closed before an answer arrived",
    );
  });

  test("a duration is never thrown away — §10.4's budget conversation needs the number", () => {
    expect(operatorReason("timed out after 1200ms")).toBe("timed out after 1200ms");
  });

  test("an unrecognised failure is passed through, not dressed up", () => {
    // A confident sentence describing the wrong thing is worse than a string they can search for.
    expect(operatorReason("something nobody has seen yet")).toBe("something nobody has seen yet");
  });
});

describe("warrant — the lead's push (§18)", () => {
  const warrant = {
    crewId: "crew-1",
    generation: 2,
    deputyMemberId: "nas",
    deputyFingerprint: "a".repeat(64),
    leadMemberId: "desk",
    issuedAt: 1,
    refreshedAt: 2,
    signature: "sig",
  };

  test("POSTs the warrant and the deputy's certificate to /crew/v1/warrant", async () => {
    const { fetch, calls } = replying({ generation: 2, applied: true });
    const outcome = await client(fetch).warrant(laptop, { warrant, deputyCertPem: "PEM" });
    expect(outcome.ok && outcome.value).toEqual({ generation: 2, applied: true });
    expect(calls[0]!.url).toBe("https://laptop.example:8787/crew/v1/warrant");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ warrant, deputyCertPem: "PEM" });
  });

  test("is an ordinary DATA dial: one bootstrap attempt per cold link, strict budget thereafter", async () => {
    const stalled: CrewFetch = (_u, init) =>
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
    const { fetch } = replying(conflictBody({ warrant: { crewId: 7 } }), { status: 409, protocol: "1" });
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
      { error: "crew protocol mismatch", code: "protocol_mismatch", expected: 2, received: 1 },
      { status: 409, protocol: "1" },
    );
    const outcome = await client(fetch).snapshot(laptop);
    if (outcome.ok || outcome.state !== "incompatible") throw new Error("expected incompatible");
    expect(outcome.expected).toBe(2);
  });

  test("hello reads the warrant generation, absent-means-closed", async () => {
    const withGen = replying({ protocol: 2, member: "laptop", warrantGeneration: 4, pairingDigest: null, pairingCollision: null });
    expect((await client(withGen.fetch).hello(laptop)).ok).toBe(true);
    const outcome = await client(withGen.fetch).hello(laptop);
    expect(outcome.ok && outcome.value.warrantGeneration).toBe(4);

    // Anything that is not a safe integer is "reported nothing" — never a reason to refuse a link,
    // and never read as agreement by the boot gate.
    for (const bad of [null, "4", 1.5, {}]) {
      const { fetch } = replying({ protocol: 2, member: "laptop", warrantGeneration: bad });
      const o = await client(fetch).hello(laptop);
      expect(o.ok && o.value.warrantGeneration).toBeNull();
    }
  });
});

describe("PeerClient — pairing_label_collision, the other 409 (§18.14)", () => {
  const sync = { crewId: "crew-1", leadMemberId: "desk", devices: [] };
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
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
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
    const init: CrewRequestInit = { method: "POST", body };
    await client(fetch, withDial()).proxy(laptop, "pane/w1:p1/upload", undefined, init);
    expect(calls[0]!.init.body).toBe(body);
    expect(new Headers(calls[0]!.init.headers).get(DIAL_HEADER)).not.toBeNull();
  });

  test("both signatures share ONE timestamp — one request makes one freshness claim", async () => {
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
    await client(fetch, withDial({ sign: () => "request-signature" })).hello(laptop);
    const headers = new Headers(calls[0]!.init.headers);
    const timestamp = Number(headers.get(TIMESTAMP_HEADER));
    expect(headers.get(SIGNATURE_HEADER)).toBe("request-signature");
    expect(
      verifyDial(material("desk").certPem, headers.get(DIAL_HEADER)!, {
        method: "GET",
        path: "/crew/v1/hello",
        timestamp,
        to: "laptop",
      }),
    ).toBe(true);
  });

  test("a client with no key sends no header at all — absent, never empty", async () => {
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
    await client(fetch).hello(laptop);
    expect(new Headers(calls[0]!.init.headers).get(DIAL_HEADER)).toBeNull();
  });
});

describe("parsePeerVersion — the sweep's version sibling (§5, §19)", () => {
  test("a carried version is read verbatim, and nothing about it is re-derived", () => {
    expect(parsePeerVersion({ bridge: {}, version: "1.4.1" })).toBe("1.4.1");
    // A build stamp and a prerelease tail are that machine's own spelling. They cross untouched.
    expect(parsePeerVersion({ version: "1.5.0-beta.2+ab12cd3" })).toBe("1.5.0-beta.2+ab12cd3");
    expect(parsePeerVersion({ version: "  1.4.1  " })).toBe("1.4.1");
  });

  test("absent means the answer SAID NOTHING — null, so the caller keeps what it had", () => {
    // A peer older than the 2026-09-04 amendment omits the field on every sweep. Each of these
    // reads the same way, and `bridge/crew/lead.ts` turns exactly this `null` into "pass no
    // observation", which is what stops a sweep erasing a version a `hello` already taught.
    expect(parsePeerVersion({ bridge: {}, agents: [] })).toBeNull();
    expect(parsePeerVersion({ version: "" })).toBeNull();
    expect(parsePeerVersion({ version: "   " })).toBeNull();
    expect(parsePeerVersion({ version: 141 })).toBeNull();
    expect(parsePeerVersion({ version: null })).toBeNull();
    expect(parsePeerVersion(["1.4.1"])).toBeNull();
    expect(parsePeerVersion("1.4.1")).toBeNull();
    expect(parsePeerVersion(null)).toBeNull();
  });

  test("it sits BESIDE the other siblings and never reaches for one of them", () => {
    const answer: JsonValue = {
      version: "1.4.1",
      updatePreflight: { verdict: "green", asOf: 1, checks: [] },
      updateRun: { state: "done", to: "1.4.1", runId: "r-1", reason: null, updatedAt: 2 },
    };
    expect(parsePeerVersion(answer)).toBe("1.4.1");
  });
});

// ── M22/03: a member's own capability block, off its `hello` answer ───────────
//
// The lead REPUBLISHES this to a phone on `/api/config?host=<member>`, so it is bounded and
// re-checked field by field here. Absent, and anything half-formed, is `null` — and `null` means
// "use the lead's answer", never "every capability present".

describe("parseMuxReport — a member's declaration, bounded and re-checked", () => {
  const block = { name: "reference", capabilities: { createSpace: true }, unsupportedKeys: [], notes: {} };

  test("a well-formed block comes through with its answers intact", () => {
    expect(parseMuxReport({ protocol: 2, member: "nas", mux: block })).toEqual({
      name: "reference",
      capabilities: muxCaps({ createSpace: true }),
      unsupportedKeys: [],
      notes: {},
    });
  });

  test("every shape that is not a block is `null`, which reads as the lead's answer", () => {
    const absent = [null, 42, "mux", [], {}, { mux: null }, { mux: "reference" }, { mux: [] }];
    for (const body of absent) expect(parseMuxReport(body)).toBeNull();
    // A name is required, and so is a capabilities object: a block naming nothing answers nothing.
    expect(parseMuxReport({ mux: { ...block, name: "  " } })).toBeNull();
    expect(parseMuxReport({ mux: { ...block, name: "x".repeat(65) } })).toBeNull();
    expect(parseMuxReport({ mux: { name: "reference" } })).toBeNull();
  });

  test("a capability key this build never heard of SURVIVES — the fail-open direction", () => {
    // `capabilities` is total for the bridge that built it, not for every version a client knows.
    // A newer member answering a key this lead lacks is honest, and the phone may well know it.
    const wire = parseMuxReport({ mux: { ...block, capabilities: { createSpace: true, teleportPane: false } } });
    expect(wire?.capabilities).toEqual(muxCaps({ createSpace: true, teleportPane: false }));
  });

  test("a non-boolean answer is dropped, not coerced", () => {
    const wire = parseMuxReport({ mux: { ...block, capabilities: { createSpace: "yes", closePane: false } } });
    expect(wire?.capabilities).toEqual(muxCaps({ closePane: false }));
  });

  test("`logoUrl` never survives the link — a path only answers on the machine that serves it", () => {
    const wire = parseMuxReport({ mux: { ...block, logoUrl: "/api/mux/logo.svg" } });
    expect(wire === null ? true : Object.hasOwn(wire, "logoUrl")).toBe(false);
  });

  test("the optional siblings are read, and an unreadable one leaves no key at all", () => {
    expect(parseMuxReport({ mux: { ...block, spaces: "one" } })?.spaces).toBe("one");
    expect(Object.hasOwn(parseMuxReport({ mux: { ...block, spaces: "several" } })!, "spaces")).toBe(false);
    expect(parseMuxReport({ mux: { ...block, topologyLatency: { kind: "bounded", ms: 9000 } } })?.topologyLatency).toEqual({
      kind: "bounded",
      ms: 9000,
    });
    expect(
      Object.hasOwn(parseMuxReport({ mux: { ...block, topologyLatency: { kind: "bounded" } } })!, "topologyLatency"),
    ).toBe(false);
  });

  test("strings and collections are capped, so a member cannot make the lead serve an unbounded body", () => {
    const keys = Array.from({ length: 300 }, (_, i) => `k${i}`);
    const wire = parseMuxReport({
      mux: { ...block, unsupportedKeys: [...keys, "x".repeat(2000)], notes: { createSpace: "y".repeat(2000) } },
    });
    expect(wire?.unsupportedKeys).toHaveLength(256);
    expect(wire?.notes).toEqual({});
  });
});

// ── The version 1 fallback dial (M27/03, CREW_PROTOCOL.md §0.1) ─────────────
// REMOVE_IN_1_9_0 — this whole describe block, and the minor-9 reminder that guards it lives in
// `bridge/removal-schedule.test.ts` (its `describe("wire")` block fails once the package minor
// reaches 9 with any of the overlap still here).
//
// The order is `/crew/v1` first, always. A lead still on 1.7.0 reveals itself in exactly two ways,
// and both are ANSWERS rather than guesses: a header-free `404` or `403` (a build that has never
// heard of the prefix, either its own 404 or `bridge/server.ts`'s non-loopback refusal for a
// declined crew path), or a crew header naming version 1.
describe("the version 1 fallback", () => {
  /** A fake that answers the version 2 prefix as a 1.7.0 collie would, and `/pack/v1` properly. */
  function oldLead(status: number) {
    const calls: string[] = [];
    const fetch: CrewFetch = async (url) => {
      calls.push(new URL(url).pathname);
      if (new URL(url).pathname.startsWith("/crew/v1/")) {
        return new Response(JSON.stringify({ error: "not found" }), { status });
      }
      return new Response(JSON.stringify({ protocol: 1, member: "laptop" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-pack-protocol": "1", "x-pack-member": "laptop" },
      });
    };
    return { fetch, calls };
  }

  for (const status of [404, 403]) {
    test(`a header-free ${status} on /crew/v1 falls back to /pack/v1, once, and the dial succeeds`, async () => {
      const { fetch, calls } = oldLead(status);
      const lines: string[] = [];
      const outcome = await client(fetch, { log: (l) => lines.push(l) }).hello(laptop);
      expect(outcome.ok).toBe(true);
      expect(calls).toEqual(["/crew/v1/hello", "/pack/v1/hello"]);
      // The answer is read in version 2's vocabulary, so nothing downstream knows about the overlap.
      expect(outcome.ok && outcome.value.protocol).toBe(1);
      expect(lines).toEqual(["[crew] laptop: speaks version 1, dialling /pack/v1 until it updates"]);
    });
  }

  test("a crew header naming version 1 falls back too — the refusal is an answer", async () => {
    const calls: string[] = [];
    const fetch: CrewFetch = async (url) => {
      const { pathname } = new URL(url);
      calls.push(pathname);
      // Both prefixes answer, and both name version 1 — a 1.7.0 collie fronted by something that
      // routes the new prefix at it. The header NAME follows the prefix, as a real one would.
      const name = pathname.startsWith("/pack/v1/") ? "x-pack-protocol" : "x-crew-protocol";
      return new Response(JSON.stringify({ protocol: 1, member: "laptop" }), {
        status: 200,
        headers: { "content-type": "application/json", [name]: "1", "x-pack-member": "laptop" },
      });
    };
    const lines: string[] = [];
    const outcome = await client(fetch, { log: (l) => lines.push(l) }).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["/crew/v1/hello", "/pack/v1/hello"]);
    expect(lines).toHaveLength(1);
  });

  // ONE line per lead, not one per sweep. The fallback itself is per dial and never cached, which is
  // what lets a member stop using it the moment its lead updates.
  test("the line is written once per lead, however many times the fallback is taken", async () => {
    const { fetch, calls } = oldLead(404);
    const lines: string[] = [];
    const c = client(fetch, { log: (l) => lines.push(l) });
    await c.hello(laptop);
    await c.hello(laptop);
    await c.snapshot(laptop);
    expect(lines).toEqual(["[crew] laptop: speaks version 1, dialling /pack/v1 until it updates"]);
    // Three dials, six requests: the fallback is taken every time, and only the LINE is remembered.
    expect(calls).toHaveLength(6);
  });

  // A LEAD holds more than one client per peer (`bridge/index.ts` builds the sweep's and the
  // takeover's), so a set per client wrote the line twice per member. The set is the process's.
  test("two clients sharing one set write the line once for the same lead", async () => {
    const { fetch } = oldLead(404);
    const lines: string[] = [];
    const shared = new Set<string>();
    await client(fetch, { log: (l) => lines.push(l), toldVersion1: shared }).hello(laptop);
    await client(fetch, { log: (l) => lines.push(l), toldVersion1: shared }).snapshot(laptop);
    expect(lines).toEqual(["[crew] laptop: speaks version 1, dialling /pack/v1 until it updates"]);
  });

  test("two clients with their own sets each write it — the default is per client", async () => {
    const { fetch } = oldLead(404);
    const lines: string[] = [];
    await client(fetch, { log: (l) => lines.push(l) }).hello(laptop);
    await client(fetch, { log: (l) => lines.push(l) }).hello(laptop);
    expect(lines).toHaveLength(2);
  });

  test("a member enrolled again under the same id is told about again", async () => {
    const { fetch } = oldLead(404);
    const lines: string[] = [];
    const c = client(fetch, { log: (l) => lines.push(l) });
    await c.hello(laptop);
    c.forget(laptop.memberId, laptop.address);
    await c.hello(laptop);
    expect(lines).toHaveLength(2);
  });

  test("an updated lead is never dialled on /pack/v1, and nothing is logged", async () => {
    const { fetch, calls } = replying({ protocol: 2, member: "laptop" });
    const lines: string[] = [];
    const outcome = await client(fetch, { log: (l) => lines.push(l) }).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/crew/v1/hello"]);
    expect(lines).toEqual([]);
  });

  // A version the overlap cannot serve is NOT a 1.7.0 lead, so it is the ordinary skew and there is
  // no second dial to make.
  test("a foreign version other than 1 does not fall back", async () => {
    const { fetch, calls } = replying({ some: "a foreign shape" }, { protocol: "3" });
    const lines: string[] = [];
    const outcome = await client(fetch, { log: (l) => lines.push(l) }).snapshot(laptop);
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  // A dead host answers nothing, so there is nothing to read a version off — and a second dial there
  // would double the budget every poll spends on a machine that is not there.
  test("a header-free 502 does not fall back — that is a proxy, not a version", async () => {
    const { fetch, calls } = replying({ ok: true }, { protocol: null, status: 502 });
    const lines: string[] = [];
    await client(fetch, { log: (l) => lines.push(l) }).snapshot(laptop);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  test("the fallback dial carries version 1's headers and the version 1 dial domain", async () => {
    const { fetch, calls } = oldLead(404);
    const seen: DialParts[] = [];
    await client(fetch, {
      log: () => undefined,
      dialSign: (parts) => {
        seen.push(parts);
        return signDial(material("desk").keyPem, parts);
      },
    }).hello(laptop);
    expect(calls).toEqual(["/crew/v1/hello", "/pack/v1/hello"]);
    // The domain is chosen from the prefix, and the PATH signed is the one actually dialled.
    expect(seen.map((p) => p.domain ?? null)).toEqual([null, "collie-pack-dial-v1"]);
    expect(seen.map((p) => p.path)).toEqual(["/crew/v1/hello", "/pack/v1/hello"]);
  });
});

// ── The shape a REAL 1.7.0 collie answers with (M27/03b) ────────────────────
// REMOVE_IN_1_9_0 — this whole describe block.
//
// Ground truth, measured in the VM lab on 2026-09-09: a 1.7.0 bridge answers `/crew/v1/hello` with
// `200 OK`, `content-type: text/html`, `x-collie-build: 1.7.0+35b60df`, and ~9 KB of the PWA's app
// shell. `bridge/server.ts` hands every unrouted path the built `index.html` so a deep link works,
// and a path it has never heard of is a deep link to that fallthrough. It is NEVER a 404.
//
// The first draft of the trigger read 404-or-403 and therefore fired on neither skew: members read
// `unreachable · hello: peer answered 200 with no crew protocol header` and no fallback line was ever
// written. These cases are that failure, pinned from both directions.
describe("the version 1 fallback, against the shape a real 1.7.0 collie answers with", () => {
  /** The app shell a 1.7.0 bridge hands an unrouted path. Short, but the same headers. */
  const APP_SHELL = '<!doctype html><html lang="en"><head><title>Collie</title></head><body></body></html>';

  /**
   * A 1.7.0 collie: the SPA catch-all on `/crew/v1/*`, a real crew answer on `/pack/v1/*`.
   *
   * `answer` is what the version 1 surface replies with, so one fake serves both skews — a member
   * dialling its lead's `hello`, and a lead dialling a peer's `snapshot`.
   */
  function collie17(answer: JsonValue) {
    const calls: string[] = [];
    const fetch: CrewFetch = async (url) => {
      const { pathname } = new URL(url);
      calls.push(pathname);
      if (pathname.startsWith("/crew/v1/")) {
        return new Response(APP_SHELL, {
          status: 200,
          headers: { "content-type": "text/html;charset=utf-8", "x-collie-build": "1.7.0+35b60df" },
        });
      }
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json", "x-pack-protocol": "1", "x-pack-member": "laptop" },
      });
    };
    return { fetch, calls };
  }

  // Skew one: a 1.8.0 MEMBER under a lead that has not been updated yet. `hello` is the call that
  // runs in the peer → lead direction (§8.6), and it is what `crew status` and `reconnect` probe with.
  test("a 1.8.0 member reaches its 1.7.0 lead, and says so once", async () => {
    const { fetch, calls } = collie17({ protocol: 1, member: "laptop" });
    const lines: string[] = [];
    const outcome = await client(fetch, { log: (l) => lines.push(l) }).hello(laptop);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["/crew/v1/hello", "/pack/v1/hello"]);
    expect(lines).toEqual(["[crew] laptop: speaks version 1, dialling /pack/v1 until it updates"]);
  });

  // Skew two: a 1.8.0 LEAD sweeping a member that has not been updated yet — the skew the roll
  // actually produces, because a crew is updated lead first (§20). One dial serves both directions,
  // so the fix lands on both, and this case is what proves it rather than assuming it.
  test("a 1.8.0 lead reaches its 1.7.0 peer's snapshot, and says so once", async () => {
    const { fetch, calls } = collie17({ bridge: "connected", agents: [], shellPanes: [] });
    const lines: string[] = [];
    const outcome = await client(fetch, { log: (l) => lines.push(l) }).snapshot(laptop);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["/crew/v1/snapshot", "/pack/v1/snapshot"]);
    expect(lines).toEqual(["[crew] laptop: speaks version 1, dialling /pack/v1 until it updates"]);
  });

  // The regression, stated as the sentence the operator was reading before this fix.
  test("the member no longer reports the app shell as an unreachable peer", async () => {
    const { fetch } = collie17({ protocol: 1, member: "laptop" });
    const outcome = await client(fetch).hello(laptop);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) return;
    expect(outcome.reason).not.toContain("with no crew protocol header");
  });

  // And the exclusions the shape rule must not swallow. A 5xx is a proxy or a peer mid-restart, and
  // a JSON 200 with no header is the case §7 already had an answer for.
  test("a 5xx app shell is still not a version — no second dial", async () => {
    const calls: string[] = [];
    const fetch: CrewFetch = async (url) => {
      calls.push(new URL(url).pathname);
      return new Response(APP_SHELL, { status: 502, headers: { "content-type": "text/html" } });
    };
    const lines: string[] = [];
    await client(fetch, { log: (l) => lines.push(l) }).snapshot(laptop);
    expect(calls).toEqual(["/crew/v1/snapshot"]);
    expect(lines).toEqual([]);
  });

  test("a headerless JSON 200 is not a version either — no second dial", async () => {
    const { fetch, calls } = replying({ ok: true }, { protocol: null, status: 200 });
    const lines: string[] = [];
    await client(fetch, { log: (l) => lines.push(l) }).snapshot(laptop);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });
});

// The shape rule on its own, as a table — pure, so it reads as the decision rather than a harness.
// REMOVE_IN_1_9_0.
describe("routesNoCrewV1", () => {
  const answer = (status: number, contentType: string | null): Response =>
    new Response(status === 204 ? null : "x", {
      status,
      headers: contentType === null ? {} : { "content-type": contentType },
    });

  test("a 200 that is not JSON is a build answering a path it does not route", () => {
    expect(routesNoCrewV1(answer(200, "text/html;charset=utf-8"))).toBe(true);
    expect(routesNoCrewV1(answer(200, "text/plain"))).toBe(true);
    expect(routesNoCrewV1(answer(200, null))).toBe(true);
  });

  test("a 200 that IS JSON is not — a crew answer is always JSON", () => {
    expect(routesNoCrewV1(answer(200, "application/json"))).toBe(false);
    expect(routesNoCrewV1(answer(200, "application/json; charset=utf-8"))).toBe(false);
    expect(routesNoCrewV1(answer(200, "APPLICATION/JSON"))).toBe(false);
  });

  test("the two narrower shapes still count: no bundle 404s, loopback-strict 403s", () => {
    expect(routesNoCrewV1(answer(404, "text/plain"))).toBe(true);
    expect(routesNoCrewV1(answer(403, "text/plain"))).toBe(true);
  });

  test("a 5xx never counts, whatever it serves", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(routesNoCrewV1(answer(status, "text/html"))).toBe(false);
    }
  });

  test("no other status counts — a 304 or a 401 is not a version", () => {
    for (const status of [204, 301, 401, 409, 429]) {
      expect(routesNoCrewV1(answer(status, "text/html"))).toBe(false);
    }
  });
});
