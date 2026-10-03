import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  ACCESS_JWT_HEADER,
  DOOR_PRESETS,
  accessConfigProblem,
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
  const inits: (RequestInit | undefined)[] = [];
  const logs: string[] = [];
  const scheduled: number[] = [];
  const gate = createAccessGate(
    { accessTeam: team, accessAud: aud },
    {
      fetch: async (url, init) => {
        fetches++;
        urls.push(url);
        inits.push(init);
        // A tick, so concurrent callers really do overlap the fetch in flight.
        await Bun.sleep(1);
        return new Response(JSON.stringify(jwks.current), { status: jwks.status ?? 200 });
      },
      nowMs: () => now,
      log: (l) => logs.push(l),
      schedule: (_fn, ms) => scheduled.push(ms),
    },
  );
  if (gate === null) throw new Error("the gate is configured in every caller");
  return {
    gate,
    urls,
    inits,
    logs,
    scheduled,
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
  // The team becomes the host the keys are fetched from, so nothing may steer that host.
  test("refuses every value that could point the key fetch at another host", () => {
    for (const bad of [
      "evil.com/x?",
      "evil.com",
      "a.cloudflareaccess.com.evil.com",
      "https://a.cloudflareaccess.com.evil.com",
      "a@b",
      "https://user@myteam.cloudflareaccess.com",
      "https://user:pw@myteam.cloudflareaccess.com",
      "https://myteam.cloudflareaccess.com:8443",
      "myteam.cloudflareaccess.com:443",
      "https://myteam.cloudflareaccess.com/x",
      "https://myteam.cloudflareaccess.com/?a=1",
      "https://myteam.cloudflareaccess.com#x",
      "myteam.cloudflareaccess.com/",
      "a.b.cloudflareaccess.com",
      "-myteam",
      "myteam-",
      "x".repeat(64),
      "https://evil.com",
      "ftp://myteam.cloudflareaccess.com",
    ]) {
      expect(accessIssuer(bad)).toBeNull();
    }
    expect(accessIssuer("x".repeat(63))).toBe(`https://${"x".repeat(63)}.cloudflareaccess.com`);
  });
  test("a bad team is half a configuration: the gate refuses everything", async () => {
    const gate = createAccessGate({ accessTeam: "evil.com/x?", accessAud: [AUD] }, { log: () => {}, schedule: () => {} })!;
    expect(gate.configured).toBe(false);
    expect((await gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: "x" }), "/"))?.status).toBe(503);
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

  test("alg is pinned to RS256 before any key is looked at", async () => {
    const p = b64url(JSON.stringify(claims()));
    const keys = await keysOf(A);
    const withAlg = (header: JsonObject, sig: string) => `${b64url(JSON.stringify(header))}.${p}.${sig}`;
    for (const header of [
      { alg: "none", kid: "kid-a" },
      { alg: "HS256", kid: "kid-a" },
      { alg: "RS512", kid: "kid-a" },
      { alg: "rs256", kid: "kid-a" },
      { kid: "kid-a" },
      // An unknown kid still answers `alg`, not `unknown-kid`: the alg check comes first.
      { alg: "HS256", kid: "kid-nobody" },
    ]) {
      expect(await verifyAccessToken(withAlg(header, ""), keys, expect_)).toEqual({ ok: false, reason: "alg" });
      expect(await verifyAccessToken(withAlg(header, b64url("x")), keys, expect_)).toEqual({ ok: false, reason: "alg" });
    }
    // A real RS256 signature under a header claiming RS512 is still refused.
    const rs512 = await A.sign({ alg: "RS512", kid: "kid-a" }, claims());
    expect(await verifyAccessToken(rs512, keys, expect_)).toEqual({ ok: false, reason: "alg" });
  });

  test("the kid must match exactly: no kid, or a near miss, never falls back to the only key", async () => {
    const keys = await keysOf(A);
    for (const header of [{ alg: "RS256" }, { alg: "RS256", kid: "KID-A" }, { alg: "RS256", kid: "kid-a " }, { alg: "RS256", kid: 1 }]) {
      const t = await A.sign(header, claims());
      expect(await verifyAccessToken(t, keys, expect_)).toEqual({ ok: false, reason: "unknown-kid" });
    }
  });

  test("iss must match exactly", async () => {
    const keys = await keysOf(A);
    for (const iss of [`${ISS}/`, "https://MYTEAM.cloudflareaccess.com", "http://myteam.cloudflareaccess.com", undefined]) {
      expect(await verifyAccessToken(await good({ iss }), keys, expect_)).toEqual({ ok: false, reason: "iss" });
    }
  });

  test("aud: an array holding the tag passes, a string or array without it fails", async () => {
    const keys = await keysOf(A);
    expect(await verifyAccessToken(await good({ aud: ["other", AUD] }), keys, expect_)).toEqual({ ok: true });
    expect(await verifyAccessToken(await good({ aud: "other" }), keys, expect_)).toEqual({ ok: false, reason: "aud" });
    expect(await verifyAccessToken(await good({ aud: [] }), keys, expect_)).toEqual({ ok: false, reason: "aud" });
    expect(await verifyAccessToken(await good({ aud: undefined }), keys, expect_)).toEqual({ ok: false, reason: "aud" });
  });

  test("exp and nbf share the same minute of skew; nbf is optional", async () => {
    const keys = await keysOf(A);
    const v = async (over: JsonObject) => verifyAccessToken(await good(over), keys, expect_);
    expect(await v({ exp: NOW_S - 30 })).toEqual({ ok: true });
    expect(await v({ exp: NOW_S - 60 })).toEqual({ ok: false, reason: "exp" });
    expect(await v({ exp: String(NOW_S + 600) })).toEqual({ ok: false, reason: "exp" });
    expect(await v({ nbf: NOW_S + 30 })).toEqual({ ok: true });
    expect(await v({ nbf: NOW_S + 61 })).toEqual({ ok: false, reason: "nbf" });
    expect(await v({ nbf: String(NOW_S) })).toEqual({ ok: false, reason: "nbf" });
    expect(await v({ nbf: undefined })).toEqual({ ok: true });
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
  test("reads keys only; public_cert and public_certs never become keys", async () => {
    expect((await importAccessKeys({ public_cert: B.jwk, public_certs: [B.jwk] })).size).toBe(0);
    const keys = await importAccessKeys({ keys: [A.jwk], public_cert: B.jwk, public_certs: [B.jwk] });
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
  test("a tunnel with httpHostHeader: localhost is still gated, because the edge stamps cf-ray", () => {
    const r = new Request("http://127.0.0.1:8787/", {
      headers: { host: "localhost", "cf-ray": "8f00-FRA", "cf-connecting-ip": "203.0.113.9" },
    });
    expect(accessExempt(r, "/")).toBe(false);
  });
  test("a loopback Host with any forwarding header is NOT local, even with no cf-* header", () => {
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"]) {
      const r = new Request("http://127.0.0.1:8787/api/snapshot", { headers: { host: "127.0.0.1:8787", [h]: "x" } });
      expect(accessExempt(r, "/api/snapshot")).toBe(false);
    }
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

  test("a loopback Host behind a forwarding proxy and no token is refused", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    const r = new Request("http://127.0.0.1:8787/api/snapshot", {
      headers: { host: "127.0.0.1:8787", "x-forwarded-for": "100.64.0.7" },
    });
    expect((await g.gate.admit(r, "/api/snapshot"))?.status).toBe(401);
  });

  // `tailscale serve` on a host that also runs the tunnel: tailnet Host, X-Forwarded-For, no cf-*.
  // With Access configured that door needs a token too, and a browser on the tailnet has none.
  test("a tailnet request (bluefin:8788, X-Forwarded-For, no token) is refused with 401", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    const r = new Request("http://127.0.0.1:8788/api/snapshot", {
      headers: { host: "bluefin:8788", "x-forwarded-for": "100.64.0.7" },
    });
    expect(accessExempt(r, "/api/snapshot")).toBe(false);
    expect((await g.gate.admit(r, "/api/snapshot"))?.status).toBe(401);
  });

  test("half a configuration logs one line naming the missing setting, and never the tag", () => {
    for (const [s, needle] of [
      [{ accessTeam: "myteam", accessAud: [] }, "COLLIE_ACCESS_AUD is not"],
      [{ accessTeam: "", accessAud: [AUD] }, "COLLIE_ACCESS_TEAM is not"],
      [{ accessTeam: "evil.com/x?", accessAud: [AUD] }, "COLLIE_ACCESS_TEAM is not a Cloudflare Access team"],
    ] as const) {
      expect(accessConfigProblem(s)).toContain(needle);
      const logs: string[] = [];
      createAccessGate(s, { log: (l) => logs.push(l), schedule: () => {} })!.start();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(needle);
      expect(logs[0]).not.toContain(AUD);
    }
    expect(accessConfigProblem({ accessTeam: "myteam", accessAud: [AUD] })).toBeNull();
  });

  test("the first key load failure logs one ERROR line; retries stay quiet; recovery logs armed", async () => {
    const jwks: Certs = { current: {}, status: 500 };
    const g = gateWith(jwks);
    await g.gate.refresh();
    await g.gate.refresh();
    await g.gate.refresh();
    expect(g.logs).toHaveLength(1);
    expect(g.logs[0]).toContain("ERROR");
    expect(g.logs[0]).toContain("HTTP 500");
    expect(g.logs[0]).not.toContain(AUD);
    jwks.current = { keys: [A.jwk] };
    jwks.status = 200;
    await g.gate.refresh();
    expect(g.logs).toHaveLength(2);
    expect(g.logs[1]).toContain("armed");
  });

  test("the certs fetch refuses redirects and carries a 5 s timeout", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    expect(g.inits[0]?.redirect).toBe("error");
    expect(g.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a redirected or oversized certs answer is a failed load", async () => {
    const big = JSON.stringify({ keys: [A.jwk], pad: "x".repeat(70 * 1024) });
    for (const make of [
      () => {
        const r = new Response(JSON.stringify({ keys: [A.jwk] }));
        Object.defineProperty(r, "redirected", { value: true });
        return r;
      },
      () => new Response(big),
      // A streamed body with no Content-Length is cut off at the cap too.
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(big));
              c.close();
            },
          }),
        ),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/certs" } }),
    ]) {
      const gate = createAccessGate(
        { accessTeam: "myteam", accessAud: [AUD] },
        { fetch: async () => make(), log: () => {}, schedule: () => {}, nowMs: () => NOW_S * 1000 },
      )!;
      expect(await gate.refresh()).toBe(false);
    }
  });

  test("a failed start retries on its own 2 s rung, not the 30 s unknown-kid window", async () => {
    const jwks: Certs = { current: {}, status: 500 };
    const g = gateWith(jwks);
    g.gate.start();
    await Bun.sleep(5);
    expect(g.scheduled).toEqual([2_000]);
    jwks.current = { keys: [A.jwk] };
    jwks.status = 200;
    // A request two seconds later nudges a fetch of its own and is admitted.
    g.advance(2_000);
    expect(await g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: await good() }), "/")).toBeNull();
    expect(g.fetches()).toBe(2);
  });

  test("N concurrent garbage-kid requests cause one fetch, and none for 30 s after", async () => {
    const g = gateWith({ current: { keys: [A.jwk] } });
    await g.gate.refresh();
    g.advance(31_000);
    const garbage = (i: number) =>
      `${b64url(JSON.stringify({ alg: "RS256", kid: `junk-${i}` }))}.${b64url("{}")}.${b64url("x")}`;
    const answers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: garbage(i) }), "/")),
    );
    expect(answers.every((a) => a?.status === 401)).toBe(true);
    expect(g.fetches()).toBe(2);
    g.advance(29_000);
    await g.gate.admit(tunnelReq("/", { [ACCESS_JWT_HEADER]: garbage(99) }), "/");
    expect(g.fetches()).toBe(2);
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
    // Within the cold-start rung no refetch happens, so still closed.
    expect((await req())?.status).toBe(503);
    g.advance(2_000);
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
  // ADR 0081 says the gate checks every request, including each poll, because the bridge holds no
  // stream open. A WebSocket upgrade or an event stream would be checked once, at connect, and keep
  // running past the token's expiry: adding one must revisit the ADR, and this line fails first.
  expect(src).not.toMatch(/\.upgrade\(|websocket\s*:|text\/event-stream/);
});

describe("DOOR_PRESETS", () => {
  test("the cloudflare preset names its header, its one algorithm and its edge headers", () => {
    const p = DOOR_PRESETS.cloudflare;
    expect(p.header).toBe("cf-access-jwt-assertion");
    expect(p.alg).toBe("RS256");
    expect([...p.edgeHeaders]).toEqual(["cf-ray", "cf-connecting-ip", "cf-visitor"]);
    expect(p.issuer("myteam")).toBe(ISS);
    expect(p.jwksUrl(ISS)).toBe(`${ISS}/cdn-cgi/access/certs`);
  });
});
