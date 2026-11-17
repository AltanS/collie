import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config } from "./config.ts";
import { localCredentialOf, mintLocalSecret } from "./local-secret.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { DEVICES_FILENAME, filePairingIo, PairingStore, sha256Hex } from "./pairing.ts";
import {
  apiFrontGate,
  browserPairingGate,
  hostInterfaceAddresses,
  isConcreteNonLoopbackBind,
  isLocalRequest,
  isSameHostPeer,
  normalizePeerAddress,
  guard,
  isOpenApiRoute,
  OPEN_API_PATTERNS,
  OPEN_API_ROUTES,
  paneGateLevel,
  type PairingGate,
  requestDevice,
} from "./server.ts";
import { HILL_ANSWER_RIGHT } from "./hill/parse.ts";
import { isLocalKeyRoute, LOCAL_KEY_ROUTES } from "./local-key.ts";
import { TRICKS_ROUTE_RIGHTS } from "./tricks/routes.ts";
import { MUX_LOGO_PATH, OPERATOR_FONTS_PATH } from "./types.ts";

// ── DENY BY DEFAULT, PINNED (ADR 0086) ────────────────────────────────────────────────────────
// `apiFrontGate` is the one pairing check in front of the whole `/api/` dispatcher. These tests hold
// it to three promises: every `/api/` path `bridge/server.ts` names is refused without a token, the
// allowlist is exactly `GET|HEAD /api/health`, `POST /api/pair` and the pairing request with its poll
// (ADR 0139), and no spelling of a path reaches a route without passing the same check the route would. `Bun.serve` is not stood up for the real
// dispatcher (CLAUDE.md), so its wiring is pinned by source below, as access-jwt.test.ts pins its own.

const SERVER_SRC = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

/** The source with comment lines dropped, so prose that names a path is not mistaken for a route. */
const SERVER_CODE = SERVER_SRC.split("\n")
  .filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  })
  .join("\n");

const TOKEN = "tok-phone-placeholder";

const tempDirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-front-gate-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** A real config, as `loadConfig` builds it, so the access gate runs with the product's defaults. */
function config(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ HOME: "/tmp/collie-front-gate-home" }), ...overrides };
}

/** A real store over a real state dir: one paired device, or an empty registry (no file at all). */
async function storeWith(paired: boolean): Promise<{ store: PairingStore; dir: string }> {
  const dir = await stateDir();
  if (paired) {
    // Seen just now, so no request here schedules a `lastSeenAt` write that could race a test's own
    // write of the file (the stamp is throttled to once a minute).
    const now = Date.now();
    const registry = { devices: [{ label: "phone", tokenHash: sha256Hex(TOKEN), createdAt: now, lastSeenAt: now }] };
    await writeFile(join(dir, DEVICES_FILENAME), JSON.stringify(registry));
  }
  return { store: new PairingStore(filePairingIo(dir)), dir };
}

