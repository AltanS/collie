import { describe, expect, test } from "bun:test";

import {
  bridgeConfigBody,
  muxConfigBody,
  muxLogoResponse,
  BUILD_HEADER,
  cacheControlFor,
  checkAccess,
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
  parsePairRequest,
  parseSnoozeRequest,
  replyPane,
  requestDevice,
  resolveStaticPath,
  sendReplySteps,
  startupWarnings,
  withBuildHeader,
  type ReplySender,
} from "./server.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuditLog, type AuditEntry } from "./audit.ts";
import type { Config } from "./config.ts";
import { declareCapabilities, MUX_CAPABILITIES } from "./mux/capabilities.ts";
import { withAgentBeacons } from "./beacon/decorate.ts";
import { fakeBeaconReader } from "./beacon/fake.ts";
import { withAgentHints } from "./beacon/hint.ts";
import { HerdrMux, herdrMuxFactory } from "./mux/herdr/adapter.ts";
import { tmuxMuxFactory } from "./mux/tmux/adapter.ts";
import type { HerdrClient, PaneRead } from "./mux/herdr/client.ts";
import { muxAck, type MuxAck, type MuxAdapter, type MuxGrid } from "./mux/types.ts";
import { neverProxy } from "./pack/fixtures.ts";
import { PackLead } from "./pack/lead.ts";
import { PackRegistry } from "./pack/registry.ts";
import { computeEtag } from "./http-cache.ts";
import { MUX_LOGO_PATH, type SnapshotResponse } from "./types.ts";

// checkAccess is the API security gate (same-origin/CSRF + optional Tailscale identity). A
// regression here silently opens remote shell access, so it gets the most direct coverage.

// A real Request, not a fake: checkAccess reads only headers, and Bun's Headers already does the
// case-insensitive lookup (and keeps `host`, which a browser would strip) — so there is nothing left
// for a hand-rolled stub to get subtly wrong.
function req(headers: Record<string, string>): Request {
  return new Request("http://collie.invalid/api/snapshot", { headers });
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    mux: "herdr",
    muxEndpoint: "/tmp/herdr.sock",
    tmuxBin: "",
    zellijBin: "",
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
      grok: ["/nope/grok"],
    },
    submitKeys: ["Enter"],
    commandsFile: "/nope/commands.toml",
    keysFile: "/nope/keys.toml",
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
    typeText(_paneId: string, _text: string): Promise<MuxAck> {
      this.calls.push("text");
      return this.failOn === "text" ? Promise.reject(new Error("text rejected")) : Promise.resolve(muxAck());
    }
    sendKeys(_paneId: string, _keys: readonly string[]): Promise<MuxAck> {
      this.calls.push("keys");
      return this.failOn === "keys" ? Promise.reject(new Error("keys rejected")) : Promise.resolve(muxAck());
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
      code: "reply.not_submitted",
    });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text step fails → nothing delivered, surfaces Herdr's message (safe to resend)", async () => {
    const client = new FakeClient("text");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    // The English is byte-for-byte the multiplexer's own words, as it always was; `code` and
    // `detail.reason` are the machine half the phone translates against (bridge/error-codes.ts).
    expect(out).toEqual({
      ok: false,
      textDelivered: false,
      error: "text rejected",
      code: "reply.send_failed",
      detail: { reason: "text rejected" },
    });
    expect(client.calls).toEqual(["text"]); // never reached the keys step
  });

  test("submit-only (empty text) failure is a plain failure, not the partial-delivery message", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "", true, ["Enter"], noSleep);
    expect(out).toEqual({
      ok: false,
      textDelivered: false,
      error: "keys rejected",
      code: "reply.send_failed",
      detail: { reason: "keys rejected" },
    });
    expect(client.calls).toEqual(["keys"]); // no text typed
  });

  test("no-submit reply just types the text", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", false, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text"]);
  });
});

/**
 * HerdrClient carries private socket fields, so no fake can ever *be* one structurally.
 * `Partial<HerdrClient>` keeps the compiler checking every method a fake DOES supply against the
 * real client's signature — the only step asserted is "the rest is never reached".
 */
