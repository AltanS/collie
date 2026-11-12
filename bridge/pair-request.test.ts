import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formatAuditLine, type AuditEntry } from "./audit.ts";
import { loadConfig, type Config } from "./config.ts";
import { forwardHeaders } from "./crew/forward.ts";
import type { JsonValue } from "./json.ts";
import { localCredentialOf, mintLocalSecret } from "./local-secret.ts";
import { createPairLimiter } from "./pair-limit.ts";
import {
  askerFromUserAgent,
  codeDistance,
  COLLECT_GRACE_MS,
  DECOY_MIN_DISTANCE,
  makeChoices,
  MAX_OPEN_REQUESTS,
  MAX_TOMBSTONES,
  pairApproveAnswerRoute,
  pairApproveGateLevel,
  pairApproveReadRoute,
  pairRequestCreateRoute,
  pairRequestPollRoute,
  PairRequestBook,
  parseApproveBody,
  REQUEST_CODE_LENGTH,
  REQUEST_SOURCE_WINDOW_MS,
  ANSWER_MARGIN_MS,
  pairRequestCancelRoute,
  REQUEST_TTL_MS,
  REQUESTS_PER_SOURCE,
  REQUESTS_PER_WINDOW,
  requestSourceKey,
  settlePairRequests,
  TOMBSTONE_MS,
  type PairRequestDeps,
} from "./pair-request.ts";
import {
  CODE_ALPHABET,
  coerceRegistry,
  DEVICES_FILENAME,
  PairingStore,
  RegistryUnreadableError,
  sha256Hex,
  uniqueLabel,
  type PairedRegistry,
  type PairingIo,
  type PendingPairing,
} from "./pairing.ts";
import { browserPairingGate, guard } from "./server.ts";

// Every rule of ADR 0139 that the bridge holds, driven through the pure handlers server.ts hands each
// request to. `Bun.serve` is not stood up here (CLAUDE.md): server.ts's own wiring of these handlers,
// the open routes and the gate levels is pinned by source in server.test.ts and api-front-gate.test.ts.

const T0 = Date.parse("2026-11-11T12:00:00Z");
const PHONE = "tok-phone-0123456789abcdef0123456789abcdef";
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const TAILNET = { route: "loopback", forwarded: "tailnet" } as const;

/** What {@link memoryIo} keeps in place of the two state files. */
interface MemoryState {
  registry: PairedRegistry | null;
  pending: PendingPairing | null;
  unreadable: boolean;
}

/** A registry in memory, as `PairingIo` sees one. `unreadable` makes every registry read throw. */
function memoryIo(seed: PairedRegistry = { devices: [] }) {
  const state: MemoryState = {
    registry: seed,
    pending: null,
    unreadable: false,
  };
  const io: PairingIo = {
    readPending: async () => state.pending,
    writePending: async (p) => {
      state.pending = p;
    },
    deletePending: async () => {
      state.pending = null;
    },
    readRegistry: async () => {
      if (state.unreadable) throw new RegistryUnreadableError(`${DEVICES_FILENAME} is not valid JSON`);
      return state.registry;
    },
    writeRegistry: async (r) => {
      state.registry = r;
    },
    readRegistrySync: () => {
      if (state.unreadable) throw new RegistryUnreadableError(`${DEVICES_FILENAME} is not valid JSON`);
      return state.registry;
    },
  };
  return { io, state };
}

const PAIRED: PairedRegistry = { devices: [{ label: "pixel", tokenHash: sha256Hex(PHONE), createdAt: T0, lastSeenAt: T0 }] };

/** One bridge's worth of pair-request state on a fake clock: the book, a real store, the audit trail. */
function rig(opts: { registry?: PairedRegistry; isPeer?: boolean; withStore?: boolean } = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const mem = memoryIo(structuredClone(opts.registry ?? PAIRED));
  const store = new PairingStore(mem.io, now);
  const book = new PairRequestBook(now);
  const audits: AuditEntry[] = [];
  const revoked: string[] = [];
  const deps: PairRequestDeps = {
    book,
    pairing: opts.withStore === false ? undefined : store,
    // By hash, as server.ts does; the label it removed is what the cases read back.
    revoke: async (tokenHash) => {
      const label = await store.revokeByTokenHash(tokenHash);
      if (label !== null) revoked.push(label);
    },
    audit: (e) => audits.push(e),
    isPeer: opts.isPeer ?? false,
  };
  return { clock, mem, store, book, audits, revoked, deps };
}

type Rig = ReturnType<typeof rig>;

async function body(res: Response): Promise<Record<string, JsonValue>> {
  // SAFETY: every handler here answers a JSON object (pinned by the `content-type` checks below).
  return (await res.json()) as Record<string, JsonValue>;
}

async function create(r: Rig, source = "192.0.2.9", ua: string | null = CHROME_LINUX) {
  const res = await pairRequestCreateRoute(r.deps, { source, route: TAILNET, userAgent: ua });
  return { res, json: await body(res) };
}

/** A request the bridge made, as its creator reads it. */
type Made = {
  publicId: string;
  pollSecret: string;
  code: string;
  expiresAt: number;
  expiresInMs: number;
};

async function made(r: Rig, source?: string): Promise<Made> {
  const { res, json } = await create(r, source);
  expect(res.status).toBe(200);
  // SAFETY: a 200 from the create route carries these five fields (pinned field by field above).
  return json as Made;
}