/** A request as the front door forwards it: loopback Host, no Origin, optional token. */
function request(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8787${path}`, { method, headers: { host: "127.0.0.1:8787", ...headers } });
}

// ── The route table, read off the source ───────────────────────────────────────────────────────

/** Every `"/api/…"` string literal in server.ts's code. */
function literalPaths(): string[] {
  return [...new Set([...SERVER_CODE.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]!))];
}

/** Every route regex in server.ts (`/^\/api\/…$/`), as its source text. */
function routeRegexSources(): string[] {
  return [...new Set([...SERVER_CODE.matchAll(/\/(\^\\\/api\\\/[^\s;]*?\$)\//g)].map((m) => m[1]!))];
}

/**
 * Concrete paths a route regex matches, one per alternative: `([^/]+)` becomes an id, an optional
 * `(?:\/(a|b))?` becomes none, `/a` and `/b`, and a group `(a|b)` becomes `a` and `b`. Each sample is
 * checked against the regex itself in the test, so a shape this expander gets wrong fails loudly.
 */
function samplesOf(source: string): string[] {
  let variants = [source.replace(/^\^/, "").replace(/\$$/, "").replaceAll("([^/]+)", "id1")];
  const expand = (re: RegExp, alts: (inner: string) => string[]): void => {
    let changed = true;
    while (changed) {
      changed = false;
      const next: string[] = [];
      for (const v of variants) {
        const m = re.exec(v);
        if (m === null) {
          next.push(v);
          continue;
        }
        changed = true;
        for (const alt of alts(m[1]!)) next.push(v.slice(0, m.index) + alt + v.slice(m.index + m[0].length));
      }
      variants = next;
    }
  };
  expand(/\(\?:\\\/\(([^()]*)\)\)\?/, (inner) => ["", ...inner.split("|").map((a) => `\\/${a}`)]);
  expand(/\(([^()?]*)\)/, (inner) => inner.split("|"));
  return variants.map((v) => v.replaceAll("\\/", "/").replaceAll("\\.", "."));
}

/** Every concrete `/api/` path the dispatcher can route, plus the two named by constant. */
function everyApiPath(): string[] {
  const fromRegex = routeRegexSources().flatMap(samplesOf);
  const byConstant = [MUX_LOGO_PATH, `${OPERATOR_FONTS_PATH}face.woff2`];
  return [...new Set([...literalPaths(), ...fromRegex, ...byConstant])].toSorted();
}

describe("the route table read off server.ts", () => {
  test("the scan finds the routes it must, so it can never pass vacuously", () => {
    const paths = everyApiPath();
    // Negative controls: a scanner that found nothing, or lost the regex routes, fails here.
    expect(paths.length).toBeGreaterThanOrEqual(45);
    for (const known of [
      "/api/snapshot",
      "/api/devices/revoke",
      "/api/pane/id1/reply",
      "/api/pane/id1/subagent/id1",
      "/api/workspace/id1/changes",
      // The Files existence check (ADR 0088): a POST read, refused without a token like every route.
      "/api/pane/id1/files/exist",
      "/api/workspace/id1/files/exist",
      // The Files image read (ADR 0090): bytes off the disk, so a missing token is refused here too.
      "/api/pane/id1/files/image",
      "/api/workspace/id1/files/image",
      // The Claude commands a pane would load: names and descriptions off this disk.
      "/api/pane/id1/claude-commands",
    ]) {
      expect(paths).toContain(known);
    }
    expect(routeRegexSources().length).toBeGreaterThanOrEqual(8);
  });

  test("every sample a route regex expanded to is matched by that regex", () => {
    for (const source of routeRegexSources()) {
      const re = new RegExp(source);
      for (const sample of samplesOf(source)) expect({ source, sample, ok: re.test(sample) }).toEqual({ source, sample, ok: true });
    }
  });

  test("the two constants it adds are routed in server.ts by name", () => {
    expect(SERVER_CODE).toContain("pathname === MUX_LOGO_PATH");
    expect(SERVER_CODE).toContain("pathname.startsWith(OPERATOR_FONTS_PATH)");
  });
});

describe("apiFrontGate: every /api/ path but the allowlist is refused without a token", () => {
  test("the allowlist is GET|HEAD /api/health, POST /api/pair, the pairing request, its poll and its cancel, and nothing else", () => {
    expect(OPEN_API_ROUTES).toEqual([
      { path: "/api/health", methods: ["GET", "HEAD"] },
      { path: "/api/pair", methods: ["POST"] },
      { path: "/api/pair/request", methods: ["POST"] },
    ]);
    expect(OPEN_API_PATTERNS.map((p) => ({ pattern: p.pattern.source, methods: p.methods }))).toEqual([
      { pattern: "^\\/api\\/pair\\/request\\/([^/]+)$", methods: ["GET", "DELETE"] },
    ]);
    expect(isOpenApiRoute("/api/pair", "GET")).toBe(false);
    expect(isOpenApiRoute("/api/health", "POST")).toBe(false);
    expect(isOpenApiRoute("/api/health/", "GET")).toBe(false);
    // The poll (GET) and the cancel (DELETE) are open on one segment, and nothing else is.
    expect(isOpenApiRoute("/api/pair/request/abc", "GET")).toBe(true);
    expect(isOpenApiRoute("/api/pair/request/abc", "DELETE")).toBe(true);
    expect(isOpenApiRoute("/api/pair/request/abc", "POST")).toBe(false);
    expect(isOpenApiRoute("/api/pair/request/abc", "PUT")).toBe(false);
    expect(isOpenApiRoute("/api/pair/request", "DELETE")).toBe(false);
    expect(isOpenApiRoute("/api/pair/request/", "GET")).toBe(false);
    expect(isOpenApiRoute("/api/pair/request/a/b", "GET")).toBe(false);
    expect(isOpenApiRoute("/api/pair/request", "GET")).toBe(false);
    // The approver's routes are never open.
    expect(isOpenApiRoute("/api/pair/approve/abc", "GET")).toBe(false);
    expect(isOpenApiRoute("/api/pair/approve/abc", "POST")).toBe(false);
  });

  for (const paired of [true, false]) {
    test(`${paired ? "a device is paired" : "the registry is empty"}: each path, each method, answers 403`, async () => {
      const { store } = await storeWith(paired);
      const cfg = config();
      let refused = 0;
      for (const path of everyApiPath()) {
        for (const method of ["GET", "POST", "HEAD", "OPTIONS", "DELETE"]) {
          const denied = apiFrontGate(request(method, path), path, cfg, store);
          if (isOpenApiRoute(path, method)) {
            expect({ path, method, gated: denied !== null }).toEqual({ path, method, gated: false });
            continue;
          }
          expect({ path, method, status: denied?.status }).toEqual({ path, method, status: 403 });
          expect(await denied!.text()).toBe("device not paired");
          refused++;
        }
      }
      expect(refused).toBeGreaterThan(200);
    });
  }

  test("a paired device's token passes the front gate on every path; the route then decides", async () => {
    const { store } = await storeWith(true);
    const cfg = config();
    for (const path of everyApiPath()) {
      expect(apiFrontGate(request("GET", path, { authorization: `Bearer ${TOKEN}` }), path, cfg, store)).toBeNull();
    }
  });

  test("a path outside /api/ is not this gate's business", async () => {
    const { store } = await storeWith(true);
    for (const path of ["/", "/index.html", "/assets/app.js", "/crew/v1/hello", "/standby/health", "/api", "//api/snapshot", "/API/snapshot"]) {
      expect(apiFrontGate(request("GET", path), path, config(), store)).toBeNull();
    }
  });
});

describe("the dispatcher's wiring, pinned by source", () => {
  test("apiFrontGate runs after the health route and before every other /api/ route", () => {
    const fetchStart = SERVER_CODE.indexOf("fetch: withHsts(");
    const gateAt = SERVER_CODE.indexOf("apiFrontGate(req, pathname, cfg, pairingGate)", fetchStart);
    expect(fetchStart).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(fetchStart);
    // The only `/api/` literal the fetch handler reads before the gate is the health route's own.
    const before = [...SERVER_CODE.slice(fetchStart, gateAt).matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]);
    expect(before).toEqual(["/api/health"]);
    // Nothing before the gate dispatches into the shared route block or a route regex.
    const head = SERVER_CODE.slice(fetchStart, gateAt);
    expect(head).not.toContain("serveSessionRoute(");
    expect(head).not.toMatch(/_ROUTE\b/);
    // And the first real route comes after it.
    expect(SERVER_CODE.indexOf('pathname === "/api/snapshot"', fetchStart)).toBeGreaterThan(gateAt);
  });
});

// ── Raw request lines, as a client can send them ───────────────────────────────────────────────
// `fetch` would normalise a path before it left this process, so these go over a bare socket. The
// listener derives `pathname` the way the dispatcher does (`new URL(req.url).pathname`) and asks the
// same gate, so what it answers is what the real front door answers before any route runs.

describe("apiFrontGate against raw request lines", () => {
  let server: ReturnType<typeof Bun.serve>;
  let gate: PairingGate;
  const cfg = config();

  beforeAll(async () => {
    gate = (await storeWith(true)).store;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        const denied = apiFrontGate(req, pathname, cfg, gate);
        if (denied) return denied;
        return new Response(`routed ${pathname}`);
      },
    });
  });
  afterAll(() => {
    void server.stop(true);
  });

  /** Send one request line, return the status and body. */
  function raw(line: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const sock = connect(server.port!, "127.0.0.1", () => {
        sock.write(`${line} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? "0");
        resolve({ status, body: buf.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
      });
      sock.on("error", reject);
    });
  }

  test("HEAD and OPTIONS on a gated path are refused", async () => {
    expect((await raw("HEAD /api/snapshot")).status).toBe(403);
    expect((await raw("OPTIONS /api/snapshot")).status).toBe(403);
    // OPTIONS is not on the allowlist even for health: only GET and HEAD are.
    expect((await raw("OPTIONS /api/health")).status).toBe(403);
  });

  test("a doubled slash and a trailing slash are gated, not routed around the gate", async () => {
    expect((await raw("GET /api//x")).status).toBe(403);
    expect((await raw("GET /api//snapshot")).status).toBe(403);
    expect((await raw("GET /api/snapshot/")).status).toBe(403);
    // A trailing slash is not the open route: exact path, exact method.
    expect((await raw("GET /api/health/")).status).toBe(403);
    expect((await raw("POST /api/pair/")).status).toBe(403);
  });

  test("dot segments: Bun normalises them before the gate, so the gate sees the path a route would", async () => {
    // Observed on Bun 1.4: `/api/x/../health` arrives as `/api/health`, an open route, and that is
    // safe because it IS the health route. Encoded dots normalise the same way.
    expect(await raw("GET /api/x/../health")).toEqual({ status: 200, body: "routed /api/health" });
    expect(await raw("GET /api/x/%2e%2e/health")).toEqual({ status: 200, body: "routed /api/health" });
    // Climbing into a gated route through dots is still that gated route.
    expect((await raw("GET /api/x/../snapshot")).status).toBe(403);
    expect((await raw("GET /api/./snapshot")).status).toBe(403);
    // Climbing OUT of /api/ leaves the API altogether: no `/api/` route matches what is left.
    expect(await raw("GET /api/%2e%2e/snapshot")).toEqual({ status: 200, body: "routed /snapshot" });
  });

  test("the invariant over every line: refused, or routed to an open route, or not an /api/ path", async () => {
    const lines = [
      "GET /api/x/../health",
      "GET /api//x",
      "GET /api/snapshot/",
      "GET /api/%2e%2e/snapshot",
      "GET //api/snapshot",
      "GET /API/snapshot",
      "GET /api/pane/w1%3Ap1",
      "GET /api/pane/..%2fsnapshot",
      "POST /api/pair",
      "PUT /api/pair",
      "HEAD /api/health",
    ];
    for (const line of lines) {
      const method = line.split(" ")[0]!;
      const { status, body } = await raw(line);
      if (status === 403) continue;
      const routed = body.replace(/^routed /, "");
      const safe = !routed.startsWith("/api/") || isOpenApiRoute(routed, method);
      expect({ line, routed, safe }).toEqual({ line, routed, safe: true });
    }
  });
});

