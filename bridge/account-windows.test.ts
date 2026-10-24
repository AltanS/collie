import { describe, expect, it } from "bun:test";

import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { USAGE_WINDOWS } from "./usage.ts";

import {
  accountWindowsDoctorLine,
  AccountWindows,
  ASK_EVERY_MS,
  BACKOFF,
  claudeAccountSource,
  claudeCredentialsPath,
  claudeTokenFrom,
  CLAUDE_USAGE_URL,
  codexAccountSource,
  codexReadingFromTail,
  defaultAccountSources,
  grokAccountSource,
  grokTokenFrom,
  hasOpencodeGoEntry,
  isTurnEnd,
  opencodeAccountSource,
  opencodeGoKeyFrom,
  parseAccountUsage,
  parseCodexRateLimits,
  parseGrokBilling,
  parseOpencodeGoUsage,
  POKE_EVERY_MS,
  readClaudeLogin,
  readGrokLogin,
  readOpencodeGoKey,
  STALE_AFTER_MS,
  type AccountFetch,
  type CredentialSeams,
} from "./account-windows.ts";
import type { AgentView } from "./types.ts";

const NOW = 1_800_000_000_000;
const HOME = "/home/op";
/** A fake, shaped like the real thing and nothing like a working token. */
const TOKEN = "sk-ant-oat01-placeholder";
const RESET_5H = "2027-01-15T10:00:00.000Z";
const RESET_7D = "2027-01-20T10:00:00.000Z";

interface LoginFields {
  accessToken?: string;
  expiresAt?: number | undefined;
}

function login(extra: LoginFields = {}): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: TOKEN, refreshToken: "sk-ant-ort01-placeholder", expiresAt: NOW + 3_600_000, ...extra },
  });
}

/** The newer answer, as seen live on 2026-10-24 (other keys trimmed to a couple of strays). */
function limitsBody(): string {
  return JSON.stringify({
    five_hour: { utilization: 1, resets_at: RESET_5H },
    seven_day: { utilization: 2, resets_at: RESET_7D },
    spend: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: "session", group: "session", percent: 12.5, severity: "normal", resets_at: RESET_5H, scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 140, severity: "high", resets_at: RESET_7D, scope: null, is_active: true },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 30,
        severity: "normal",
        resets_at: RESET_7D,
        scope: { model: { display_name: "Opus\u0007 " } },
        is_active: false,
      },
    ],
  });
}

/** One flat window as the older answer writes it. */
interface FlatWindow {
  utilization: number;
  resets_at: string | null;
}

/** The older flat answer. */
function flatBody(fiveHour: FlatWindow | null, sevenDay: FlatWindow | null): string {
  return JSON.stringify({ five_hour: fiveHour, seven_day: sevenDay, seven_day_opus: null });
}

describe("parseAccountUsage", () => {
  it("reads limits[]: session is 5h, weekly_all is 7d, clamped, with the reset in epoch ms", () => {
    expect(parseAccountUsage(limitsBody())).toEqual({
      limits: [
        { window: "5h", used: 12.5, resetsAt: Date.parse(RESET_5H) },
        { window: "7d", used: 100, resetsAt: Date.parse(RESET_7D) },
      ],
      scoped: [{ label: "Opus", used: 30, resetsAt: Date.parse(RESET_7D) }],
    });
  });

  it("falls back to the flat five_hour / seven_day fields", () => {
    expect(parseAccountUsage(flatBody({ utilization: 41, resets_at: RESET_5H }, { utilization: -3, resets_at: null }))).toEqual({
      limits: [
        { window: "5h", used: 41, resetsAt: Date.parse(RESET_5H) },
        { window: "7d", used: 0 },
      ],
      scoped: [],
    });
  });

  it("takes a window limits[] does not name from the flat field", () => {
    const body = JSON.stringify({
      five_hour: { utilization: 9, resets_at: RESET_5H },
      seven_day: { utilization: 22, resets_at: RESET_7D },
      limits: [{ kind: "session", percent: 50, resets_at: RESET_5H }],
    });
    expect(parseAccountUsage(body)?.limits).toEqual([
      { window: "5h", used: 50, resetsAt: Date.parse(RESET_5H) },
      { window: "7d", used: 22, resetsAt: Date.parse(RESET_7D) },
    ]);
  });

  it("reads null windows as an account without windows", () => {
    expect(parseAccountUsage(flatBody(null, null))).toEqual({ limits: [], scoped: [] });
    expect(parseAccountUsage(JSON.stringify({ limits: [], five_hour: null }))).toEqual({ limits: [], scoped: [] });
  });

  it("refuses a body that is not either shape", () => {
    expect(parseAccountUsage("<html>")).toBeNull();
    expect(parseAccountUsage("[]")).toBeNull();
    expect(parseAccountUsage(JSON.stringify({ usage: { five: 3 } }))).toBeNull();
  });

  it("drops a row whose percent is not a number", () => {
    const body = JSON.stringify({ limits: [{ kind: "session", percent: "12" }, { kind: "weekly_all", percent: 3 }] });
    expect(parseAccountUsage(body)?.limits).toEqual([{ window: "7d", used: 3 }]);
  });
});

