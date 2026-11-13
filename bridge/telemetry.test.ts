// Tests for bridge/telemetry.ts: the anonymous install ping (M86 spec 01).
//
// The decision order, the exact key set of the ping, the 24 hour wait and the once-a-day rule are
// the contract. Nothing here reaches the network: every send goes through a fake `fetch`.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Environment } from "./config-source.ts";
import type { CrewMode } from "./types.ts";
import {
  buildPing,
  createTelemetry,
  EMPTY_TELEMETRY_RECORD,
  FIRST_PING_DELAY_MS,
  noteTrouble,
  parseTelemetryRecord,
  parseTroubleSignal,
  parseTelemetryRequest,
  pingRole,
  pingVersion,
  PING_TIMEOUT_MS,
  PING_USER_AGENT,
  readTelemetryRecord,
  readTelemetrySwitch,
  resolveTelemetryUrl,
  shouldSend,
  telemetryBootLine,
  telemetryDoctorLine,
  telemetryPath,
  telemetrySwitchWarning,
  telemetryState,
  TELEMETRY_URL,
  TROUBLE_COUNT_MAX,
  TROUBLE_ROWS_MAX,
  TROUBLE_SCREEN,
  utcDay,
  type PingFetch,
  type TelemetryDecider,
  type TelemetryDeps,
  type TelemetryOrigin,
  type TelemetrySetting,
  type TelemetryRecord,
  type TelemetryState,
  type TroubleSignal,
  type UsagePane,
  type UsageRow,
  noteSessions,
  parseTroubleBody,
  PING_SCHEMA,
  USAGE_HARNESSES,
  USAGE_MUXES,
  USAGE_PANES_MAX,
  USAGE_ROWS_MAX,
  USAGE_SAMPLE_MS,
  usageWord,
} from "./telemetry.ts";

const RELEASE = "1.26.0+fd5a796587";
const DEV = "1.26.0-dev+1530ff7cb0";
const REQUEST_ID = "5f3c1c1e-2f0a-4c8f-9c67-0a1f2b3c4d5e";
const OTHER_ID = "9a8b7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d";

function state(a: {
  env?: Environment;
  origin?: TelemetryOrigin;
  setting?: TelemetrySetting | null;
  version?: string;
}): { on: boolean; decidedBy: TelemetryDecider } {
  return telemetryState({ env: a.env ?? {}, origin: a.origin ?? "env", setting: a.setting ?? null, version: a.version ?? RELEASE });
}

describe("telemetryState: the decision order", () => {
  test("default: a tagged release build with nothing set is on", () => {
    expect(state({})).toEqual({ on: true, decidedBy: "default" });
  });

  test("DO_NOT_TRACK: any non-empty value but 0 is off, and it beats everything", () => {
    expect(state({ env: { DO_NOT_TRACK: "1" } })).toEqual({ on: false, decidedBy: "do_not_track" });
    expect(state({ env: { DO_NOT_TRACK: "yes" } })).toEqual({ on: false, decidedBy: "do_not_track" });
    expect(state({ env: { DO_NOT_TRACK: "1", COLLIE_TELEMETRY: "1" } })).toEqual({ on: false, decidedBy: "do_not_track" });
    expect(state({ env: { DO_NOT_TRACK: "1" }, setting: "on" })).toEqual({ on: false, decidedBy: "do_not_track" });
  });

  test("DO_NOT_TRACK=0, empty or blank does not count", () => {
    expect(state({ env: { DO_NOT_TRACK: "0" } })).toEqual({ on: true, decidedBy: "default" });
    expect(state({ env: { DO_NOT_TRACK: "" } })).toEqual({ on: true, decidedBy: "default" });
    expect(state({ env: { DO_NOT_TRACK: "  " } })).toEqual({ on: true, decidedBy: "default" });
  });

  test("COLLIE_TELEMETRY off words turn it off, decided by env", () => {
    for (const word of ["0", "false", "no", "off", "OFF"]) {
      expect(state({ env: { COLLIE_TELEMETRY: word } })).toEqual({ on: false, decidedBy: "env" });
    }
  });

  test("COLLIE_TELEMETRY on words turn it on when nothing else says off", () => {
    for (const word of ["1", "true", "yes", "on"]) {
      expect(state({ env: { COLLIE_TELEMETRY: word } })).toEqual({ on: true, decidedBy: "env" });
    }
  });

  test("COLLIE_TELEMETRY on does not beat CI, a mirror, a dev build or the phone's off", () => {
    expect(state({ env: { COLLIE_TELEMETRY: "1", CI: "true" } })).toEqual({ on: false, decidedBy: "ci" });
    expect(state({ env: { COLLIE_TELEMETRY: "1", COLLIE_UPDATE_MIRROR: "http://127.0.0.1:9" } })).toEqual({ on: false, decidedBy: "mirror" });
    expect(state({ env: { COLLIE_TELEMETRY: "1" }, version: DEV })).toEqual({ on: false, decidedBy: "dev_build" });
    expect(state({ env: { COLLIE_TELEMETRY: "1" }, setting: "off" })).toEqual({ on: false, decidedBy: "settings" });
    expect(state({ env: { COLLIE_TELEMETRY: "true" }, origin: "config", setting: "off" })).toEqual({ on: false, decidedBy: "settings" });
  });

  test("a COLLIE_TELEMETRY that came from config.toml is decided by config", () => {
    expect(state({ env: { COLLIE_TELEMETRY: "false" }, origin: "config" })).toEqual({ on: false, decidedBy: "config" });
    expect(state({ env: { COLLIE_TELEMETRY: "true" }, origin: "config" })).toEqual({ on: true, decidedBy: "config" });
  });

  test("a value that is no known word fails closed: off, decided by the origin", () => {
    for (const word of ["maybe", "ofF1", "2", "disabled", "enable", "y", "n", "tru"]) {
      expect(state({ env: { COLLIE_TELEMETRY: word } })).toEqual({ on: false, decidedBy: "env" });
      expect(state({ env: { COLLIE_TELEMETRY: word }, origin: "config" })).toEqual({ on: false, decidedBy: "config" });
    }
    // The phone cannot turn an unknown value back on.
    expect(state({ env: { COLLIE_TELEMETRY: "maybe" }, setting: "on" })).toEqual({ on: false, decidedBy: "env" });
  });

  test("the words are read in any case and trimmed", () => {
    for (const word of [" OFF ", "No", "FALSE", "\t0\n"]) {
      expect(state({ env: { COLLIE_TELEMETRY: word } })).toEqual({ on: false, decidedBy: "env" });
    }
    for (const word of [" ON ", "Yes", "TRUE", " 1 "]) {
      expect(state({ env: { COLLIE_TELEMETRY: word } })).toEqual({ on: true, decidedBy: "env" });
    }
  });

  test("an empty or blank value is no vote: the phone and the default decide", () => {
    expect(state({ env: { COLLIE_TELEMETRY: "" } })).toEqual({ on: true, decidedBy: "default" });
    expect(state({ env: { COLLIE_TELEMETRY: "   " } })).toEqual({ on: true, decidedBy: "default" });
    expect(state({ env: { COLLIE_TELEMETRY: "" }, setting: "off" })).toEqual({ on: false, decidedBy: "settings" });
  });

  test("readTelemetrySwitch and telemetrySwitchWarning: only an unknown value warns, with the value as written", () => {
    expect(readTelemetrySwitch(undefined)).toEqual({ kind: "unset" });
    expect(readTelemetrySwitch("")).toEqual({ kind: "unset" });
    expect(readTelemetrySwitch("Yes")).toEqual({ kind: "on" });
    expect(readTelemetrySwitch("OFF")).toEqual({ kind: "off" });
    expect(readTelemetrySwitch(" maybe ")).toEqual({ kind: "unknown", value: "maybe" });
    expect(telemetrySwitchWarning({})).toBeNull();
    expect(telemetrySwitchWarning({ COLLIE_TELEMETRY: "off" })).toBeNull();
    expect(telemetrySwitchWarning({ COLLIE_TELEMETRY: "" })).toBeNull();
    expect(telemetrySwitchWarning({ COLLIE_TELEMETRY: "maybe" })).toBe("COLLIE_TELEMETRY=maybe is not a known value, read as off");
  });

  test("the phone's switch decides when env and config say nothing, in both directions", () => {
    expect(state({ setting: "off" })).toEqual({ on: false, decidedBy: "settings" });
    expect(state({ setting: "on" })).toEqual({ on: true, decidedBy: "settings" });
  });

  test("the phone's on cannot turn on over CI, a mirror or a dev build", () => {
    expect(state({ setting: "on", env: { CI: "1" } })).toEqual({ on: false, decidedBy: "ci" });
    expect(state({ setting: "on", env: { COLLIE_UPDATE_MIRROR: "http://127.0.0.1:9" } })).toEqual({ on: false, decidedBy: "mirror" });
    expect(state({ setting: "on", version: DEV })).toEqual({ on: false, decidedBy: "dev_build" });
  });

  test("env or config off cannot be undone from the phone", () => {
    expect(state({ env: { COLLIE_TELEMETRY: "0" }, setting: "on" })).toEqual({ on: false, decidedBy: "env" });
    expect(state({ env: { COLLIE_TELEMETRY: "0" }, origin: "config", setting: "on" })).toEqual({ on: false, decidedBy: "config" });
  });

  test("CI set is off", () => {
    expect(state({ env: { CI: "true" } })).toEqual({ on: false, decidedBy: "ci" });
  });

  test("a rehearsal mirror is off", () => {
    expect(state({ env: { COLLIE_UPDATE_MIRROR: "http://127.0.0.1:8080" } })).toEqual({ on: false, decidedBy: "mirror" });
  });

  test("CI is read before the mirror, the mirror before a dev build", () => {
    expect(state({ env: { CI: "1", COLLIE_UPDATE_MIRROR: "http://127.0.0.1:1" }, version: DEV }).decidedBy).toBe("ci");
    expect(state({ env: { COLLIE_UPDATE_MIRROR: "http://127.0.0.1:1" }, version: DEV }).decidedBy).toBe("mirror");
  });

  test("a -dev version is off with dev_build, and a +sha tag build is on", () => {
    expect(state({ version: DEV })).toEqual({ on: false, decidedBy: "dev_build" });
    expect(state({ version: "1.26.0-dev" })).toEqual({ on: false, decidedBy: "dev_build" });
    expect(state({ version: "1.26.0+fd5a796587" })).toEqual({ on: true, decidedBy: "default" });
    expect(state({ version: "1.26.0-edge.1+ab12cd3" })).toEqual({ on: true, decidedBy: "default" });
    expect(state({ version: "1.26.0" })).toEqual({ on: true, decidedBy: "default" });
  });

  test("a URL override that is not allowed turns it off, decided by url, below DO_NOT_TRACK only", () => {
    expect(state({ env: { COLLIE_TELEMETRY_URL: "http://example.com/ping" } })).toEqual({ on: false, decidedBy: "url" });
    expect(state({ env: { COLLIE_TELEMETRY_URL: "http://example.com/ping", COLLIE_TELEMETRY: "1" }, setting: "on" })).toEqual({
      on: false,
      decidedBy: "url",
    });
    expect(state({ env: { COLLIE_TELEMETRY_URL: "http://example.com/ping", DO_NOT_TRACK: "1" } }).decidedBy).toBe("do_not_track");
  });
});