function asMux(fake: Partial<HerdrClient>): MuxAdapter {
  // SAFETY: the pane-write handlers under test reach exactly readPane / sendPaneText / sendPaneKeys,
  // all of which FakePaneClient implements; no other member is reachable from these code paths.
  return new HerdrMux(fake as HerdrClient);
}

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

  /**
   * A pane-action body as the phone posts it. `expected_prompt` is deliberately wider than the
   * handler's contract: two tests below post a non-string on purpose, and rejecting that IS the
   * behaviour under test, so the fixture type has to be able to express it.
   */
  interface PaneActionBody {
    keys?: string[];
    text?: string;
    submit?: boolean;
    expected_prompt?: string | number | null;
  }

  function request(body: PaneActionBody): Request {
    return new Request("http://localhost/api/pane/w1%3Ap1/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** One audit line as `JSON.parse` returns it: the entry as written, plus formatAuditLine's stamp. */
  type AuditLine = AuditEntry & { ts: string };

  function auditEntries() {
    const entries: AuditLine[] = [];
    return {
      audit: new AuditLog((line) => {
        // SAFETY: the appender is handed formatAuditLine's own output — this test never feeds it
        // anything else — so the parse round-trips the AuditEntry it just serialised.
        entries.push(JSON.parse(line) as AuditLine);
      }),
      entries,
    };
  }

  test("keys without expected_prompt writes without an extra pane read", async () => {
    const client = new FakePaneClient();
    const { audit } = auditEntries();
    const res = await keysPane(
      asMux(client),
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
      asMux(client),
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
      asMux(client),
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
      asMux(client),
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
      asMux(client),
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
      asMux(client),
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
      asMux(client),
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

  test("a refused key batch carries the multiplexer's words AND a code the phone can translate", async () => {
    // The refusal an operator actually meets: the words are the multiplexer's, so they stay byte for
    // byte what they were, and the machine half rides beside them (bridge/error-codes.ts). A client
    // with no translation shows `error`; one with a translation reads `code` and quotes
    // `detail.reason`.
    const client = new FakePaneClient();
    client.sendPaneKeys = () => Promise.reject(new Error("no such pane"));
    const { audit } = auditEntries();
    const res = await keysPane(asMux(client), cfg(), "w1:p1", request({ keys: ["1"] }), audit, null, "default");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: "no such pane",
      code: "keys.send_failed",
      detail: { reason: "no such pane" },
    });
  });

  test("rejects oversized and non-string expected_prompt before a keys write", async () => {
    for (const expected_prompt of ["x".repeat(8193), 42]) {
      const client = new FakePaneClient();
      const { audit } = auditEntries();
      const res = await keysPane(
        asMux(client),
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
        asMux(client),
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
    const read: MuxGrid = { paneId: "w1:p1", text: "hello", truncated: true, revision: 42 };
    expect(paneReadResponse("w1:p1", read)).toEqual({
      paneId: "w1:p1",
      text: "hello",
      truncated: true,
      revision: 42,
    });
  });

  test("carries a zero revision unchanged (fresh pane) rather than dropping the field", () => {
    const read: MuxGrid = { paneId: "w2:p1", text: "", truncated: false, revision: 0 };
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
    const authCfg = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone", "laptop"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": " phone " }), authCfg)).toEqual({
      enforced: true,
      device: "phone",
      authorized: true,
    });
  });

  test("feature on, non-allowlisted device: read-only (attributed but not authorised)", () => {
    const authCfg = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "intruder" }), authCfg)).toEqual({
      enforced: true,
      device: "intruder",
      authorized: false,
    });
  });

  test("the 'unknown' sentinel is never authorised, even if it appears in the allowlist", () => {
    const authCfg = cfg({ deviceHeader: HDR, deviceAllowlist: ["unknown"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "unknown" }), authCfg)).toEqual({
      enforced: true,
      device: "unknown",
      authorized: false,
    });
  });

  test("feature on with an empty allowlist: every header-carrying device is read-only (fail-closed)", () => {
    const authCfg = cfg({ deviceHeader: HDR, deviceAllowlist: [] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), authCfg)).toEqual({
      enforced: true,
      device: "phone",
      authorized: false,
    });
  });
});