async function poll(r: Rig, id: string, secret: string | null) {
  const res = await pairRequestPollRoute(r.deps, id, secret);
  return { status: res.status, json: await body(res) };
}

const APPROVER = { approver: "pixel", approverRoute: { route: "loopback", forwarded: "tailnet" } } as const;

async function approve(r: Rig, id: string, payload: JsonValue) {
  const res = await pairApproveAnswerRoute(r.deps, id, payload, APPROVER);
  return { status: res.status, json: await body(res) };
}

// ── The asker as the approver sees it ────────────────────────────────────────────────────────

describe("askerFromUserAgent", () => {
  test("names the browser and system family from a fixed list", () => {
    expect(askerFromUserAgent(CHROME_LINUX)).toEqual({ browser: "Chrome", os: "Linux" });
    expect(
      askerFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toEqual({ browser: "Safari", os: "iOS" });
    expect(askerFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0")).toEqual({ browser: "Firefox", os: "Windows" });
    expect(
      askerFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"),
    ).toEqual({ browser: "Edge", os: "Windows" });
    expect(
      askerFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"),
    ).toEqual({ browser: "Safari", os: "macOS" });
    expect(askerFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36")).toEqual({
      browser: "Chrome",
      os: "Android",
    });
  });

  test("never passes the raw header on: text it does not know reads as null", () => {
    expect(askerFromUserAgent(null)).toEqual({ browser: null, os: null });
    expect(askerFromUserAgent("<script>alert(1)</script> ‮ EvilBrowser/1.0")).toEqual({ browser: null, os: null });
    expect(askerFromUserAgent("curl/8.9.1")).toEqual({ browser: null, os: null });
  });
});

// ── The code and its decoys ──────────────────────────────────────────────────────────────────

describe("makeChoices", () => {
  test("three distinct codes from the alphabet, one of them the real one, every pair at least 3 apart", () => {
    const positions = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const { code, choices } = makeChoices();
      expect(choices).toHaveLength(3);
      expect(choices).toContain(code);
      positions.add(choices.indexOf(code));
      for (const c of choices) {
        expect(c).toHaveLength(REQUEST_CODE_LENGTH);
        for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
      }
      for (let a = 0; a < 3; a++) {
        for (let b = a + 1; b < 3; b++) expect(codeDistance(choices[a]!, choices[b]!)).toBeGreaterThanOrEqual(DECOY_MIN_DISTANCE);
      }
    }
    // The real code is not always in one place.
    expect([...positions].toSorted()).toEqual([0, 1, 2]);
  });

  test("a random source that cannot make a far decoy is loud, never a near one", () => {
    // Every draw is the same bytes, so every decoy equals the code.
    expect(() => makeChoices((n) => Buffer.alloc(n, 7))).toThrow("could not draw decoys");
  });

  test("codeDistance counts differing positions", () => {
    expect(codeDistance("ABCDEF", "ABCDEF")).toBe(0);
    expect(codeDistance("ABCDEF", "ABCXYZ")).toBe(3);
    expect(codeDistance("ABC", "ABCD")).toBe(1);
  });
});

// ── Making a request ─────────────────────────────────────────────────────────────────────────