describe("resolveTelemetryUrl: the override rules", () => {
  test("unset or blank is the default endpoint", () => {
    expect(resolveTelemetryUrl({})).toEqual({ ok: true, url: TELEMETRY_URL });
    expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: "  " })).toEqual({ ok: true, url: TELEMETRY_URL });
    expect(TELEMETRY_URL).toBe("https://ping.colliepwa.dev/v1/ping");
  });

  test("https is taken as given", () => {
    expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: "https://ping.example.test/v1/ping" })).toEqual({
      ok: true,
      url: "https://ping.example.test/v1/ping",
    });
  });

  test("http is taken for 127.0.0.1 and localhost only", () => {
    expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: "http://127.0.0.1:8123/p" }).ok).toBe(true);
    expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: "http://localhost:8123/p" }).ok).toBe(true);
    expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: "http://example.com/p" })).toEqual({ ok: false, value: "http://example.com/p" });
    expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: "http://127.0.0.1.example.com/p" }).ok).toBe(false);
  });

  test("anything else is refused: other schemes, no scheme, credentials", () => {
    for (const value of ["ftp://127.0.0.1/p", "ping.example.test/v1", "not a url", "https://user:pw@ping.example.test/p", "file:///etc/passwd"]) {
      expect(resolveTelemetryUrl({ COLLIE_TELEMETRY_URL: value }), value).toEqual({ ok: false, value });
    }
  });
});

