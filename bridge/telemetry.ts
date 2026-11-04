import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { InstallKind } from "../cli/install-kind.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../web/src/lib/json.ts";
import { settingByEnv } from "./config-schema.ts";
import { sourceOf, type ConfigFileLayer, type Environment } from "./config-source.ts";
import { UPDATE_MIRROR_ENV } from "./update.ts";
import { diskWriter, type ReleaseLine, type UpdateLineWriter } from "./update-line.ts";
import { developmentBase } from "./version.ts";
import { isRequestId } from "./worktree-receipts.ts";

// ── THE ANONYMOUS INSTALL PING (M86 spec 01) ────────────────────────────────────────────────────
//
// Once a day, at most, a bridge tells Collie's own endpoint that one install exists: a random ID,
// the UTC day, the version, the OS, the CPU, the install kind and the release line. Nothing else.
// No harness or mux name, no pane, no host name, no path, no count of anything. The ID is made on
// this machine, lives in `telemetry.json` in the state folder and is deleted the moment the ping is
// off for any reason.
//
// FUNCTIONAL CORE, IMPERATIVE SHELL. {@link telemetryState}, {@link buildPing}, {@link shouldSend}
// and {@link resolveTelemetryUrl} are pure and carry the whole contract. {@link createTelemetry} is
// the thin shell: it reads and writes the state file and makes the one request through an injected
// `fetch`, so a test never reaches the real endpoint.
//
// THE SWITCHES, in the order that decides. Any off switch wins; an on word never beats an off:
//   1. DO_NOT_TRACK                      off
//   2. a URL override that is not vetted off
//   3. COLLIE_TELEMETRY / config off     off  (env or config; a value nobody knows reads as off)
//   4. CI set                            off
//   5. a rehearsal mirror                off
//   6. a development build               off  (even with state copied from an install that had it on)
//   7. the phone's switch "off"          off
//   8. COLLIE_TELEMETRY / config on      on   (env or config)
//   9. the phone's switch "on"           on
//  10. default                           on
// Env or config off cannot be undone from the phone, and neither can CI, a mirror or a dev build.
// An explicit COLLIE_TELEMETRY=1 does not beat DO_NOT_TRACK or the phone's "off".
// THE SWITCH FAILS CLOSED. `0 false off no` are off, `1 true on yes` are on, an empty value is no vote,
// and ANY OTHER value (a typo such as `COLLIE_TELEMETRY=ofF1`) is off, with a warning from the boot log
// and `collie doctor`. DO_NOT_TRACK is the one exception, by its own convention: anything but `0` is off.
// A COLLIE_TELEMETRY_URL that is not https (or http to loopback) is its own
// refusal: it turns the ping off, because a ping to an address nobody vetted is not a ping.

/** Where the ping goes unless {@link TELEMETRY_URL_ENV} says otherwise. */
export const TELEMETRY_URL = "https://ping.colliepwa.dev/v1/ping";

/** The test seam that moves the endpoint. Also a settings row. */
export const TELEMETRY_URL_ENV = "COLLIE_TELEMETRY_URL";

/** The state file's name inside the state folder. */
export const TELEMETRY_FILE = "telemetry.json";

/** The ping's schema number, the `v` field. */
export const PING_SCHEMA = 1;

/** The wait before an install's first ping. A person has a day to read the notice and say no. */
export const FIRST_PING_DELAY_MS = 24 * 60 * 60 * 1000;

/** One request, one try, then it is dropped. */
export const PING_TIMEOUT_MS = 5000;

/** The fixed user agent. It names the feature and nothing about the build. */
export const PING_USER_AGENT = "collie-ping";

/** First check 10 minutes after boot, then hourly. Each tick only asks {@link shouldSend}. */
export const TELEMETRY_FIRST_DELAY_MS = 10 * 60 * 1000;
export const TELEMETRY_INTERVAL_MS = 60 * 60 * 1000;

/** Which switch decided. A closed set, so the phone never parses a string. */
export type TelemetryDecider =
  | "do_not_track"
  | "env"
  | "config"
  | "settings"
  | "ci"
  | "mirror"
  | "dev_build"
  | "url"
  | "default";

/** The phone's two words. */
export type TelemetrySetting = "on" | "off";

/** Where `COLLIE_TELEMETRY` came from: the process environment, or a `config.toml`. */
export type TelemetryOrigin = "env" | "config";

