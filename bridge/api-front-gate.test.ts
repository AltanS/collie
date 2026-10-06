import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config } from "./config.ts";
import { localCredentialOf, mintLocalSecret } from "./local-secret.ts";
import { DEVICES_FILENAME, filePairingIo, PairingStore, sha256Hex } from "./pairing.ts";
import {
  apiFrontGate,
  browserPairingGate,
  guard,
  isOpenApiRoute,
  OPEN_API_ROUTES,
  type PairingGate,
  requestDevice,
} from "./server.ts";
import { MUX_LOGO_PATH, OPERATOR_FONTS_PATH } from "./types.ts";

// ── DENY BY DEFAULT, PINNED (ADR 0086) ────────────────────────────────────────────────────────
// `apiFrontGate` is the one pairing check in front of the whole `/api/` dispatcher. These tests hold
// it to three promises: every `/api/` path `bridge/server.ts` names is refused without a token, the
// allowlist is exactly `GET|HEAD /api/health` and `POST /api/pair`, and no spelling of a path reaches
// a route without passing the same check the route would. `Bun.serve` is not stood up for the real
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
    for (const known of ["/api/snapshot", "/api/devices/revoke", "/api/pane/id1/reply", "/api/workspace/id1/worktrees"]) {
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
  test("the allowlist is GET|HEAD /api/health and POST /api/pair, and nothing else", () => {
    expect(OPEN_API_ROUTES).toEqual([
      { path: "/api/health", methods: ["GET", "HEAD"] },
      { path: "/api/pair", methods: ["POST"] },
    ]);
    expect(isOpenApiRoute("/api/pair", "GET")).toBe(false);
    expect(isOpenApiRoute("/api/health", "POST")).toBe(false);
    expect(isOpenApiRoute("/api/health/", "GET")).toBe(false);
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

describe("the local credential: reads only, from a loopback peer only", () => {
  const secret = mintLocalSecret();
  const credential = localCredentialOf(secret);
  const bearer = { authorization: `Bearer ${secret}` };
  const loopback = () => "127.0.0.1";

  async function gateFrom(peer: () => string | null | undefined, paired = true) {
    const { store, dir } = await storeWith(paired);
    return { gate: browserPairingGate(store, credential, peer), dir };
  }

  test("a read from loopback is admitted, and attributed to `local`, never authorised to write", async () => {
    const { gate } = await gateFrom(loopback);
    expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", gate)).toBeNull();
    expect(apiFrontGate(request("GET", "/api/update/check", bearer), "/api/update/check", config(), gate)).toBeNull();
    expect(requestDevice(request("GET", "/api/snapshot", bearer), config(), gate)).toEqual({
      enforced: true,
      device: "local",
      authorized: false,
    });
    // v4-mapped and IPv6 loopback are loopback too.
    for (const peer of ["::1", "::ffff:127.0.0.1"]) {
      const { gate: g } = await gateFrom(() => peer);
      expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", g)).toBeNull();
    }
  });

  test("it is refused for a write and for the Files view's device-read", async () => {
    const { gate } = await gateFrom(loopback);
    const write = guard(request("POST", "/api/tab", { ...bearer, origin: "http://127.0.0.1:8787" }), config(), "write", gate)!;
    expect(write.status).toBe(403);
    expect(await write.text()).toBe("device not paired");
    expect(guard(request("GET", "/api/pane/w1/files", bearer), config(), "device-read", gate)!.status).toBe(403);
  });

  test("it is refused from a non-loopback peer, and from a peer the runtime cannot name", async () => {
    for (const peer of ["100.64.0.9", "192.168.1.20", "fd7a:115c:a1e0::1", "", null, undefined]) {
      const { gate } = await gateFrom(() => peer);
      const denied = guard(request("GET", "/api/snapshot", bearer), config(), "read", gate);
      expect({ peer, status: denied?.status }).toEqual({ peer, status: 403 });
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
    const none = browserPairingGate(store, undefined, loopback);
    expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", none)?.status).toBe(403);
  });

  test("the CLI still reads while the registry is unreadable, which is when doctor is run", async () => {
    const { gate, dir } = await gateFrom(loopback);
    await writeFile(join(dir, DEVICES_FILENAME), "{");
    expect(guard(request("GET", "/api/snapshot", bearer), config(), "read", gate)).toBeNull();
    expect(guard(request("GET", "/api/snapshot", { authorization: `Bearer ${TOKEN}` }), config(), "read", gate)!.status).toBe(503);
  });

  test("a paired phone's token still works through the same gate", async () => {
    const { gate } = await gateFrom(() => "127.0.0.1");
    const phone = { authorization: `Bearer ${TOKEN}` };
    expect(guard(request("GET", "/api/snapshot", phone), config(), "read", gate)).toBeNull();
    expect(requestDevice(request("GET", "/api/snapshot", phone), config(), gate).device).toBe("phone");
  });
});