describe("buildPing", () => {
  const ping = buildPing({ id: "a".repeat(32), day: "2026-11-04", version: "1.26.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [], usage: [] });

  test("the key set is exactly v, id, day, version, os, arch, install, line, role, trouble, usage (eleven keys)", () => {
    expect(Object.keys(ping)).toEqual(["v", "id", "day", "version", "os", "arch", "install", "line", "role", "trouble", "usage"]);
  });

  test("an empty tally is [], and a row carries exactly kind, harness, version, mux, linked, count", () => {
    expect(ping.trouble).toEqual([]);
    // A row read from a record file that grew a stray field still leaves with its six fields only.
    const grown = { kind: "send", harness: "claude", version: "2.1.316", mux: "herdr", linked: true, count: 2, paneId: "w1:p1" } as const;
    const built = buildPing({ id: "a".repeat(32), day: "2026-11-04", version: "1.26.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [grown], usage: [] });
    expect(built.trouble).toEqual([{ kind: "send", harness: "claude", version: "2.1.316", mux: "herdr", linked: true, count: 2 }]);
    expect(Object.keys(built.trouble[0] ?? {})).toEqual(["kind", "harness", "version", "mux", "linked", "count"]);
  });

  test("a dialog row with a screen carries it before linked and count, and a row without one has no screen key", () => {
    const plain = { kind: "dialog", harness: "codex", version: "0.167.0", mux: "herdr", linked: false, count: 13 } as const;
    const hashed = { ...plain, screen: "634c6530" } as const;
    const built = buildPing({ id: "a".repeat(32), day: "2026-11-08", version: "1.27.4", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [plain, hashed], usage: [] });
    expect(JSON.stringify(built.trouble[0])).toBe('{"kind":"dialog","harness":"codex","version":"0.167.0","mux":"herdr","linked":false,"count":13}');
    expect(JSON.stringify(built.trouble[1])).toBe('{"kind":"dialog","harness":"codex","version":"0.167.0","mux":"herdr","screen":"634c6530","linked":false,"count":13}');
    expect(built.trouble[0]).not.toHaveProperty("screen");
  });

  test("each role value is carried as given", () => {
    for (const role of ["solo", "lead", "member"] as const) {
      const built = buildPing({ id: "a".repeat(32), day: "2026-11-04", version: "1.26.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role, trouble: [], usage: [] });
      expect(built.role).toBe(role);
    }
  });

  test("pingRole: solo is solo, lead is lead, and a peer (a member or a non-lead deputy) is a member", () => {
    expect(pingRole("solo")).toBe("solo");
    expect(pingRole("lead")).toBe("lead");
    expect(pingRole("peer")).toBe("member");
  });

  test("the values are the ones given, and the schema is 3", () => {
    expect(ping).toEqual({
      v: 3,
      id: "a".repeat(32),
      day: "2026-11-04",
      version: "1.26.0",
      os: "linux",
      arch: "x64",
      install: "binary",
      line: "stable",
      role: "solo",
      trouble: [],
      usage: [],
    });
  });

  test("pingVersion drops the +sha tail and keeps an Edge suffix", () => {
    expect(pingVersion("1.26.0+fd5a796587")).toBe("1.26.0");
    expect(pingVersion("1.26.0-edge.1+ab12cd3")).toBe("1.26.0-edge.1");
    expect(pingVersion("1.26.0")).toBe("1.26.0");
  });
});

describe("shouldSend", () => {
  const first = Date.UTC(2026, 10, 3, 12, 0, 0);

  test("off never sends", () => {
    expect(shouldSend({ now: first + 5 * FIRST_PING_DELAY_MS, firstSeenAt: first, lastSentDay: null, on: false })).toBe(false);
  });

  test("a machine that has not started its clock never sends", () => {
    expect(shouldSend({ now: first, firstSeenAt: null, lastSentDay: null, on: true })).toBe(false);
  });

  test("waits 24 hours after the first start, to the millisecond", () => {
    expect(shouldSend({ now: first + FIRST_PING_DELAY_MS - 1, firstSeenAt: first, lastSentDay: null, on: true })).toBe(false);
    expect(shouldSend({ now: first + FIRST_PING_DELAY_MS, firstSeenAt: first, lastSentDay: null, on: true })).toBe(true);
  });

  test("not twice on the same UTC day, and again on the next", () => {
    const now = first + 3 * FIRST_PING_DELAY_MS;
    expect(shouldSend({ now, firstSeenAt: first, lastSentDay: utcDay(now), on: true })).toBe(false);
    expect(shouldSend({ now, firstSeenAt: first, lastSentDay: utcDay(now - FIRST_PING_DELAY_MS), on: true })).toBe(true);
  });

  test("the day is UTC: 23:59 and 00:00 are two days", () => {
    expect(utcDay(Date.UTC(2026, 10, 4, 23, 59, 59))).toBe("2026-11-04");
    expect(utcDay(Date.UTC(2026, 10, 5, 0, 0, 0))).toBe("2026-11-05");
  });
});

describe("the state file", () => {
  test("a file that is not a record reads as empty", () => {
    expect(parseTelemetryRecord(null)).toEqual(EMPTY_TELEMETRY_RECORD);
    expect(parseTelemetryRecord("not json")).toEqual(EMPTY_TELEMETRY_RECORD);
    expect(parseTelemetryRecord("[]")).toEqual(EMPTY_TELEMETRY_RECORD);
  });

  test("a field of the wrong shape reads as absent, the rest is kept", () => {
    const record = parseTelemetryRecord(JSON.stringify({ id: "not-hex", firstSeenAt: "soon", lastSentDay: "yesterday", setting: "maybe", changedAt: 5, requestId: REQUEST_ID }));
    expect(record).toEqual({ ...EMPTY_TELEMETRY_RECORD, changedAt: 5, requestId: REQUEST_ID });
  });

  test("parseTelemetryRequest: a setting and a request id, or null for what is missing", () => {
    expect(parseTelemetryRequest({ setting: "off", requestId: REQUEST_ID })).toEqual({ setting: "off", requestId: REQUEST_ID });
    expect(parseTelemetryRequest({ setting: "off" })).toEqual({ setting: "off", requestId: null });
    expect(parseTelemetryRequest({ setting: "maybe", requestId: REQUEST_ID })).toEqual({ setting: null, requestId: REQUEST_ID });
    expect(parseTelemetryRequest({ setting: "on", requestId: "not-a-uuid" })).toEqual({ setting: "on", requestId: null });
    expect(parseTelemetryRequest("on")).toBeNull();
  });
});

// ── THE SHELL, over a real temp folder and a fake fetch ───────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function rig(over: { env?: Environment; origin?: TelemetryOrigin; version?: string; fail?: boolean; start?: number } = {}) {
  let crewMode: CrewMode = "solo";
  const stateDir = mkdtempSync(join(tmpdir(), "collie-telemetry-"));
  dirs.push(stateDir);
  const clock = { now: over.start ?? Date.UTC(2026, 10, 3, 12, 0, 0) };
  const sent: Sent[] = [];
  const ids = ["1".repeat(32), "2".repeat(32), "3".repeat(32)];
  const warnings: string[] = [];
  const logs: string[] = [];
  const fakeFetch: PingFetch = async (url, init) => {
    sent.push({ url, init });
    if (over.fail === true) throw new Error("offline");
    return new Response("ok");
  };
  const telemetry = createTelemetry({
    stateDir,
    env: over.env ?? {},
    origin: over.origin ?? "env",
    version: over.version ?? RELEASE,
    installKind: "binary",
    line: () => "stable",
    crewMode: () => crewMode,
    now: () => clock.now,
    fetch: fakeFetch,
    os: "linux",
    arch: "x64",
    newId: () => ids.shift() ?? "f".repeat(32),
    warn: (line) => warnings.push(line),
    log: (line) => logs.push(line),
  });
  const setCrewMode = (mode: CrewMode): void => {
    crewMode = mode;
  };
  return { stateDir, clock, setCrewMode, sent, telemetry, warnings, logs };
}

describe("createTelemetry", () => {
  test("a fresh install sends nothing for 24 hours, then one ping, then nothing the same day", async () => {
    const r = rig();
    r.telemetry.observe();
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(0);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
  });

  test("the next UTC day sends again", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(2);
    const days = r.sent.map((s) => JSON.parse(String(s.init.body)).day);
    expect(days[0]).not.toBe(days[1]);
  });

  test("the role is read at ping time: a mode that changes between pings changes the role", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    r.setCrewMode("lead");
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    r.setCrewMode("peer");
    expect(r.telemetry.view().next?.role).toBe("member");
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    const roles = r.sent.map((s) => JSON.parse(String(s.init.body)).role);
    expect(roles).toEqual(["solo", "lead", "member"]);
  });

  test("the request: POST, JSON, the fixed user agent, the default URL, exactly the ping", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    const [call] = r.sent;
    expect(call?.url).toBe(TELEMETRY_URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({ "content-type": "application/json", "user-agent": PING_USER_AGENT });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      v: 3,
      id: "1".repeat(32),
      day: utcDay(r.clock.now),
      version: "1.26.0",
      os: "linux",
      arch: "x64",
      install: "binary",
      line: "stable",
      role: "solo",
      trouble: [],
      usage: [],
    });
    expect(call?.init.signal).toBeDefined();
  });

  test("the URL override goes to the loopback test server", async () => {
    const r = rig({ env: { COLLIE_TELEMETRY_URL: "http://127.0.0.1:9999/ping" } });
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent.map((s) => s.url)).toEqual(["http://127.0.0.1:9999/ping"]);
  });

  test("a refused URL override sends nothing, warns once at boot, and says off", async () => {
    const r = rig({ env: { COLLIE_TELEMETRY_URL: "http://example.com/ping" } });
    r.telemetry.observe();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("COLLIE_TELEMETRY_URL");
    r.clock.now += 3 * FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(0);
    expect(r.telemetry.view()).toMatchObject({ on: false, decidedBy: "url", next: null });
  });

  test("a failed fetch writes lastSentDay first, does not throw, and does not retry the same day", async () => {
    const r = rig({ fail: true });
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
    expect(readTelemetryRecord(r.stateDir).lastSentDay).toBe(utcDay(r.clock.now));
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
  });

  test("lastSentDay is on disk before the request goes out", async () => {
    const r = rig();
    const seen: Array<string | null> = [];
    const telemetry = createTelemetry({
      stateDir: r.stateDir,
      env: {},
      origin: "env",
      version: RELEASE,
      installKind: "binary",
      line: () => "stable",
      crewMode: () => "solo",
      now: () => r.clock.now,
      fetch: async () => {
        seen.push(readTelemetryRecord(r.stateDir).lastSentDay);
        return new Response("ok");
      },
      os: "linux",
      arch: "x64",
    });
    telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await telemetry.tick();
    expect(seen).toEqual([utcDay(r.clock.now)]);
  });

  test("a state folder that cannot be written does not throw, and nothing is sent", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    rmSync(r.stateDir, { recursive: true, force: true });
    // A file where the folder was: mkdir and every write under it fail.
    await Bun.write(r.stateDir, "not a folder");
    await expect(r.telemetry.tick()).resolves.toBeUndefined();
    expect(r.sent).toHaveLength(0);
    rmSync(r.stateDir, { force: true });
  });

  test.skipIf(process.platform === "win32")("the file is owner-only", () => {
    const r = rig();
    r.telemetry.observe();
    expect(statSync(telemetryPath(r.stateDir)).mode & 0o777).toBe(0o600);
  });

  test("the ID is made once and kept; the view shows the exact next ping", () => {
    const r = rig();
    const one = r.telemetry.view();
    const two = r.telemetry.view();
    expect(one.on).toBe(true);
    expect(one.next?.id).toBe("1".repeat(32));
    expect(two.next?.id).toBe("1".repeat(32));
    expect(one.next).toEqual({
      v: 3,
      id: "1".repeat(32),
      day: utcDay(r.clock.now),
      version: "1.26.0",
      os: "linux",
      arch: "x64",
      install: "binary",
      line: "stable",
      role: "solo",
      trouble: [],
      usage: [],
    });
  });

  test("off by any switch keeps no ID: no ID in the file and next is null", () => {
    const r = rig({ env: { DO_NOT_TRACK: "1" } });
    r.telemetry.observe();
    expect(r.telemetry.view()).toEqual({ on: false, decidedBy: "do_not_track", setting: null, next: null });
    expect(readTelemetryRecord(r.stateDir).id).toBeNull();
  });

  test("a dev build is off and keeps no ID", () => {
    const r = rig({ version: DEV });
    expect(r.telemetry.view()).toEqual({ on: false, decidedBy: "dev_build", setting: null, next: null });
    expect(readTelemetryRecord(r.stateDir).id).toBeNull();
  });

  test("a dev build never sends, even with an ON switch and an ID copied from an install that had it on", async () => {
    const r = rig({ version: DEV });
    r.telemetry.choose({ setting: "on", requestId: REQUEST_ID });
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(0);
    expect(readTelemetryRecord(r.stateDir).id).toBeNull();
  });

  test("the ID is deleted on off, lastSentDay is cleared, and on again makes a new ID", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    const before = readTelemetryRecord(r.stateDir);
    expect(before.id).toBe("1".repeat(32));
    expect(before.lastSentDay).not.toBeNull();

    const off = r.telemetry.choose({ setting: "off", requestId: REQUEST_ID });
    expect(off.view).toEqual({ on: false, decidedBy: "settings", setting: "off", next: null });
    const afterOff = readTelemetryRecord(r.stateDir);
    expect(afterOff.id).toBeNull();
    expect(afterOff.lastSentDay).toBeNull();
    expect(readFileSync(telemetryPath(r.stateDir), "utf8")).not.toContain("1".repeat(32));

    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);

    const on = r.telemetry.choose({ setting: "on", requestId: OTHER_ID });
    expect(on.view.on).toBe(true);
    expect(on.view.next?.id).toBe("2".repeat(32));
    expect(on.view.next?.id).not.toBe(before.id);
  });

  test("the phone's POST: a replay of the same request id answers unchanged and writes nothing", () => {
    const r = rig();
    const first = r.telemetry.choose({ setting: "off", requestId: REQUEST_ID });
    expect(first.replay).toBe(false);
    const stamp = readTelemetryRecord(r.stateDir).changedAt;
    r.clock.now += 1000;
    const again = r.telemetry.choose({ setting: "off", requestId: REQUEST_ID });
    expect(again.replay).toBe(true);
    expect(again.view).toEqual(first.view);
    expect(readTelemetryRecord(r.stateDir).changedAt).toBe(stamp);
  });

  test("a phone ON cannot undo an env off", () => {
    const r = rig({ env: { COLLIE_TELEMETRY: "0" } });
    const result = r.telemetry.choose({ setting: "on", requestId: REQUEST_ID });
    expect(result.view).toEqual({ on: false, decidedBy: "env", setting: "on", next: null });
    expect(readTelemetryRecord(r.stateDir).id).toBeNull();
  });

  test("the same machine without a state file at all sends no file contents it did not make", () => {
    const r = rig({ env: { DO_NOT_TRACK: "1" } });
    expect(existsSync(telemetryPath(r.stateDir))).toBe(false);
  });
});