export interface TelemetryState {
  readonly on: boolean;
  readonly decidedBy: TelemetryDecider;
}

export interface TelemetryStateInput {
  /** The effective environment: `process.env` with the config file layer already applied. */
  readonly env: Environment;
  /** Whether a set `COLLIE_TELEMETRY` came from the environment or from the config file. */
  readonly origin: TelemetryOrigin;
  /** The phone's switch from `telemetry.json`, or null when it never made one. */
  readonly setting: TelemetrySetting | null;
  /** This build's version as it reports itself, e.g. `1.26.0-dev+1530ff7cb0`. */
  readonly version: string;
}

const OFF_WORDS: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);
const ON_WORDS: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** What `COLLIE_TELEMETRY` says: a vote on, a vote off, no vote, or a value nobody knows. */
export type TelemetrySwitch =
  | { readonly kind: "unset" }
  | { readonly kind: "on" }
  | { readonly kind: "off" }
  | { readonly kind: "unknown"; readonly value: string };

/** Read `COLLIE_TELEMETRY` (after the config file's layer): the words, any case, trimmed. Empty is no vote. */
export function readTelemetrySwitch(raw: string | undefined): TelemetrySwitch {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "unset" };
  const word = value.toLowerCase();
  if (OFF_WORDS.has(word)) return { kind: "off" };
  if (ON_WORDS.has(word)) return { kind: "on" };
  return { kind: "unknown", value };
}

/** The sentence for a value nobody knows, or null when the switch is fine. For the boot log and `collie doctor`. */
export function telemetrySwitchWarning(env: Environment): string | null {
  const read = readTelemetrySwitch(env.COLLIE_TELEMETRY);
  if (read.kind !== "unknown") return null;
  return `COLLIE_TELEMETRY=${read.value} is not a known value, read as off`;
}

/** A variable that is set to something other than nothing. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Where the ping goes: the default, or the override when it is https, or http to 127.0.0.1 or
 * localhost (a test server). Anything else is refused with the value, and the ping is off.
 */
export function resolveTelemetryUrl(
  env: Environment,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly value: string } {
  const raw = env[TELEMETRY_URL_ENV]?.trim() ?? "";
  if (raw === "") return { ok: true, url: TELEMETRY_URL };
  const parsed = URL.parse(raw);
  if (parsed === null || parsed.username !== "" || parsed.password !== "") return { ok: false, value: raw };
  if (parsed.protocol === "https:") return { ok: true, url: raw };
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol === "http:" && isLoopback) return { ok: true, url: raw };
  return { ok: false, value: raw };
}

/** The refusal sentence for a URL override, for the boot log and the doctor line. */
export const telemetryUrlRefusal = (value: string): string =>
  `${TELEMETRY_URL_ENV}='${value}' is not an https URL (or http to 127.0.0.1 or localhost). The install ping is off.`;

/** Whether the ping is on, and which switch decided. The whole off-switch contract, pure. */
export function telemetryState(input: TelemetryStateInput): TelemetryState {
  const { env } = input;
  const doNotTrack = env.DO_NOT_TRACK;
  if (isSet(doNotTrack) && doNotTrack?.trim() !== "0") return { on: false, decidedBy: "do_not_track" };
  if (!resolveTelemetryUrl(env).ok) return { on: false, decidedBy: "url" };
  const vote = readTelemetrySwitch(env.COLLIE_TELEMETRY).kind;
  // An unknown value is off, and decided by the same origin as an off word: the card says the same line.
  if (vote === "off" || vote === "unknown") return { on: false, decidedBy: input.origin };
  if (isSet(env.CI)) return { on: false, decidedBy: "ci" };
  if (isSet(env[UPDATE_MIRROR_ENV])) return { on: false, decidedBy: "mirror" };
  if (developmentBase(input.version) !== null) return { on: false, decidedBy: "dev_build" };
  if (input.setting === "off") return { on: false, decidedBy: "settings" };
  if (vote === "on") return { on: true, decidedBy: input.origin };
  if (input.setting === "on") return { on: true, decidedBy: "settings" };
  return { on: true, decidedBy: "default" };
}