describe("the Claude login", () => {
  function seams(over: Partial<CredentialSeams> & { files?: Record<string, { mode: number; text: string; file?: boolean }> } = {}): CredentialSeams {
    const files = over.files ?? {};
    return {
      env: {},
      home: HOME,
      platform: "linux",
      stat: async (path) => {
        const entry = files[path];
        return entry === undefined ? null : { file: entry.file ?? true, mode: entry.mode, size: entry.text.length };
      },
      read: async (path) => files[path]?.text ?? null,
      keychain: async () => null,
      list: async () => [],
      tail: async () => null,
      now: () => NOW,
      ...over,
    };
  }
  const path = join(HOME, ".claude", ".credentials.json");

  it("reads the access token from a 0600 or 0400 file", async () => {
    expect(await readClaudeLogin(seams({ files: { [path]: { mode: 0o600, text: login() } } }))).toEqual({ ok: true, token: TOKEN });
    expect(await readClaudeLogin(seams({ files: { [path]: { mode: 0o400, text: login() } } }))).toEqual({ ok: true, token: TOKEN });
  });

  it("follows CLAUDE_CONFIG_DIR", async () => {
    const profile = join("/profiles", "work", ".credentials.json");
    expect(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: "/profiles/work" }, HOME)).toBe(profile);
    const read = await readClaudeLogin(seams({ env: { CLAUDE_CONFIG_DIR: "/profiles/work" }, files: { [profile]: { mode: 0o600, text: login() } } }));
    expect(read.ok).toBe(true);
  });

  it("refuses a 0644 file and never reads it", async () => {
    let reads = 0;
    const read = await readClaudeLogin(
      seams({
        files: { [path]: { mode: 0o644, text: login() } },
        read: async () => {
          reads += 1;
          return login();
        },
      }),
    );
    expect(read).toEqual({ ok: false, reason: "readable by others" });
    expect(reads).toBe(0);
  });

  it("does not judge the mode on Windows", async () => {
    expect((await readClaudeLogin(seams({ platform: "win32", files: { [path]: { mode: 0o666, text: login() } } }))).ok).toBe(true);
  });

  it("refuses a missing file, a directory, an expired token and a strange token", async () => {
    expect(await readClaudeLogin(seams())).toEqual({ ok: false, reason: "missing" });
    expect(await readClaudeLogin(seams({ files: { [path]: { mode: 0o600, text: "", file: false } } }))).toEqual({ ok: false, reason: "not a regular file" });
    expect(claudeTokenFrom(login({ expiresAt: NOW - 1 }), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(claudeTokenFrom(login({ expiresAt: NOW }), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(claudeTokenFrom(login({ expiresAt: undefined }), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(claudeTokenFrom(login({ accessToken: "two words" }), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(claudeTokenFrom(login({ accessToken: "" }), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(claudeTokenFrom(login({ accessToken: "x".repeat(4096) }), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(claudeTokenFrom("not json", NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("asks the Keychain on macOS only, and only when the file is absent", async () => {
    let asked = 0;
    const keychain = async (): Promise<string | null> => {
      asked += 1;
      return `${login()}\n`;
    };
    expect(await readClaudeLogin(seams({ platform: "darwin", keychain }))).toEqual({ ok: true, token: TOKEN });
    expect(asked).toBe(1);
    expect(await readClaudeLogin(seams({ platform: "linux", keychain }))).toEqual({ ok: false, reason: "missing" });
    expect(asked).toBe(1);
    expect((await readClaudeLogin(seams({ platform: "darwin", keychain, files: { [path]: { mode: 0o600, text: login() } } }))).ok).toBe(true);
    expect(asked).toBe(1);
    expect(await readClaudeLogin(seams({ platform: "darwin", keychain: async () => null }))).toEqual({ ok: false, reason: "missing" });
  });

  it("builds the one ask with the bearer header and the beta header", () => {
    const source = claudeAccountSource(seams());
    if (source.kind !== "http") throw new Error("http");
    expect(source.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(source.headers(TOKEN)).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });
  });
});

// ── The service ─────────────────────────────────────────────────────────────────────────────────

function pane(agent: string, kind: "agent" | "shell" = "agent"): AgentView {
  // SAFETY: the service reads `agent` and `kind` and nothing else off a pane.
  return { agent, kind } as AgentView;
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake vendor: answers from a queue, records each call, and can hold an answer open. */
function vendor() {
  const calls: Call[] = [];
  const answers: Array<{ status: number; body?: string } | "throw" | "hold"> = [];
  let release: (() => void) | null = null;
  const fetch: AccountFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = answers.shift() ?? { status: 200, body: limitsBody() };
    if (next === "throw") throw new Error("connect ECONNREFUSED");
    if (next === "hold") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, text: async () => limitsBody() };
    }
    return { status: next.status, text: async () => next.body ?? "" };
  };
  return { calls, answers, fetch, release: () => release?.() };
}

function service(opts: { enabled?: boolean; login?: () => Promise<{ ok: true; token: string } | { ok: false; reason: "expired" | "missing" }> } = {}) {
  const clock = { now: NOW };
  const fake = vendor();
  const lines: string[] = [];
  const windows = new AccountWindows({
    enabled: opts.enabled ?? true,
    sources: [
      {
        kind: "http",
        harness: "claude",
        url: CLAUDE_USAGE_URL,
        login: opts.login ?? (async () => ({ ok: true, token: TOKEN })),
        headers: (token) => ({ Authorization: `Bearer ${token}` }),
        parse: parseAccountUsage,
      },
    ],
    fetch: fake.fetch,
    now: () => clock.now,
    userAgent: "collie/1.24.0",
    log: (line) => lines.push(line),
  });
  return { windows, fake, clock, lines };
}

describe("AccountWindows", () => {
  it("asks nothing while no pane of the harness exists", async () => {
    const { windows, fake } = service();
    windows.observe([pane("codex"), pane("claude", "shell")], "main");
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls).toEqual([]);
    expect(windows.limits("claude")).toBeUndefined();
  });

  it("asks once when a pane appears, with the token only in the header, and draws 5h and 7d", async () => {
    const { windows, fake, lines } = service();
    windows.observe([pane("claude")], "main");
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls).toEqual([{ url: CLAUDE_USAGE_URL, headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "collie/1.24.0" } }]);
    expect(windows.limits("claude")).toEqual([
      { window: "5h", used: 12.5, resetsAt: Date.parse(RESET_5H) },
      { window: "7d", used: 100, resetsAt: Date.parse(RESET_7D) },
    ]);
    expect(windows.scoped("claude")).toEqual([{ label: "Opus", used: 30, resetsAt: Date.parse(RESET_7D) }]);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("asks again every five minutes while the pane stays, and not before", async () => {
    const { windows, fake, clock } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += ASK_EVERY_MS - 1;
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls.length).toBe(1);
    clock.now += 1;
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
  });

  it("a turn's end asks at most once a minute", async () => {
    const { windows, fake, clock } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(1);
    clock.now += POKE_EVERY_MS;
    windows.poke("claude");
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
    clock.now += POKE_EVERY_MS / 2;
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
    windows.poke("codex");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
  });

  it("keeps one ask in flight per harness", async () => {
    const { windows, fake, clock } = service();
    fake.answers.push("hold");
    windows.observe([pane("claude")], "main");
    clock.now += ASK_EVERY_MS;
    windows.observe([pane("claude")], "main");
    windows.poke("claude");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.length).toBe(1);
    fake.release();
    await windows.settled();
    expect(windows.limits("claude")?.length).toBe(2);
  });

  it("one mux session's poll does not forget another session's pane", async () => {
    const { windows, fake, clock } = service();
    windows.observe([pane("claude")], "a");
    await windows.settled();
    windows.observe([], "b");
    clock.now += POKE_EVERY_MS;
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
    windows.observe([], "a");
    clock.now += POKE_EVERY_MS;
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
  });

  it("drops the reading on 401 and backs off 15 minutes", async () => {
    const { windows, fake, clock, lines } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += POKE_EVERY_MS;
    fake.answers.push({ status: 401 });
    windows.poke("claude");
    await windows.settled();
    expect(windows.limits("claude")).toBeUndefined();
    clock.now += BACKOFF.denied - 1;
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
    clock.now += 1;
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls.length).toBe(3);
    expect(windows.limits("claude")?.length).toBe(2);
    expect(lines).toEqual(["[usage] account windows, claude: HTTP 401, reading dropped, asking again in 15 min"]);
  });

  it("drops the reading on 403 too", async () => {
    const { windows, fake, clock } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += POKE_EVERY_MS;
    fake.answers.push({ status: 403 });
    windows.poke("claude");
    await windows.settled();
    expect(windows.limits("claude")).toBeUndefined();
  });

  it("keeps the reading on 429 and backs off 15 minutes", async () => {
    const { windows, fake, clock } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += ASK_EVERY_MS;
    fake.answers.push({ status: 429 });
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(windows.limits("claude")?.length).toBe(2);
    clock.now += ASK_EVERY_MS;
    windows.observe([pane("claude")], "main");
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
    clock.now += BACKOFF.limited - ASK_EVERY_MS;
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls.length).toBe(3);
  });

  it("keeps the reading on a network error and backs off 2 minutes", async () => {
    const { windows, fake, clock, lines } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += ASK_EVERY_MS;
    fake.answers.push("throw");
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(windows.limits("claude")?.length).toBe(2);
    clock.now += BACKOFF.network - 1;
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
    clock.now += 1;
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(3);
    expect(lines.join("\n")).not.toContain("ECONNREFUSED");
  });

  it("keeps the reading on a body it cannot read and backs off 5 minutes", async () => {
    const { windows, fake, clock } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += ASK_EVERY_MS;
    fake.answers.push({ status: 200, body: "<html>maintenance</html>" });
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(windows.limits("claude")?.length).toBe(2);
    clock.now += BACKOFF.unreadable - 1;
    windows.poke("claude");
    await windows.settled();
    expect(fake.calls.length).toBe(2);
  });

  it("does not draw a reading older than 20 minutes", async () => {
    const { windows, clock } = service();
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += STALE_AFTER_MS;
    expect(windows.limits("claude")?.length).toBe(2);
    clock.now += 1;
    expect(windows.limits("claude")).toBeUndefined();
  });

  it("drops a window whose reset has passed", async () => {
    const { windows, fake, clock } = service();
    fake.answers.push({ status: 200, body: flatBody({ utilization: 5, resets_at: new Date(NOW + 1000).toISOString() }, { utilization: 6, resets_at: RESET_7D }) });
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(windows.limits("claude")?.map((l) => l.window)).toEqual(["5h", "7d"]);
    clock.now += 1000;
    expect(windows.limits("claude")?.map((l) => l.window)).toEqual(["7d"]);
  });

  it("an account without windows draws nothing", async () => {
    const { windows, fake } = service();
    fake.answers.push({ status: 200, body: flatBody(null, null) });
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(windows.limits("claude")).toBeUndefined();
  });

  it("asks nothing when the login is refused, says so once, and looks again sooner for an expired one", async () => {
    let reason: "expired" | "missing" = "missing";
    const { windows, fake, clock, lines } = service({ login: async () => ({ ok: false, reason }) });
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls).toEqual([]);
    clock.now += BACKOFF.refused;
    reason = "expired";
    windows.observe([pane("claude")], "main");
    await windows.settled();
    clock.now += BACKOFF.expired;
    windows.observe([pane("claude")], "main");
    await windows.settled();
    expect(fake.calls).toEqual([]);
    expect(lines).toEqual([
      "[usage] account windows, claude: no login read (missing)",
      "[usage] account windows, claude: no login read (expired)",
    ]);
  });

  it("off reads no login and asks nothing", async () => {
    let logins = 0;
    const { windows, fake } = service({
      enabled: false,
      login: async () => {
        logins += 1;
        return { ok: true, token: TOKEN };
      },
    });
    windows.observe([pane("claude")], "main");
    windows.poke("claude");
    await windows.settled();
    expect(logins).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(windows.limits("claude")).toBeUndefined();
  });
});

describe("isTurnEnd", () => {
  it("is a working or blocked pane settling into idle or done", () => {
    expect(isTurnEnd("working", "idle")).toBe(true);
    expect(isTurnEnd("working", "done")).toBe(true);
    expect(isTurnEnd("blocked", "idle")).toBe(true);
    expect(isTurnEnd("done", "idle")).toBe(false);
    expect(isTurnEnd("idle", "working")).toBe(false);
    expect(isTurnEnd("working", "blocked")).toBe(false);
  });
});

describe("the doctor line", () => {
  const tail = "codex: reads ~/.codex/sessions; opencode: no Go key; grok: no login)";
  it("names what each harness reads and the hosts it asks, and says off when off", () => {
    expect(accountWindowsDoctorLine(true, {}, HOME, "linux")).toBe(
      `on (claude: read ~/.claude/.credentials.json, asks api.anthropic.com; ${tail}`,
    );
    expect(accountWindowsDoctorLine(true, { CLAUDE_CONFIG_DIR: "/profiles/work" }, HOME, "linux")).toBe(
      `on (claude: read ${join("/profiles/work", ".credentials.json")}, asks api.anthropic.com; ${tail}`,
    );
    expect(accountWindowsDoctorLine(true, {}, HOME, "darwin")).toBe(
      `on (claude: read ~/.claude/.credentials.json or the Keychain, asks api.anthropic.com; ${tail}`,
    );
    expect(accountWindowsDoctorLine(false, {}, HOME, "linux")).toBe("off");
  });

  it("lists OpenCode Go and Grok with their file and host once they have a login, and follows the home variables", () => {
    expect(accountWindowsDoctorLine(true, {}, HOME, "linux", { opencodeGoKey: true, grokLogin: true })).toBe(
      "on (claude: read ~/.claude/.credentials.json, asks api.anthropic.com; codex: reads ~/.codex/sessions; " +
        "opencode: read ~/.local/share/opencode/auth.json, asks opencode.ai; grok: read ~/.grok/auth.json, asks cli-chat-proxy.grok.com)",
    );
    const env = { CODEX_HOME: "/c", XDG_DATA_HOME: "/x", GROK_HOME: "/g" };
    expect(accountWindowsDoctorLine(true, env, HOME, "linux", { opencodeGoKey: true, grokLogin: true })).toBe(
      `on (claude: read ~/.claude/.credentials.json, asks api.anthropic.com; codex: reads ${join("/c", "sessions")}; ` +
        `opencode: read ${join("/x", "opencode", "auth.json")}, asks opencode.ai; grok: read ${join("/g", "auth.json")}, asks cli-chat-proxy.grok.com)`,
    );
  });
});

// ── Codex, OpenCode Go and Grok ─────────────────────────────────────────────────────────────────
// Shapes from third-party readers (CodexBar, oh-my-pi), unverified live on 2026-10-24. Every key and
// token below is a placeholder.

const RESET_SEC = Math.floor(Date.parse(RESET_5H) / 1000);
const RESET_WEEK_SEC = Math.floor(Date.parse(RESET_7D) / 1000);

function tokenCount(rateLimits: JsonValue, type = "token_count"): string {
  return JSON.stringify({ timestamp: "2026-10-24T09:00:00.000Z", type: "event_msg", payload: { type, info: null, rate_limits: rateLimits } });
}

function chatgptLimits(unit: number): JsonObject {
  return {
    limit_id: "codex",
    primary: { used_percent: 41.5, window_minutes: 300, resets_at: RESET_SEC * unit },
    secondary: { used_percent: 7, window_minutes: 10_080, resets_at: RESET_WEEK_SEC * unit },
  };
}

describe("Codex rate_limits", () => {
  it("reads primary as 5h and secondary as 7d, resets in seconds", () => {
    expect(parseCodexRateLimits(chatgptLimits(1))).toEqual({
      limits: [
        { window: "5h", used: 41.5, resetsAt: RESET_SEC * 1000 },
        { window: "7d", used: 7, resetsAt: RESET_WEEK_SEC * 1000 },
      ],
      scoped: [],
    });
  });

  it("reads a reset in milliseconds by its magnitude", () => {
    expect(parseCodexRateLimits(chatgptLimits(1000))?.limits.map((l) => l.resetsAt)).toEqual([RESET_SEC * 1000, RESET_WEEK_SEC * 1000]);
  });

  it("keeps a window of another length as scoped and not drawn", () => {
    const reading = parseCodexRateLimits({ primary: { used_percent: 10, window_minutes: 60, resets_at: RESET_SEC }, secondary: { used_percent: 20, window_minutes: 43_200 } });
    expect(reading).toEqual({ limits: [], scoped: [{ label: "1h", used: 10, resetsAt: RESET_SEC * 1000 }, { label: "30d", used: 20 }] });
  });

  it("takes every field as optional: a window without minutes or percent is skipped", () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 10 }, secondary: { window_minutes: 10_080 } })).toBeNull();
    expect(parseCodexRateLimits({ secondary: { used_percent: 3, window_minutes: 10_080 } })).toEqual({
      limits: [{ window: "7d", used: 3 }],
      scoped: [],
    });
  });

  it("reads an API-key login (null windows) and a stray shape as nothing", () => {
    expect(parseCodexRateLimits({ limit_id: "codex", primary: null, secondary: null })).toBeNull();
    expect(parseCodexRateLimits(null)).toBeNull();
    expect(parseCodexRateLimits("x")).toBeNull();
    expect(parseCodexRateLimits({ primary: { used_percent: "9", window_minutes: 300 } })).toBeNull();
  });

  it("walks a rollout tail from the end to the newest event with windows, skipping nulls, other events and a cut first line", () => {
    const text = [
      '"cut_line_from_a_tail": 1}',
      tokenCount(chatgptLimits(1)),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "token_count" } }),
      tokenCount({ primary: null, secondary: null }),
      "not json but mentions token_count",
      JSON.stringify({ type: "response_item", payload: { type: "token_count", rate_limits: chatgptLimits(1) } }),
      "",
    ].join("\n");
    expect(codexReadingFromTail(text)?.limits[0]).toEqual({ window: "5h", used: 41.5, resetsAt: RESET_SEC * 1000 });
    expect(codexReadingFromTail([tokenCount({ primary: null, secondary: null }), tokenCount(null)].join("\n"))).toBeNull();
  });
});