describe("the boot line (M86 spec 01)", () => {
  const ON = "install count: on, decided by default; first ping after 2026-11-04 12:00 UTC; off with COLLIE_TELEMETRY=0 in the service .env, docs/security.md#what-leaves-your-machine";

  test("a fresh install logs one line with the exact time of the first ping", () => {
    const r = rig();
    r.telemetry.observe();
    expect(r.logs).toEqual([ON]);
  });

  test("every start logs it again, and the time stays where the first start put it", () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += 3 * 60 * 60 * 1000;
    r.telemetry.observe();
    expect(r.logs).toEqual([ON, ON]);
  });

  test("after the first ping's time the line says so, and after a send it names the day", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    r.telemetry.observe();
    expect(r.logs[1]).toBe("install count: on, decided by default; first ping is due; off with COLLIE_TELEMETRY=0 in the service .env, docs/security.md#what-leaves-your-machine");
    await r.telemetry.tick();
    r.telemetry.observe();
    expect(r.logs[2]).toBe("install count: on, decided by default; last send attempt 2026-11-04; off with COLLIE_TELEMETRY=0 in the service .env, docs/security.md#what-leaves-your-machine");
  });

  test("off says which switch, in the doctor's words, and nothing more", () => {
    const logs = (a: Parameters<typeof rig>[0]): string[] => {
      const r = rig(a);
      r.telemetry.observe();
      return r.logs;
    };
    expect(logs({ env: { DO_NOT_TRACK: "1" } })).toEqual(["install count: off (DO_NOT_TRACK)"]);
    expect(logs({ env: { COLLIE_TELEMETRY: "0" } })).toEqual(["install count: off (COLLIE_TELEMETRY)"]);
    expect(logs({ env: { CI: "true" } })).toEqual(["install count: off (CI is set)"]);
    expect(logs({ version: DEV })).toEqual(["install count: off (development build)"]);
  });

  test("the on line names the switch that voted on", () => {
    const r = rig({ env: { COLLIE_TELEMETRY: "yes" } });
    r.telemetry.observe();
    expect(r.logs[0]).toContain("on, decided by COLLIE_TELEMETRY;");
    const c = rig({ env: { COLLIE_TELEMETRY: "true" }, origin: "config" });
    c.telemetry.observe();
    expect(c.logs[0]).toContain("on, decided by config.toml;");
  });

  test("an unknown COLLIE_TELEMETRY value logs off and warns once with the value", () => {
    const r = rig({ env: { COLLIE_TELEMETRY: "maybe" } });
    r.telemetry.observe();
    expect(r.logs).toEqual(["install count: off (COLLIE_TELEMETRY)"]);
    expect(r.warnings).toEqual(["COLLIE_TELEMETRY=maybe is not a known value, read as off"]);
  });

  test("telemetryBootLine is pure: the same input is the same line", () => {
    const input = {
      state: { on: true, decidedBy: "default" },
      record: { firstSeenAt: Date.UTC(2026, 10, 3, 12, 0, 0), lastSentDay: null },
      now: Date.UTC(2026, 10, 3, 12, 0, 0),
      env: {},
    } as const;
    expect(telemetryBootLine(input)).toBe(telemetryBootLine(input));
    expect(telemetryBootLine(input)).toBe(ON);
  });
});

describe("the send is hardened (M86 spec 01)", () => {
  test("it follows no redirect: a 302 is a failed send, and the second address is never asked", async () => {
    let landed = 0;
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { landed += 1; return new Response("landed"); } });
    const first = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/x`, 302) });
    try {
      const stateDir = mkdtempSync(join(tmpdir(), "collie-telemetry-"));
      dirs.push(stateDir);
      const now = Date.UTC(2026, 10, 3, 12, 0, 0);
      const t = createTelemetry({
        stateDir,
        env: { COLLIE_TELEMETRY_URL: `http://127.0.0.1:${first.port}/v1/ping` },
        origin: "env",
        version: RELEASE,
        installKind: "binary",
        line: () => "stable",
        crewMode: () => "solo",
        now: () => now,
        fetch: (url, init) => fetch(url, init),
        os: "linux",
        arch: "x64",
      });
      t.observe();
      await expect(t.tick()).resolves.toBeUndefined();
      const later = createTelemetry({
        stateDir,
        env: { COLLIE_TELEMETRY_URL: `http://127.0.0.1:${first.port}/v1/ping` },
        origin: "env",
        version: RELEASE,
        installKind: "binary",
        line: () => "stable",
        crewMode: () => "solo",
        now: () => now + FIRST_PING_DELAY_MS,
        fetch: (url, init) => fetch(url, init),
        os: "linux",
        arch: "x64",
      });
      await expect(later.tick()).resolves.toBeUndefined();
      expect(landed).toBe(0);
      expect(readTelemetryRecord(stateDir).lastSentDay).toBe(utcDay(now + FIRST_PING_DELAY_MS));
    } finally {
      void first.stop(true);
      void target.stop(true);
    }
  });

  test("the request refuses redirects and carries a timeout of at most five seconds", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent[0]?.init.redirect).toBe("error");
    expect(r.sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(PING_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  test("the answer's body is never read, and a hostile answer changes nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "collie-telemetry-"));
    dirs.push(stateDir);
    let touched = false;
    const body = new ReadableStream({ pull() { touched = true; throw new Error("read"); } }, { highWaterMark: 0 });
    const hostile = new Response(body, { status: 200, headers: { "set-cookie": "a=b", location: "http://evil.example/" } });
    let now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const t = createTelemetry({
      stateDir, env: {}, origin: "env", version: RELEASE, installKind: "binary", line: () => "stable", crewMode: () => "solo",
      now: () => now, fetch: async () => hostile, os: "linux", arch: "x64",
    });
    t.observe();
    now += FIRST_PING_DELAY_MS;
    await t.tick();
    expect(touched).toBe(false);
  });

  test("boot never calls the network: observe is synchronous and sends nothing", () => {
    const r = rig();
    r.telemetry.observe();
    expect(r.sent).toHaveLength(0);
  });
});

