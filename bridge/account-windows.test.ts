import { describe, expect, it } from "bun:test";

import { join } from "node:path";

import {
  accountWindowsDoctorLine,
  AccountWindows,
  ASK_EVERY_MS,
  BACKOFF,
  claudeAccountSource,
  claudeCredentialsPath,
  claudeTokenFrom,
  CLAUDE_USAGE_URL,
  isTurnEnd,
  parseAccountUsage,
  POKE_EVERY_MS,
  readClaudeLogin,
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
        harness: "claude",
        url: CLAUDE_USAGE_URL,
        login: opts.login ?? (async () => ({ ok: true, token: TOKEN })),
        headers: (token) => ({ Authorization: `Bearer ${token}` }),
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
  it("names the file and the host when on, and says off when off", () => {
    expect(accountWindowsDoctorLine(true, {}, HOME, "linux")).toBe(
      "on (claude: read ~/.claude/.credentials.json, asks api.anthropic.com)",
    );
    expect(accountWindowsDoctorLine(true, { CLAUDE_CONFIG_DIR: "/profiles/work" }, HOME, "linux")).toBe(
      `on (claude: read ${join("/profiles/work", ".credentials.json")}, asks api.anthropic.com)`,
    );
    expect(accountWindowsDoctorLine(true, {}, HOME, "darwin")).toBe(
      "on (claude: read ~/.claude/.credentials.json or the Keychain, asks api.anthropic.com)",
    );
    expect(accountWindowsDoctorLine(false, {}, HOME, "linux")).toBe("off");
  });
});
