import { describe, expect, test } from "bun:test";

import {
  BUILD_HEADER,
  cacheControlFor,
  checkAccess,
  launch,
  marksPaneSeen,
  SEEN_HEADER,
  deviceAuth,
  guard,
  historyParams,
  isHostAllowed,
  isReservedAuthPath,
  keysPane,
  normalizeTabLabel,
  paneReadResponse,
  replyPane,
  resolveStaticPath,
  sendReplySteps,
  startupWarnings,
  withBuildHeader,
  type ReplySender,
} from "./server.ts";
import { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";

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
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: true,
    journalRoots: {
      claude: ["/tmp/claude-projects"],
      codex: ["/nope/codex"],
      pi: ["/nope/pi"],
      opencode: ["/nope/opencode"],
    },
    submitKeys: ["Enter"],
    commandsFile: "/nope/commands.toml",
    keysFile: "/nope/keys.toml",
    launchersFile: "/nope/launchers.toml",
    trustedUser: "",
    auditContent: "preview",
    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    multiSession: true,
    skipServe: false,
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

describe("checkAccess — Host-header validation (COLLIE_PUBLIC_HOSTS)", () => {
  const c = cfg({ publicHosts: ["collie.example.ts.net"] });

  test("DNS-rebinding: Origin==Host==evil host is rejected once publicHosts is set", () => {
    expect(
      checkAccess(req({ origin: "http://evil.example.com", host: "evil.example.com" }), c),
    ).toEqual({ ok: false, reason: "host not allowed" });
    // Fails closed even for a write with a matching evil Origin.
    expect(
      checkAccess(req({ origin: "http://evil.example.com", host: "evil.example.com" }), c, "write"),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });

  test("a legit MagicDNS host with a matching Origin passes", () => {
    expect(
      checkAccess(
        req({ origin: "https://collie.example.ts.net", host: "collie.example.ts.net" }),
        c,
      ),
    ).toEqual({ ok: true });
  });

  test("loopback Host always passes even with publicHosts set (read and write)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), c)).toEqual({ ok: true });
    expect(checkAccess(req({ host: "localhost:8787" }), c, "write")).toEqual({ ok: true });
  });

  test("a Host derived from an allowed origin passes", () => {
    const c2 = cfg({
      publicHosts: ["collie.example.ts.net"],
      allowedOrigins: ["https://collie.example.com"],
    });
    expect(
      checkAccess(req({ origin: "https://collie.example.com", host: "collie.example.com" }), c2),
    ).toEqual({ ok: true });
  });

  test("empty publicHosts keeps legacy behaviour (Host==Origin==evil still passes reads)", () => {
    // Without opting in, an evil host that also sets a matching Origin passes the bare same-origin
    // check — the documented legacy hole COLLIE_PUBLIC_HOSTS closes. Proves the default is unchanged.
    expect(
      checkAccess(req({ origin: "https://evil.example.com", host: "evil.example.com" }), cfg()),
    ).toEqual({ ok: true });
  });
});

describe("checkAccess — Origin required for writes", () => {
  test("write with no Origin from a non-loopback Host is rejected", () => {
    expect(checkAccess(req({ host: "collie.example.ts.net" }), cfg(), "write")).toEqual({
      ok: false,
      reason: "origin required",
    });
  });

  test("write with no Origin from loopback is allowed (curl on the host)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), cfg(), "write")).toEqual({ ok: true });
  });

  test("read with no Origin from a non-loopback Host still passes (the snapshot poll)", () => {
    expect(checkAccess(req({ host: "collie.example.ts.net" }), cfg(), "read")).toEqual({ ok: true });
  });

  test("write WITH a matching Origin passes (normal browser POST)", () => {
    expect(
      checkAccess(
        req({ origin: "https://collie.example.ts.net", host: "collie.example.ts.net" }),
        cfg(),
        "write",
      ),
    ).toEqual({ ok: true });
  });
});

describe("isHostAllowed", () => {
  test("loopback forms are always allowed", () => {
    const c = cfg({ publicHosts: ["a.ts.net"] });
    expect(isHostAllowed("127.0.0.1:8787", c)).toBe(true);
    expect(isHostAllowed("localhost", c)).toBe(true);
    expect(isHostAllowed("[::1]:8787", c)).toBe(true);
  });

  test("configured public host and allowed-origin host pass; anything else fails", () => {
    const c = cfg({ publicHosts: ["a.ts.net"], allowedOrigins: ["https://b.example.com"] });
    expect(isHostAllowed("a.ts.net", c)).toBe(true);
    expect(isHostAllowed("b.example.com", c)).toBe(true);
    expect(isHostAllowed("evil.com", c)).toBe(false);
    expect(isHostAllowed("", c)).toBe(false);
  });
});