describe("POST /api/pair/request", () => {
  test("answers the ids, the code and the expiry, and audits the route alone", async () => {
    const r = rig();
    const { res, json } = await create(r);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(String(json.publicId)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(String(json.pollSecret)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(json.publicId).not.toBe(json.pollSecret);
    expect(String(json.code)).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${REQUEST_CODE_LENGTH}}$`));
    expect(json.expiresAt).toBe(T0 + REQUEST_TTL_MS);
    expect(json.expiresInMs).toBe(REQUEST_TTL_MS);
    expect(r.audits).toEqual([{ action: "pair-request", detail: { route: "loopback", forwardedFrom: "tailnet" } }]);
  });

  test("with no paired device nobody can approve: 409 no-approver, and each try still counts", async () => {
    const r = rig({ registry: { devices: [] } });
    for (let i = 0; i < REQUESTS_PER_SOURCE; i++) {
      const { res, json } = await create(r);
      expect(res.status).toBe(409);
      expect(json).toEqual({ error: "no-approver" });
    }
    // The seventh is refused by the source's cap before the registry is asked at all.
    expect((await create(r)).res.status).toBe(429);
    expect(r.book.openCount()).toBe(0);
    expect(r.audits).toEqual([{ action: "pair-request-refused", detail: { reason: "rate" } }]);
  });

  test("a registry whose every device expired has no approver either", async () => {
    const r = rig({ registry: { devices: [{ ...PAIRED.devices[0]!, expiresAt: T0 - 1 }] } });
    expect((await create(r)).res.status).toBe(409);
  });

  test("an unreadable registry is an outage, 503, never no-approver", async () => {
    const r = rig();
    r.mem.state.unreadable = true;
    const res = await pairRequestCreateRoute(r.deps, { source: "a", route: TAILNET, userAgent: null });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  test("at most 3 open in all: the fourth is 429 with retry-after until the soonest ends", async () => {
    const r = rig();
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) await made(r, `192.0.2.${i + 1}`);
    r.clock.now += 30_000;
    const { res, json } = await create(r, "192.0.2.50");
    expect(res.status).toBe(429);
    expect(json.error).toBe("rate-limited");
    expect(res.headers.get("retry-after")).toBe(String((REQUEST_TTL_MS - 30_000) / 1000));
    expect(json.retryAfter).toBe((REQUEST_TTL_MS - 30_000) / 1000);
    expect(r.audits.at(-1)).toEqual({ action: "pair-request-refused", detail: { reason: "rate" } });
    // Once they ran out, a place is free again.
    r.clock.now += REQUEST_TTL_MS;
    expect((await create(r, "192.0.2.50")).res.status).toBe(200);
  });

  test("at most 6 per source in 10 minutes, keyed by the source, audited once per burst", async () => {
    const r = rig();
    for (let i = 0; i < REQUESTS_PER_SOURCE; i++) {
      const m = await made(r, "192.0.2.9");
      // End each one so the global cap is not what refuses.
      await approve(r, m.publicId, { refuse: true });
    }
    const first = await create(r, "192.0.2.9");
    expect(first.res.status).toBe(429);
    expect(Number(first.res.headers.get("retry-after"))).toBe(REQUEST_SOURCE_WINDOW_MS / 1000);
    expect((await create(r, "192.0.2.9")).res.status).toBe(429);
    expect(r.audits.filter((a) => a.action === "pair-request-refused" && a.detail?.reason === "rate")).toHaveLength(1);
    // Another source is not affected.
    expect((await create(r, "192.0.2.10")).res.status).toBe(200);
    // The window slides: past it, the source may ask again.
    r.clock.now += REQUEST_SOURCE_WINDOW_MS;
    expect((await create(r, "192.0.2.9")).res.status).toBe(200);
  });

  test("a crew member serves no browser door: every route answers 404", async () => {
    const r = rig({ isPeer: true });
    expect((await create(r)).res.status).toBe(404);
    expect((await pairRequestPollRoute(r.deps, "x".repeat(22), "y".repeat(22))).status).toBe(404);
    expect((await pairApproveReadRoute(r.deps, "x".repeat(22))).status).toBe(404);
    expect((await pairApproveAnswerRoute(r.deps, "x".repeat(22), { refuse: true }, APPROVER)).status).toBe(404);
    expect(r.audits).toEqual([]);
  });

  test("a bridge with no pairing store answers 503, as /api/pair does", async () => {
    const r = rig({ withStore: false });
    const res = await pairRequestCreateRoute(r.deps, { source: "a", route: TAILNET, userAgent: null });
    expect(res.status).toBe(503);
  });
});

// ── The poll ─────────────────────────────────────────────────────────────────────────────────

describe("GET /api/pair/request/<id>", () => {
  test("a wrong or missing secret reads exactly like an unknown id", async () => {
    const r = rig();
    const m = await made(r);
    const unknown = await poll(r, "A".repeat(22), m.pollSecret);
    const wrong = await poll(r, m.publicId, "B".repeat(22));
    const missing = await poll(r, m.publicId, null);
    const empty = await poll(r, m.publicId, "");
    const malformed = await poll(r, "../../etc", m.pollSecret);
    for (const got of [unknown, wrong, missing, empty, malformed]) expect(got).toEqual({ status: 404, json: { error: "not found" } });
    expect(await poll(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "waiting", expiresInMs: REQUEST_TTL_MS } });
  });

  test("the secret is compared in constant time, against a stand-in when the id is unknown", () => {
    const src = readFileSync(join(import.meta.dir, "pair-request.ts"), "utf8");
    // `poll` and `cancel` both find their entry through `matching`.
    const at = src.indexOf("  private matching(publicId: string, secret: string | null): Entry | null {");
    const method = src.slice(at, src.indexOf("\n  }\n", at));
    expect(method).toContain("hashesEqual(e?.pollHash ?? DUMMY_HASH, given)");
    // The compare runs before any early return on the id.
    expect(method.indexOf("hashesEqual(")).toBeLessThan(method.indexOf("return null"));
    for (const name of ["  poll(publicId", "  cancel(publicId"]) {
      const start = src.indexOf(name);
      expect(src.slice(start, src.indexOf("\n  }\n", start))).toContain("this.matching(publicId, secret)");
    }
    // And the bridge keeps the secret's hash, never the secret.
    expect(src).toContain("pollHash: sha256Hex(pollSecret)");
  });

  test("past two minutes the request is expired, for the poller and the approver, and audited once", async () => {
    const r = rig();
    const m = await made(r);
    r.clock.now += REQUEST_TTL_MS;
    expect(await poll(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "expired" } });
    expect((await pairApproveReadRoute(r.deps, m.publicId)).status).toBe(404);
    expect(await approve(r, m.publicId, { code: m.code, label: "x" })).toEqual({ status: 404, json: { error: "gone" } });
    expect(r.audits.filter((a) => a.action === "pair-request-refused")).toEqual([{ action: "pair-request-refused", detail: { reason: "expired" } }]);
    // The tombstone goes too, and then the id is unknown.
    r.clock.now += TOMBSTONE_MS;
    expect((await poll(r, m.publicId, m.pollSecret)).status).toBe(404);
  });
});

// ── The approver ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/pair/approve/<id>", () => {
  test("shows the asker's families, the route and three choices in an order fixed per request", async () => {
    const r = rig();
    const m = await made(r);
    const first = await body(await pairApproveReadRoute(r.deps, m.publicId));
    expect(first.browser).toBe("Chrome");
    expect(first.os).toBe("Linux");
    expect(first.route).toBe("loopback");
    expect(first.forwardedFrom).toBe("tailnet");
    expect(first.expiresAt).toBe(m.expiresAt);
    expect(first.choices).toContain(m.code);
    expect(first.choices).toHaveLength(3);
    // No secret is on the approver's answer.
    expect(JSON.stringify(first)).not.toContain(m.pollSecret);
    expect(first).not.toHaveProperty("code");
    const again = await body(await pairApproveReadRoute(r.deps, m.publicId));
    expect(again.choices).toEqual(first.choices);
  });

  test("an unknown id is gone (404)", async () => {
    const r = rig();
    expect((await pairApproveReadRoute(r.deps, "Q".repeat(22))).status).toBe(404);
  });
});

describe("POST /api/pair/approve/<id>", () => {
  test("the right code enrols through the store, the token goes to the first poll once, with no expiry", async () => {
    const r = rig();
    const m = await made(r);
    const got = await approve(r, m.publicId, { code: m.code, label: "Chrome on Linux" });
    expect(got).toEqual({ status: 200, json: { state: "approved", label: "Chrome on Linux" } });
    // The approver's answer never holds the token.
    const collected = await poll(r, m.publicId, m.pollSecret);
    expect(collected.status).toBe(200);
    expect(collected.json.state).toBe("approved");
    expect(collected.json.label).toBe("Chrome on Linux");
    const token = String(collected.json.token);
    expect(token.length).toBeGreaterThanOrEqual(43);
    // The registry holds the hash only, and the entry has no expiry key (as `collie pair` without --expires).
    const registry = coerceRegistry(r.mem.state.registry);
    const entry = registry.devices.find((d) => d.label === "Chrome on Linux")!;
    expect(entry.tokenHash).toBe(sha256Hex(token));
    expect(entry).not.toHaveProperty("expiresAt");
    expect(JSON.stringify(r.mem.state.registry)).not.toContain(token);
    // The new token works at the gate the same way a claimed one does.
    expect(r.store.resolve(token)?.label).toBe("Chrome on Linux");
    // Once: the next poll is an unknown id.
    expect((await poll(r, m.publicId, m.pollSecret)).status).toBe(404);
    expect(r.audits.at(-1)).toEqual({
      action: "pair-approve",
      device: "pixel",
      detail: {
        approver: "pixel",
        label: "Chrome on Linux",
        route: "loopback",
        forwardedFrom: "tailnet",
        approverRoute: "loopback",
        approverForwardedFrom: "tailnet",
      },
    });
  });

  test("the code is matched however the approver's client spelled its case", async () => {
    const r = rig();
    const m = await made(r);
    expect((await approve(r, m.publicId, { code: m.code.toLowerCase(), label: "desk" })).json.state).toBe("approved");
  });

  test("a wrong code ends the request for good: refused, audited, and a second answer is 409", async () => {
    const r = rig();
    const m = await made(r);
    const view = await body(await pairApproveReadRoute(r.deps, m.publicId));
    // SAFETY: the approver's answer carries `choices` as an array of three strings (pinned above).
    const decoy = (view.choices as string[]).find((c) => c !== m.code)!;
    expect(await approve(r, m.publicId, { code: decoy, label: "desk" })).toEqual({ status: 200, json: { state: "refused", reason: "wrong-code" } });
    expect(await approve(r, m.publicId, { code: m.code, label: "desk" })).toEqual({ status: 409, json: { error: "answered" } });
    expect((await pairApproveReadRoute(r.deps, m.publicId)).status).toBe(409);
    expect(await poll(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "refused" } });
    expect(coerceRegistry(r.mem.state.registry).devices.map((d) => d.label)).toEqual(["pixel"]);
    expect(r.audits.at(-1)).toEqual({ action: "pair-request-refused", device: "pixel", detail: { reason: "wrong-code" } });
  });

  test("Not my device ends it too", async () => {
    const r = rig();
    const m = await made(r);
    expect(await approve(r, m.publicId, { refuse: true })).toEqual({ status: 200, json: { state: "refused", reason: "refused" } });
    expect(await approve(r, m.publicId, { refuse: true })).toEqual({ status: 409, json: { error: "answered" } });
    expect(await poll(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "refused" } });
    expect(r.audits.at(-1)).toEqual({ action: "pair-request-refused", device: "pixel", detail: { reason: "refused" } });
  });

  test("one answer per request, also when two arrive at once", async () => {
    const r = rig();
    const m = await made(r);
    const [a, b] = await Promise.all([approve(r, m.publicId, { code: m.code, label: "one" }), approve(r, m.publicId, { code: m.code, label: "two" })]);
    expect([a.status, b.status].toSorted()).toEqual([200, 409]);
    expect(coerceRegistry(r.mem.state.registry).devices).toHaveLength(2);
  });

  test("a bad name is the approver's to fix: 400, and the request keeps its one answer", async () => {
    const r = rig();
    const m = await made(r);
    for (const label of ["", "   ", "x".repeat(49), "evil‮name", 42, undefined]) {
      expect(await approve(r, m.publicId, { code: m.code, label: label ?? null })).toEqual({ status: 400, json: { error: "bad-label" } });
    }
    expect(await approve(r, m.publicId, "nonsense")).toEqual({ status: 400, json: { error: "bad-request" } });
    expect(await approve(r, m.publicId, { code: 7, label: "desk" })).toEqual({ status: 400, json: { error: "bad-request" } });
    expect((await approve(r, m.publicId, { code: m.code, label: "desk" })).json.state).toBe("approved");
  });

  test("a name a device holds gets a number, live or expired, and is never replaced", async () => {
    const r = rig({
      registry: {
        devices: [
          ...PAIRED.devices,
          { label: "Chrome on Linux", tokenHash: sha256Hex("a"), createdAt: T0, lastSeenAt: T0 },
          { label: "Chrome on Linux 2", tokenHash: sha256Hex("b"), createdAt: T0, lastSeenAt: T0, expiresAt: T0 - 1 },
        ],
      },
    });
    const m = await made(r);
    expect((await approve(r, m.publicId, { code: m.code, label: "Chrome on Linux" })).json.label).toBe("Chrome on Linux 3");
    expect(coerceRegistry(r.mem.state.registry).devices.map((d) => d.label)).toEqual([
      "pixel",
      "Chrome on Linux",
      "Chrome on Linux 2",
      "Chrome on Linux 3",
    ]);
  });

  test("an unreadable registry writes nothing and leaves the request open for another tap", async () => {
    const r = rig();
    const m = await made(r);
    r.mem.state.unreadable = true;
    expect((await pairApproveAnswerRoute(r.deps, m.publicId, { code: m.code, label: "desk" }, APPROVER)).status).toBe(503);
    r.mem.state.unreadable = false;
    expect((await approve(r, m.publicId, { code: m.code, label: "desk" })).json.state).toBe("approved");
  });

  test("a token nobody collected is revoked when its window ends, and never handed out after", async () => {
    const r = rig();
    const m = await made(r);
    await approve(r, m.publicId, { code: m.code, label: "desk" });
    r.clock.now += Math.max(REQUEST_TTL_MS, COLLECT_GRACE_MS);
    await settlePairRequests(r.deps);
    expect(r.revoked).toEqual(["desk"]);
    expect(coerceRegistry(r.mem.state.registry).devices.map((d) => d.label)).toEqual(["pixel"]);
    expect(await poll(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "expired" } });
  });

  test("an approval late in the window still leaves the new device the grace to collect", async () => {
    const r = rig();
    const m = await made(r);
    r.clock.now += REQUEST_TTL_MS - 1_000;
    await approve(r, m.publicId, { code: m.code, label: "desk" });
    r.clock.now += 5_000;
    expect((await poll(r, m.publicId, m.pollSecret)).json.state).toBe("approved");
    expect(r.revoked).toEqual([]);
  });
});

// ── The approver's gate: guard at pairApproveGateLevel, the trick switch's rule ─────────────────

describe("the approver's gate", () => {
  const secret = mintLocalSecret();
  const credential = localCredentialOf(secret);
  const cfg = (overrides: Partial<Config> = {}): Config => ({ ...loadConfig({ HOME: "/tmp/collie-pair-request-home" }), ...overrides });

  function gateFor(r: Rig) {
    return browserPairingGate(r.store, credential, () => "127.0.0.1", "127.0.0.1");
  }

  function request(method: string, headers: Record<string, string>): Request {
    const all = new Headers({ host: "127.0.0.1:8787", ...headers });
    // A browser sends `Origin` on a POST and none on a same-origin GET.
    if (method === "POST") all.set("origin", "http://127.0.0.1:8787");
    return new Request("http://127.0.0.1:8787/api/pair/approve/x", { method, headers: all });
  }

  test("GET reads as a device-read and POST as a write", () => {
    expect(pairApproveGateLevel("GET")).toBe("device-read");
    expect(pairApproveGateLevel("POST")).toBe("write");
  });

  for (const method of ["GET", "POST"]) {
    test(`${method}: a paired device token passes`, () => {
      const r = rig();
      expect(guard(request(method, { authorization: `Bearer ${PHONE}` }), cfg(), pairApproveGateLevel(method), gateFor(r))).toBeNull();
    });

    test(`${method}: the host's local read credential is refused`, async () => {
      const r = rig();
      const denied = guard(request(method, { authorization: `Bearer ${secret}` }), cfg(), pairApproveGateLevel(method), gateFor(r));
      expect(denied?.status).toBe(403);
      expect(await denied!.text()).toBe("device not paired");
    });

    test(`${method}: an unpaired browser is refused`, () => {
      const r = rig();
      expect(guard(request(method, {}), cfg(), pairApproveGateLevel(method), gateFor(r))?.status).toBe(403);
      expect(guard(request(method, { authorization: "Bearer not-a-token" }), cfg(), pairApproveGateLevel(method), gateFor(r))?.status).toBe(403);
    });

    test(`${method}: a header-allowlisted device with no token is refused`, () => {
      const r = rig();
      const config = cfg({ deviceHeader: "x-device", deviceAllowlist: ["desk"] });
      expect(guard(request(method, { "x-device": "desk" }), config, pairApproveGateLevel(method), gateFor(r))?.status).toBe(403);
      // And a paired token on a device the header gate does not list is refused too: the gates compose by AND.
      expect(guard(request(method, { "x-device": "other", authorization: `Bearer ${PHONE}` }), config, pairApproveGateLevel(method), gateFor(r))?.status).toBe(403);
      expect(guard(request(method, { "x-device": "desk", authorization: `Bearer ${PHONE}` }), config, pairApproveGateLevel(method), gateFor(r))).toBeNull();
    });

    test(`${method}: a crew forward never carries the token, so it is refused`, () => {
      const r = rig();
      const phone = request(method, { authorization: `Bearer ${PHONE}` });
      const forwarded = new Request("http://127.0.0.1:8787/api/pair/approve/x", {
        method,
        headers: { host: "127.0.0.1:8787", ...Object.fromEntries(forwardHeaders(phone, "pixel")) },
      });
      expect(forwarded.headers.get("authorization")).toBeNull();
      expect(guard(forwarded, cfg(), pairApproveGateLevel(method), gateFor(r))?.status).toBe(403);
    });

    test(`${method}: an expired device's token is refused`, async () => {
      const r = rig({ registry: { devices: [{ ...PAIRED.devices[0]!, expiresAt: T0 - 1 }] } });
      const denied = guard(request(method, { authorization: `Bearer ${PHONE}` }), cfg(), pairApproveGateLevel(method), browserPairingGate(r.store, credential, () => "127.0.0.1", "127.0.0.1"));
      expect(denied?.status).toBe(403);
    });
  }

  test("POST from another host without an Origin is refused, as every write is", () => {
    const r = rig();
    const req = new Request("http://collie.example.ts.net/api/pair/approve/x", {
      method: "POST",
      headers: { host: "collie.example.ts.net", authorization: `Bearer ${PHONE}` },
    });
    expect(guard(req, cfg({ publicHosts: ["collie.example.ts.net"] }), "write", gateFor(r))?.status).toBe(403);
  });
});