describe("the Codex source", () => {
  const root = join(HOME, ".codex", "sessions");
  const today = new Date(NOW);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const dayDir = (date: Date): string => join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));

  interface FakeFile {
    name: string;
    ageMs: number;
    text: string;
    file?: boolean;
  }

  function machine(folders: Record<string, FakeFile[]>, env: Record<string, string> = {}) {
    const tails: string[] = [];
    const listed: string[] = [];
    const seams: CredentialSeams = {
      env,
      home: HOME,
      platform: "linux",
      stat: async () => null,
      read: async () => null,
      keychain: async () => null,
      list: async (path) => {
        listed.push(path);
        return (folders[path] ?? []).map((f) => ({ name: f.name, file: f.file ?? true, mtimeMs: NOW - f.ageMs }));
      },
      tail: async (path, maxBytes) => {
        tails.push(`${path}:${String(maxBytes)}`);
        for (const files of Object.values(folders)) for (const f of files) if (path.endsWith(f.name)) return f.text;
        return null;
      },
      now: () => NOW,
    };
    return { seams, tails, listed };
  }

  const MIN = 60_000;

  it("reads the newest recent rollout file's last 256 KiB and stops at the first that has windows", async () => {
    const m = machine({
      [dayDir(today)]: [
        { name: "rollout-a.jsonl", ageMs: 30 * MIN, text: tokenCount({ primary: null, secondary: null }) },
        { name: "rollout-b.jsonl", ageMs: 5 * MIN, text: tokenCount(chatgptLimits(1)) },
        { name: "rollout-c.jsonl", ageMs: 20 * MIN, text: tokenCount({ primary: { used_percent: 99, window_minutes: 300 } }) },
      ],
    });
    const source = codexAccountSource(m.seams);
    if (source.kind !== "local") throw new Error("local");
    const answer = await source.read();
    expect(answer).toEqual({
      ok: true,
      reading: {
        limits: [
          { window: "5h", used: 41.5, resetsAt: RESET_SEC * 1000 },
          { window: "7d", used: 7, resetsAt: RESET_WEEK_SEC * 1000 },
        ],
        scoped: [],
      },
    });
    expect(m.tails).toEqual([`${join(dayDir(today), "rollout-b.jsonl")}:262144`]);
  });

  it("reads at most three files, newest first, and looks only at today and yesterday", async () => {
    const files = [1, 2, 3, 4, 5].map((n) => ({ name: `rollout-${String(n)}.jsonl`, ageMs: n * MIN, text: tokenCount({ primary: null, secondary: null }) }));
    const m = machine({ [dayDir(today)]: files });
    const source = codexAccountSource(m.seams);
    expect(source.kind).toBe("local");
    if (source.kind !== "local") return;
    expect(await source.read()).toEqual({ ok: false, reason: "no subscription limits in the newest session files" });
    expect(m.tails.map((t) => t.split("/").at(-1)?.split(":")[0])).toEqual(["rollout-1.jsonl", "rollout-2.jsonl", "rollout-3.jsonl"]);
    const yesterday = new Date(NOW - 86_400_000);
    expect(m.listed).toContain(dayDir(yesterday));
    expect(m.listed.every((p) => p.startsWith(root))).toBe(true);
    expect(m.listed.length).toBeLessThanOrEqual(4);
  });

  it("finds yesterday's folder too, and ignores files older than two hours, other names and non-files", async () => {
    const yesterday = new Date(NOW - 86_400_000);
    const m = machine({
      [dayDir(today)]: [
        { name: "rollout-old.jsonl", ageMs: 121 * MIN, text: tokenCount(chatgptLimits(1)) },
        { name: "notes.jsonl", ageMs: MIN, text: tokenCount(chatgptLimits(1)) },
        { name: "rollout-dir.jsonl", ageMs: MIN, text: tokenCount(chatgptLimits(1)), file: false },
      ],
      [dayDir(yesterday)]: [{ name: "rollout-late.jsonl", ageMs: 90 * MIN, text: tokenCount(chatgptLimits(1000)) }],
    });
    const source = codexAccountSource(m.seams);
    if (source.kind !== "local") throw new Error("local");
    const answer = await source.read();
    expect(answer.ok).toBe(true);
    expect(m.tails).toEqual([`${join(dayDir(yesterday), "rollout-late.jsonl")}:262144`]);
  });

  it("says why when there is no recent file, and reads nothing", async () => {
    const m = machine({});
    const source = codexAccountSource(m.seams);
    if (source.kind !== "local") throw new Error("local");
    expect(await source.read()).toEqual({ ok: false, reason: "no session file in the last 2 hours" });
    expect(m.tails).toEqual([]);
  });

  it("follows CODEX_HOME", async () => {
    const m = machine({}, { CODEX_HOME: "/elsewhere" });
    const source = codexAccountSource(m.seams);
    if (source.kind !== "local") throw new Error("local");
    await source.read();
    expect(m.listed.every((p) => p.startsWith(join("/elsewhere", "sessions")))).toBe(true);
  });

  it("serves the windows through the service with no fetch and no login", async () => {
    const m = machine({ [dayDir(today)]: [{ name: "rollout-b.jsonl", ageMs: MIN, text: tokenCount(chatgptLimits(1)) }] });
    const fake = vendor();
    const windows = new AccountWindows({ enabled: true, sources: [codexAccountSource(m.seams)], fetch: fake.fetch, now: () => NOW, userAgent: "collie/1.24.0" });
    windows.observe([pane("codex")], "main");
    await windows.settled();
    expect(fake.calls).toEqual([]);
    expect(windows.limits("codex")?.map((l) => l.window)).toEqual(["5h", "7d"]);
  });

  it("an API-key Codex draws nothing, says so once, and looks again after a minute", async () => {
    const m = machine({ [dayDir(today)]: [{ name: "rollout-b.jsonl", ageMs: MIN, text: tokenCount({ primary: null, secondary: null }) }] });
    const lines: string[] = [];
    const clock = { now: NOW };
    const windows = new AccountWindows({
      enabled: true,
      sources: [codexAccountSource({ ...m.seams, now: () => clock.now })],
      fetch: vendor().fetch,
      now: () => clock.now,
      userAgent: "collie/1.24.0",
      log: (line) => lines.push(line),
    });
    windows.observe([pane("codex")], "main");
    await windows.settled();
    windows.observe([pane("codex")], "main");
    await windows.settled();
    expect(m.tails.length).toBe(1);
    clock.now += BACKOFF.none;
    windows.poke("codex");
    await windows.settled();
    expect(m.tails.length).toBe(2);
    expect(windows.limits("codex")).toBeUndefined();
    expect(lines).toEqual(["[usage] account windows, codex: no windows read (no subscription limits in the newest session files)"]);
  });
});