describe("resolveStaticPath — static path traversal guard", () => {
  const WEB = "/srv/collie/web/dist";

  test("resolves a normal file under the web dir", () => {
    expect(resolveStaticPath("/assets/app.js", WEB)).toEqual({
      rel: "assets/app.js",
      full: "/srv/collie/web/dist/assets/app.js",
    });
  });

  test("maps / to index.html", () => {
    expect(resolveStaticPath("/", WEB)).toEqual({
      rel: "index.html",
      full: "/srv/collie/web/dist/index.html",
    });
  });

  test("rejects a .. traversal attempt", () => {
    expect(resolveStaticPath("/../../etc/passwd", WEB)).toBeNull();
  });

  test("rejects a sibling dir that merely shares the prefix (web/dist-x)", () => {
    // normalize(join(WEB, "../dist-x/evil.js")) === "/srv/collie/web/dist-x/evil.js" — a bare
    // startsWith(WEB) would accept it; the `+ sep` boundary is what rejects it.
    expect(resolveStaticPath("/../dist-x/evil.js", WEB)).toBeNull();
  });
});

describe("sendReplySteps — two-step send & partial-failure clarity", () => {
  // A fake client that records calls and can be told to fail either step.
  class FakeClient implements ReplySender {
    readonly calls: string[] = [];
    constructor(private readonly failOn?: "text" | "keys") {}
    sendPaneText(_paneId: string, _text: string): Promise<void> {
      this.calls.push("text");
      return this.failOn === "text" ? Promise.reject(new Error("text rejected")) : Promise.resolve();
    }
    sendPaneKeys(_paneId: string, _keys: string[]): Promise<void> {
      this.calls.push("keys");
      return this.failOn === "keys" ? Promise.reject(new Error("keys rejected")) : Promise.resolve();
    }
  }

  const noSleep = async () => {};

  test("types then submits on the happy path", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text lands but submit fails → distinguishable error + textDelivered:true (don't resend)", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({
      ok: false,
      textDelivered: true,
      error: "typed into the pane but not submitted — check the pane before resending",
    });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text step fails → nothing delivered, surfaces Herdr's message (safe to resend)", async () => {
    const client = new FakeClient("text");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "text rejected" });
    expect(client.calls).toEqual(["text"]); // never reached the keys step
  });

  test("submit-only (empty text) failure is a plain failure, not the partial-delivery message", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "keys rejected" });
    expect(client.calls).toEqual(["keys"]); // no text typed
  });

  test("no-submit reply just types the text", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", false, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text"]);
  });
});