// ── What never reaches the audit log ─────────────────────────────────────────────────────────

describe("no secret in the audit trail", () => {
  test("a full run, approved, refused, wrong and expired, writes no code, id, secret or token", async () => {
    const r = rig();
    const secrets: string[] = [];
    const remember = (m: { publicId: string; pollSecret: string; code: string }) => secrets.push(m.publicId, m.pollSecret, m.code);

    const a = await made(r, "s1");
    remember(a);
    const view = await body(await pairApproveReadRoute(r.deps, a.publicId));
    // SAFETY: the approver's answer carries `choices` as an array of three strings.
    secrets.push(...(view.choices as string[]));
    await approve(r, a.publicId, { code: a.code, label: "desk" });
    const collected = await poll(r, a.publicId, a.pollSecret);
    secrets.push(String(collected.json.token));

    const b = await made(r, "s2");
    remember(b);
    await approve(r, b.publicId, { refuse: true });
    const c = await made(r, "s3");
    remember(c);
    await approve(r, c.publicId, { code: "ZZZZZZ", label: "x" });
    const d = await made(r, "s4");
    remember(d);
    r.clock.now += REQUEST_TTL_MS;
    await settlePairRequests(r.deps);

    expect(r.audits.map((e) => e.action).toSorted()).toEqual(
      ["pair-request", "pair-request", "pair-request", "pair-request", "pair-approve", "pair-request-refused", "pair-request-refused", "pair-request-refused"].toSorted(),
    );
    for (const entry of r.audits) {
      for (const content of ["preview", "none"] as const) {
        const line = formatAuditLine(entry, T0, content);
        for (const s of secrets) expect({ line, leaked: line.includes(s) }).toEqual({ line, leaked: false });
      }
    }
  });

  test("no log line in the module can print a secret: its only console call names an error", () => {
    const src = readFileSync(join(import.meta.dir, "pair-request.ts"), "utf8");
    const calls = src.split("console.").slice(1).map((rest) => rest.slice(0, rest.indexOf(");")));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("could not revoke an uncollected device");
    for (const word of ["token", "code", "secret", "publicId"]) expect(calls[0]).not.toContain(`\${${word}`);
  });
});