// ── Device pairing composed into the write gate (bridge/pairing.ts) ────────────────────────────
// The pairing module is exhaustively covered in bridge/pairing.test.ts. What is pinned HERE is the
// wiring — which is where a security feature actually lives: that an empty registry changes nothing,
// that a non-empty one gates writes and not reads, that the two device gates compose by AND rather
// than either replacing the other, and that attribution prefers the label.
describe("guard — the pairing gate composes with the header gate", () => {
  const HDR = "x-device-id";
  /** A minimal PairingGate: `labels` are the paired tokens, keyed by token. */
  const gateOf = (tokens: Record<string, string>) => ({
    enforced: () => Object.keys(tokens).length > 0,
    resolve: (token: string | null) =>
      token !== null && tokens[token] !== undefined ? { label: tokens[token]! } : null,
  });
  const paired = gateOf({ "tok-phone": "phone" });
  const nothingPaired = gateOf({});

  const write = (c: Config, headers: Record<string, string>, gate?: ReturnType<typeof gateOf>) =>
    guard(req({ host: "collie.ts.net", origin: "https://collie.ts.net", ...headers }), c, "write", gate);
  const read = (c: Config, headers: Record<string, string>, gate?: ReturnType<typeof gateOf>) =>
    guard(req({ host: "collie.ts.net", ...headers }), c, "read", gate);

  test("an empty registry enforces nothing — the feature is off until something is paired", () => {
    expect(write(cfg(), {}, nothingPaired)).toBeNull();
    // …and so is passing no gate at all, which is what every pre-pairing call site did.
    expect(write(cfg(), {})).toBeNull();
  });

  test("a non-empty registry refuses a write with no bearer token", async () => {
    const denied = write(cfg(), {}, paired);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
    expect(await denied!.text()).toBe("device not paired");
  });

  test("a wrong or malformed bearer token is refused", () => {
    expect(write(cfg(), { authorization: "Bearer wrong" }, paired)!.status).toBe(403);
    expect(write(cfg(), { authorization: "Basic tok-phone" }, paired)!.status).toBe(403);
    expect(write(cfg(), { authorization: "tok-phone" }, paired)!.status).toBe(403);
  });

  test("a valid bearer token proceeds", () => {
    expect(write(cfg(), { authorization: "Bearer tok-phone" }, paired)).toBeNull();
    expect(write(cfg(), { authorization: "bearer  tok-phone " }, paired)).toBeNull();
  });

  test("reads are unaffected — parity with the header gate, which is also write-only", () => {
    expect(read(cfg(), {}, paired)).toBeNull();
    expect(read(cfg(), { authorization: "Bearer wrong" }, paired)).toBeNull();
  });

  test("the two gates compose by AND: each refuses independently of the other", async () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    // Header ok, not paired → the pairing refusal.
    const noToken = write(c, { "x-device-id": "phone" }, paired)!;
    expect(await noToken.text()).toBe("device not paired");
    // Paired, header missing → the header refusal, which is checked first and names itself.
    const noHeader = write(c, { authorization: "Bearer tok-phone" }, paired)!;
    expect(await noHeader.text()).toBe("device not authorised");
    // Both satisfied → through.
    expect(write(c, { "x-device-id": "phone", authorization: "Bearer tok-phone" }, paired)).toBeNull();
  });

  test("the header gate is untouched when nothing is paired", async () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect((await write(c, {}, nothingPaired)!.text())).toBe("device not authorised");
    expect(write(c, { "x-device-id": "phone" }, nothingPaired)).toBeNull();
  });

  test("the same-origin gate still runs first — a token is no substitute for an Origin", () => {
    const denied = guard(
      req({ host: "collie.ts.net", authorization: "Bearer tok-phone" }),
      cfg(),
      "write",
      paired,
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });
});