describe("pane write prompt binding", () => {
  type ReadArgs = Parameters<HerdrClient["readPane"]>;

  class FakePaneClient {
    text = "Approve this command?\n1. Yes\n2. No";
    readonly reads: ReadArgs[] = [];
    readonly texts: Array<[string, string]> = [];
    readonly keys: Array<[string, string[]]> = [];

    readPane(
      paneId: string,
      source: ReadArgs[1],
      lines: number,
      format: ReadArgs[3],
    ): Promise<PaneRead> {
      this.reads.push([paneId, source, lines, format]);
      return Promise.resolve({
        pane_id: paneId,
        text: this.text,
        truncated: false,
        revision: 1,
      });
    }

    sendPaneText(paneId: string, text: string): Promise<void> {
      this.texts.push([paneId, text]);
      return Promise.resolve();
    }

    sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
      this.keys.push([paneId, keys]);
      return Promise.resolve();
    }
  }

  function request(body: unknown): Request {
    return new Request("http://localhost/api/pane/w1%3Ap1/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function auditEntries(): { audit: AuditLog; entries: Array<Record<string, unknown>> } {
    const entries: Array<Record<string, unknown>> = [];
    return {
      audit: new AuditLog((line) => {
        entries.push(JSON.parse(line));
      }),
      entries,
    };
  }

  test("keys without expected_prompt writes without an extra pane read", async () => {
    const client = new FakePaneClient();
    const { audit } = auditEntries();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({ keys: ["1"] }),
      audit,
      null,
      "default",
    );
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([]);
    expect(client.keys).toEqual([["w1:p1", ["1"]]]);
  });

  test("reply without expected_prompt writes without an extra pane read", async () => {
    const client = new FakePaneClient();
    const { audit } = auditEntries();
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({ text: "hello", submit: false }),
      audit,
      null,
      "default",
    );
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([]);
    expect(client.texts).toEqual([["w1:p1", "hello"]]);
  });

  test("matching expected_prompt reads the GET window then sends keys", async () => {
    const client = new FakePaneClient();
    const { audit, entries } = auditEntries();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg({ readLines: 321 }),
      "w1:p1",
      request({ keys: ["1"], expected_prompt: "Approve this command?\n1. Yes\n2. No" }),
      audit,
      "phone",
      "default",
    );
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([["w1:p1", "recent", 321, "ansi"]]);
    expect(client.keys).toEqual([["w1:p1", ["1"]]]);
    expect(entries[0]?.detail).toMatchObject({
      promptBinding: { checked: true, passed: true },
    });
  });

  test("binding read depth grows beyond a small configured window to contain the expectation", async () => {
    const client = new FakePaneClient();
    const expected = Array.from({ length: 32 }, (_, index) => `prompt line ${index + 1}`).join("\n");
    client.text = expected;
    const { audit } = auditEntries();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg({ readLines: 20 }),
      "w1:p1",
      request({ keys: ["1"], expected_prompt: expected }),
      audit,
      null,
      "default",
    );

    expect(res.status).toBe(200);
    expect(client.reads).toHaveLength(1);
    expect(client.reads[0]?.[0]).toBe("w1:p1");
    expect(client.reads[0]?.[1]).toBe("recent");
    expect(client.reads[0]?.[2]).toBeGreaterThan(32);
    expect(client.reads[0]?.[3]).toBe("ansi");
    expect(client.keys).toEqual([["w1:p1", ["1"]]]);
  });

  test("matching expected_prompt reads the GET window then sends reply text", async () => {
    const client = new FakePaneClient();
    const { audit } = auditEntries();
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg({ readLines: 321 }),
      "w1:p1",
      request({
        text: "hello",
        submit: false,
        expected_prompt: "Approve this command?\n1. Yes\n2. No",
      }),
      audit,
      null,
      "default",
    );
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([["w1:p1", "recent", 321, "ansi"]]);
    expect(client.texts).toEqual([["w1:p1", "hello"]]);
  });

  test("stale expected_prompt returns prompt_changed and sends no keys", async () => {
    const client = new FakePaneClient();
    client.text = "Command finished";
    const { audit, entries } = auditEntries();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({ keys: ["1"], expected_prompt: "Approve this command?\n1. Yes\n2. No" }),
      audit,
      null,
      "default",
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
    expect(client.keys).toEqual([]);
    expect(client.texts).toEqual([]);
    expect(entries[0]?.detail).toMatchObject({
      promptBinding: { checked: true, passed: false, reason: "not_found" },
    });
  });

  test("stale expected_prompt returns prompt_changed and sends no reply text or keys", async () => {
    const client = new FakePaneClient();
    client.text = "Command finished";
    const { audit } = auditEntries();
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({
        text: "hello",
        submit: true,
        expected_prompt: "Approve this command?\n1. Yes\n2. No",
      }),
      audit,
      null,
      "default",
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "prompt_changed" });
    expect(client.keys).toEqual([]);
    expect(client.texts).toEqual([]);
  });

  test("rejects oversized and non-string expected_prompt before a keys write", async () => {
    for (const expected_prompt of ["x".repeat(8193), 42]) {
      const client = new FakePaneClient();
      const { audit } = auditEntries();
      const res = await keysPane(
        client as unknown as HerdrClient,
        cfg(),
        "w1:p1",
        request({ keys: ["1"], expected_prompt }),
        audit,
        null,
        "default",
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("bad expected_prompt");
      expect(client.reads).toEqual([]);
      expect(client.keys).toEqual([]);
    }
  });

  test("rejects oversized and non-string expected_prompt before a reply write", async () => {
    for (const expected_prompt of ["x".repeat(8193), null]) {
      const client = new FakePaneClient();
      const { audit } = auditEntries();
      const res = await replyPane(
        client as unknown as HerdrClient,
        cfg(),
        "w1:p1",
        request({ text: "hello", expected_prompt }),
        audit,
        null,
        "default",
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("bad expected_prompt");
      expect(client.reads).toEqual([]);
      expect(client.texts).toEqual([]);
      expect(client.keys).toEqual([]);
    }
  });
});