// ── The book's own bounds ────────────────────────────────────────────────────────────────────

describe("PairRequestBook", () => {
  test("tombstones are bounded, oldest first", () => {
    const clock = { now: T0 };
    // A limiter that never refuses, so the bound is what is tested.
    const book = new PairRequestBook(() => clock.now, randomBytes, createPairLimiter(10_000, 1), 10_000);
    for (let i = 0; i < MAX_TOMBSTONES + 20; i++) {
      const one = book.create({ source: `s${i}`, route: { route: "loopback" }, asker: { browser: null, os: null } });
      if (!one.ok) throw new Error("refused");
      const taken = book.take(one.publicId);
      expect(taken.kind).toBe("taken");
      book.refuse(one.publicId);
      clock.now += 1;
    }
    book.sweep();
    expect(book.size()).toBe(MAX_TOMBSTONES);
    expect(book.openCount()).toBe(0);
  });

  test("the limiter says how long until the oldest attempt leaves the window", () => {
    const limiter = createPairLimiter(2, 60_000);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("a", 10_000).allowed).toBe(true);
    expect(limiter.hit("a", 15_000)).toEqual({ allowed: false, first: true, retryAfterMs: 45_000 });
  });

  test("parseApproveBody takes a refusal or a code, and nothing else", () => {
    expect(parseApproveBody({ refuse: true })).toEqual({ kind: "refuse" });
    expect(parseApproveBody({ refuse: "yes" })).toBeNull();
    expect(parseApproveBody({ code: "ABCDEF", label: "x" })).toEqual({ kind: "answer", code: "ABCDEF", label: "x" });
    expect(parseApproveBody({ code: "A".repeat(33), label: "x" })).toBeNull();
    expect(parseApproveBody(null)).toBeNull();
    expect(parseApproveBody(["ABCDEF"])).toBeNull();
  });

  test("uniqueLabel keeps a free name and cuts a long one to fit its number", () => {
    const reg = (labels: string[]): PairedRegistry => ({ devices: labels.map((label) => ({ label, tokenHash: sha256Hex(label), createdAt: 0, lastSeenAt: 0 })) });
    expect(uniqueLabel(reg([]), "desk")).toBe("desk");
    expect(uniqueLabel(reg(["desk"]), "desk")).toBe("desk 2");
    const long = "x".repeat(48);
    const next = uniqueLabel(reg([long]), long);
    expect(next).toHaveLength(48);
    expect(next.endsWith(" 2")).toBe(true);
  });
});