describe("telemetryDoctorLine", () => {
  test("one plain line per deciding switch", () => {
    const line = (decidedBy: TelemetryDecider, on: boolean, env: Environment = {}): string => telemetryDoctorLine({ state: { on, decidedBy }, env });
    expect(line("default", true)).toBe("on (default)");
    expect(line("do_not_track", false)).toBe("off (DO_NOT_TRACK)");
    expect(line("env", false)).toBe("off (COLLIE_TELEMETRY)");
    expect(line("config", false)).toBe("off (config.toml, telemetry)");
    expect(line("settings", false)).toBe("off (set on the phone)");
    expect(line("ci", false)).toBe("off (CI is set)");
    expect(line("mirror", false)).toBe("off (COLLIE_UPDATE_MIRROR is set)");
    expect(line("dev_build", false)).toBe("off (development build)");
    expect(line("url", false, { COLLIE_TELEMETRY_URL: "http://example.com" })).toBe("off (COLLIE_TELEMETRY_URL is not an https URL)");
  });
});

// ── THE TROUBLE TALLY (M86 spec 05) ─────────────────────────────────────────────────────────────

describe("noteTrouble: the tally, pure", () => {
  const ON: TelemetryState = { on: true, decidedBy: "default" };
  const OFF: TelemetryState = { on: false, decidedBy: "settings" };
  const DIALOG: TroubleSignal = { kind: "dialog", harness: "codex", version: "0.46.0", mux: "herdr" };
  const SEND: TroubleSignal = { kind: "send", harness: "claude", version: "2.1.316", mux: "tmux" };
  const base = { ...EMPTY_TELEMETRY_RECORD, id: "a".repeat(32), firstSeenAt: 1 };

  test("a new signal makes a row of exactly kind, harness, version, mux, linked, count", () => {
    const next = noteTrouble(base, DIALOG, ON);
    expect(next.trouble).toEqual([{ ...DIALOG, linked: false, count: 1 }]);
    expect(Object.keys(next.trouble[0] ?? {}).toSorted()).toEqual(["count", "harness", "kind", "linked", "mux", "version"]);
  });

  test("the same four names count one more; any other name is its own row", () => {
    let record = noteTrouble(base, DIALOG, ON);
    record = noteTrouble(record, DIALOG, ON);
    record = noteTrouble(record, SEND, ON);
    record = noteTrouble(record, { ...SEND, version: null }, ON);
    expect(record.trouble).toEqual([
      { ...DIALOG, linked: false, count: 2 },
      { ...SEND, linked: false, count: 1 },
      { ...SEND, version: null, linked: false, count: 1 },
    ]);
  });

  test(`at most ${String(TROUBLE_ROWS_MAX)} distinct rows: a new row past the cap is dropped, a known row still counts`, () => {
    let record: TelemetryRecord = base;
    for (let n = 0; n < TROUBLE_ROWS_MAX; n++) record = noteTrouble(record, { ...SEND, harness: `agent-${String(n)}` }, ON);
    expect(record.trouble).toHaveLength(TROUBLE_ROWS_MAX);
    const full = record;
    expect(noteTrouble(full, { ...SEND, harness: "one-more" }, ON)).toBe(full);
    expect(noteTrouble(full, { ...SEND, harness: "agent-0" }, ON).trouble[0]?.count).toBe(2);
  });

  test(`a count stops at ${String(TROUBLE_COUNT_MAX)}`, () => {
    const record = { ...base, trouble: [{ ...DIALOG, linked: false, count: TROUBLE_COUNT_MAX - 1 }] };
    const once = noteTrouble(record, DIALOG, ON);
    expect(once.trouble[0]?.count).toBe(TROUBLE_COUNT_MAX);
    expect(noteTrouble(once, DIALOG, ON).trouble[0]?.count).toBe(TROUBLE_COUNT_MAX);
  });

  test("the screen is part of the key: one row per dialog, and a row without one has no screen key (1.27.4)", () => {
    let record = noteTrouble(base, { ...DIALOG, screen: "634c6530" }, ON);
    record = noteTrouble(record, { ...DIALOG, screen: "634c6530" }, ON);
    record = noteTrouble(record, { ...DIALOG, screen: "41ea66c7" }, ON);
    record = noteTrouble(record, DIALOG, ON);
    expect(record.trouble).toEqual([
      { ...DIALOG, screen: "634c6530", linked: false, count: 2 },
      { ...DIALOG, screen: "41ea66c7", linked: false, count: 1 },
      { ...DIALOG, linked: false, count: 1 },
    ]);
    expect(Object.keys(record.trouble[2] ?? {}).toSorted()).toEqual(["count", "harness", "kind", "linked", "mux", "version"]);
    expect(Object.keys(record.trouble[0] ?? {}).toSorted()).toEqual(["count", "harness", "kind", "linked", "mux", "screen", "version"]);
  });

  test("off for any reason: the signal is dropped and the tally goes with the ID", () => {
    const record = { ...base, lastSentDay: "2026-11-05", trouble: [{ ...DIALOG, linked: false, count: 4 }] };
    const next = noteTrouble(record, SEND, OFF);
    expect(next.trouble).toEqual([]);
    expect(next.id).toBeNull();
    expect(next.lastSentDay).toBeNull();
  });
});

describe("parseTroubleSignal: the route's body", () => {
  test("exactly kind, harness, version, mux in their shapes", () => {
    expect(parseTroubleSignal({ kind: "dialog", harness: "codex", version: "0.46.0", mux: "herdr-core" })).toEqual({ kind: "dialog", harness: "codex", version: "0.46.0", mux: "herdr-core" });
    expect(parseTroubleSignal({ kind: "send", harness: "other", version: null, mux: "other" })).toEqual({ kind: "send", harness: "other", version: null, mux: "other" });
    expect(parseTroubleSignal({ kind: "send", harness: "claude", version: null, mux: "wezterm" })).toEqual({ kind: "send", harness: "claude", version: null, mux: "wezterm" });
  });

  test("anything else is null: a stray key, a missing key, a word out of its shape", () => {
    const good = { kind: "send", harness: "claude", version: "2.1.316", mux: "herdr" };
    const bad = [
      undefined,
      "send",
      [],
      { ...good, paneId: "w1:p1" },
      { kind: "send", harness: "claude", mux: "herdr" },
      { ...good, kind: "crash" },
      { ...good, mux: "Screen" },
      { ...good, mux: "a".repeat(25) },
      { ...good, mux: "my mux" },
      { ...good, mux: "" },
      { ...good, mux: 7 },
      { ...good, harness: "Claude" },
      { ...good, harness: "a".repeat(25) },
      { ...good, harness: "" },
      { ...good, version: "latest" },
      { ...good, version: `1.${"2".repeat(40)}` },
      { ...good, version: 2 },
    ];
    for (const body of bad) expect(parseTroubleSignal(body), JSON.stringify(body)).toBeNull();
  });

  test("a dialog signal may add a screen hash of 8 lower-case hex characters (1.27.4)", () => {
    const dialog = { kind: "dialog", harness: "codex", version: "0.167.0", mux: "herdr" } as const;
    expect(parseTroubleSignal({ ...dialog, screen: "634c6530" })).toEqual({ ...dialog, screen: "634c6530" });
    expect(TROUBLE_SCREEN.test("634c6530")).toBe(true);
    const bad = [
      { ...dialog, kind: "send", screen: "634c6530" },
      { ...dialog, screen: "634C6530" },
      { ...dialog, screen: "634c653" },
      { ...dialog, screen: "634c65300" },
      { ...dialog, screen: "634c653z" },
      { ...dialog, screen: "" },
      { ...dialog, screen: null },
      { ...dialog, screen: 1666999600 },
      { ...dialog, screen: "enter select · esc back" },
      { ...dialog, screen: "634c6530", rows: "enter select · esc back" },
    ];
    for (const body of bad) expect(parseTroubleSignal(body), JSON.stringify(body)).toBeNull();
  });
});