describe("requestDevice — attribution across both gates", () => {
  const HDR = "x-device-id";
  const gateOf = (tokens: Record<string, string>) => ({
    enforced: () => Object.keys(tokens).length > 0,
    resolve: (token: string | null) =>
      token !== null && tokens[token] !== undefined ? { label: tokens[token]! } : null,
  });
  const paired = gateOf({ "tok-phone": "phone" });

  test("with nothing paired it is exactly deviceAuth — an unpaired deployment sees no change", () => {
    for (const c of [cfg(), cfg({ deviceHeader: HDR, deviceAllowlist: ["desk"] })]) {
      const cases: Record<string, string>[] = [{ host: "h" }, { host: "h", "x-device-id": "desk" }];
      for (const headers of cases) {
        expect(requestDevice(req(headers), c, gateOf({}))).toEqual(deviceAuth(req(headers), c));
        expect(requestDevice(req(headers), c)).toEqual(deviceAuth(req(headers), c));
      }
    }
  });

  test("a token's label wins over the header name", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["desk"] });
    expect(requestDevice(req({ host: "h", "x-device-id": "desk", authorization: "Bearer tok-phone" }), c, paired)).toEqual(
      { enforced: true, device: "phone", authorized: true },
    );
  });

  test("without a token the header name still attributes, but is not authorised", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["desk"] });
    expect(requestDevice(req({ host: "h", "x-device-id": "desk" }), c, paired)).toEqual({
      enforced: true,
      device: "desk",
      authorized: false,
    });
  });

  test("pairing alone reports enforcement even with no header gate configured", () => {
    expect(requestDevice(req({ host: "h", authorization: "Bearer tok-phone" }), cfg(), paired)).toEqual({
      enforced: true,
      device: "phone",
      authorized: true,
    });
    expect(requestDevice(req({ host: "h" }), cfg(), paired)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
  });

  test("a paired device that the header gate refuses is not authorised", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["desk"] });
    expect(
      requestDevice(req({ host: "h", "x-device-id": "intruder", authorization: "Bearer tok-phone" }), c, paired),
    ).toEqual({ enforced: true, device: "phone", authorized: false });
  });
});

describe("parsePairRequest — the bootstrap body", () => {
  test("both fields, with the label normalised", () => {
    expect(parsePairRequest({ code: "abcd-2345", label: "  Pixel 9 " })).toEqual({
      code: "abcd-2345",
      label: "Pixel 9",
    });
  });

  test("a missing, empty or oversized field is refused", () => {
    expect(parsePairRequest(null)).toBeNull();
    expect(parsePairRequest("code")).toBeNull();
    expect(parsePairRequest({ code: "abcd2345" })).toBeNull();
    expect(parsePairRequest({ label: "phone" })).toBeNull();
    expect(parsePairRequest({ code: "", label: "phone" })).toBeNull();
    expect(parsePairRequest({ code: "abcd2345", label: "   " })).toBeNull();
    expect(parsePairRequest({ code: "x".repeat(65), label: "phone" })).toBeNull();
    expect(parsePairRequest({ code: "abcd2345", label: "x".repeat(49) })).toBeNull();
    expect(parsePairRequest({ code: 12345678, label: "phone" })).toBeNull();
  });

  test("the code is passed through unjudged — shape-checking it would be a free oracle", () => {
    // Not code-shaped at all, but it is the hash compare's job to say so, in constant time.
    expect(parsePairRequest({ code: "!!!!", label: "phone" })?.code).toBe("!!!!");
  });
});