/** The seams of a machine with only these login files, each with a mode. */
function fileSeams(files: Record<string, { mode: number; text: string }>, env: Record<string, string> = {}): CredentialSeams {
  return {
    env,
    home: HOME,
    platform: "linux",
    stat: async (path) => {
      const entry = files[path];
      return entry === undefined ? null : { file: true, mode: entry.mode, size: entry.text.length };
    },
    read: async (path) => files[path]?.text ?? null,
    keychain: async () => null,
    list: async () => [],
    tail: async () => null,
    now: () => NOW,
  };
}

const GO_KEY = "placeholder-go-key";
const OPENCODE_AUTH = join(HOME, ".local", "share", "opencode", "auth.json");

function goStore(entry: JsonObject | null = { type: "api", key: GO_KEY }): string {
  return JSON.stringify({ openrouter: { type: "api", key: "placeholder-other" }, "opencode-go": entry === null ? undefined : entry });
}

describe("OpenCode Go", () => {
  const body = (over: JsonObject = {}): string =>
    JSON.stringify({
      rolling: { status: "ok", percent: 23, resetsAt: RESET_5H },
      weekly: { status: "ok", percent: 61, resetsAt: RESET_7D },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2027-02-01T00:00:00.000Z" },
      ...over,
    });

  it("maps rolling to 5h, weekly to 7d and keeps monthly as 30d, not drawn", () => {
    expect(parseOpencodeGoUsage(body())).toEqual({
      limits: [
        { window: "5h", used: 23, resetsAt: Date.parse(RESET_5H) },
        { window: "7d", used: 61, resetsAt: Date.parse(RESET_7D) },
      ],
      scoped: [{ label: "30d", used: 100, resetsAt: Date.parse("2027-02-01T00:00:00.000Z") }],
    });
  });

  it("copes with a missing weekly window, a missing reset and a missing status", () => {
    const reading = parseOpencodeGoUsage(JSON.stringify({ rolling: { percent: 5 }, monthly: null }));
    expect(reading).toEqual({ limits: [{ window: "5h", used: 5 }], scoped: [] });
    expect(parseOpencodeGoUsage(body({ weekly: undefined }))?.limits.map((l) => l.window)).toEqual(["5h"]);
  });

  it("refuses a body with none of the three names and a body that is not an object", () => {
    expect(parseOpencodeGoUsage("<html>")).toBeNull();
    expect(parseOpencodeGoUsage(JSON.stringify({ error: { message: "x" } }))).toBeNull();
    expect(parseOpencodeGoUsage("[]")).toBeNull();
  });

  it("reads the Go key from the auth store: key, or access of an oauth-shaped entry", async () => {
    expect(opencodeGoKeyFrom(goStore(), NOW)).toEqual({ ok: true, token: GO_KEY });
    expect(opencodeGoKeyFrom(goStore({ type: "oauth", access: "placeholder-access", refresh: "placeholder-refresh", expires: NOW + 1000 }), NOW)).toEqual({
      ok: true,
      token: "placeholder-access",
    });
    expect(opencodeGoKeyFrom(goStore({ type: "oauth", access: "placeholder-access", expires: NOW - 1 }), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(opencodeGoKeyFrom(goStore({ type: "api" }), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(opencodeGoKeyFrom(goStore(null), NOW)).toEqual({ ok: false, reason: "no Go key" });
    expect(opencodeGoKeyFrom("nope", NOW)).toEqual({ ok: false, reason: "no Go key" });
    expect(hasOpencodeGoEntry(goStore())).toBe(true);
    expect(hasOpencodeGoEntry(goStore(null))).toBe(false);
  });

  it("applies the mode check, follows XDG_DATA_HOME, and says missing for no file", async () => {
    expect(await readOpencodeGoKey(fileSeams({ [OPENCODE_AUTH]: { mode: 0o600, text: goStore() } }))).toEqual({ ok: true, token: GO_KEY });
    expect(await readOpencodeGoKey(fileSeams({ [OPENCODE_AUTH]: { mode: 0o640, text: goStore() } }))).toEqual({ ok: false, reason: "readable by others" });
    const xdg = join("/data", "opencode", "auth.json");
    expect((await readOpencodeGoKey(fileSeams({ [xdg]: { mode: 0o600, text: goStore() } }, { XDG_DATA_HOME: "/data" }))).ok).toBe(true);
    expect(await readOpencodeGoKey(fileSeams({}))).toEqual({ ok: false, reason: "missing" });
  });

  it("asks opencode.ai with the bearer header, and asks nothing without a Go key", async () => {
    const source = opencodeAccountSource(fileSeams({ [OPENCODE_AUTH]: { mode: 0o600, text: goStore() } }));
    if (source.kind !== "http") throw new Error("http");
    expect(source.url).toBe("https://opencode.ai/zen/go/v1/usage");
    const headers = source.headers(GO_KEY);
    expect(headers.Authorization).toBe(`Bearer ${GO_KEY}`);
    expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);

    const lines: string[] = [];
    const fake = vendor();
    const windows = new AccountWindows({
      enabled: true,
      sources: [opencodeAccountSource(fileSeams({ [OPENCODE_AUTH]: { mode: 0o600, text: goStore(null) } }))],
      fetch: fake.fetch,
      now: () => NOW,
      userAgent: "collie/1.24.0",
      log: (line) => lines.push(line),
    });
    windows.observe([pane("opencode")], "main");
    await windows.settled();
    expect(fake.calls).toEqual([]);
    expect(lines).toEqual(["[usage] account windows, opencode: no login read (no Go key)"]);
  });

  it("serves the windows through the service", async () => {
    const fake = vendor();
    fake.answers.push({ status: 200, body: body() });
    const windows = new AccountWindows({
      enabled: true,
      sources: [opencodeAccountSource(fileSeams({ [OPENCODE_AUTH]: { mode: 0o600, text: goStore() } }))],
      fetch: fake.fetch,
      now: () => NOW,
      userAgent: "collie/1.24.0",
    });
    windows.observe([pane("opencode")], "main");
    await windows.settled();
    expect(fake.calls[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(fake.calls[0]?.headers["User-Agent"]).toBe("collie/1.24.0");
    expect(windows.limits("opencode")?.map((l) => l.window)).toEqual(["5h", "7d"]);
    expect(windows.scoped("opencode")?.map((w) => w.label)).toEqual(["30d"]);
  });
});

const GROK_TOKEN = "placeholder-grok-token";
const GROK_AUTH = join(HOME, ".grok", "auth.json");

function grokStore(entries: Record<string, JsonObject>): string {
  return JSON.stringify(entries);
}

describe("Grok", () => {
  const weekly = { creditUsagePercent: 37, currentPeriod: { start: "2027-01-13T00:00:00.000Z", end: "2027-01-20T00:00:00.000Z" } };
  const monthly = { creditUsagePercent: 12, currentPeriod: { start: "2027-01-01T00:00:00.000Z", end: "2027-02-01T00:00:00.000Z" } };

  it("maps a weekly period to 7d", () => {
    expect(parseGrokBilling(JSON.stringify(weekly))).toEqual({ limits: [{ window: "7d", used: 37, resetsAt: Date.parse("2027-01-20T00:00:00.000Z") }], scoped: [] });
    expect(parseGrokBilling(JSON.stringify({ config: weekly }))?.limits.length).toBe(1);
  });

  it("keeps a monthly period as 30d, not drawn", () => {
    expect(parseGrokBilling(JSON.stringify(monthly))).toEqual({ limits: [], scoped: [{ label: "30d", used: 12, resetsAt: Date.parse("2027-02-01T00:00:00.000Z") }] });
  });

  it("draws an eight-day period and not a nine-day one", () => {
    const span = (days: number): string =>
      JSON.stringify({ creditUsagePercent: 5, currentPeriod: { start: "2027-01-01T00:00:00.000Z", end: new Date(Date.parse("2027-01-01T00:00:00.000Z") + days * 86_400_000).toISOString() } });
    expect(parseGrokBilling(span(8))?.limits.length).toBe(1);
    expect(parseGrokBilling(span(9))?.limits.length).toBe(0);
  });

  it("keeps a period of unknown length as scoped, and takes the on-demand ratio when the percent is absent", () => {
    expect(parseGrokBilling(JSON.stringify({ creditUsagePercent: 50, currentPeriod: { end: "2027-01-20T00:00:00.000Z" } }))).toEqual({
      limits: [],
      scoped: [{ label: "credits", used: 50, resetsAt: Date.parse("2027-01-20T00:00:00.000Z") }],
    });
    expect(parseGrokBilling(JSON.stringify({ config: { onDemandUsed: { val: 25 }, onDemandCap: { val: 100 } } }))?.scoped[0]?.used).toBe(25);
  });

  it("reads a period without a percent as an account without windows, and strange bodies as unreadable", () => {
    expect(parseGrokBilling(JSON.stringify({ currentPeriod: weekly.currentPeriod }))).toEqual({ limits: [], scoped: [] });
    expect(parseGrokBilling("<html>")).toBeNull();
    expect(parseGrokBilling(JSON.stringify({ error: "nope" }))).toBeNull();
  });

  it("finds the token: the SuperGrok entry first, then the legacy one, then a flat store", () => {
    const both = grokStore({
      "https://accounts.x.ai/sign-in": { key: "placeholder-legacy" },
      "https://auth.x.ai::client": { key: GROK_TOKEN, refresh_token: "placeholder-refresh", expires_at: new Date(NOW + 86_400_000).toISOString() },
    });
    expect(grokTokenFrom(both, NOW)).toEqual({ ok: true, token: GROK_TOKEN });
    expect(grokTokenFrom(grokStore({ "https://accounts.x.ai/sign-in": { key: "placeholder-legacy" } }), NOW)).toEqual({ ok: true, token: "placeholder-legacy" });
    for (const field of ["token", "accessToken", "access_token"]) {
      expect(grokTokenFrom(JSON.stringify({ [field]: GROK_TOKEN }), NOW)).toEqual({ ok: true, token: GROK_TOKEN });
    }
  });

  it("judges expires_at as an ISO text, epoch seconds or epoch milliseconds, when it parses", () => {
    const at = (expires: JsonValue | undefined): string => grokStore({ "https://auth.x.ai::c": { key: GROK_TOKEN, expires_at: expires } });
    expect(grokTokenFrom(at(new Date(NOW - 1000).toISOString()), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(grokTokenFrom(at(Math.floor((NOW - 1000) / 1000)), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(grokTokenFrom(at(NOW - 1000), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(grokTokenFrom(at(Math.floor((NOW + 100_000) / 1000)), NOW).ok).toBe(true);
    expect(grokTokenFrom(at("soon"), NOW).ok).toBe(true);
    expect(grokTokenFrom(at(undefined), NOW).ok).toBe(true);
  });

  it("refuses a store with no token", () => {
    expect(grokTokenFrom(grokStore({ "https://auth.x.ai::c": { email: "someone@example.com" } }), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(grokTokenFrom("nope", NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("applies the mode check, follows GROK_HOME, and treats a missing file as nothing", async () => {
    const store = grokStore({ "https://auth.x.ai::c": { key: GROK_TOKEN } });
    expect(await readGrokLogin(fileSeams({ [GROK_AUTH]: { mode: 0o600, text: store } }))).toEqual({ ok: true, token: GROK_TOKEN });
    expect(await readGrokLogin(fileSeams({ [GROK_AUTH]: { mode: 0o604, text: store } }))).toEqual({ ok: false, reason: "readable by others" });
    expect((await readGrokLogin(fileSeams({ [join("/g", "auth.json")]: { mode: 0o600, text: store } }, { GROK_HOME: "/g" }))).ok).toBe(true);
    expect(await readGrokLogin(fileSeams({}))).toEqual({ ok: false, reason: "missing" });
  });

  it("asks the CLI proxy with the bearer and the token-auth header, through the service", async () => {
    const source = grokAccountSource(fileSeams({}));
    if (source.kind !== "http") throw new Error("http");
    expect(source.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(source.headers(GROK_TOKEN)).toEqual({ Authorization: `Bearer ${GROK_TOKEN}`, "x-xai-token-auth": "xai-grok-cli", Accept: "application/json" });

    const fake = vendor();
    fake.answers.push({ status: 200, body: JSON.stringify(weekly) });
    const lines: string[] = [];
    const windows = new AccountWindows({
      enabled: true,
      sources: [grokAccountSource(fileSeams({ [GROK_AUTH]: { mode: 0o600, text: grokStore({ "https://auth.x.ai::c": { key: GROK_TOKEN } }) } }))],
      fetch: fake.fetch,
      now: () => NOW,
      userAgent: "collie/1.24.0",
      log: (line) => lines.push(line),
    });
    windows.observe([pane("grok")], "main");
    await windows.settled();
    expect(fake.calls[0]?.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(windows.limits("grok")).toEqual([{ window: "7d", used: 37, resetsAt: Date.parse("2027-01-20T00:00:00.000Z") }]);
    expect(lines.join("\n")).not.toContain(GROK_TOKEN);
  });

  it("with no login file asks nothing and logs one line", async () => {
    const fake = vendor();
    const lines: string[] = [];
    const windows = new AccountWindows({ enabled: true, sources: [grokAccountSource(fileSeams({}))], fetch: fake.fetch, now: () => NOW, userAgent: "collie/1.24.0", log: (l) => lines.push(l) });
    windows.observe([pane("grok")], "main");
    await windows.settled();
    expect(fake.calls).toEqual([]);
    expect(lines).toEqual(["[usage] account windows, grok: no login read (missing)"]);
  });
});

describe("the source table", () => {
  it("has one source per harness id, claude, codex, opencode and grok, and the phone's windows stay 5h and 7d", () => {
    const sources = defaultAccountSources(fileSeams({}));
    expect(sources.map((source) => `${source.harness}:${source.kind}`)).toEqual(["claude:http", "codex:local", "opencode:http", "grok:http"]);
    expect([...USAGE_WINDOWS]).toEqual(["5h", "7d"]);
  });

  it("a bad body costs the reading and never the pane, for each harness", async () => {
    for (const harness of ["opencode", "grok"]) {
      const files = { [OPENCODE_AUTH]: { mode: 0o600, text: goStore() }, [GROK_AUTH]: { mode: 0o600, text: grokStore({ "https://auth.x.ai::c": { key: GROK_TOKEN } }) } };
      const fake = vendor();
      fake.answers.push({ status: 200, body: "<html>maintenance</html>" });
      const windows = new AccountWindows({ enabled: true, sources: defaultAccountSources(fileSeams(files)), fetch: fake.fetch, now: () => NOW, userAgent: "collie/1.24.0" });
      windows.observe([pane(harness)], "main");
      await windows.settled();
      expect(windows.limits(harness)).toBeUndefined();
    }
  });
});