/** The one info line `collie doctor` prints for the ping. Never a warning: off is a choice. */
export function telemetryDoctorLine(a: { readonly state: TelemetryState; readonly env: Environment }): string {
  const { on, decidedBy } = a.state;
  const word = on ? "on" : "off";
  const reasons = {
    do_not_track: "DO_NOT_TRACK",
    env: "COLLIE_TELEMETRY",
    config: "config.toml, telemetry",
    settings: "set on the phone",
    ci: "CI is set",
    mirror: `${UPDATE_MIRROR_ENV} is set`,
    dev_build: "development build",
    url: `${TELEMETRY_URL_ENV} is not an https URL`,
    default: "default",
  } satisfies Record<TelemetryDecider, string>;
  return `${word} (${reasons[decidedBy]})`;
}

/** The docs address the boot line points at, relative to the repository's `docs/` folder. */
export const TELEMETRY_DOCS_REF = "docs/security.md#what-leaves-your-machine";

/** `2026-11-05 14:10 UTC`: an instant to the minute, in the zone the ping itself counts days in. */
export const utcMinute = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The one line a bridge logs at every start (M86 spec 01). A headless machine has no phone, so this
 * line is its notice: what the count is doing, which switch decided, when the first ping may go, and
 * how to say no. Off keeps it short, because there is nothing to announce. Pure.
 */
export function telemetryBootLine(a: {
  readonly state: TelemetryState;
  readonly record: Pick<TelemetryRecord, "firstSeenAt" | "lastSentDay">;
  readonly now: number;
  readonly env: Environment;
}): string {
  if (!a.state.on) return `install count: ${telemetryDoctorLine({ state: a.state, env: a.env })}`;
  const deciders = {
    do_not_track: "DO_NOT_TRACK",
    env: "COLLIE_TELEMETRY",
    config: "config.toml",
    settings: "the phone's switch",
    ci: "CI",
    mirror: UPDATE_MIRROR_ENV,
    dev_build: "the build",
    url: TELEMETRY_URL_ENV,
    default: "default",
  } satisfies Record<TelemetryDecider, string>;
  const firstAt = a.record.firstSeenAt === null ? null : a.record.firstSeenAt + FIRST_PING_DELAY_MS;
  const when =
    firstAt !== null && firstAt > a.now
      ? `first ping after ${utcMinute(firstAt)}`
      : a.record.lastSentDay !== null
        ? `last send attempt ${a.record.lastSentDay}`
        : "first ping is due";
  return `install count: on, decided by ${deciders[a.state.decidedBy]}; ${when}; off with COLLIE_TELEMETRY=0 in the service .env, ${TELEMETRY_DOCS_REF}`;
}

/** Where `COLLIE_TELEMETRY` came from, given the effective environment and the config layer under it. */
export function telemetryOrigin(env: Environment, layer: ConfigFileLayer): TelemetryOrigin {
  const row = settingByEnv("COLLIE_TELEMETRY");
  if (row === undefined) return "env";
  return sourceOf(row, env, layer) === "env" ? "env" : "config";
}

/** The ping, exactly. A test pins the key set, so a new field breaks a test on purpose. */
export type TelemetryPing = {
  readonly v: typeof PING_SCHEMA;
  readonly id: string;
  readonly day: string;
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly install: InstallKind["kind"];
  readonly line: ReleaseLine;
};

export function buildPing(a: {
  readonly id: string;
  readonly day: string;
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly installKind: InstallKind["kind"];
  readonly line: ReleaseLine;
}): TelemetryPing {
  return {
    v: PING_SCHEMA,
    id: a.id,
    day: a.day,
    version: a.version,
    os: a.os,
    arch: a.arch,
    install: a.installKind,
    line: a.line,
  };
}

/** The version the ping carries: the release version, without the `+sha` build tail. */
export function pingVersion(reported: string): string {
  const plus = reported.indexOf("+");
  return (plus < 0 ? reported : reported.slice(0, plus)).trim();
}

/** The UTC day of an instant, `YYYY-MM-DD`. */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** On, a full day since the first start, and not yet sent today (UTC). */
export function shouldSend(a: {
  readonly now: number;
  readonly firstSeenAt: number | null;
  readonly lastSentDay: string | null;
  readonly on: boolean;
}): boolean {
  if (!a.on) return false;
  if (a.firstSeenAt === null) return false;
  if (a.now - a.firstSeenAt < FIRST_PING_DELAY_MS) return false;
  return a.lastSentDay !== utcDay(a.now);
}

