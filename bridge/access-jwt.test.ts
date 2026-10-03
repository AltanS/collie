import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  ACCESS_JWT_HEADER,
  accessExempt,
  accessIssuer,
  createAccessGate,
  importAccessKeys,
  verifyAccessToken,
} from "./access-jwt.ts";

const ISS = "https://myteam.cloudflareaccess.com";
const AUD = "aud-collie-0123456789abcdef";
const NOW_S = 1_800_000_000;

function b64urlOf(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64url = (text: string): string => b64urlOf(new TextEncoder().encode(text));

interface Signer {
  kid: string;
  jwk: JsonObject;
  sign: (header: JsonObject, payload: JsonObject) => Promise<string>;
}

async function signer(kid: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    jwk: { kty: "RSA", n: pub.n ?? "", e: pub.e ?? "", alg: "RS256", use: "sig", kid },
    sign: async (header, payload) => {
      const h = b64url(JSON.stringify(header));
      const p = b64url(JSON.stringify(payload));
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64urlOf(new Uint8Array(sig))}`;
    },
  };
}

const A = await signer("kid-a");
const B = await signer("kid-b");

const claims = (over: JsonObject = {}): JsonObject => ({
  iss: ISS,
  aud: [AUD],
  exp: NOW_S + 600,
  iat: NOW_S - 10,
  nbf: NOW_S - 10,
  email: "me@example.com",
  ...over,
});
const good = (over: JsonObject = {}, signerKey: Signer = A) =>
  signerKey.sign({ alg: "RS256", kid: signerKey.kid, typ: "JWT" }, claims(over));

const expect_ = { issuer: ISS, aud: [AUD], nowS: NOW_S };
const keysOf = (...s: Signer[]) => importAccessKeys({ keys: s.map((x) => x.jwk) });

function tunnelReq(path = "/api/snapshot", headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8787${path}`, {
    headers: { host: "collie.example.com", "cf-ray": "8f00-FRA", ...headers },
  });
}

/** A gate whose certs endpoint serves whatever `jwks.current` holds, counting the fetches. */
/** What the fake certs endpoint serves, mutable mid-test. */
interface Certs {
  current: JsonValue;
  status?: number;
}