// ── Review round (lead, 2026-11-11): N2, N3, N4, A2, A5, A7 ──────────────────────────────────

async function cancel(r: Rig, id: string, secret: string | null) {
  const res = await pairRequestCancelRoute(r.deps, id, secret);
  return { status: res.status, json: await body(res) };
}

describe("N3: sources are keyed by /64, and the global caps hold", () => {
  test("an IPv6 address is cut to its /64; IPv4, mapped IPv4 and loopback pass unchanged", () => {
    expect(requestSourceKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(requestSourceKey("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(requestSourceKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(requestSourceKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(requestSourceKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(requestSourceKey("192.0.2.9")).toBe("192.0.2.9");
    expect(requestSourceKey("loopback")).toBe("loopback");
    expect(requestSourceKey("not an address")).toBe("not an address");
  });

  test("addresses in one /64 share the cap of six", async () => {
    const r = rig();
    for (let i = 0; i < REQUESTS_PER_SOURCE; i++) expect((await create(r, `2001:db8:1:2::${i + 1}`)).res.status).toBe(200);
    expect((await create(r, "2001:db8:1:2:ffff::7")).res.status).toBe(429);
    expect((await create(r, "2001:db8:1:3::1")).res.status).toBe(200);
  });

  test(`at most ${REQUESTS_PER_WINDOW} requests in ten minutes, whatever the source, and one audit line for the burst`, async () => {
    const r = rig();
    for (let i = 0; i < REQUESTS_PER_WINDOW; i++) {
      const m = await made(r, `10.0.${Math.floor(i / 200)}.${i % 200}`);
      await cancel(r, m.publicId, m.pollSecret);
    }
    for (let i = 0; i < 5; i++) {
      const refused = await create(r, `10.9.9.${i}`);
      expect(refused.res.status).toBe(429);
      expect(Number(refused.res.headers.get("retry-after"))).toBe(600);
    }
    expect(r.audits.filter((a) => a.detail?.reason === "rate")).toHaveLength(1);
    r.clock.now += 600_000;
    expect((await create(r, "10.9.9.9")).res.status).toBe(200);
  });

  test("the open cap's refusals are audited once per window, not once each", async () => {
    const r = rig();
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) await made(r, `192.0.2.${i + 1}`);
    for (let i = 0; i < 5; i++) expect((await create(r, `100.64.1.${i}`)).res.status).toBe(429);
    expect(r.audits.filter((a) => a.detail?.reason === "rate")).toHaveLength(1);
  });
});

describe("N4: cancel, and one open request per source", () => {
  test("DELETE with the secret ends the request: audited, the poll reads expired, the approver gone", async () => {
    const r = rig();
    const m = await made(r);
    expect(await cancel(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "cancelled" } });
    expect(r.audits.at(-1)).toEqual({ action: "pair-request-refused", detail: { reason: "cancelled" } });
    expect(await poll(r, m.publicId, m.pollSecret)).toEqual({ status: 200, json: { state: "expired" } });
    expect((await pairApproveReadRoute(r.deps, m.publicId)).status).toBe(404);
    expect(r.book.openCount()).toBe(0);
    // A second cancel finds an ended request: no second audit line.
    expect((await cancel(r, m.publicId, m.pollSecret)).status).toBe(200);
    expect(r.audits.filter((a) => a.detail?.reason === "cancelled")).toHaveLength(1);
  });

  test("a wrong, missing or empty secret, or an unknown id, is the same 404, and changes nothing", async () => {
    const r = rig();
    const m = await made(r);
    for (const [id, secret] of [
      [m.publicId, "B".repeat(22)],
      [m.publicId, null],
      [m.publicId, ""],
      ["A".repeat(22), m.pollSecret],
    ] as const) {
      expect(await cancel(r, id, secret)).toEqual({ status: 404, json: { error: "not found" } });
    }
    expect((await poll(r, m.publicId, m.pollSecret)).json.state).toBe("waiting");
  });

  test("a cancel after the approval revokes the device nobody will collect", async () => {
    const r = rig();
    const m = await made(r);
    await approve(r, m.publicId, { code: m.code, label: "desk" });
    await cancel(r, m.publicId, m.pollSecret);
    expect(r.revoked).toEqual(["desk"]);
    expect(coerceRegistry(r.mem.state.registry).devices.map((d) => d.label)).toEqual(["pixel"]);
  });

  test("a crew member answers the cancel with 404", async () => {
    const r = rig({ isPeer: true });
    expect((await cancel(r, "x".repeat(22), "y".repeat(22))).status).toBe(404);
  });

  test("a new request from the same source replaces its open one", async () => {
    const r = rig();
    const first = await made(r, "192.0.2.9");
    const second = await made(r, "192.0.2.9");
    expect(r.book.openCount()).toBe(1);
    expect(await poll(r, first.publicId, first.pollSecret)).toEqual({ status: 200, json: { state: "expired" } });
    expect((await poll(r, second.publicId, second.pollSecret)).json.state).toBe("waiting");
    expect(r.audits.filter((a) => a.detail?.reason === "replaced")).toHaveLength(1);
  });

  test("so three Cancels in a row never fill the open cap", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) await made(r, "192.0.2.9");
    expect(r.book.openCount()).toBe(1);
  });

  test("a replaced request whose device was approved and not collected takes that device with it", async () => {
    const r = rig();
    const first = await made(r, "192.0.2.9");
    await approve(r, first.publicId, { code: first.code, label: "desk" });
    await made(r, "192.0.2.9");
    expect(r.revoked).toEqual(["desk"]);
  });

  test("an enrol that finishes after the request ended leaves no device behind", async () => {
    const r = rig();
    const m = await made(r);
    // The asker cancels while the approver's enrol is in the registry queue.
    const original = r.store.enrolApproved.bind(r.store);
    r.store.enrolApproved = async (label, expiresAt) => {
      await cancel(r, m.publicId, m.pollSecret);
      return original(label, expiresAt);
    };
    expect(await approve(r, m.publicId, { code: m.code, label: "desk" })).toEqual({ status: 404, json: { error: "gone" } });
    expect(r.revoked).toEqual(["desk"]);
    expect(coerceRegistry(r.mem.state.registry).devices.map((d) => d.label)).toEqual(["pixel"]);
    expect(r.audits.some((a) => a.action === "pair-approve")).toBe(false);
  });
});