describe("paneReadResponse — pane read → REST body", () => {
  test("passes text, truncated, and the monotonic revision through", () => {
    const read: PaneRead = { pane_id: "w1:p1", text: "hello", truncated: true, revision: 42 };
    expect(paneReadResponse("w1:p1", read)).toEqual({
      paneId: "w1:p1",
      text: "hello",
      truncated: true,
      revision: 42,
    });
  });

  test("carries a zero revision unchanged (fresh pane) rather than dropping the field", () => {
    const read: PaneRead = { pane_id: "w2:p1", text: "", truncated: false, revision: 0 };
    expect(paneReadResponse("w2:p1", read)).toEqual({
      paneId: "w2:p1",
      text: "",
      truncated: false,
      revision: 0,
    });
  });
});

describe("historyParams — transcript paging params", () => {
  const params = (qs: string) => historyParams(new URL(`http://x/api/pane/w1:p1/history${qs}`));

  test("no params means the newest page at the default size", () => {
    expect(params("")).toEqual({ limit: 200 });
  });

  test("an explicit limit is honoured", () => {
    expect(params("?limit=10")).toEqual({ limit: 10 });
  });

  // "Show entire history" asks for the whole conversation, so the ceiling is a safety net against a
  // pathological log rather than a paging window.
  test("an absurd limit is clamped to the safety ceiling", () => {
    expect(params("?limit=99999")).toEqual({ limit: 5000 });
  });

  test.each([["zero", "?limit=0"], ["negative", "?limit=-5"], ["garbage", "?limit=abc"]])(
    "a %s limit falls back to the default",
    (_label, qs) => {
      expect(params(qs).limit).toBe(200);
    },
  );

  test("a cursor is carried through as an opaque string", () => {
    expect(params("?before=abc-123")).toEqual({ limit: 200, before: "abc-123" });
  });

  test("an absurdly long cursor is dropped rather than carried", () => {
    expect(params(`?before=${"x".repeat(500)}`)).toEqual({ limit: 200 });
  });

  test("an empty cursor is omitted, not passed as an empty match", () => {
    expect(params("?before=")).toEqual({ limit: 200 });
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

  test("feature on, header absent: refused", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h" }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
    // A blank/whitespace header value is treated as absent, not as a device named "".
    expect(deviceAuth(req({ host: "h", "x-device-id": "  " }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
  });

  // The absent-header case has no loopback exemption, and a loopback-looking Host must not create
  // one by the back door: Host is set by the caller and rewritten by the proxy, so it attests
  // nothing. This pins that no future "but it came from localhost" shortcut sneaks in here.
  test("feature on, header absent: a loopback Host does not buy an exemption", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    for (const host of ["127.0.0.1", "127.0.0.1:8787", "localhost", "[::1]:8787"]) {
      expect(deviceAuth(req({ host }), c).authorized).toBe(false);
    }
  });
});

// deviceAuth being right in isolation proves nothing if the wiring in guard() regresses, and that
// wiring is where the whole gate lives: it consults deviceAuth for "write" and deliberately not for
// "read". Both halves are asserted here, so neither the gate nor the read-only scope can drift
// silently. The write cases carry a matching Origin so checkAccess passes and the device decision is
// the only thing under test.
describe("guard applies the device gate to writes only", () => {
  const HDR = "x-device-id";
  const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
  const write = (headers: Record<string, string>) =>
    guard(req({ host: "collie.ts.net", origin: "https://collie.ts.net", ...headers }), c, "write");
  const read = (headers: Record<string, string>) =>
    guard(req({ host: "collie.ts.net", ...headers }), c, "read");

  test("write with no device header is refused with 403", () => {
    const denied = write({});
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  test("write with a non-allowlisted device is refused with 403", () => {
    const denied = write({ "x-device-id": "intruder" });
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  test("write with an allowlisted device proceeds", () => {
    expect(write({ "x-device-id": "phone" })).toBeNull();
  });

  // The scope of the gate, stated as a test rather than only in prose: a header-less caller keeps
  // READ access (it is read-only, not rejected outright). If someone later tightens this, it should
  // be a deliberate change with this test updated, not an accident.
  test("read with no device header still proceeds (read-only, not rejected)", () => {
    expect(read({})).toBeNull();
    expect(read({ "x-device-id": "intruder" })).toBeNull();
  });

  test("with the feature off, a write with no device header proceeds", () => {
    expect(guard(req({ host: "127.0.0.1:8787" }), cfg(), "write")).toBeNull();
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

describe("startupWarnings — security-posture nags", () => {
  const has = (ws: string[], needle: string) => ws.some((w) => w.includes(needle));

  test("skipServe + trustedUser: warns the identity gate is inert and points at the device header", () => {
    const ws = startupWarnings(cfg({ skipServe: true, trustedUser: "me@example.com" }));
    expect(has(ws, "COLLIE_TRUSTED_USER has no effect")).toBe(true);
    expect(has(ws, "COLLIE_DEVICE_HEADER")).toBe(true);
    // The pointer must name the doc the variant actually lives in — B–E moved to DEPLOYMENT.md in
    // 0.31.0, while Variant A stayed in the README (pinned in the empty-trustedUser test below).
    expect(has(ws, "DEPLOYMENT.md → Variant C")).toBe(true);
    // The Variant-A empty-trustedUser nag must NOT also fire (it's meaningless behind a proxy).
    expect(has(ws, "any tailnet device/user")).toBe(false);
  });

  test("skipServe + empty trustedUser: no empty-trustedUser warning at all", () => {
    const ws = startupWarnings(cfg({ skipServe: true, trustedUser: "" }));
    expect(has(ws, "COLLIE_TRUSTED_USER")).toBe(false);
  });

  test("no skipServe + empty trustedUser: the existing Variant-A warning still fires", () => {
    const ws = startupWarnings(cfg({ skipServe: false, trustedUser: "" }));
    expect(has(ws, "COLLIE_TRUSTED_USER is empty")).toBe(true);
    expect(has(ws, "README → Variant A")).toBe(true);
  });

  test("no skipServe + trustedUser set: no identity warning (correctly configured)", () => {
    const ws = startupWarnings(cfg({ skipServe: false, trustedUser: "me@example.com" }));
    expect(has(ws, "COLLIE_TRUSTED_USER")).toBe(false);
  });

  test("empty publicHosts: the Host-validation warning fires and no longer names COLLIE_SERVE_MODE", () => {
    const ws = startupWarnings(cfg({ publicHosts: [] }));
    expect(has(ws, "COLLIE_PUBLIC_HOSTS is empty")).toBe(true);
    // The reworded clause must not reference the script-only COLLIE_SERVE_MODE var.
    expect(has(ws, "COLLIE_SERVE_MODE")).toBe(false);
  });

  test("populated publicHosts: no Host-validation warning", () => {
    const ws = startupWarnings(cfg({ publicHosts: ["collie.example.ts.net"] }));
    expect(has(ws, "COLLIE_PUBLIC_HOSTS")).toBe(false);
  });
});

// A tab's label is a non-null, non-empty string (herdr rejects null and stores "" literally — no
// "clear" for a tab, unlike a pane). normalizeTabLabel is the gate that enforces that before the RPC.
describe("normalizeTabLabel", () => {
  test("accepts a non-empty string, trimming surrounding whitespace", () => {
    expect(normalizeTabLabel("deploy")).toEqual({ ok: true, label: "deploy" });
    expect(normalizeTabLabel("  deploy  ")).toEqual({ ok: true, label: "deploy" });
  });

  test("rejects a blank label (empty or whitespace-only) — a tab has no clear", () => {
    expect(normalizeTabLabel("")).toEqual({ ok: false, error: "label required" });
    expect(normalizeTabLabel("   ")).toEqual({ ok: false, error: "label required" });
  });

  test("rejects a non-string label (null / number / missing)", () => {
    expect(normalizeTabLabel(null)).toEqual({ ok: false, error: "bad label" });
    expect(normalizeTabLabel(42)).toEqual({ ok: false, error: "bad label" });
    expect(normalizeTabLabel(undefined)).toEqual({ ok: false, error: "bad label" });
  });
});

// The X-Collie-Build response header is what a no-service-worker client polls to notice a live
// rebuild (web/src/lib/server-build.ts). withBuildHeader is the pure attach helper; the handlers
// that call it (snapshot/pane) stay untested by convention (they need Bun.serve + the socket).
describe("withBuildHeader", () => {
  test("sets the build header to the given id and returns the same response", () => {
    const res = new Response("body");
    const out = withBuildHeader(res, "0.13.0+abc.123");
    expect(out).toBe(res);
    expect(out.headers.get(BUILD_HEADER)).toBe("0.13.0+abc.123");
    expect(BUILD_HEADER).toBe("x-collie-build");
  });

  test("overwrites any existing build header (last write wins)", () => {
    const res = new Response(null, { headers: { [BUILD_HEADER]: "old" } });
    withBuildHeader(res, "new");
    expect(res.headers.get(BUILD_HEADER)).toBe("new");
  });

  test("preserves a 304's empty body and status", async () => {
    const res = withBuildHeader(new Response(null, { status: 304 }), "id-1");
    expect(res.status).toBe(304);
    expect(res.headers.get(BUILD_HEADER)).toBe("id-1");
    expect(await res.text()).toBe("");
  });
});

// Cache-Control selection for served dist files. Hashed assets cache hard; every other (mutable)
// dist file — crucially sw.js, which shipped with NO Cache-Control before — must be no-cache so a
// browser or reverse proxy always revalidates it and can't wedge the update pipeline on a stale copy.
describe("cacheControlFor", () => {
  test("hashed assets under assets/ are immutable", () => {
    expect(cacheControlFor("assets/index-B7cWgJ3M.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("assets/index-abc.css")).toBe("public, max-age=31536000, immutable");
  });

  test("sw.js and every other mutable dist-root file are no-cache", () => {
    for (const rel of [
      "sw.js",
      "index.html",
      "manifest.webmanifest",
      "build-info.json",
      "favicon.svg",
      "favicon.ico",
      "apple-touch-icon.png",
    ]) {
      expect(cacheControlFor(rel)).toBe("no-cache");
    }
  });
});

// The other end of web/src/lib/sw-routes.ts. The service worker hands `/auth/` to the network; if
// the bridge doesn't recognise the same set, the SPA fallback answers with the app shell and the
// operator gets the very UI they were trying to escape. These two must agree exactly.
describe("isReservedAuthPath — the namespace a fronting proxy owns", () => {
  test("claims /auth with or without a trailing slash, and everything beneath it", () => {
    expect(isReservedAuthPath("/auth")).toBe(true);
    expect(isReservedAuthPath("/auth/")).toBe(true);
    expect(isReservedAuthPath("/auth/sign-in")).toBe(true);
    expect(isReservedAuthPath("/auth/oidc/callback")).toBe(true);
  });

  test("leaves Collie's own routes alone, including a mere prefix match", () => {
    for (const path of ["/", "/settings", "/pane/w1:p1", "/authors", "/api/snapshot"]) {
      expect(isReservedAuthPath(path)).toBe(false);
    }
  });
});

// marksPaneSeen guards the one place a READ mutates server state. checkAccess lets a read through
// without an Origin (browsers omit it on same-origin GETs), so without this a cross-site <img> at a
// guessed pane id could silently clear the "Ready · unseen" section.
describe("marksPaneSeen — CSRF guard on marking a pane seen", () => {
  const withHeader = (h: Record<string, string> = {}) => new Request("http://x/api/pane/w1:p1", { headers: h });

  test("a read carrying the client header counts — only our own page can set it", () => {
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "1" }), undefined)).toBe(true);
  });

  test("a bare cross-site GET does NOT count", () => {
    // What an <img src="…/api/pane/w1:p1"> produces: no Origin, no custom header.
    expect(marksPaneSeen(withHeader(), undefined)).toBe(false);
  });

  test("history is a read — it needs the header too", () => {
    expect(marksPaneSeen(withHeader(), "history")).toBe(false);
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "1" }), "history")).toBe(true);
  });

  test("write actions count without it — they already cleared the Origin-requiring write gate", () => {
    for (const action of ["reply", "keys", "upload", "close", "rename"]) {
      expect(marksPaneSeen(withHeader(), action)).toBe(true);
    }
  });

  test("any header value counts — presence is the proof, not the contents", () => {
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "" }), undefined)).toBe(true);
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "anything" }), undefined)).toBe(true);
  });
});