function gateWith(jwks: Certs, team = "myteam", aud = [AUD]) {
  let fetches = 0;
  let now = NOW_S * 1000;
  const urls: string[] = [];
  const gate = createAccessGate(
    { accessTeam: team, accessAud: aud },
    {
      fetch: async (url) => {
        fetches++;
        urls.push(url);
        return new Response(JSON.stringify(jwks.current), { status: jwks.status ?? 200 });
      },
      nowMs: () => now,
      log: () => {},
      schedule: () => {},
    },
  );
  if (gate === null) throw new Error("the gate is configured in every caller");
  return {
    gate,
    urls,
    fetches: () => fetches,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("accessIssuer", () => {
  test("a bare team, its full domain and the issuer URL all name the same issuer", () => {
    expect(accessIssuer("myteam")).toBe(ISS);
    expect(accessIssuer("MyTeam.cloudflareaccess.com")).toBe(ISS);
    expect(accessIssuer("https://myteam.cloudflareaccess.com/")).toBe(ISS);
  });
  test("refuses what cannot be an issuer", () => {
    expect(accessIssuer("")).toBeNull();
    expect(accessIssuer("http://myteam.cloudflareaccess.com")).toBeNull();
    expect(accessIssuer("https://myteam.cloudflareaccess.com/cdn-cgi/access/certs")).toBeNull();
    expect(accessIssuer("my team")).toBeNull();
  });
});

describe("verifyAccessToken", () => {
  test("a token for this app, from this team, unexpired, verifies", async () => {
    expect(await verifyAccessToken(await good(), await keysOf(A), expect_)).toEqual({ ok: true });
  });

  test("aud as a single string is read too", async () => {
    expect(await verifyAccessToken(await good({ aud: AUD }), await keysOf(A), expect_)).toEqual({ ok: true });
  });

  // The issue's point: every app in a team shares the signing key, so the signature alone admits a
  // token issued for a different application.
  test("a correctly signed token for ANOTHER Access app in the team is refused", async () => {
    const t = await good({ aud: ["aud-some-other-app"] });
    expect(await verifyAccessToken(t, await keysOf(A), expect_)).toEqual({ ok: false, reason: "aud" });
  });

  test("another team's issuer is refused", async () => {
    const t = await good({ iss: "https://otherteam.cloudflareaccess.com" });
    expect(await verifyAccessToken(t, await keysOf(A), expect_)).toEqual({ ok: false, reason: "iss" });
  });

  test("an expired token is refused, a token without exp too", async () => {
    const keys = await keysOf(A);
    expect(await verifyAccessToken(await good({ exp: NOW_S - 120 }), keys, expect_)).toEqual({
      ok: false,
      reason: "exp",
    });
    expect(await verifyAccessToken(await good({ exp: undefined }), keys, expect_)).toEqual({
      ok: false,
      reason: "exp",
    });
  });

  test("a token not yet valid is refused", async () => {
    const t = await good({ nbf: NOW_S + 3600 });
    expect(await verifyAccessToken(t, await keysOf(A), expect_)).toEqual({ ok: false, reason: "nbf" });
  });

  test("a tampered payload fails the signature", async () => {
    const [h, , s] = (await good()).split(".");
    const forged = `${h}.${b64url(JSON.stringify(claims({ email: "attacker@example.com" })))}.${s}`;
    expect(await verifyAccessToken(forged, await keysOf(A), expect_)).toEqual({ ok: false, reason: "signature" });
  });

  test("a token signed by a key the team does not publish is refused", async () => {
    const t = await A.sign({ alg: "RS256", kid: "kid-b" }, claims());
    expect(await verifyAccessToken(t, await keysOf(B), expect_)).toEqual({ ok: false, reason: "signature" });
    expect(await verifyAccessToken(await good(), await keysOf(B), expect_)).toEqual({
      ok: false,
      reason: "unknown-kid",
    });
  });

  test("alg none and HS256 are refused before any key is used", async () => {
    const p = b64url(JSON.stringify(claims()));
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "kid-a" }))}.${p}.`;
    const hs = `${b64url(JSON.stringify({ alg: "HS256", kid: "kid-a" }))}.${p}.${b64url("x")}`;
    const keys = await keysOf(A);
    expect(await verifyAccessToken(none, keys, expect_)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAccessToken(hs, keys, expect_)).toEqual({ ok: false, reason: "alg" });
  });

  test("garbage is malformed, not a throw", async () => {
    const keys = await keysOf(A);
    for (const t of ["", "a.b", "a.b.c.d", "!!.??.**", `${b64url("[]")}.${b64url("{}")}.${b64url("x")}`]) {
      expect((await verifyAccessToken(t, keys, expect_)).ok).toBe(false);
    }
  });
});

describe("importAccessKeys", () => {
  test("skips keys it cannot use and keeps the rest", async () => {
    const keys = await importAccessKeys({
      keys: [A.jwk, { kty: "EC", kid: "ec" }, { ...B.jwk, alg: "RS512" }, { ...B.jwk, kid: undefined }, null],
      public_cert: { kid: "ignored" },
    });
    expect([...keys.keys()]).toEqual(["kid-a"]);
  });
  test("a body without keys yields none", async () => {
    expect((await importAccessKeys({})).size).toBe(0);
    expect((await importAccessKeys(null)).size).toBe(0);
  });
});

describe("accessExempt", () => {
  test("/api/health is always exempt", () => {
    expect(accessExempt(tunnelReq("/api/health"), "/api/health")).toBe(true);
  });
  test("a local caller (loopback Host, no Cloudflare header) is exempt", () => {
    const r = new Request("http://127.0.0.1:8787/api/snapshot", { headers: { host: "127.0.0.1:8787" } });
    expect(accessExempt(r, "/api/snapshot")).toBe(true);
  });
  test("a loopback Host that came through the edge is NOT exempt", () => {
    for (const h of ["cf-ray", "cf-connecting-ip", "cf-visitor", ACCESS_JWT_HEADER]) {
      const r = new Request("http://127.0.0.1:8787/api/snapshot", { headers: { host: "localhost:8787", [h]: "x" } });
      expect(accessExempt(r, "/api/snapshot")).toBe(false);
    }
  });
  test("the public hostname is never exempt, even with no edge header", () => {
    const r = new Request("http://127.0.0.1:8787/", { headers: { host: "collie.example.com" } });
    expect(accessExempt(r, "/")).toBe(false);
  });
});

describe("AccessGate", () => {
  test("off when neither setting is present", () => {
    expect(createAccessGate({ accessTeam: "", accessAud: [] })).toBeNull();
    expect(createAccessGate({ accessTeam: "  ", accessAud: [" "] })).toBeNull();
  });

  test("fetches the team's certs URL", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    expect(g.urls).toEqual(["https://myteam.cloudflareaccess.com/cdn-cgi/access/certs"]);
  });

  test("half a configuration refuses every tunnel request (fail closed)", async () => {
    for (const s of [
      { accessTeam: "myteam", accessAud: [] },
      { accessTeam: "", accessAud: [AUD] },
      { accessTeam: "not a team!", accessAud: [AUD] },
    ]) {
      const gate = createAccessGate(s, { log: () => {}, schedule: () => {} })!;
      expect(gate.configured).toBe(false);
      const res = await gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: await good() }), "/");
      expect(res?.status).toBe(503);
    }
  });

  test("admits a valid token, refuses a missing or wrong one with 401", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    expect(await g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: await good() }), "/")).toBeNull();
    expect((await g.gate.admit(tunnelReq("/"), "/"))?.status).toBe(401);
    const other = await good({ aud: ["aud-some-other-app"] });
    expect((await g.gate.admit(tunnelReq("/api/snapshot", { [ACCESS_JWT_HEADER]: other }), "/api/snapshot"))?.status).toBe(
      401,
    );
  });

  test("the email header alone is never evidence", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    const r = tunnelReq("/", { "cf-access-authenticated-user-email": "me@example.com" });
    expect((await g.gate.admit(r, "/"))?.status).toBe(401);
  });

  test("keys never fetched: refuses with 503 and retries on a later request", async () => {
    const jwks: Certs = { current: {}, status: 500 };
    const g = gateWith(jwks);
    await g.gate.refresh();
    const req = async () => g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: await good() }), "/");
    expect((await req())?.status).toBe(503);
    jwks.current = { keys: [A.jwk] };
    jwks.status = 200;
    // Within the throttle window no refetch happens, so still closed.
    expect((await req())?.status).toBe(503);
    g.advance(31_000);
    expect(await req()).toBeNull();
  });

  test("a failed refresh keeps the cached keys", async () => {
    const jwks: Certs = { current: { keys: [A.jwk] }, status: 200 };
    const g = gateWith(jwks);
    expect(await g.gate.refresh()).toBe(true);
    jwks.status = 503;
    expect(await g.gate.refresh()).toBe(false);
    jwks.status = 200;
    jwks.current = { keys: [] };
    expect(await g.gate.refresh()).toBe(false);
    expect(await g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: await good() }), "/")).toBeNull();
  });

  test("an unknown kid refetches once (key rotation), throttled", async () => {
    const jwks: Certs = { current: { keys: [A.jwk] } };
    const g = gateWith(jwks);
    await g.gate.refresh();
    jwks.current = { keys: [A.jwk, B.jwk] };
    const rotated = await good({}, B);
    // Fetched a moment ago: the throttle holds, so the new kid is not known yet.
    expect((await g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: rotated }), "/"))?.status).toBe(401);
    expect(g.fetches()).toBe(1);
    g.advance(31_000);
    expect(await g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: rotated }), "/")).toBeNull();
    expect(g.fetches()).toBe(2);
  });

  test("exempt requests pass even with no keys loaded", async () => {
    const g = gateWith({ current: {}, status: 500 });
    expect(await g.gate.admit(tunnelReq("/api/health"), "/api/health")).toBeNull();
    const local = new Request("http://127.0.0.1:8787/api/snapshot", { headers: { host: "127.0.0.1:8787" } });
    expect(await g.gate.admit(local, "/api/snapshot")).toBeNull();
  });
});

// The wiring, pinned by source: no `startServer` harness exists in this suite, so this proves the
// gate sits after the peer check and before the deposed page and every route.
test("server.ts consults the Access gate before the deposed page and the routes", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const peer = src.indexOf('text("non-loopback peer rejected", 403)');
  const gate = src.indexOf("await accessGate.admit(req, pathname)");
  const deposed = src.indexOf("opts.deposed?.(req, url)");
  const health = src.indexOf('pathname === "/api/health"');
  expect(peer).toBeGreaterThan(0);
  expect(gate).toBeGreaterThan(peer);
  expect(deposed).toBeGreaterThan(gate);
  expect(health).toBeGreaterThan(gate);
});