describe("A7: a hung answer does not hold its place", () => {
  test("the sweep ends an `answering` request past its expiry and the margin", () => {
    const clock = { now: T0 };
    const book = new PairRequestBook(() => clock.now);
    const one = book.create({ source: "a", route: { route: "loopback" }, asker: { browser: null, os: null } });
    if (!one.ok) throw new Error("refused");
    expect(book.take(one.publicId).kind).toBe("taken");
    clock.now += REQUEST_TTL_MS;
    expect(book.sweep().expired).toBe(0);
    expect(book.openCount()).toBe(1);
    clock.now += ANSWER_MARGIN_MS;
    expect(book.sweep().expired).toBe(1);
    expect(book.openCount()).toBe(0);
    // And the late approve is refused, so the route revokes what it made.
    expect(book.approve(one.publicId, "tok", "desk")).toBe(false);
  });
});

describe("N2: the new device ends with its approver", () => {
  const ENDS = T0 + 30 * 86_400_000;

  test("the read names the approver's end; the enrolled device carries it", async () => {
    const r = rig();
    const m = await made(r);
    const view = await body(await pairApproveReadRoute(r.deps, m.publicId, { approverExpiresAt: ENDS }));
    expect(view.endsAt).toBe(ENDS);
    const res = await pairApproveAnswerRoute(r.deps, m.publicId, { code: m.code, label: "desk" }, { ...APPROVER, approverExpiresAt: ENDS });
    expect(res.status).toBe(200);
    const desk = coerceRegistry(r.mem.state.registry).devices.find((d) => d.label === "desk")!;
    expect(desk.expiresAt).toBe(ENDS);
  });

  test("an approver with no end gives none, and the read says null", async () => {
    const r = rig();
    const m = await made(r);
    expect((await body(await pairApproveReadRoute(r.deps, m.publicId))).endsAt).toBeNull();
    await approve(r, m.publicId, { code: m.code, label: "desk" });
    expect(coerceRegistry(r.mem.state.registry).devices.find((d) => d.label === "desk")).not.toHaveProperty("expiresAt");
  });
});