describe("parseSnoozeRequest — absence is not null", () => {
  test("an explicit null clears the snooze", () => {
    expect(parseSnoozeRequest({ snoozedUntil: null })).toEqual({ ok: true, until: null });
  });

  test("a number is passed through as the deadline", () => {
    expect(parseSnoozeRequest({ snoozedUntil: 1_700_000_000_000 })).toEqual({
      ok: true,
      until: 1_700_000_000_000,
    });
  });

  test("an OMITTED field is refused — it must never read as a clear", () => {
    // The regression this pins: `{}` reaching `snooze.set(null)` would silently unmute every
    // session's notifications on a body that asked for nothing.
    expect(parseSnoozeRequest({})).toEqual({ ok: false });
    expect(parseSnoozeRequest({ snoozed_until: null })).toEqual({ ok: false });
    expect(parseSnoozeRequest({ snoozedUntil: undefined })).toEqual({ ok: false });
  });

  test("a body that is not an object is refused rather than dereferenced", () => {
    expect(parseSnoozeRequest(null)).toEqual({ ok: false });
    expect(parseSnoozeRequest("later")).toEqual({ ok: false });
    expect(parseSnoozeRequest([null])).toEqual({ ok: false });
  });

  test("a non-numeric value is refused", () => {
    expect(parseSnoozeRequest({ snoozedUntil: "1700000000000" })).toEqual({ ok: false });
    expect(parseSnoozeRequest({ snoozedUntil: true })).toEqual({ ok: false });
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

// GET /api/config is where a client learns the pack mode without probing behaviour (M4/01). The
// handler lives inside Bun.serve, which bun test cannot stand up (CLAUDE.md), so the body it emits
// is asserted through the pure builder the handler calls.
describe("bridgeConfigBody — /api/config reports the pack mode", () => {
  const base = { push: true, vapidPublicKey: "BKey", build: "abc123" } as const;

  test("a solo instance emits today's exact body — no `mode` key at all", () => {
    const body = bridgeConfigBody({ ...base, mode: "solo" });
    expect(body).toEqual({ push: true, vapidPublicKey: "BKey", build: "abc123" });
    expect(Object.keys(body)).toEqual(["push", "vapidPublicKey", "build"]);
    expect("mode" in body).toBe(false);
    // Byte level, because the point is the serialized response, not the object.
    expect(JSON.stringify(body)).toBe('{"push":true,"vapidPublicKey":"BKey","build":"abc123"}');
  });

  test("a lead and a peer say so", () => {
    expect(bridgeConfigBody({ ...base, mode: "lead" }).mode).toBe("lead");
    expect(bridgeConfigBody({ ...base, mode: "peer" }).mode).toBe("peer");
  });

  test("the mode is appended, never reordering the fields a solo client already parses", () => {
    expect(Object.keys(bridgeConfigBody({ ...base, mode: "peer" }))).toEqual([
      "push",
      "vapidPublicKey",
      "build",
      "mode",
    ]);
  });

  test("push disabled still round-trips its key untouched", () => {
    const body = bridgeConfigBody({ push: false, vapidPublicKey: "", build: "unknown", mode: "solo" });
    expect(body).toEqual({ push: false, vapidPublicKey: "", build: "unknown" });
  });
});

// The mux block (M10/06) — how the phone learns what the multiplexer underneath can do, without
// ever learning to branch on which one it is. Same reason as above: the handler is inside Bun.serve,
// so the shape is asserted through the pure builder it calls.
describe("muxConfigBody — the capability declaration, as the phone reads it", () => {
  const everything = declareCapabilities({
    supports: [...MUX_CAPABILITIES],
    unsupportedKeys: ["PageUp", "End"],
    notes: { gridScrollback: "developer prose about a capability this adapter HAS" },
    topologyLatency: { kind: "push" },
  });
  const partial = declareCapabilities({
    supports: ["paneGrid", "typeText", "sendKeys"],
    notes: {
      agentSessionRef: "a multiplexer keeps no agent session log for Collie to read.",
      createSpace: "one collie drives one session here, so a new one would not appear at all.",
    },
    topologyLatency: { kind: "bounded", ms: 12_000 },
  });

  test("capabilities are TOTAL — every name answered, so nothing reads as absent by omission", () => {
    const wire = muxConfigBody({ mux: "reference", capabilities: everything });
    expect(Object.keys(wire.capabilities).toSorted()).toEqual([...MUX_CAPABILITIES].toSorted());
    for (const cap of MUX_CAPABILITIES) expect(wire.capabilities[cap]).toBe(true);
  });

  test("an adapter missing capabilities says false, never omits the key", () => {
    const wire = muxConfigBody({ mux: "partial", capabilities: partial });
    expect(wire.capabilities.agentSessionRef).toBe(false);
    expect(wire.capabilities.createSpace).toBe(false);
    expect(wire.capabilities.paneGrid).toBe(true);
    expect("agentSessionRef" in wire.capabilities).toBe(true);
  });

  test("notes ride only for the capabilities the adapter LACKS", () => {
    expect(muxConfigBody({ mux: "reference", capabilities: everything }).notes).toEqual({});
    const notes = muxConfigBody({ mux: "partial", capabilities: partial }).notes;
    expect(Object.keys(notes).toSorted()).toEqual(["agentSessionRef", "createSpace"]);
  });

  test("how many spaces the multiplexer can hold rides too, and defaults to `many`", () => {
    // `partial` declares nothing about spaces, and the wire says `many` — the fail-open direction,
    // where at worst a space strip shows one chip instead of hiding navigation that exists.
    expect(muxConfigBody({ mux: "partial", capabilities: partial }).spaces).toBe("many");
    const single = declareCapabilities({
      supports: ["paneGrid"],
      spaces: "one",
      topologyLatency: { kind: "push" },
    });
    expect(muxConfigBody({ mux: "single", capabilities: single }).spaces).toBe("one");
  });

  test("the name and the refused keys ride verbatim", () => {
    const wire = muxConfigBody({ mux: "reference", capabilities: everything });
    expect(wire.name).toBe("reference");
    expect(wire.unsupportedKeys).toEqual(["PageUp", "End"]);
  });

  test("the wire is a copy — mutating it cannot reach the adapter's declaration", () => {
    const wire = muxConfigBody({ mux: "reference", capabilities: everything });
    wire.capabilities.paneGrid = false;
    wire.unsupportedKeys.push("Home");
    expect(everything.supports.paneGrid).toBe(true);
    expect(everything.unsupportedKeys).toEqual(["PageUp", "End"]);
  });

  test("the real Herdr adapter publishes every capability — nothing changes for its operators", () => {
    const wire = muxConfigBody(herdrMuxFactory.create({ endpoint: "/tmp/none.sock", timeoutMs: 100, options: {} }));
    for (const cap of MUX_CAPABILITIES) expect(wire.capabilities[cap]).toBe(true);
    expect(wire.notes).toEqual({});
  });

  // The mark's URL is published like everything else here: as data the phone prints. An adapter
  // WITHOUT one must publish no key, because the key's absence is the whole instruction to render
  // the header's text alone — a `logoUrl` on an adapter with no logo is a 404 in every header.
  test("an adapter with a logo publishes its URL; one without publishes no key", () => {
    const withLogo = muxConfigBody({ mux: "reference", capabilities: everything, logo: "<svg/>" });
    expect(withLogo.logoUrl).toBe(MUX_LOGO_PATH);
    expect("logoUrl" in muxConfigBody({ mux: "reference", capabilities: everything })).toBe(false);
  });

  test("the real Herdr adapter ships a mark, so its header renders one", () => {
    const wire = muxConfigBody(herdrMuxFactory.create({ endpoint: "/tmp/none.sock", timeoutMs: 100, options: {} }));
    expect(wire.logoUrl).toBe(MUX_LOGO_PATH);
  });

  // …AND THROUGH THE WRAPPERS, which is where the first version of this shipped broken. `bridge/`
  // never hands `muxConfigBody` a raw adapter: index.ts wraps every one in the hint tier and a blind
  // one in the beacon decorator first, and both rebuild the adapter as a literal. Asserting the raw
  // adapter's mark proves nothing about the object the route actually holds — that is precisely the
  // gap that let three live instances publish no `logoUrl` while the suite stayed green.
  test("the mark survives the hint tier — the wrapper EVERY adapter gets", () => {
    const raw = herdrMuxFactory.create({ endpoint: "/tmp/none.sock", timeoutMs: 100, options: {} });
    const wrapped = withAgentHints(raw, { hooksInstalled: () => false });
    expect(muxConfigBody(wrapped).logoUrl).toBe(MUX_LOGO_PATH);
  });

  test("the mark survives BOTH wrappers on a blind adapter, stacked as index.ts stacks them", () => {
    const target = { endpoint: "collie-test", timeoutMs: 100, options: {} } as const;
    const raw = tmuxMuxFactory.create(target);
    const matcher = tmuxMuxFactory.beaconMatcher?.(target);
    if (matcher === undefined) throw new Error("the tmux factory must contribute a beacon matcher");
    const seeing = withAgentBeacons(raw, fakeBeaconReader([]), { matcher, hooksInstalled: () => false });
    const wrapped = withAgentHints(seeing, { hooksInstalled: () => false });
    expect(muxConfigBody(wrapped).logoUrl).toBe(MUX_LOGO_PATH);
  });
});

// GET /api/mux/logo.svg. The bytes are an ADAPTER's, so the headers are the containment: sandboxed
// (no script can run even if a future adapter's file carried some), nosniff (a browser may not
// re-decide what they are), and validated by ETag rather than pinned by a max-age, so a release that
// changes the mark is picked up on the next load.
describe("muxLogoResponse — serving an adapter's mark", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>`;

  test("answers the SVG with the image type and both hardening headers", async () => {
    const res = muxLogoResponse(svg, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(svg);
  });

  test("carries a strong ETag and revalidates rather than pinning a max-age", () => {
    const res = muxLogoResponse(svg, null);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("etag")).toBe(computeEtag(svg));
  });

  test("a client holding the current bytes gets a bodiless 304 — still hardened", async () => {
    const res = muxLogoResponse(svg, computeEtag(svg));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("etag")).toBe(computeEtag(svg));
  });

  test("a stale validator re-sends the body", () => {
    expect(muxLogoResponse(svg, `"stale"`).status).toBe(200);
  });
});

describe("bridgeConfigBody — the mux block is appended, never reordering what came before", () => {
  const base = { push: true, vapidPublicKey: "BKey", build: "abc123", mode: "solo" } as const;
  const mux = { mux: "reference", capabilities: declareCapabilities({ supports: ["paneGrid"], topologyLatency: { kind: "push" } }) };

  test("no adapter in hand: no key at all, which a client reads as an older bridge", () => {
    expect("mux" in bridgeConfigBody({ ...base })).toBe(false);
  });

  test("with one, it lands last", () => {
    expect(Object.keys(bridgeConfigBody({ ...base, mux }))).toEqual([
      "push",
      "vapidPublicKey",
      "build",
      "mux",
    ]);
    expect(Object.keys(bridgeConfigBody({ ...base, mode: "peer", mux }))).toEqual([
      "push",
      "vapidPublicKey",
      "build",
      "mode",
      "mux",
    ]);
  });

  test("it carries the declaration, not the adapter", () => {
    const body = bridgeConfigBody({ ...base, mux });
    expect(body.mux?.name).toBe("reference");
    expect(body.mux?.capabilities.paneGrid).toBe(true);
    expect(body.mux?.capabilities.createSpace).toBe(false);
  });
});

// ── The merged snapshot route (M4/04) ────────────────────────────────────────
// `/api/snapshot` is `packLead ? packLead.merge(body) : body`, inside Bun.serve — which bun test
// cannot stand up (CLAUDE.md). So the two halves are asserted where they actually live: the
// composition through the real PackLead, and the routing invariants by reading the source that
// registers them. PACK_PROTOCOL.md §9.2, §10.2.

const snapshotSource = (): SnapshotResponse => ({
  bridge: "connected",
  agents: [
    {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "collie",
      workspaceNumber: 1,
      tabId: "w1:t1",
      agent: "claude",
      status: "blocked",
      cwd: "/home/you",
      focused: false,
      kind: "agent",
    },
  ],
  shellPanes: [],
  workspaces: [],
  tabs: [],
  sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 1 }],
  ts: 1_754_000_000_000,
});

function leadOverDeadPeer(): PackLead {
  const registry = new PackRegistry({
    sessions: { get: () => undefined },
    self: "desk",
    members: () => [
      {
        memberId: "laptop",
        fingerprint: "a".repeat(64),
        certPem: "-----BEGIN CERTIFICATE-----\nunused-in-this-test\n-----END CERTIFICATE-----\n",
        address: "laptop.example:8787",
        role: "peer",
        status: "enrolled",
        enrolledAt: 0,
        secretGeneration: 1,
        signedAt: 0,
      },
    ],
  });
  return new PackLead({
    registry,
    // Every dial fails, exactly as `PeerClient` reports a peer that is off: a value, not a throw.
    snapshot: async () => ({ ok: false, state: "unreachable", reason: "connection refused", receivedAt: 1 }),
    proxy: neverProxy,
    self: { id: "desk", name: "the herd" },
  });
}

describe("the merged snapshot — an unreachable peer degrades its entry, never the response", () => {
  test("a dead peer yields a body (which the route 200s), not a throw and not a 5xx", async () => {
    const lead = leadOverDeadPeer();
    await lead.sweep();
    // The route has no try/catch around this call and needs none — that is the contract.
    const merged = lead.merge(snapshotSource());
    expect(merged.bridge).toBe("connected");
    expect(merged.servers).toEqual([
      { id: "desk", name: "the herd", isLead: true, reachable: true, protocol: "ok", lastSeenAt: expect.any(Number) },
      { id: "laptop", name: "laptop", isLead: false, reachable: false, protocol: "unknown", lastSeenAt: 0 },
    ]);
    // The lead's own herd is untouched by its peer being down.
    expect(merged.agents.map((p) => p.paneId)).toEqual(["w1:p1"]);
    expect(JSON.parse(JSON.stringify(merged))).toBeTruthy();
  });

  test("with no lead runtime the body is passed through by identity — solo's zero tax at the seam", () => {
    const body = snapshotSource();
    // Character-for-character the route's own expression, with the route's own optional dep.
    const route = (packLead: PackLead | undefined, b: SnapshotResponse) => (packLead ? packLead.merge(b) : b);
    const out = route(undefined, body);
    expect(out).toBe(body);
    expect(JSON.stringify(out)).not.toMatch(/"servers"|"host"/);
  });
});

describe("the host gate — `?host=` selects among enrolled members and nothing else", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("the selector is parsed only when a pack surface is mounted", () => {
    // The same trust-store-existence predicate the pack router mounts on: a solo instance never
    // applies the `?host=` grammar to a URL at all (§11).
    expect(src).toContain("const host = packHandler ? selectHostFrom(url) : LOCAL_HOST;");
  });

  test("every session-scoped route resolves through the gate, never past it", () => {
    // The load-bearing claim: `?h=laptop` + `w1:p1` must never be served the DESK's `w1:p1`, and
    // pane ids collide across machines, so a fall-through here is a cross-host write.
    //
    // All four session-scoped routes (tab create, workspace create, tab action, the pane family)
    // reach their runtime through the caller's resolver and nothing else.
    expect([...src.matchAll(/await caller\.resolve\(\);/g)]).toHaveLength(4);
    // Exactly four `registry.get(` calls remain, and each is a sanctioned one, named here rather
    // than exempted: assembling THIS collie's own snapshot body; `localRuntime`, the single
    // "(session) → runtime, or 404" helper both callers share; `/api/config`, which reports THIS
    // collie's own multiplexer (M10/06) and is not session-scoped at all; and `/api/mux/logo.svg`,
    // which serves that same local multiplexer's mark and is session-scoped no more than the config
    // that publishes its URL. A fifth would be a route reaching past the gate.
    expect([...src.matchAll(/registry\.get\(/g)]).toHaveLength(4);
    // The mux read is a read of the LOCAL primary — never `?host=`, because a peer's capabilities
    // are its own business and reach the lead over the pack API, never out of this registry.
    expect(src).toContain("const activeMux = registry.get();");
    // An unknown or ill-formed host is a 404, mirroring unknownSession() (§4)… The words now come
    // from the error catalogue (bridge/error-codes.ts), so what this pins is the SELECTION — that
    // both host shapes still name themselves in the refusal, and both still land on `host.unknown`.
    expect(src).toContain(
      'apiError("host.unknown", { host: host.kind === "member" ? host.id : host.raw })',
    );
    // …and a KNOWN peer is forwarded, with the peer's own response handed back (§5, §9.1). The
    // forward is the gate's own branch — no route may grow a second one.
    expect([...src.matchAll(/packLead!\.forward\(/g)]).toHaveLength(1);
    expect(src).not.toContain("per-pane proxying is not implemented in this build");
  });

  test("a peer's own routes are the SAME closure the browser's are (§5), with two callers", () => {
    // The 1:1 rule: `/pack/v1/pane/:id/reply` and `/api/pane/:id/reply` are not two handlers that
    // agree — they are one block reached by two callers. Exactly one definition, exactly two calls.
    expect([...src.matchAll(/const serveSessionRoute = async/g)]).toHaveLength(1);
    expect([...src.matchAll(/serveSessionRoute\(\s*req/g)]).toHaveLength(2);
    // The peer's caller supplies its OWN gate and its OWN audit attribution — the lead's verdict is
    // never an input, and the write lands in the peer's log marked pack-originated (§12).
    expect(src).toContain("packGate(level, cfg, device)");
    expect(src).toContain('audit.scoped({ via: "pack", from })');
  });

  test('"seen" is marked once, on the owning host, and never for a remote pane (.adr/0003)', () => {
    // One call site, and it sits AFTER the resolver — so a pane on a peer has already returned the
    // peer's forwarded response and cannot reach it. The peer marks it, against its own ledger,
    // because the `x-collie-seen` header is forwarded verbatim. Two machines counting one look would
    // be exactly the "one shared fact" ADR 0003 forbids.
    const calls = [...src.matchAll(/activity\.noteSeen\(/g)];
    expect(calls).toHaveLength(1);
    expect(src.indexOf("activity.noteSeen(")).toBeGreaterThan(src.indexOf("await caller.resolve();"));
    // And it is still keyed by (session, paneId) alone: the ledger's host dimension exists for the
    // LEAD's own bookkeeping, not for a peer marking its own panes (bridge/activity.ts).
    expect(src).toContain("activity.noteSeen(session, paneId)");
  });
});