describe("the tally in the shell (M86 spec 05)", () => {
  const SIGNAL: TroubleSignal = { kind: "dialog", harness: "codex", version: "0.46.0", mux: "herdr" };

  test("a signal in the first 24 hours rides the first ping, and the send clears it in the lastSentDay write", async () => {
    const r = rig();
    r.telemetry.observe();
    r.telemetry.trouble(SIGNAL);
    r.telemetry.trouble(SIGNAL);
    expect(r.telemetry.view().next?.trouble).toEqual([{ ...SIGNAL, linked: false, count: 2 }]);
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(0);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
    expect(JSON.parse(String(r.sent[0]?.init.body)).trouble).toEqual([{ ...SIGNAL, linked: false, count: 2 }]);
    const after = readTelemetryRecord(r.stateDir);
    expect(after.trouble).toEqual([]);
    expect(after.lastSentDay).toBe(utcDay(r.clock.now));
  });

  test("a failed send still clears the tally: at most one day's tally is lost, never counted twice", async () => {
    const r = rig({ fail: true });
    r.telemetry.observe();
    r.telemetry.trouble(SIGNAL);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
    expect(readTelemetryRecord(r.stateDir).trouble).toEqual([]);
  });

  test("the phone's off clears the tally with the ID, and a signal while off stores nothing", () => {
    const r = rig();
    r.telemetry.observe();
    r.telemetry.trouble(SIGNAL);
    expect(readTelemetryRecord(r.stateDir).trouble).toHaveLength(1);
    r.telemetry.choose({ setting: "off", requestId: REQUEST_ID });
    expect(readTelemetryRecord(r.stateDir).trouble).toEqual([]);
    const before = readFileSync(telemetryPath(r.stateDir), "utf8");
    r.telemetry.trouble(SIGNAL);
    expect(readFileSync(telemetryPath(r.stateDir), "utf8")).toBe(before);
  });

  test("an env off switch: nothing is stored and no file is written for the signal", () => {
    const r = rig({ env: { COLLIE_TELEMETRY: "0" } });
    r.telemetry.observe();
    const before = readFileSync(telemetryPath(r.stateDir), "utf8");
    r.telemetry.trouble(SIGNAL);
    expect(readFileSync(telemetryPath(r.stateDir), "utf8")).toBe(before);
    expect(readTelemetryRecord(r.stateDir).trouble).toEqual([]);
  });

  test("a dialog's screen rides the ping, and a row without one leaves as before (1.27.4)", async () => {
    const r = rig();
    r.telemetry.observe();
    r.telemetry.trouble({ ...SIGNAL, screen: "634c6530" });
    r.telemetry.trouble(SIGNAL);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    const body = String(r.sent[0]?.init.body);
    expect(body).toContain('{"kind":"dialog","harness":"codex","version":"0.46.0","mux":"herdr","screen":"634c6530","linked":false,"count":1}');
    expect(body).toContain('{"kind":"dialog","harness":"codex","version":"0.46.0","mux":"herdr","linked":false,"count":1}');
  });

  test("the record file round-trips a screen, and drops a row whose screen is out of shape or on a send", () => {
    const record = parseTelemetryRecord(
      JSON.stringify({
        ...EMPTY_TELEMETRY_RECORD,
        trouble: [
          { ...SIGNAL, screen: "634c6530", count: 2 },
          { ...SIGNAL, screen: "634C6530", count: 1 },
          { ...SIGNAL, kind: "send", screen: "634c6530", count: 1 },
          { ...SIGNAL, screen: null, count: 1 },
        ],
      }),
    );
    expect(record.trouble).toEqual([{ ...SIGNAL, screen: "634c6530", linked: false, count: 2 }]);
  });

  test("the record file round-trips the tally, and a bad row in it is dropped", () => {
    const record = parseTelemetryRecord(
      JSON.stringify({ ...EMPTY_TELEMETRY_RECORD, trouble: [{ ...SIGNAL, count: 3 }, { ...SIGNAL, mux: "Screen", count: 1 }, { ...SIGNAL, count: 0 }] }),
    );
    expect(record.trouble).toEqual([{ ...SIGNAL, linked: false, count: 3 }]);
  });
});

// ── THE USAGE TALLY (ping v3): presence only ─────────────────────────────────────────────────────

const ON: TelemetryState = { on: true, decidedBy: "default" };
const OFF: TelemetryState = { on: false, decidedBy: "settings" };
const WITH_ID: TelemetryRecord = { ...EMPTY_TELEMETRY_RECORD, id: "a".repeat(32) };

const pane = (paneId: string, agent: string, extra: Partial<UsagePane> = {}): UsagePane => ({ paneId, agent, ...extra });
const NONE = (): boolean => false;

const seen = (record: TelemetryRecord, a: { mux: string; panes: readonly UsagePane[]; linked?: (paneId: string) => boolean }): TelemetryRecord =>
  noteSessions(record, { mux: a.mux, panes: a.panes, linked: a.linked ?? NONE }, ON);

describe("the closed lists", () => {
  test("a word on the list stays, any other word is other", () => {
    expect(usageWord("claude", USAGE_HARNESSES)).toBe("claude");
    expect(usageWord("omp", USAGE_HARNESSES)).toBe("omp");
    expect(usageWord("my-private-agent", USAGE_HARNESSES)).toBe("other");
    expect(usageWord("", USAGE_HARNESSES)).toBe("other");
    expect(usageWord("tmux", USAGE_MUXES)).toBe("tmux");
    expect(usageWord("my-mux", USAGE_MUXES)).toBe("other");
  });

  test("the lists are the code's own: the journal adapters and aliases, the mux registry's ids", () => {
    for (const word of ["claude", "codex", "pi", "omp"]) expect(USAGE_HARNESSES).toContain(word);
    for (const word of ["herdr", "herdr-core", "tmux", "zellij", "durable"]) expect(USAGE_MUXES).toContain(word);
    expect(USAGE_HARNESSES).not.toContain("other");
    expect(USAGE_MUXES).not.toContain("other");
    expect(USAGE_HARNESSES).not.toContain("shell");
  });
});

describe("noteSessions: the pairs, pure", () => {
  test("a fake session list gives one row per pair, however many sessions ran", () => {
    const next = seen(WITH_ID, {
      mux: "herdr",
      panes: [pane("w1:p1", "claude"), pane("w1:p2", "claude"), pane("w2:p1", "codex"), pane("w3:p1", "omp")],
    });
    expect(next.usage).toEqual([
      { harness: "claude", mux: "herdr", linked: false },
      { harness: "codex", mux: "herdr", linked: false },
      { harness: "omp", mux: "herdr", linked: false },
    ]);
  });

  test("a row holds no count of any kind, whatever the list was", () => {
    const next = seen(WITH_ID, { mux: "tmux", panes: Array.from({ length: 50 }, (_, at) => pane(`p${String(at)}`, "claude")) });
    expect(next.usage).toEqual([{ harness: "claude", mux: "tmux", linked: false }]);
    expect(JSON.stringify(next)).not.toContain("sessions");
    expect(JSON.stringify(next)).not.toContain("count\":5");
  });

  test("linked is true when one session of the pair is linked, and stays true for the window", () => {
    const first = seen(WITH_ID, { mux: "herdr", panes: [pane("a", "claude"), pane("b", "claude")], linked: (id) => id === "b" });
    expect(first.usage).toEqual([{ harness: "claude", mux: "herdr", linked: true }]);
    const later = seen(first, { mux: "herdr", panes: [pane("a", "claude")] });
    expect(later).toBe(first);
  });

  test("a pair first seen unlinked turns linked when a linked pane shows up later", () => {
    const first = seen(WITH_ID, { mux: "herdr", panes: [pane("a", "codex")] });
    const later = seen(first, { mux: "herdr", panes: [pane("a", "codex")], linked: () => true });
    expect(later.usage).toEqual([{ harness: "codex", mux: "herdr", linked: true }]);
  });

  test("the same pair read again changes nothing", () => {
    const first = seen(WITH_ID, { mux: "tmux", panes: [pane("%1", "claude")] });
    expect(seen(first, { mux: "tmux", panes: [pane("%1", "claude")] })).toBe(first);
  });

  test("a bare shell and a pane with no agent are not a pair", () => {
    const next = seen(WITH_ID, { mux: "herdr", panes: [pane("a", "shell"), pane("b", "claude", { kind: "shell" }), pane("d", "")] });
    expect(next).toBe(WITH_ID);
  });

  test("a harness off the list is other, and so is a mux off the list; the unknown ones share a row", () => {
    const next = seen(WITH_ID, { mux: "some-mux", panes: [pane("1", "private-agent"), pane("2", "another-agent"), pane("3", "claude")] });
    expect(next.usage).toEqual([
      { harness: "other", mux: "other", linked: false },
      { harness: "claude", mux: "other", linked: false },
    ]);
  });

  test("the record keeps no pane id, no agent word off the lists and no hash", () => {
    const next = seen(WITH_ID, { mux: "herdr", panes: [pane("w9:p9", "private-agent")] });
    const text = JSON.stringify(next.usage);
    for (const leak of ["w9:p9", "private-agent"]) expect(text).not.toContain(leak);
    expect(Object.keys(next.usage[0] ?? {})).toEqual(["harness", "mux", "linked"]);
    expect(Object.keys(next)).not.toContain("seen");
  });

  test("off: nothing is kept, and the tally goes with the ID", () => {
    const counted = seen(WITH_ID, { mux: "herdr", panes: [pane("1", "claude")] });
    const off = noteSessions(counted, { mux: "herdr", panes: [pane("2", "claude")], linked: NONE }, OFF);
    expect(off.id).toBeNull();
    expect(off.usage).toEqual([]);
  });

  test("a record with no ID keeps nothing", () => {
    expect(noteSessions(EMPTY_TELEMETRY_RECORD, { mux: "herdr", panes: [pane("1", "claude")], linked: NONE }, ON)).toBe(EMPTY_TELEMETRY_RECORD);
  });

  test("a sample reads at most 2000 panes", () => {
    const spent = Array.from({ length: USAGE_PANES_MAX }, () => pane("same", "shell"));
    expect(seen(WITH_ID, { mux: "herdr", panes: [...spent, pane("beyond", "claude")] })).toBe(WITH_ID);
  });

  test("the rows stop at 24: a pair past the cap is dropped, a pair already there can still turn linked", () => {
    let record = WITH_ID;
    const harnesses = [...USAGE_HARNESSES, "other"];
    const pairs = harnesses.flatMap((harness) => USAGE_MUXES.map((mux) => ({ harness, mux })));
    expect(pairs.length).toBeGreaterThan(USAGE_ROWS_MAX);
    pairs.forEach(({ harness, mux }, at) => {
      record = seen(record, { mux, panes: [pane(`n${String(at)}`, harness)] });
    });
    expect(record.usage).toHaveLength(USAGE_ROWS_MAX);
    const first = record.usage[0];
    const again = seen(record, { mux: first?.mux ?? "", panes: [pane("x", first?.harness ?? "")], linked: () => true });
    expect(again.usage[0]).toEqual({ harness: first?.harness ?? "", mux: first?.mux ?? "", linked: true });
    expect(again.usage).toHaveLength(USAGE_ROWS_MAX);
  });
});