// ── A registry that cannot be read is an outage, never "nobody is paired" ──────────────────────

describe("guard while paired-devices.json cannot be read", () => {
  const torn = '{"devices":[{"label":"phone","tokenHash":"';

  test("a truncated file answers 503 pairing unavailable with retry-after 5, on a read and on a write", async () => {
    const { store, dir } = await storeWith(true);
    await writeFile(join(dir, DEVICES_FILENAME), torn);
    const cfg = config();
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const [level, headers] of [
      ["read", auth],
      ["write", { ...auth, origin: "http://127.0.0.1:8787" }],
      ["device-read", auth],
    ] as const) {
      const denied = guard(request(level === "write" ? "POST" : "GET", "/api/snapshot", headers), cfg, level, store)!;
      expect({ level, status: denied.status }).toEqual({ level, status: 503 });
      expect(denied.headers.get("retry-after")).toBe("5");
      expect(await denied.text()).toBe("pairing unavailable");
    }
    // No token at all: still unknown, still 503, never the 403 that wipes a phone.
    expect(guard(request("GET", "/api/snapshot"), cfg, "read", store)!.status).toBe(503);
    // And the front gate says the same, for a route it has never heard of too.
    expect(apiFrontGate(request("GET", "/api/nope"), "/api/nope", cfg, store)!.status).toBe(503);
  });

  test("a missing file is the empty registry: 403 device not paired", async () => {
    const { store } = await storeWith(false);
    const denied = guard(request("GET", "/api/snapshot", { authorization: `Bearer ${TOKEN}` }), config(), "read", store)!;
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("device not paired");
  });

  test("the file repaired, the same token passes again: the mtime cache does not pin the error", async () => {
    const { store, dir } = await storeWith(true);
    const whole = await Bun.file(join(dir, DEVICES_FILENAME)).text();
    const cfg = config();
    const read = () => guard(request("GET", "/api/snapshot", { authorization: `Bearer ${TOKEN}` }), cfg, "read", store);
    expect(read()).toBeNull();
    await writeFile(join(dir, DEVICES_FILENAME), torn);
    expect(read()!.status).toBe(503);
    expect(read()!.status).toBe(503);
    await writeFile(join(dir, DEVICES_FILENAME), whole);
    expect(read()).toBeNull();
  });

  test("attribution does not throw while the registry is unreadable: nobody, not authorised", async () => {
    const { store, dir } = await storeWith(true);
    await writeFile(join(dir, DEVICES_FILENAME), torn);
    const who = requestDevice(request("GET", "/api/snapshot", { authorization: `Bearer ${TOKEN}` }), config(), store);
    expect(who).toEqual({ enforced: true, device: null, authorized: false });
  });
});

// ── The host's own read credential (bridge/local-secret.ts) ────────────────────────────────────