// POST /api/launch — the launcher strip's one-tap: a workspace whose cwd/label come from the row,
// then the command + Enter typed into its fresh shell. The allowlist is the configured rows themselves.
describe("launch — allowlisted workspace.create + pane.send_text/keys", () => {
  function request(body: unknown): Request {
    return new Request("http://localhost/api/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function auditEntries(): { audit: AuditLog; entries: Array<Record<string, unknown>> } {
    const entries: Array<Record<string, unknown>> = [];
    return {
      audit: new AuditLog((line) => {
        entries.push(JSON.parse(line));
      }),
      entries,
    };
  }

  // Minimal fake herdr that records createWorkspace + send calls. Close exists only to verify rollback.
  class FakeLaunchClient {
    createArgs: unknown = null;
    readonly texts: Array<[string, string]> = [];
    readonly keys: Array<[string, string[]]> = [];
    closes: string[] = [];
    failOn: "create" | "text" | "keys" | null = null;
    createResult = {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "MySpace",
      tabId: "w1:t1",
      cwd: "/home/op",
    };

    async createWorkspace(opts: { cwd: string; label?: string }): Promise<typeof this.createResult> {
      this.createArgs = opts;
      if (this.failOn === "create") throw new Error("create failed");
      return this.createResult;
    }

    async sendPaneText(paneId: string, text: string): Promise<void> {
      this.texts.push([paneId, text]);
      if (this.failOn === "text") throw new Error("text failed");
    }

    async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
      this.keys.push([paneId, keys]);
      if (this.failOn === "keys") throw new Error("keys failed");
    }

    async closePane(paneId: string): Promise<void> {
      this.closes.push(paneId);
    }
  }

  function getLaunchers(commands: Array<{ command: string; label: string; cwd: string }>) {
    return async () => commands;
  }

  test("unlisted command rejected without creating anything", async () => {
    const client = new FakeLaunchClient();
    const { audit, entries } = auditEntries();
    const res = await launch(
      client as unknown as HerdrClient,
      request({ command: "intruder" }),
      audit,
      null,
      "default",
      getLaunchers([{ command: "rumen-peek", label: "Runs & quota", cwd: "/home/op" }]),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(client.createArgs).toBeNull();
    expect(client.texts).toEqual([]);
    expect(client.keys).toEqual([]);
    expect(entries).toHaveLength(0);
  });

  test("a listed row creates a workspace with that row's label AND cwd and types command + Enter", async () => {
    const client = new FakeLaunchClient();
    const { audit, entries } = auditEntries();
    const res = await launch(
      client as unknown as HerdrClient,
      request({ command: "rumen-peek" }),
      audit,
      null,
      "default",
      getLaunchers([{ command: "rumen-peek", label: "Runs & quota", cwd: "/home/op/project" }]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Workspace created with the row's cwd and label (same threat model as createWorkspace).
    expect(client.createArgs).toEqual({ cwd: "/home/op/project", label: "Runs & quota" });
    // Command typed verbatim plus a bare Enter — NOT cfg.submitKeys.
    expect(client.texts).toEqual([["w1:p1", "rumen-peek"]]);
    expect(client.keys).toEqual([["w1:p1", ["Enter"]]]);
    // Audited as workspace.launch with the explicit detail the envelope already answers.
    expect(entries[0]?.action).toBe("workspace.launch");
    expect(entries[0]?.detail).toEqual({
      command: "rumen-peek",
      label: "Runs & quota",
      cwd: "/home/op/project",
    });
  });

  test("a send failure closes the created pane and answers ok:false", async () => {
    const client = new FakeLaunchClient();
    client.failOn = "keys";
    const { audit } = auditEntries();
    const res = await launch(
      client as unknown as HerdrClient,
      request({ command: "rumen-peek" }),
      audit,
      null,
      "default",
      getLaunchers([{ command: "rumen-peek", label: "Runs", cwd: "/home/op" }]),
    );
    // Must not leave a half-born Space behind — the pane is closed.
    expect(client.closes).toEqual(["w1:p1"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  test("a closePane failure during rollback is swallowed, still answering ok:false", async () => {
    const client = new FakeLaunchClient();
    client.failOn = "text";
    // Make close itself fail.
    client.closePane = async () => {
      throw new Error("close failed");
    };
    const { audit } = auditEntries();
    const res = await launch(
      client as unknown as HerdrClient,
      request({ command: "rumen-peek" }),
      audit,
      null,
      "default",
      getLaunchers([{ command: "rumen-peek", label: "Runs", cwd: "/home/op" }]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

