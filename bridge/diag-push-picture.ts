import type { JsonValue } from "./json.ts";

// ── THE PUSH PICTURE TRACE: WHY A PUSH CAME WITH OR WITHOUT ITS PICTURE (round 19) ───────────────
//
// A push about a session with a project picture shows that picture as its icon, from a copy the page drew
// itself (web/src/lib/project-picture-push.ts). Twice a phone showed the Collie mark instead, and nobody
// could tell why: the bridge cannot see which service worker or which page bundle a phone runs. So the
// worker keeps the verdict of its last such push, and the page posts it once at its next start, with its
// own build. This file checks that record and writes ONE log line. It keeps nothing.
//
// ── WHAT A RECORD IS ─────────────────────────────────────────────────────────────────────────────
// A verdict from a fixed list, a machine KIND (lead or member, never a name), an age in whole seconds and
// two build ids. Never a path, a version, a pane id, a title or a word from a repository: the parser
// refuses any other key, any other word and any build id that is not the bundle's own stamp shape.
//
// ── WHERE IT GOES ────────────────────────────────────────────────────────────────────────────────
// The bridge's own log, on this machine, read by a person on the host. Never forwarded to a crew member
// (`bridge/crew/forward.ts` names no `/api/diag/` route) and never sent anywhere else. At most one line
// per device per {@link DIAG_PUSH_PICTURE_DEVICE_MS}, and {@link DIAG_PUSH_PICTURE_HOUR_MAX} an hour in
// all, so no page can flood the log.

/** The longest request body the route reads. A record is about 150 bytes. */
export const DIAG_PUSH_PICTURE_BODY_MAX = 512;
/** One line per device at most this often. */
export const DIAG_PUSH_PICTURE_DEVICE_MS = 60_000;
/** The most lines in any hour, all devices together. */
export const DIAG_PUSH_PICTURE_HOUR_MAX = 30;
/** The oldest verdict a record may report: thirty days, in seconds. */
const MAX_AGE_S = 30 * 24 * 60 * 60;
/** The longest device label a line keeps. */
const MAX_LABEL_CHARS = 80;

/** The worker's verdicts. The phone's list (`PUSH_PICTURE_VERDICTS` in project-picture-push.ts) is the same: a test pins it. */
export const PUSH_PICTURE_VERDICTS = ["shown", "switch-off", "no-map", "no-entry", "no-copy", "not-png", "unreadable"] as const;
export type PushPictureVerdict = (typeof PUSH_PICTURE_VERDICTS)[number];

/** One record as the phone sends it. */
export interface PushPictureDiag {
  readonly verdict: PushPictureVerdict;
  readonly machine: "lead" | "member";
  readonly ageS: number;
  readonly workerBuild: string;
  readonly pageBuild: string;
}

/** Every key a record holds, and no other. */
export const PUSH_PICTURE_DIAG_KEYS: readonly string[] = ["ageS", "machine", "pageBuild", "verdict", "workerBuild"];

/** A build id as the bundle stamps it (`<version>+<sha>[-dirty].<seconds>`), or `unknown`. */
const BUILD_ID = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/;

// The representation is asked by the value's own tag, as in web/src/lib/json.ts: a parsed document cannot
// spoof it (`Symbol.toStringTag` is a symbol key, and `JSON.parse` only makes string keys).
const tagOf = (value: JsonValue | undefined): string => Object.prototype.toString.call(value);

function isRecordObject(value: JsonValue | undefined): value is { [key: string]: JsonValue | undefined } {
  return tagOf(value) === "[object Object]";
}

function buildId(value: JsonValue | undefined): string | null {
  if (tagOf(value) !== "[object String]") return null;
  // SAFETY: the tag check above passed, so `[object String]` means the value IS a string.
  const text = value as string;
  return BUILD_ID.test(text) ? text : null;
}

/** A whole number of seconds in range, or null. */
function ageOf(value: JsonValue | undefined): number | null {
  if (tagOf(value) !== "[object Number]") return null;
  // SAFETY: the tag check above passed, so `[object Number]` means the value IS a number.
  const n = value as number;
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_AGE_S ? n : null;
}

/** The record a body holds, or null. Strict on purpose: a fixed key set, fixed words, a bounded integer. */
export function parsePushPictureDiag(body: JsonValue | undefined): PushPictureDiag | null {
  if (!isRecordObject(body)) return null;
  const keys = Object.keys(body).toSorted();
  if (keys.length !== PUSH_PICTURE_DIAG_KEYS.length || keys.some((k, i) => k !== PUSH_PICTURE_DIAG_KEYS[i])) return null;
  const verdict = PUSH_PICTURE_VERDICTS.find((v) => v === body.verdict);
  const machine = body.machine === "lead" || body.machine === "member" ? body.machine : null;
  const ageS = ageOf(body.ageS);
  const workerBuild = buildId(body.workerBuild);
  const pageBuild = buildId(body.pageBuild);
  if (verdict === undefined || machine === null || ageS === null || workerBuild === null || pageBuild === null) return null;
  return { verdict, machine, ageS, workerBuild, pageBuild };
}

/** How long ago, in the log's words. */
function agoOf(seconds: number): string {
  if (seconds < 120) return `${String(seconds)}s ago`;
  if (seconds < 2 * 3600) return `${String(Math.round(seconds / 60))}m ago`;
  return `${String(Math.round(seconds / 3600))}h ago`;
}

/** The device label as the line may hold it: no control codes, at most {@link MAX_LABEL_CHARS}. */
function cleanLabel(label: string | null): string {
  const clean = [...(label ?? "")].filter((c) => c >= " " && c !== "\u007f").join("").slice(0, MAX_LABEL_CHARS);
  return clean === "" ? "this host" : clean;
}

/**
 * The one log line, for example
 * `[diag] push picture: none (no-copy) for a member's pane, 2m ago; worker 1.29.1+abc.1 page 1.29.0+def.2 (they differ); device pixel`.
 */
export function pushPictureDiagLine(report: PushPictureDiag, device: string | null): string {
  const what = report.verdict === "shown" ? "shown" : `none (${report.verdict})`;
  const whose = report.machine === "lead" ? "the lead's own pane" : "a member's pane";
  const skew = report.workerBuild === report.pageBuild ? "the same build" : "they differ";
  return `[diag] push picture: ${what} for ${whose}, ${agoOf(report.ageS)}; worker ${report.workerBuild} page ${report.pageBuild} (${skew}); device ${cleanLabel(device)}`;
}

/** The rate limit: one line per device per {@link DIAG_PUSH_PICTURE_DEVICE_MS}, {@link DIAG_PUSH_PICTURE_HOUR_MAX} an hour in all. */
export class PushPictureDiagLimit {
  private readonly lastByDevice = new Map<string, number>();
  private hour: number[] = [];

  /** Whether a line for `device` may be written at `now`; counts it when it may. */
  allow(device: string, now: number): boolean {
    this.hour = this.hour.filter((at) => now - at < 3_600_000);
    for (const [key, at] of this.lastByDevice) if (now - at >= DIAG_PUSH_PICTURE_DEVICE_MS) this.lastByDevice.delete(key);
    if (this.lastByDevice.has(device) || this.hour.length >= DIAG_PUSH_PICTURE_HOUR_MAX) return false;
    this.lastByDevice.set(device, now);
    this.hour.push(now);
    return true;
  }
}