describe("the local credential: reads only, from this host through nothing", () => {
  const secret = mintLocalSecret();
  const credential = localCredentialOf(secret);
  const bearer = { authorization: `Bearer ${secret}` };
  const loopback = () => "127.0.0.1";
  // This host's interfaces, as a test names them: never the real ones, so a case cannot pass or fail
  // on the machine it runs on.
  const OWN = new Set(["100.64.10.2", "192.168.1.10", "fd7a:115c:a1e0::8", "fe80::1"]);
  const own = () => OWN;
  /** A lead or a single-machine install: the default bind. */
  const LOOPBACK_BIND = "127.0.0.1";
  /** A crew peer: one concrete tailnet address, nothing on loopback. */
  const CONCRETE_BIND = "100.64.10.2";

  async function gateFrom(
    peer: () => string | null | undefined,
    bindHost = LOOPBACK_BIND,
    paired = true,
    addresses = own,
  ) {
    const { store, dir } = await storeWith(paired);
    return { gate: browserPairingGate(store, credential, peer, bindHost, addresses), dir };
  }

  test("a read from loopback is admitted on either bind, attributed to `local`, never authorised to write", async () => {
    for (const bind of [LOOPBACK_BIND, CONCRETE_BIND]) {
      const { gate } = await gateFrom(loopback, bind);
      expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", gate)).toBeNull();
      expect(apiFrontGate(request("GET", "/api/update/check", bearer), "/api/update/check", config(), gate)).toBeNull();
      expect(requestDevice(request("GET", "/api/snapshot", bearer), config(), gate)).toEqual({
        enforced: true,
        device: "local",
        authorized: false,
      });
      // v4-mapped, IPv6 loopback, and a zone or upper case on either, are loopback too.
      for (const peer of ["::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::1%lo"]) {
        const { gate: g } = await gateFrom(() => peer, bind);
        expect({ bind, peer, gate: guard(request("GET", "/api/snapshot", bearer), config(), "read", g) }).toEqual({
          bind,
          peer,
          gate: null,
        });
      }
    }
  });

  test("on a loopback bind, this host's own addresses do NOT count: the 1.17.2 rule exactly", async () => {
    // A forwarder on this host (socat, ssh -L, Docker's userland proxy) dialling the host's own
    // address would otherwise speak for whoever reached it. Nothing legitimate needs it here: the
    // CLI dials loopback when the bridge listens there.
    for (const bind of [LOOPBACK_BIND, "localhost", "::1", "[::1]", "127.0.0.2"]) {
      for (const peer of ["100.64.10.2", "::ffff:100.64.10.2", "192.168.1.10", "FD7A:115C:A1E0::8", "fe80::1%eth0"]) {
        const { gate } = await gateFrom(() => peer, bind);
        const denied = guard(request("GET", "/api/snapshot", bearer), config(), "read", gate);
        expect({ bind, peer, status: denied?.status }).toEqual({ bind, peer, status: 403 });
        expect(requestDevice(request("GET", "/api/snapshot", bearer), config(), gate).device).toBeNull();
      }
    }
  });

  test("a wildcard or a host-name bind keeps the loopback-only rule too", async () => {
    for (const bind of ["", "0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "lodge", "lodge.tailnet.ts.net"]) {
      const { gate } = await gateFrom(() => "100.64.10.2", bind);
      expect({ bind, status: guard(request("GET", "/api/snapshot", bearer), config(), "read", gate)?.status }).toEqual({
        bind,
        status: 403,
      });
    }
  });

  test("on a concrete non-loopback bind, a read from this host's own addresses is admitted: a crew peer's CLI dials its bind", async () => {
    // A deputy binds COLLIE_HOST to its tailnet address and nothing answers on 127.0.0.1, so doctor
    // dials that address and the kernel reports it as the peer. Every spelling of it counts.
    for (const bind of [CONCRETE_BIND, "::ffff:100.64.10.2", "[fd7a:115c:a1e0::8]", "192.168.1.10"]) {
      for (const peer of ["100.64.10.2", "::ffff:100.64.10.2", "192.168.1.10", "FD7A:115C:A1E0::8", "fe80::1%eth0"]) {
        const { gate } = await gateFrom(() => peer, bind);
        expect({ bind, peer, gate: guard(request("GET", "/api/snapshot", bearer), config(), "read", gate) }).toEqual({
          bind,
          peer,
          gate: null,
        });
        expect(requestDevice(request("GET", "/api/snapshot", bearer), config(), gate).device).toBe("local");
      }
    }
  });

  test("a request carrying a proxy's header is never admitted, from loopback or from an own address", async () => {
    // The CLI sends none of these (cli/doctor.ts, cli/crew-update.ts, scripts/capture-fixture.sh,
    // scripts/crew-mux-probe.ts); `tailscale serve`, Caddy, Traefik and nginx always add one.
    const markers: Record<string, string>[] = [
      { "x-forwarded-for": "100.64.10.1" },
      { forwarded: "for=100.64.10.1" },
      { "x-real-ip": "100.64.10.1" },
      { "x-forwarded-host": "lodge:8787" },
      { "x-forwarded-proto": "https" },
      { "cf-connecting-ip": "203.0.113.9" },
      { "tailscale-user-name": "Someone" },
      // An empty value is still the header: the proxy's word is that it was there.
      { "X-Forwarded-For": "" },
    ];
    for (const [bind, peer] of [
      [LOOPBACK_BIND, "127.0.0.1"],
      [LOOPBACK_BIND, "::1"],
      [CONCRETE_BIND, "127.0.0.1"],
      [CONCRETE_BIND, "100.64.10.2"],
    ] as const) {
      for (const marker of markers) {
        const { gate } = await gateFrom(() => peer, bind);
        const req = request("GET", "/api/snapshot", { ...bearer, ...marker });
        expect({ bind, peer, marker, status: guard(req, config(), "read", gate)?.status }).toEqual({
          bind,
          peer,
          marker,
          status: 403,
        });
        expect(requestDevice(request("GET", "/api/snapshot", { ...bearer, ...marker }), config(), gate).device).toBeNull();
      }
    }
  });

  test("the configured Tailscale login alone does not refuse it: doctor sends that header (issue #238)", async () => {
    // `checkAccess` fails closed without the login while COLLIE_TRUSTED_USER is set, so doctor sends
    // the configured login beside the secret. A request through `tailscale serve` carries
    // X-Forwarded-For as well, and is refused on that header (above).
    const cfg = config({ trustedUser: "operator@example.com" });
    const { gate } = await gateFrom(loopback);
    const withLogin = request("GET", "/api/snapshot", { ...bearer, "tailscale-user-login": "operator@example.com" });
    expect(guard(withLogin, cfg, "read", gate)).toBeNull();
    const throughServe = request("GET", "/api/snapshot", {
      ...bearer,
      "tailscale-user-login": "operator@example.com",
      "x-forwarded-for": "100.64.10.1",
    });
    expect(guard(throughServe, cfg, "read", gate)?.status).toBe(403);
  });

  test("it stays read-only on every bind: a write, the Files read, files/image and files/exist all 403", async () => {
    for (const [bind, peer] of [
      [LOOPBACK_BIND, "127.0.0.1"],
      [CONCRETE_BIND, "100.64.10.2"],
    ] as const) {
      const { gate } = await gateFrom(() => peer, bind);
      const write = guard(request("POST", "/api/tab", { ...bearer, origin: "http://127.0.0.1:8787" }), config(), "write", gate)!;
      expect(write.status).toBe(403);
      expect(await write.text()).toBe("device not paired");
      // The three Files routes ask `device-read` (pinned by source below); each is refused.
      for (const path of ["/api/pane/w1/files", "/api/pane/w1/files/image?path=x.png", "/api/workspace/w1/files/exist"]) {
        const method = path.endsWith("/exist") ? "POST" : "GET";
        const denied = guard(request(method, path, { ...bearer, origin: "http://127.0.0.1:8787" }), config(), "device-read", gate);
        expect({ bind, path, status: denied?.status }).toEqual({ bind, path, status: 403 });
      }
      expect(requestDevice(request("GET", "/api/snapshot", bearer), config(), gate).authorized).toBe(false);
    }
  });

  // Counsel on the Edge 5 candidate: a Stop and a steer are a person's tap only. The local credential
  // is the one HTTP credential a process beside the bridge can hold (an agent, its hook, the walky
  // talky CLI, which itself speaks over the walky socket and has no route to either), so it is refused
  // on both routes at the level server.ts asks for them, before any read of the pane.
  test("a Stop (`POST /api/pane/:id/abort`) and a steer (`POST /api/send`, `when: steer`) with the local credential are 403", async () => {
    expect(paneGateLevel("abort")).toBe("write");
    // A Clear of the box (ADR 0116) is a write too, and the local credential is refused on it the same way.
    expect(paneGateLevel("clear")).toBe("write");
    expect(SERVER_CODE).toContain('if (pathname === "/api/send" && req.method === "POST") {\n        const denied = browserGate("write");');
    for (const [bind, peer] of [
      [LOOPBACK_BIND, "127.0.0.1"],
      [CONCRETE_BIND, "100.64.10.2"],
    ] as const) {
      const { gate } = await gateFrom(() => peer, bind);
      const headers = { ...bearer, origin: "http://127.0.0.1:8787", "content-type": "application/json" };
      const stop = guard(request("POST", "/api/pane/w1%3Ap1/abort", headers), config(), paneGateLevel("abort"), gate);
      expect({ bind, status: stop?.status }).toEqual({ bind, status: 403 });
      const cleared = guard(request("POST", "/api/pane/w1%3Ap1/clear", headers), config(), paneGateLevel("clear"), gate);
      expect({ bind, status: cleared?.status }).toEqual({ bind, status: 403 });
      const steer = guard(request("POST", "/api/send", headers), config(), "write", gate);
      expect({ bind, status: steer?.status }).toEqual({ bind, status: 403 });
    }
  });

  // Official tricks (M94): an add or an update from the list fetches code onto this machine, so it is a
  // person's tap only, like the trick switch. The local credential (an agent beside the bridge can hold it)
  // is refused at the level server.ts asks for the route (pinned in bridge/tricks/units.test.ts).
  test("an add or an update from the official list with the local credential is 403", async () => {
    expect(TRICKS_ROUTE_RIGHTS.officialAdd).toBe("write");
    for (const [bind, peer] of [
      [LOOPBACK_BIND, "127.0.0.1"],
      [CONCRETE_BIND, "100.64.10.2"],
    ] as const) {
      const { gate } = await gateFrom(() => peer, bind);
      const headers = { ...bearer, origin: "http://127.0.0.1:8787", "content-type": "application/json" };
      for (const path of ["/api/tricks/official/design-review/add", "/api/tricks/official/design-review/update"]) {
        const denied = guard(request("POST", path, headers), config(), TRICKS_ROUTE_RIGHTS.officialAdd, gate);
        expect({ bind, path, status: denied?.status }).toEqual({ bind, path, status: 403 });
      }
      // The list itself is a read, as the tricks list is.
      expect(guard(request("GET", "/api/tricks/official", bearer), config(), TRICKS_ROUTE_RIGHTS.official, gate)).toBeNull();
    }
  });

  test("the Files read, files/image, files/exist and Claude commands routes ask device-read, never read (by source)", () => {
    for (const route of ["WORKSPACE_FILES_ROUTE", "PANE_FILES_EXIST_ROUTE", "PANE_FILES_IMAGE_ROUTE", "PANE_CLAUDE_COMMANDS_ROUTE"]) {
      const at = SERVER_CODE.indexOf(`pathname.match(${route})`);
      expect({ route, found: at > 0 }).toEqual({ route, found: true });
      const nextGate = SERVER_CODE.slice(at).match(/caller\.gate\("([a-z-]+)"\)/);
      expect({ route, level: nextGate?.[1] }).toEqual({ route, level: "device-read" });
    }
    // The pane Files read takes its level from the action table.
    expect(SERVER_CODE).toContain('if (action === "files") return "device-read";');
  });

  test("the host's addresses are asked only once the secret matched, on a concrete bind, and read fresh each time", async () => {
    let asked = 0;
    const counting = () => {
      asked += 1;
      return OWN;
    };
    const { gate } = await gateFrom(() => "100.64.10.2", CONCRETE_BIND, true, counting);
    guard(request("GET", "/api/snapshot", { authorization: `Bearer ${TOKEN}` }), config(), "read", gate);
    expect(asked).toBe(0);
    guard(request("GET", "/api/snapshot", bearer), config(), "read", gate);
    guard(request("GET", "/api/snapshot", bearer), config(), "read", gate);
    expect(asked).toBe(2);
    // A loopback bind never asks at all.
    const { gate: loopbackBound } = await gateFrom(() => "100.64.10.2", LOOPBACK_BIND, true, counting);
    guard(request("GET", "/api/snapshot", bearer), config(), "read", loopbackBound);
    expect(asked).toBe(2);
  });

  test("it is refused from another machine, and from a peer the runtime cannot name", async () => {
    for (const bind of [LOOPBACK_BIND, CONCRETE_BIND]) {
      for (const peer of ["100.64.10.1", "192.168.1.20", "fd7a:115c:a1e0::1", "::ffff:100.64.10.1", "", null, undefined]) {
        const { gate } = await gateFrom(() => peer, bind);
        const denied = guard(request("GET", "/api/snapshot", bearer), config(), "read", gate);
        expect({ bind, peer, status: denied?.status }).toEqual({ bind, peer, status: 403 });
      }
    }
  });

  test("a wrong value, a near miss and a missing credential are refused", async () => {
    const { gate } = await gateFrom(loopback);
    const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    for (const value of [mintLocalSecret(), flipped, secret.slice(1), `${secret}x`, "local"]) {
      const denied = guard(request("GET", "/api/snapshot", { authorization: `Bearer ${value}` }), config(), "read", gate);
      expect(denied?.status).toBe(403);
    }
    // A bridge that could not write the file holds no credential: the secret is then just a token.
    const { store } = await storeWith(true);
    const none = browserPairingGate(store, undefined, loopback, LOOPBACK_BIND);
    expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", none)?.status).toBe(403);
  });

  test("the CLI still reads while the registry is unreadable, which is when doctor is run", async () => {
    const { gate, dir } = await gateFrom(loopback);
    await writeFile(join(dir, DEVICES_FILENAME), "{");
    expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", gate)).toBeNull();
    expect(guard(request("GET", "/api/snapshot", { authorization: `Bearer ${TOKEN}` }), config(), "read", gate)!.status).toBe(503);
  });

  test("a paired phone's token still works through the same gate, proxy headers and all", async () => {
    const { gate } = await gateFrom(() => "127.0.0.1");
    const phone = { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "100.64.10.1" };
    expect(guard(request("GET", "/api/snapshot", phone), config(), "read", gate)).toBeNull();
    expect(requestDevice(request("GET", "/api/snapshot", phone), config(), gate).device).toBe("phone");
  });

  test("isLocalRequest: true only for the host's own CLI, never for a phone, a proxy hop or no token", async () => {
    const { gate } = await gateFrom(() => "127.0.0.1");
    expect(isLocalRequest(request("GET", "/api/tricks", bearer), gate)).toBe(true);
    expect(isLocalRequest(request("GET", "/api/tricks", { authorization: `Bearer ${TOKEN}` }), gate)).toBe(false);
    expect(isLocalRequest(request("GET", "/api/tricks", { ...bearer, "x-forwarded-for": "100.64.10.2" }), gate)).toBe(false);
    expect(isLocalRequest(request("GET", "/api/tricks"), gate)).toBe(false);
    expect(isLocalRequest(request("GET", "/api/tricks", bearer), undefined)).toBe(false);
    const { gate: remote } = await gateFrom(() => "100.64.10.1");
    expect(isLocalRequest(request("GET", "/api/tricks", bearer), remote)).toBe(false);
  });

  test("server.ts wires the listener's own bind into the gate, not a global", () => {
    expect(SERVER_CODE).toContain("browserPairingGate(pairing, localCredential, (req) => server.requestIP(req)?.address, cfg.host)");
  });
});

describe("isSameHostPeer: loopback, or this host's own addresses on a concrete bind only", () => {
  test("addresses are compared in one spelling", () => {
    expect(normalizePeerAddress("::FFFF:100.64.10.2")).toBe("100.64.10.2");
    expect(normalizePeerAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizePeerAddress(" FD7A::8 ")).toBe("fd7a::8");
    // A v4-mapped prefix on a pure IPv6 address is not an IPv4 address and stays as it is.
    expect(normalizePeerAddress("::ffff:abcd")).toBe("::ffff:abcd");
  });

  test("the real interface list holds loopback, and loopback counts on every bind", () => {
    expect(hostInterfaceAddresses().has("127.0.0.1")).toBe(true);
    for (const bind of ["127.0.0.1", "100.64.10.2", ""]) {
      expect(isSameHostPeer("127.0.0.1", bind, () => new Set())).toBe(true);
      expect(isSameHostPeer("::1", bind, () => new Set())).toBe(true);
      expect(isSameHostPeer("::ffff:127.0.0.1", bind, () => new Set())).toBe(true);
    }
  });

  test("an own address counts only on a concrete non-loopback bind, in every spelling", () => {
    const own = () => new Set(["100.64.10.2", "fe80::1"]);
    expect(isSameHostPeer("::ffff:100.64.10.2", "100.64.10.2", own)).toBe(true);
    expect(isSameHostPeer("FE80::1%eth0", "100.64.10.2", own)).toBe(true);
    expect(isSameHostPeer("::ffff:100.64.10.2", "127.0.0.1", own)).toBe(false);
    expect(isSameHostPeer("fe80::1%eth0", "127.0.0.1", own)).toBe(false);
  });

  test("an unnamed peer is never this host, whatever the interfaces say", () => {
    for (const peer of ["", "  ", null, undefined]) expect(isSameHostPeer(peer, "100.64.10.2", () => new Set([""]))).toBe(false);
  });

  test("which binds are concrete and non-loopback", () => {
    for (const bind of ["100.64.10.2", "192.168.1.10", "fd7a:115c:a1e0::8", "[fd7a:115c:a1e0::8]", "::ffff:100.64.10.2", " 100.64.10.2 "]) {
      expect({ bind, concrete: isConcreteNonLoopbackBind(bind) }).toEqual({ bind, concrete: true });
    }
    for (const bind of ["", "  ", "127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", "::", "[::]", "::0", "0:0:0:0:0:0:0:0", "lodge", "999.1.1.1"]) {
      expect({ bind, concrete: isConcreteNonLoopbackBind(bind) }).toEqual({ bind, concrete: false });
    }
  });
});

// ── A trick's setting: the value route is a write (security read of package G, point 7) ─────

describe("the Hill answer route is gated at the write level (a trick proposal's yes switches the trick on)", () => {
  const path = "/api/hill/answer";
  const headers = { host: "collie.ts.net", origin: "https://collie.ts.net", "x-device-id": "tablet", "content-type": "application/json" };

  test("the level is write, and server.ts asks the guard for exactly that level on the POST route", () => {
    expect(HILL_ANSWER_RIGHT).toBe("write");
    const at = SERVER_CODE.indexOf('pathname === "/api/hill/answer"');
    expect(at).toBeGreaterThan(0);
    expect(SERVER_CODE.slice(at, at + 200)).toContain('req.method === "POST"');
    expect(SERVER_CODE.slice(at, at + 300)).toContain("browserGate(HILL_ANSWER_RIGHT)");
  });

  test("a read-only device is refused by the guard with 403, and the same device may still read the list; a writer passes", () => {
    const c = config({ deviceHeader: "x-device-id", deviceAllowlist: ["phone"], allowAnyHost: true });
    const post = new Request(`http://collie.ts.net${path}`, { method: "POST", headers });
    expect(guard(post, c, HILL_ANSWER_RIGHT)!.status).toBe(403);
    expect(guard(new Request("http://collie.ts.net/api/hill", { headers }), c, "read")).toBeNull();
    const writer = new Request(`http://collie.ts.net${path}`, { method: "POST", headers: { ...headers, "x-device-id": "phone" } });
    expect(guard(writer, c, HILL_ANSWER_RIGHT)).toBeNull();
  });

  test("the local credential, which an agent beside the bridge can hold, is refused at the answer route", async () => {
    const { store } = await storeWith(true);
    const secret = mintLocalSecret();
    const gate = browserPairingGate(store, localCredentialOf(secret), () => "127.0.0.1", "127.0.0.1", () => new Set(["100.64.10.2"]));
    const denied = guard(request("POST", path, { authorization: `Bearer ${secret}`, origin: "http://127.0.0.1:8787", "content-type": "application/json" }), config(), HILL_ANSWER_RIGHT, gate);
    expect(denied?.status).toBe(403);
  });
});

describe("the host's local secret at POST /api/hill/answer, through the gates server.ts runs in order", () => {
  const path = "/api/hill/answer";
  const secret = mintLocalSecret();
  const credential = localCredentialOf(secret);
  const post = (token: string) => request("POST", path, { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:8787", "content-type": "application/json" });

  // The same two calls, in the same order, as the dispatcher: the front gate before any route, then the route's own write gate.
  async function chain(token: string, peer: string, bind: string, paired: boolean): Promise<number | null> {
    const { store } = await storeWith(paired);
    const gate = browserPairingGate(store, credential, () => peer, bind, () => new Set(["100.64.10.2"]));
    const front = apiFrontGate(post(token), path, config(), gate);
    if (front) return front.status;
    return guard(post(token), config(), HILL_ANSWER_RIGHT, gate)?.status ?? null;
  }

  test("the secret is refused with 403 on a loopback bind and on a tailnet bind, with a device paired or none", async () => {
    for (const [bind, peer] of [["127.0.0.1", "127.0.0.1"], ["127.0.0.1", "::1"], ["100.64.10.2", "127.0.0.1"], ["100.64.10.2", "100.64.10.2"]] as const) {
      for (const paired of [true, false]) {
        expect({ bind, peer, paired, status: await chain(secret, peer, bind, paired) }).toEqual({ bind, peer, paired, status: 403 });
      }
    }
  });

  test("the front gate refuses the secret here (the route is not a local-key route), the route's own gate refuses it as a write, and a paired device's token writes", async () => {
    const { store } = await storeWith(true);
    const gate = browserPairingGate(store, credential, () => "127.0.0.1", "127.0.0.1", () => new Set(["100.64.10.2"]));
    const front = apiFrontGate(post(secret), path, config(), gate);
    expect(front?.status).toBe(403);
    expect(asJsonString(parseJsonObject((await front?.text()) ?? "")?.code)).toBe("local.no_text");
    // `guard` alone still admits the key as a read; the front gate is what keeps it off this route.
    expect(guard(request("GET", "/api/hill", { authorization: `Bearer ${secret}` }), config(), "read", gate)).toBeNull();
    expect(guard(post(secret), config(), HILL_ANSWER_RIGHT, gate)?.status).toBe(403);
    expect(await chain(TOKEN, "127.0.0.1", "127.0.0.1", true)).toBeNull();
  });

  test("server.ts runs the front gate before the route and the route's gate before it reads the body", () => {
    const front = SERVER_CODE.indexOf("apiFrontGate(req, pathname, cfg, pairingGate)");
    const at = SERVER_CODE.indexOf('pathname === "/api/hill/answer" && req.method === "POST"');
    expect(front).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(front);
    const route = SERVER_CODE.slice(at, at + 600);
    expect(route.indexOf("browserGate(HILL_ANSWER_RIGHT)")).toBeGreaterThan(0);
    expect(route.indexOf("if (denied) return denied;")).toBeLessThan(route.indexOf("req.json()"));
  });
});

describe("the trick value route is gated at the write level", () => {
  const path = "/api/tricks/lodge/legs/value";
  const headers = { host: "collie.ts.net", origin: "https://collie.ts.net", "x-device-id": "tablet", "content-type": "application/json" };

  test("the level is write, and server.ts asks the guard for exactly that level on the POST route", () => {
    expect(TRICKS_ROUTE_RIGHTS.value).toBe("write");
    const at = SERVER_CODE.indexOf("TRICKS_VALUE_ROUTE.exec(pathname)");
    expect(at).toBeGreaterThan(0);
    const next = SERVER_CODE.slice(at).match(/guard\(req, cfg, ([A-Za-z_.]+)/);
    expect(next?.[1]).toBe("TRICKS_ROUTE_RIGHTS.value");
    expect(SERVER_CODE.slice(at, at + 200)).toContain('req.method === "POST"');
  });

  test("a read-only device is refused at the gate with 403, and the same device may still read the list", () => {
    const c = config({ deviceHeader: "x-device-id", deviceAllowlist: ["phone"], allowAnyHost: true });
    const post = new Request(`http://collie.ts.net${path}`, { method: "POST", headers });
    expect(guard(post, c, TRICKS_ROUTE_RIGHTS.value)!.status).toBe(403);
    expect(guard(new Request("http://collie.ts.net/api/tricks", { headers }), c, TRICKS_ROUTE_RIGHTS.reply)).toBeNull();
    // The device the allowlist names may write.
    const writer = new Request(`http://collie.ts.net${path}`, { method: "POST", headers: { ...headers, "x-device-id": "phone" } });
    expect(guard(writer, c, TRICKS_ROUTE_RIGHTS.value)).toBeNull();
  });

  test("the local credential, which an agent beside the bridge can hold, is refused at the value route", async () => {
    const { store } = await storeWith(true);
    const secret = mintLocalSecret();
    const gate = browserPairingGate(store, localCredentialOf(secret), () => "127.0.0.1", "127.0.0.1", () => new Set(["100.64.10.2"]));
    const denied = guard(request("POST", path, { authorization: `Bearer ${secret}`, origin: "http://127.0.0.1:8787", "content-type": "application/json" }), config(), TRICKS_ROUTE_RIGHTS.value, gate);
    expect(denied?.status).toBe(403);
  });
});

// ── A trick's code for the About sheet's folds (package F) ──────────────────────────────────

describe("the trick code route needs a paired device's token", () => {
  const path = "/api/tricks/lodge/legs/code";

  test("a request with no token is refused at the front gate; a paired device's token passes it; the level is read", async () => {
    const { store } = await storeWith(true);
    expect(TRICKS_ROUTE_RIGHTS.code).toBe("read");
    expect(apiFrontGate(request("GET", path), path, config(), store)?.status).toBe(403);
    expect(apiFrontGate(request("GET", `${path}?file=trick.toml`), path, config(), store)?.status).toBe(403);
    expect(apiFrontGate(request("GET", path, { authorization: `Bearer ${TOKEN}` }), path, config(), store)).toBeNull();
  });

  test("with no device paired at all, the same request is refused too", async () => {
    const { store } = await storeWith(false);
    expect(apiFrontGate(request("GET", path), path, config(), store)?.status).toBe(403);
  });
});

// ── The local key reaches only the routes it is marked for (bridge/local-key.ts) ──────────────

describe("the local key: deny by default, by the mark in LOCAL_KEY_ROUTES", () => {
  const secret = mintLocalSecret();
  const credential = localCredentialOf(secret);
  const bearer = { authorization: `Bearer ${secret}` };

  async function localGate(): Promise<PairingGate> {
    const { store } = await storeWith(true);
    return browserPairingGate(store, credential, () => "127.0.0.1", "127.0.0.1", () => new Set(["100.64.10.2"]));
  }

  /** The front gate's answer for the key: null (it may go on) or the refusal's status and code. */
  async function front(gate: PairingGate, method: string, path: string, query = ""): Promise<{ status: number; code: string | undefined } | null> {
    const denied = apiFrontGate(request(method, `${path}${query}`, bearer), path, config(), gate);
    if (denied === null) return null;
    return { status: denied.status, code: asJsonString(parseJsonObject(await denied.text())?.code) };
  }

  const REFUSED = { status: 403, code: "local.no_text" };

  test("the list is exactly five reads, each with a reason", () => {
    expect(LOCAL_KEY_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/snapshot",
      "GET /api/tricks",
      "GET /api/telemetry",
      "GET /api/update/check",
      "GET /api/config",
    ]);
    for (const r of LOCAL_KEY_ROUTES) expect(r.reason.length).toBeGreaterThan(40);
  });

  test("every /api/ path the dispatcher names, every method, is refused to the key unless it is marked", async () => {
    const gate = await localGate();
    let refused = 0;
    const admitted: string[] = [];
    for (const path of everyApiPath()) {
      for (const method of ["GET", "POST", "HEAD", "PUT", "DELETE"]) {
        if (isOpenApiRoute(path, method)) continue;
        const answer = await front(gate, method, path);
        if (isLocalKeyRoute(path, method)) {
          expect({ method, path, answer }).toEqual({ method, path, answer: null });
          admitted.push(`${method} ${path}`);
          continue;
        }
        expect({ method, path, answer }).toEqual({ method, path, answer: REFUSED });
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(400);
    expect(admitted.toSorted()).toEqual(LOCAL_KEY_ROUTES.map((r) => `${r.method} ${r.path}`).toSorted());
  });

  test("a route nobody wrote yet is refused to the key: the mark, not the route table, decides", async () => {
    const gate = await localGate();
    for (const path of ["/api/brand-new", "/api/pane/id1/brand-new", "/api/snapshot/more", "/api/snapshotx"]) {
      expect(await front(gate, "GET", path)).toEqual(REFUSED);
    }
  });

  test("every route that returns a screen or a message is refused, with ?host= too, so no member is read through the lead", async () => {
    const gate = await localGate();
    const textRoutes = [
      "/api/pane/w1%3Ap1",
      "/api/pane/w1%3Ap1/history",
      "/api/pane/w1%3Ap1/chat",
      "/api/pane/w1%3Ap1/pins",
      "/api/pane/w1%3Ap1/changes",
      "/api/pane/w1%3Ap1/held",
      "/api/pane/w1%3Ap1/arrived",
      "/api/pane/w1%3Ap1/walky",
      "/api/pane/w1%3Ap1/subagent/a1",
      "/api/pane/w1%3Ap1/claude-commands",
      "/api/workspace/w1/changes",
      "/api/surface",
      "/api/hill",
      "/api/hill/state",
      "/api/hill/media/h1/m1",
      "/api/trick-views",
      "/api/trick-views/media/v1/m1",
      "/api/blobs/b1",
      "/api/tricks/lead/legs/code",
      "/api/tricks/lead/legs/media/a.png",
      "/api/durable/conversations",
      "/api/durable/conversation/c1/items",
      "/api/sent",
      "/api/send/receipts",
      "/api/send/r1",
      "/api/walky/who",
      "/api/report/context",
      "/api/crew",
    ];
    for (const path of textRoutes) {
      for (const query of ["", "?host=member-1", "?h=member-1&session=desk"]) {
        expect({ path, query, answer: await front(gate, "GET", path, query) }).toEqual({ path, query, answer: REFUSED });
      }
    }
  });

  test("the refusal says the next step: a paired device reads this, a script sends COLLIE_TOKEN", async () => {
    const gate = await localGate();
    const denied = apiFrontGate(request("GET", "/api/pane/w1%3Ap1", bearer), "/api/pane/w1%3Ap1", config(), gate);
    const body = parseJsonObject((await denied?.text()) ?? "");
    expect(asJsonString(body?.error)).toContain("paired device");
    expect(asJsonString(body?.error)).toContain("COLLIE_TOKEN");
  });

  test("a paired device's token is not the key: it passes the front gate on a text route", async () => {
    const gate = await localGate();
    expect(apiFrontGate(request("GET", "/api/pane/w1%3Ap1", { authorization: `Bearer ${TOKEN}` }), "/api/pane/w1%3Ap1", config(), gate)).toBeNull();
  });

  test("server.ts asks the mark in apiFrontGate, which runs before the session router and its ?host= forward", () => {
    const at = SERVER_CODE.indexOf("export function apiFrontGate(");
    const body = SERVER_CODE.slice(at, SERVER_CODE.indexOf("\n}\n", at));
    expect(body).toContain("isLocalRequest(req, pairing) && !isLocalKeyRoute(pathname, req.method)");
    const gateAt = SERVER_CODE.indexOf("apiFrontGate(req, pathname, cfg, pairingGate)");
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(SERVER_CODE.indexOf("crewLead!.forward("));
    expect(gateAt).toBeLessThan(SERVER_CODE.indexOf('if (pathname === "/api/snapshot")'));
  });
});