// ── THE STATE FILE ──────────────────────────────────────────────────────────────────────────────

/** What `telemetry.json` holds. Every absent fact is null. */
export interface TelemetryRecord {
  readonly id: string | null;
  readonly firstSeenAt: number | null;
  readonly lastSentDay: string | null;
  readonly setting: TelemetrySetting | null;
  readonly changedAt: number | null;
  readonly requestId: string | null;
}

/** The reading of a machine with no file. */
export const EMPTY_TELEMETRY_RECORD: TelemetryRecord = {
  id: null,
  firstSeenAt: null,
  lastSentDay: null,
  setting: null,
  changedAt: null,
  requestId: null,
};

const INSTALL_ID = /^[0-9a-f]{32}$/;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the file defensively. Anything unreadable reads as a machine with no file. */
export function parseTelemetryRecord(text: string | null): TelemetryRecord {
  const doc = text === null ? undefined : asJsonObject(parseJson(text));
  if (doc === undefined) return EMPTY_TELEMETRY_RECORD;
  const id = asJsonString(doc.id);
  const day = asJsonString(doc.lastSentDay);
  const setting = asJsonString(doc.setting);
  const first = asJsonNumber(doc.firstSeenAt);
  const changed = asJsonNumber(doc.changedAt);
  const requestId = asJsonString(doc.requestId);
  return {
    id: id !== undefined && INSTALL_ID.test(id) ? id : null,
    firstSeenAt: first !== undefined && Number.isFinite(first) ? first : null,
    lastSentDay: day !== undefined && UTC_DAY.test(day) ? day : null,
    setting: setting === "on" || setting === "off" ? setting : null,
    changedAt: changed !== undefined && Number.isFinite(changed) ? changed : null,
    requestId: requestId !== undefined && requestId !== "" ? requestId : null,
  };
}

/** The file's path inside a state folder. */
export const telemetryPath = (stateDir: string): string => join(stateDir, TELEMETRY_FILE);

/** Read the record off disk. An absent or unreadable file is the empty record. */
export function readTelemetryRecord(stateDir: string): TelemetryRecord {
  try {
    return parseTelemetryRecord(readFileSync(telemetryPath(stateDir), "utf8"));
  } catch {
    return EMPTY_TELEMETRY_RECORD;
  }
}

