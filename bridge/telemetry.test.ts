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
  utcDay,
  type PingFetch,
  type TelemetryDecider,
  type TelemetryOrigin,
  type TelemetrySetting,
  type TelemetryRecord,
  type TelemetryState,
  type TroubleSignal,
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
  const ping = buildPing({ id: "a".repeat(32), day: "2026-11-04", version: "1.26.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [] });

  test("the key set is exactly v, id, day, version, os, arch, install, line, role, trouble (ten keys)", () => {
    expect(Object.keys(ping)).toEqual(["v", "id", "day", "version", "os", "arch", "install", "line", "role", "trouble"]);
  });

  test("an empty tally is [], and a row carries exactly kind, harness, version, mux, count", () => {
    expect(ping.trouble).toEqual([]);
    // A row read from a record file that grew a stray field still leaves with its five fields only.
    const grown = { kind: "send", harness: "claude", version: "2.1.316", mux: "herdr", count: 2, paneId: "w1:p1" } as const;
    const built = buildPing({ id: "a".repeat(32), day: "2026-11-04", version: "1.26.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role: "solo", trouble: [grown] });
    expect(built.trouble).toEqual([{ kind: "send", harness: "claude", version: "2.1.316", mux: "herdr", count: 2 }]);
    expect(Object.keys(built.trouble[0] ?? {})).toEqual(["kind", "harness", "version", "mux", "count"]);
  });

  test("each role value is carried as given", () => {
    for (const role of ["solo", "lead", "member"] as const) {
      const built = buildPing({ id: "a".repeat(32), day: "2026-11-04", version: "1.26.0", os: "linux", arch: "x64", installKind: "binary", line: "stable", role, trouble: [] });
      expect(built.role).toBe(role);
    }
  });

  test("pingRole: solo is solo, lead is lead, and a peer (a member or a non-lead deputy) is a member", () => {
    expect(pingRole("solo")).toBe("solo");
    expect(pingRole("lead")).toBe("lead");
    expect(pingRole("peer")).toBe("member");
  });

  test("the values are the ones given, and the schema is 2", () => {
    expect(ping).toEqual({
      v: 2,
      id: "a".repeat(32),
      day: "2026-11-04",
      version: "1.26.0",
      os: "linux",
      arch: "x64",
      install: "binary",
      line: "stable",
      role: "solo",
      trouble: [],
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
      v: 2,
      id: "1".repeat(32),
      day: utcDay(r.clock.now),
      version: "1.26.0",
      os: "linux",
      arch: "x64",
      install: "binary",
      line: "stable",
      role: "solo",
      trouble: [],
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
      v: 2,
      id: "1".repeat(32),
      day: utcDay(r.clock.now),
      version: "1.26.0",
      os: "linux",
      arch: "x64",
      install: "binary",
      line: "stable",
      role: "solo",
      trouble: [],
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

  test("a new signal makes a row of exactly kind, harness, version, mux, count", () => {
    const next = noteTrouble(base, DIALOG, ON);
    expect(next.trouble).toEqual([{ ...DIALOG, count: 1 }]);
    expect(Object.keys(next.trouble[0] ?? {}).toSorted()).toEqual(["count", "harness", "kind", "mux", "version"]);
  });

  test("the same four names count one more; any other name is its own row", () => {
    let record = noteTrouble(base, DIALOG, ON);
    record = noteTrouble(record, DIALOG, ON);
    record = noteTrouble(record, SEND, ON);
    record = noteTrouble(record, { ...SEND, version: null }, ON);
    expect(record.trouble).toEqual([
      { ...DIALOG, count: 2 },
      { ...SEND, count: 1 },
      { ...SEND, version: null, count: 1 },
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
    const record = { ...base, trouble: [{ ...DIALOG, count: TROUBLE_COUNT_MAX - 1 }] };
    const once = noteTrouble(record, DIALOG, ON);
    expect(once.trouble[0]?.count).toBe(TROUBLE_COUNT_MAX);
    expect(noteTrouble(once, DIALOG, ON).trouble[0]?.count).toBe(TROUBLE_COUNT_MAX);
  });

  test("off for any reason: the signal is dropped and the tally goes with the ID", () => {
    const record = { ...base, lastSentDay: "2026-11-05", trouble: [{ ...DIALOG, count: 4 }] };
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
      { ...good, mux: "screen" },
      { ...good, harness: "Claude" },
      { ...good, harness: "a".repeat(25) },
      { ...good, harness: "" },
      { ...good, version: "latest" },
      { ...good, version: `1.${"2".repeat(40)}` },
      { ...good, version: 2 },
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
    expect(r.telemetry.view().next?.trouble).toEqual([{ ...SIGNAL, count: 2 }]);
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(0);
    r.clock.now += FIRST_PING_DELAY_MS;
    await r.telemetry.tick();
    expect(r.sent).toHaveLength(1);
    expect(JSON.parse(String(r.sent[0]?.init.body)).trouble).toEqual([{ ...SIGNAL, count: 2 }]);
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

  test("the record file round-trips the tally, and a bad row in it is dropped", () => {
    const record = parseTelemetryRecord(
      JSON.stringify({ ...EMPTY_TELEMETRY_RECORD, trouble: [{ ...SIGNAL, count: 3 }, { ...SIGNAL, mux: "screen", count: 1 }, { ...SIGNAL, count: 0 }] }),
    );
    expect(record.trouble).toEqual([{ ...SIGNAL, count: 3 }]);
  });
});