describe("A5: an uncollected device is revoked by its token's hash", () => {
  test("a device that took the label in between is not the one removed", async () => {
    const r = rig();
    const m = await made(r);
    await approve(r, m.publicId, { code: m.code, label: "desk" });
    // Somebody revokes "desk" by hand and pairs another device under the same name.
    await r.store.revoke("desk");
    const other = sha256Hex("tok-other");
    r.mem.state.registry = { devices: [...coerceRegistry(r.mem.state.registry).devices, { label: "desk", tokenHash: other, createdAt: T0, lastSeenAt: T0 }] };
    r.clock.now += REQUEST_TTL_MS;
    await settlePairRequests(r.deps);
    expect(r.revoked).toEqual([]);
    expect(coerceRegistry(r.mem.state.registry).devices.find((d) => d.label === "desk")?.tokenHash).toBe(other);
  });

  test("server.ts revokes through one path: the device list and the sweep share `deviceRevoked`", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(src).toContain("const deviceRevoked = async (label: string");
    expect(src).toContain("await pairing.revokeByTokenHash(tokenHash)");
    expect(src).toContain('await deviceRevoked(label, undefined, "never-collected")');
    expect(src).toContain("await deviceRevoked(label, whois(req).device)");
    // The body names the watch once, so the label is not reported a second time.
    const at = src.indexOf("const deviceRevoked = async");
    const fn = src.slice(at, src.indexOf("\n  };\n", at));
    expect(fn).toContain('forgetDevice(label, "device-revoked")');
    expect(fn).toContain("revokeWatch(pairedLabels())");
  });

  test("server.ts routes DELETE of a request to the cancel, behind the write's access rule", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const at = src.indexOf('if (pairRequestMatch && req.method === "DELETE")');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("\n      }\n", at));
    expect(block).toContain('checkAccess(req, cfg, "write")');
    expect(block).toContain("pairRequestCancelRoute(pairRequestDeps, pairRequestMatch[1]!, req.headers.get(POLL_HEADER))");
  });
});