describe("the record file and the ping carry the pairs", () => {
  const rows: UsageRow[] = [
    { harness: "codex", mux: "herdr", linked: false },
    { harness: "claude", mux: "tmux", linked: true },
  ];

  test("the file round-trips, and a bad row, a repeated pair or a stray key is dropped or ignored", () => {
    const record = parseTelemetryRecord(
      JSON.stringify({
        usage: [
          ...rows,
          { harness: "claude", mux: "tmux", linked: false },
          { harness: "mine", mux: "tmux", linked: true },
          { harness: "claude", mux: "mine", linked: true },
          { harness: "claude", mux: "zellij", sessions: 5000 },
          "x",
        ],
      }),
    );
    expect(record.usage).toEqual([...rows, { harness: "claude", mux: "zellij", linked: false }]);
    expect(parseTelemetryRecord(JSON.stringify({ usage: "x" })).usage).toEqual([]);
    expect(parseTelemetryRecord(JSON.stringify({ id: "a".repeat(32) })).usage).toEqual([]);
  });

  test("an old file with the counting tally reads as its rows without counts", () => {
    const record = parseTelemetryRecord(JSON.stringify({ usage: { rows: [{ harness: "claude", mux: "tmux", sessions: 3 }], seen: ["0123456789abcdef"] } }));
    expect(record.usage).toEqual([]);
  });

  test("a file with too many rows is cut to the cap", () => {
    const rowFlood = USAGE_HARNESSES.flatMap((harness) => USAGE_MUXES.map((mux) => ({ harness, mux, linked: false })));
    expect(parseTelemetryRecord(JSON.stringify({ usage: rowFlood })).usage).toHaveLength(USAGE_ROWS_MAX);
  });

  test("buildPing leaves each row with exactly harness, mux and linked, unique, in name order, capped", () => {
    const grown = { harness: "claude", mux: "tmux", linked: false, sessions: 5000, paneId: "w1:p1" };
    const built = buildPing({ id: "a".repeat(32), day: "2026-11-13", version: "1.29.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [], usage: [...rows.slice(0, 1), grown, ...rows.slice(1)] });
    expect(JSON.stringify(built.usage)).toBe('[{"harness":"claude","mux":"tmux","linked":true},{"harness":"codex","mux":"herdr","linked":false}]');
    const flood = Array.from({ length: 100 }, (_, at) => ({ harness: "claude", mux: `m${String(at)}`, linked: false }));
    const capped = buildPing({ id: "a".repeat(32), day: "2026-11-13", version: "1.29.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [], usage: flood });
    expect(capped.usage).toHaveLength(USAGE_ROWS_MAX);
  });

  test("the worst ping the caps allow stays under 8 KB", () => {
    const trouble = Array.from({ length: TROUBLE_ROWS_MAX }, () => ({
      kind: "dialog" as const,
      harness: "x".repeat(24),
      version: "1.2.3-beta.1234567890abcdef0123456789",
      mux: "y".repeat(24),
      screen: "634c6530",
      linked: true,
      count: TROUBLE_COUNT_MAX,
    }));
    const usage = Array.from({ length: USAGE_ROWS_MAX }, (_, at) => ({ harness: `claude-${String(at)}`, mux: "herdr-core", linked: true }));
    const built = buildPing({ id: "a".repeat(32), day: "2026-11-13", version: "1.29.0-edge.12", os: "freebsd", arch: "arm64", installKind: "detached-checkout", line: "stable", role: "member", trouble, usage });
    expect(JSON.stringify(built).length).toBeLessThan(8 * 1024);
  });
});

describe("a trouble row says whether its pane was linked (ping v3)", () => {
  const SIGNAL: TroubleSignal = { kind: "send", harness: "claude", version: "2.1.316", mux: "herdr" };

  test("linked is part of the row, so a linked and an unlinked signal are two rows", () => {
    const a = noteTrouble(WITH_ID, SIGNAL, ON, true);
    const b = noteTrouble(a, SIGNAL, ON, false);
    const c = noteTrouble(b, SIGNAL, ON, true);
    expect(c.trouble).toEqual([
      { ...SIGNAL, linked: true, count: 2 },
      { ...SIGNAL, linked: false, count: 1 },
    ]);
  });

  test("the ping row carries linked before count, always, and a record row without it reads false", () => {
    const record = parseTelemetryRecord(JSON.stringify({ trouble: [{ ...SIGNAL, count: 2 }, { ...SIGNAL, mux: "tmux", linked: true, count: 1 }] }));
    expect(record.trouble).toEqual([{ ...SIGNAL, linked: false, count: 2 }, { ...SIGNAL, mux: "tmux", linked: true, count: 1 }]);
    const built = buildPing({ id: "a".repeat(32), day: "2026-11-13", version: "1.29.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: record.trouble, usage: [] });
    expect(JSON.stringify(built.trouble[0])).toBe('{"kind":"send","harness":"claude","version":"2.1.316","mux":"herdr","linked":false,"count":2}');
  });

  test("parseTroubleBody reads pane and session as where, and refuses what is not a short string", () => {
    expect(parseTroubleBody({ ...SIGNAL, pane: "w1:p1" })).toEqual({ signal: SIGNAL, where: { paneId: "w1:p1", session: null } });
    expect(parseTroubleBody({ ...SIGNAL, pane: "w1:p1", session: "default" })?.where).toEqual({ paneId: "w1:p1", session: "default" });
    expect(parseTroubleBody({ ...SIGNAL })).toEqual({ signal: SIGNAL, where: null });
    expect(parseTroubleBody({ ...SIGNAL, pane: 5 })).toBeNull();
    expect(parseTroubleBody({ ...SIGNAL, pane: "" })).toBeNull();
    expect(parseTroubleBody({ ...SIGNAL, pane: "x".repeat(200) })).toBeNull();
    expect(parseTroubleBody({ ...SIGNAL, extra: 1 })).toBeNull();
    expect(parseTroubleBody({ ...SIGNAL, linked: true })).toBeNull();
  });
});

describe("the tally in the shell (ping v3)", () => {
  const DAY1 = Date.UTC(2026, 10, 3, 12, 0, 0);
  const sample = (r: ReturnType<typeof rig>, scope: string, mux: string, panes: UsagePane[], linked: (paneId: string) => boolean = NONE): void =>
    r.telemetry.sessions({ scope, mux, panes, linked });

  test("a day with no agent sends usage as an empty list, in exactly the v3 shape", async () => {
    const r = rig();
    r.telemetry.observe();
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(String(r.sent[0]?.init.body)).toBe(
      `{"v":3,"id":"${"1".repeat(32)}","day":"${utcDay(r.clock.now)}","version":"1.26.0","os":"linux","arch":"x64","install":"binary","line":"stable","role":"solo","trouble":[],"usage":[]}`,
    );
    expect(PING_SCHEMA).toBe(3);
  });

  test("the pairs of the window ride the ping, exactly, and the send clears them", async () => {
    const r = rig();
    r.telemetry.observe();
    sample(r, "default", "herdr", [pane("w1:p1", "claude"), pane("w1:p2", "claude"), pane("w1:p3", "codex"), pane("w1:p4", "shell")], (id) => id === "w1:p2");
    expect(r.telemetry.view().next?.usage).toEqual([
      { harness: "claude", mux: "herdr", linked: true },
      { harness: "codex", mux: "herdr", linked: false },
    ]);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    const body = String(r.sent[0]?.init.body);
    const sent = JSON.parse(body);
    expect(Object.keys(sent)).toEqual(["v", "id", "day", "version", "os", "arch", "install", "line", "role", "trouble", "usage"]);
    expect(body).toContain('"usage":[{"harness":"claude","mux":"herdr","linked":true},{"harness":"codex","mux":"herdr","linked":false}]');
    expect(body).not.toContain("sessions");
    expect(readTelemetryRecord(r.stateDir).usage).toEqual([]);
    sample(r, "default", "herdr", [pane("w1:p1", "claude")]);
    expect(readTelemetryRecord(r.stateDir).usage).toEqual([{ harness: "claude", mux: "herdr", linked: false }]);
  });

  test("the state file keeps pairs and nothing else: no hash, no pane, no session", () => {
    const r = rig();
    r.telemetry.observe();
    sample(r, "default", "herdr", [pane("w9:p9", "claude")]);
    const file = JSON.parse(readFileSync(telemetryPath(r.stateDir), "utf8"));
    expect(file.usage).toEqual([{ harness: "claude", mux: "herdr", linked: false }]);
    expect(readFileSync(telemetryPath(r.stateDir), "utf8")).not.toContain("w9:p9");
  });

  test("a failed send still clears the tally", async () => {
    const r = rig({ fail: true });
    r.telemetry.observe();
    sample(r, "default", "herdr", [pane("1", "claude")]);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
    expect(readTelemetryRecord(r.stateDir).usage).toEqual([]);
  });

  test("a scope is sampled at most every 30 seconds, and each scope has its own clock", () => {
    const r = rig({ start: DAY1 });
    r.telemetry.observe();
    sample(r, "one", "herdr", [pane("1", "claude")]);
    r.clock.now += 1500;
    sample(r, "one", "herdr", [pane("1", "claude"), pane("2", "codex")]);
    expect(readTelemetryRecord(r.stateDir).usage).toEqual([{ harness: "claude", mux: "herdr", linked: false }]);
    sample(r, "two", "herdr", [pane("1", "codex")]);
    expect(readTelemetryRecord(r.stateDir).usage).toHaveLength(2);
    r.clock.now += USAGE_SAMPLE_MS;
    sample(r, "one", "herdr", [pane("1", "claude")], () => true);
    expect(readTelemetryRecord(r.stateDir).usage).toContainEqual({ harness: "claude", mux: "herdr", linked: true });
  });

  test("the phone's off clears the tally with the ID, and a sample while off stores nothing", () => {
    const r = rig();
    r.telemetry.observe();
    sample(r, "default", "herdr", [pane("1", "claude")]);
    expect(readTelemetryRecord(r.stateDir).usage).toHaveLength(1);
    r.telemetry.choose({ setting: "off", requestId: REQUEST_ID });
    expect(readTelemetryRecord(r.stateDir).usage).toEqual([]);
    r.clock.now += USAGE_SAMPLE_MS;
    const before = readFileSync(telemetryPath(r.stateDir), "utf8");
    sample(r, "default", "herdr", [pane("2", "claude")]);
    expect(readFileSync(telemetryPath(r.stateDir), "utf8")).toBe(before);
    expect(r.telemetry.view().next).toBeNull();
  });

  test("every off switch keeps nothing and sends nothing", async () => {
    const offs: Environment[] = [{ COLLIE_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }, { COLLIE_TELEMETRY_URL: "ftp://x.test/p" }];
    for (const env of offs) {
      const r = rig({ env });
      r.telemetry.observe();
      const before = readFileSync(telemetryPath(r.stateDir), "utf8");
      sample(r, "default", "herdr", [pane("1", "claude")]);
      r.telemetry.trouble({ kind: "send", harness: "claude", version: null, mux: "herdr" }, { paneId: "1", session: null });
      expect(readFileSync(telemetryPath(r.stateDir), "utf8")).toBe(before);
      r.clock.now += FIRST_PING_DELAY_MS;
      await r.telemetry.tick();
      expect(r.sent).toHaveLength(0);
      expect(readTelemetryRecord(r.stateDir).usage).toEqual([]);
    }
  });

  test("a development build keeps nothing", () => {
    const r = rig({ version: DEV });
    r.telemetry.observe();
    sample(r, "default", "herdr", [pane("1", "claude")]);
    expect(readTelemetryRecord(r.stateDir).usage).toEqual([]);
  });

  test("a trouble signal's pane is asked whether it is linked, and a doubt reads as not linked", async () => {
    const asked: unknown[] = [];
    const base: Omit<TelemetryDeps, "stateDir" | "linked"> = {
      env: {},
      origin: "env",
      version: RELEASE,
      installKind: "binary",
      line: () => "stable",
      crewMode: () => "solo",
      now: () => DAY1,
      fetch: async () => new Response("ok"),
      os: "linux",
      arch: "x64",
    };
    const make = (linked: (where: { paneId: string; session: string | null }) => boolean) => {
      const stateDir = mkdtempSync(join(tmpdir(), "collie-telemetry-"));
      dirs.push(stateDir);
      return { stateDir, telemetry: createTelemetry({ ...base, stateDir, linked }) };
    };
    const yes = make((where) => {
      asked.push(where);
      return true;
    });
    yes.telemetry.observe();
    yes.telemetry.trouble({ kind: "send", harness: "claude", version: null, mux: "herdr" }, { paneId: "w1:p1", session: "default" });
    expect(asked).toEqual([{ paneId: "w1:p1", session: "default" }]);
    expect(readTelemetryRecord(yes.stateDir).trouble.map((row) => row.linked)).toEqual([true]);
    const none = make(() => {
      throw new Error("no hub");
    });
    none.telemetry.observe();
    none.telemetry.trouble({ kind: "send", harness: "claude", version: null, mux: "herdr" }, { paneId: "w1:p1", session: null });
    none.telemetry.trouble({ kind: "send", harness: "claude", version: null, mux: "herdr" });
    expect(readTelemetryRecord(none.stateDir).trouble.map((row) => row.linked)).toEqual([false]);
  });

  test("a write that fails never reaches the poll", () => {
    const broken = createTelemetry({
      stateDir: "/nonexistent-collie-state",
      env: {},
      origin: "env",
      version: RELEASE,
      installKind: "binary",
      line: () => "stable",
      crewMode: () => "solo",
      now: () => DAY1,
      fetch: async () => new Response("ok"),
      os: "linux",
      arch: "x64",
      files: {
        mkdirp: () => {
          throw new Error("read-only");
        },
        write: () => {
          throw new Error("read-only");
        },
        rename: () => {
          throw new Error("read-only");
        },
      },
    });
    expect(() => broken.sessions({ scope: "default", mux: "herdr", panes: [pane("1", "claude")], linked: NONE })).not.toThrow();
  });
});

describe("the bridge feeds the tally (ping v3)", () => {
  test("each session's engine hands its real agent panes, with its own multiplexer and the link reader, to the ping", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    // A trick's own session is no agent: the one filter drops it before the tally sees it.
    expect(src).toContain("panes: realAgentPanes(s.agents),");
    expect(src).toContain('const usageMux = endpoint.kind === "program" ? DURABLE_MUX : cfg.mux;');
    // The link reader is the pane read's own (`paneLinkedReader`, bridge/surface/path.ts), never a second rule.
    expect(src).toContain("linked: (paneId) => paneIsLinked(name, paneId),");
    expect(src).toContain("paneLinked: paneIsLinked,");
    expect(src).not.toContain("insideHub?.partOf(");
  });
});
