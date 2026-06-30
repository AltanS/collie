import { describe, expect, test } from "bun:test";

import { checkAccess, deviceAuth } from "./server.ts";
import type { Config } from "./config.ts";

// checkAccess is the API security gate (same-origin/CSRF + optional Tailscale identity). A
// regression here silently opens remote shell access, so it gets the most direct coverage.

function req(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    pollMs: 1500,
    readLines: 200,
    submitKeys: ["Enter"],
    trustedUser: "",
    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    ...overrides,
  };
}

describe("checkAccess — same-origin / CSRF gate", () => {
  test("allows a request with no Origin header (same-origin GET)", () => {
    expect(checkAccess(req({ host: "collie.example.ts.net" }), cfg())).toEqual({ ok: true });
  });

  test("allows when the Origin host equals the Host header", () => {
    const r = checkAccess(
      req({ origin: "https://collie.example.ts.net", host: "collie.example.ts.net" }),
      cfg(),
    );
    expect(r).toEqual({ ok: true });
  });

  test("rejects a genuine cross-origin request", () => {
    const r = checkAccess(
      req({ origin: "https://evil.example.com", host: "collie.example.ts.net" }),
      cfg(),
    );
    expect(r).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("always allows a localhost / 127.0.0.1 origin (loopback by design)", () => {
    expect(
      checkAccess(req({ origin: "http://localhost:8787", host: "collie.example.ts.net" }), cfg()),
    ).toEqual({ ok: true });
    expect(checkAccess(req({ origin: "http://127.0.0.1:8787", host: "anything" }), cfg())).toEqual({
      ok: true,
    });
  });

  test("allows an explicitly-configured extra origin (COLLIE_ALLOWED_ORIGINS)", () => {
    const c = cfg({ allowedOrigins: ["https://collie.example.com"] });
    const r = checkAccess(
      req({ origin: "https://collie.example.com", host: "collie.example.ts.net" }),
      c,
    );
    expect(r).toEqual({ ok: true });
  });

  test("rejects an unparseable Origin", () => {
    expect(checkAccess(req({ origin: "notaurl", host: "h" }), cfg())).toEqual({
      ok: false,
      reason: "bad origin",
    });
  });
});

describe("checkAccess — Tailscale identity gate", () => {
  test("with no trusted user, any identity (or none) passes", () => {
    expect(checkAccess(req({ host: "h" }), cfg())).toEqual({ ok: true });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "anyone@example.com" }), cfg()),
    ).toEqual({ ok: true });
  });

  test("with a trusted user set, a matching login passes", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "me@example.com" }), c),
    ).toEqual({ ok: true });
  });

  test("with a trusted user set, a mismatching login is rejected", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "intruder@example.com" }), c),
    ).toEqual({ ok: false, reason: "identity not trusted" });
  });

  test("with a trusted user set, a missing header still passes (documented loopback tolerance)", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(checkAccess(req({ host: "h" }), c)).toEqual({ ok: true });
  });
});

describe("deviceAuth — per-device authorisation", () => {
  const HDR = "x-device-id";

  test("feature off: not enforced, fully authorised regardless of any header", () => {
    expect(deviceAuth(req({ host: "h" }), cfg())).toEqual({
      enforced: false,
      device: null,
      authorized: true,
    });
    // A stray header value is ignored entirely when the feature is off.
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), cfg())).toEqual({
      enforced: false,
      device: null,
      authorized: true,
    });
  });

  test("feature on, header absent: authorised and unchanged (on-host loopback operator)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h" }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: true,
    });
    // A blank/whitespace header value is treated as absent, not as a device named "".
    expect(deviceAuth(req({ host: "h", "x-device-id": "  " }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: true,
    });
  });

  test("feature on, allowlisted device: authorised and attributed (header is trimmed)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone", "laptop"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": " phone " }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: true,
    });
  });

  test("feature on, non-allowlisted device: read-only (attributed but not authorised)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "intruder" }), c)).toEqual({
      enforced: true,
      device: "intruder",
      authorized: false,
    });
  });

  test("the 'unknown' sentinel is never authorised, even if it appears in the allowlist", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["unknown"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "unknown" }), c)).toEqual({
      enforced: true,
      device: "unknown",
      authorized: false,
    });
  });

  test("feature on with an empty allowlist: every header-carrying device is read-only (fail-closed)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: [] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: false,
    });
  });
});