/** Write the record atomically (temp file, then rename), owner-only, like the release line store. */
export function writeTelemetryRecord(files: UpdateLineWriter, stateDir: string, record: TelemetryRecord): void {
  const at = telemetryPath(stateDir);
  const scratch = `${at}.tmp`;
  files.mkdirp(stateDir, 0o700);
  files.write(scratch, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  files.rename(scratch, at);
}

/** The ID, 16 random bytes as hex. */
export const newInstallId = (): string => randomBytes(16).toString("hex");

// ── THE ROUTE'S BODY ────────────────────────────────────────────────────────────────────────────

/** The body `POST /api/telemetry` accepts, after parsing. */
export interface TelemetryRequest {
  readonly setting: TelemetrySetting | null;
  readonly requestId: string | null;
}

/** Parse an untrusted body. Null when it is not an object, and the caller answers 400. */
export function parseTelemetryRequest(body: JsonValue): TelemetryRequest | null {
  const rec: JsonObject | undefined = asJsonObject(body);
  if (rec === undefined) return null;
  return {
    setting: rec.setting === "on" || rec.setting === "off" ? rec.setting : null,
    requestId: isRequestId(rec.requestId) ? rec.requestId : null,
  };
}

/** What `GET /api/telemetry` answers. `next` is the exact JSON the next ping would send. */
export type TelemetryView = {
  readonly on: boolean;
  readonly decidedBy: TelemetryDecider;
  readonly setting: TelemetrySetting | null;
  readonly next: TelemetryPing | null;
};

// ── THE SHELL ───────────────────────────────────────────────────────────────────────────────────

/** The one request a ping makes. Global `fetch` satisfies it; a test passes a fake. */
export type PingFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelemetryDeps {
  readonly stateDir: string;
  /** The effective environment, read once at boot. */
  readonly env: Environment;
  readonly origin: TelemetryOrigin;
  /** This build's version as it reports itself, with the `+sha` tail. */
  readonly version: string;
  readonly installKind: InstallKind["kind"];
  /** The release line now, read at the moment of use. */
  readonly line: () => ReleaseLine;
  readonly now: () => number;
  readonly fetch: PingFetch;
  readonly os: string;
  readonly arch: string;
  readonly newId?: () => string;
  readonly files?: UpdateLineWriter;
  readonly warn?: (line: string) => void;
  /** The bridge's normal log, for the one line {@link telemetryBootLine} makes at every start. */
  readonly log?: (line: string) => void;
}

export interface Telemetry {
  /** The state now, with the ID made on first need. Writes the file when the ID or the clock moved. */
  view(): TelemetryView;
  /** Apply the phone's switch. A repeat of the last request id answers unchanged. */
  choose(a: { readonly setting: TelemetrySetting; readonly requestId: string }): { readonly replay: boolean; readonly view: TelemetryView };
  /**
   * Boot: settle the state file, log the one `install count:` line (every start), and say why a refused
   * URL or an unknown `COLLIE_TELEMETRY` value turned the ping off.
   */
  observe(): void;
  /** One timer tick. Sends at most once a UTC day and never throws. */
  tick(): Promise<void>;
}

/** The record after it was made to agree with the state, and that state. */
interface Settled {
  readonly record: TelemetryRecord;
  readonly state: TelemetryState;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const files = deps.files ?? diskWriter;
  const newId = deps.newId ?? newInstallId;
  const warn = deps.warn ?? (() => {});
  const log = deps.log ?? (() => {});

  const stateOf = (record: TelemetryRecord): TelemetryState =>
    telemetryState({ env: deps.env, origin: deps.origin, setting: record.setting, version: deps.version });

  const save = (record: TelemetryRecord): TelemetryRecord => {
    writeTelemetryRecord(files, deps.stateDir, record);
    return record;
  };

  /** Make the file say what the state says: off keeps no ID, on has one, and the clock has started. */
  const settle = (): Settled => {
    const before = readTelemetryRecord(deps.stateDir);
    const state = stateOf(before);
    const started = before.firstSeenAt ?? deps.now();
    const wanted: TelemetryRecord = state.on
      ? { ...before, id: before.id ?? newId(), firstSeenAt: started }
      : { ...before, id: null, lastSentDay: null, firstSeenAt: started };
    const changed =
      wanted.id !== before.id || wanted.lastSentDay !== before.lastSentDay || wanted.firstSeenAt !== before.firstSeenAt;
    return { record: changed ? save(wanted) : before, state };
  };

  const pingOf = (record: TelemetryRecord): TelemetryPing | null => {
    if (record.id === null) return null;
    return buildPing({
      id: record.id,
      day: utcDay(deps.now()),
      version: pingVersion(deps.version),
      os: deps.os,
      arch: deps.arch,
      installKind: deps.installKind,
      line: deps.line(),
    });
  };

  const view = (): TelemetryView => {
    const { record, state } = settle();
    return { on: state.on, decidedBy: state.decidedBy, setting: record.setting, next: state.on ? pingOf(record) : null };
  };

  return {
    view,
    choose(a) {
      const before = readTelemetryRecord(deps.stateDir);
      const replay = before.requestId === a.requestId && before.setting === a.setting;
      if (!replay) save({ ...before, setting: a.setting, changedAt: deps.now(), requestId: a.requestId });
      return { replay, view: view() };
    },
    observe() {
      const { record, state } = settle();
      log(telemetryBootLine({ state, record, now: deps.now(), env: deps.env }));
      const url = resolveTelemetryUrl(deps.env);
      if (!url.ok) warn(telemetryUrlRefusal(url.value));
      const unknown = telemetrySwitchWarning(deps.env);
      if (unknown !== null) warn(unknown);
    },
    async tick() {
      try {
        const { record, state } = settle();
        const now = deps.now();
        if (!shouldSend({ now, firstSeenAt: record.firstSeenAt, lastSentDay: record.lastSentDay, on: state.on })) return;
        const url = resolveTelemetryUrl(deps.env);
        const ping = pingOf(record);
        if (!url.ok || ping === null) return;
        // Written BEFORE the request: a crash or a failure never sends twice in one day.
        save({ ...record, lastSentDay: utcDay(now) });
        await deps.fetch(url.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": PING_USER_AGENT },
          body: JSON.stringify(ping),
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
          redirect: "error",
        });
      } catch {
        // A failed send is dropped: no retry, no queue. The day is already spent.
        return;
      }
    },
  };
}
