import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../web/src/lib/json.ts";
import {
  compareSemver,
  followsTrain,
  majorOf,
  parsePrereleaseTag,
  versionOfTag,
} from "./update.ts";

// ── TWO RELEASE LINES: STABLE AND EDGE (M60 spec 01, ADR 0110) ─────────────────────────────────
//
// A machine is on ONE line, Stable by default. Stable is ADR 0020 unchanged: strict releases only.
// Edge also takes `vX.Y.Z-edge.N` pre-releases, the builds volunteers run before Stable is cut from
// one of them. The line is a per-machine setting, kept here, beside the bridge's other update
// records, and written only by the update line route (with a receipt) and by a rollback off an
// Edge build, which puts the machine back on Stable and marks the build it left as rejected.
//
// ── ONE RESOLVER, THREE READERS ────────────────────────────────────────────────────────────────
// {@link lineOffer} is what a line offers. The bridge's monitor reads it for the Updates page, the
// update verbs read it through `cli/update.ts`, and the phone's back-to-Stable states are its `back`
// answer. Pure over version strings, so the table in `update-line.test.ts` is the whole contract.
//
// ── THE FILE IS ADDITIVE, AND OPTIONAL ─────────────────────────────────────────────────────────
// `update-line.json` is a NEW file (ADR 0110: new files and new fields only). A machine that never
// opened the setting has none, and reads as Stable with nothing rejected, which is exactly the
// behaviour of every build before it. Removing the file restores that behaviour.

export type ReleaseLine = "stable" | "edge";

/** The record's file name inside the state dir. */
export const UPDATE_LINE_FILE = "update-line.json";

/** The record's schema. A reader of a schema it does not know reads Stable rather than guessing. */
export const UPDATE_LINE_SCHEMA = 1;

/** The most rejected builds kept. The oldest goes first; a rejected build older than the newest
 *  hundred is long superseded by a release anyway. */
export const REJECTED_MAX = 100;

/** The one pre-release tail a line resolves: `edge.N`, `N` with no leading zero. */
const EDGE_TAIL = /^edge\.(0|[1-9]\d*)$/;

/** What the file holds. */
export interface UpdateLineRecord {
  readonly schema: number;
  readonly line: ReleaseLine;
  /** Builds this machine rolled back from, as dotted versions. Never offered again on either line. */
  readonly rejected: readonly string[];
  /** When the line last changed, epoch ms on this machine's clock, or null when it never did. */
  readonly changedAt: number | null;
  /** The request id of the last switch through the route, so a retry answers the same receipt. */
  readonly requestId?: string;
}

/** The reading of a machine with no file: Stable, nothing rejected. */
export const DEFAULT_UPDATE_LINE: UpdateLineRecord = {
  schema: UPDATE_LINE_SCHEMA,
  line: "stable",
  rejected: [],
  changedAt: null,
};

/** The `+build` tail dropped: `1.23.0-edge.1+ab12cd3` → `1.23.0-edge.1`. */
function bare(version: string): string {
  const plus = version.indexOf("+");
  return (plus < 0 ? version : version.slice(0, plus)).trim();
}

/** Whether a dotted version is an Edge build (`1.23.0-edge.1`, with or without a `+sha` tail). */
export function isEdgeBuild(version: string): boolean {
  const parsed = parsePrereleaseTag(`v${bare(version)}`);
  return parsed !== null && parsed.prerelease !== null && EDGE_TAIL.test(parsed.prerelease);
}

/**
 * The base version an Edge build was cut from (`1.23.0-edge.1` → `1.23.0`), or the version itself.
 * Where a CHANGELOG section or a release's notes are looked up: the suffix lives in the tag only.
 */
export function baseVersion(version: string): string {
  const v = bare(version);
  return isEdgeBuild(v) ? v.replace(/-edge\.(0|[1-9]\d*)$/, "") : v;
}

/** Whether a tag name or a dotted version is a strict release (`v1.2.3` or `1.2.3`). */
export function isStrictRelease(version: string): boolean {
  const v = bare(version);
  const parsed = parsePrereleaseTag(v.startsWith("v") ? v : `v${v}`);
  return parsed !== null && parsed.prerelease === null;
}

/** Parse the record, defensively. Anything that is not a record of this schema reads as the default. */
export function parseUpdateLine(text: string | null): UpdateLineRecord {
  const doc = text === null ? undefined : asJsonObject(parseJson(text));
  if (doc === undefined || asJsonNumber(doc.schema) !== UPDATE_LINE_SCHEMA) return DEFAULT_UPDATE_LINE;
  const line: ReleaseLine = asJsonString(doc.line) === "edge" ? "edge" : "stable";
  const raw = doc.rejected;
  const rejected = Array.isArray(raw)
    ? raw.flatMap((v) => {
        const version = asJsonString(v);
        return version !== undefined && parsePrereleaseTag(`v${bare(version)}`) !== null ? [bare(version)] : [];
      })
    : [];
  const at = asJsonNumber(doc.changedAt);
  const record: UpdateLineRecord = {
    schema: UPDATE_LINE_SCHEMA,
    line,
    rejected: rejected.slice(-REJECTED_MAX),
    changedAt: at !== undefined && Number.isFinite(at) ? at : null,
  };
  const requestId = asJsonString(doc.requestId);
  return requestId === undefined || requestId === "" ? record : { ...record, requestId };
}

/** The record's path inside a state dir. */
export const updateLinePath = (stateDir: string): string => join(stateDir, UPDATE_LINE_FILE);

/** Read the record through any reader (the CLI's `Files`, or the disk). Absent reads as the default. */
export function readUpdateLine(read: (path: string) => string | null, stateDir: string): UpdateLineRecord {
  return parseUpdateLine(read(updateLinePath(stateDir)));
}

/** Read the record straight off disk. The bridge's reader. */
export function readUpdateLineSync(stateDir: string): UpdateLineRecord {
  return readUpdateLine((p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }, stateDir);
}

/** The writer seam both trees can satisfy: the CLI's `Files`, or {@link diskWriter}. */
export interface UpdateLineWriter {
  mkdirp(dir: string, mode?: number): void;
  write(path: string, text: string, mode?: number): void;
  rename(from: string, to: string): void;
}

/** Write the record atomically (temp file, then rename), owner-only. */
export function writeUpdateLine(files: UpdateLineWriter, stateDir: string, record: UpdateLineRecord): void {
  const at = updateLinePath(stateDir);
  const scratch = `${at}.tmp`;
  files.mkdirp(stateDir, 0o700);
  files.write(scratch, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  files.rename(scratch, at);
}

/** {@link UpdateLineWriter} over the real disk, for the bridge. */
export const diskWriter: UpdateLineWriter = {
  mkdirp: (dir, mode) => mkdirSync(dir, { recursive: true, mode }),
  write: (path, text, mode) => {
    const fd = openSync(path, "w", mode);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => renameSync(from, to),
};

/** The record with the line set. A switch to the line already set keeps `changedAt`. */
export function withLine(record: UpdateLineRecord, line: ReleaseLine, at: number, requestId?: string): UpdateLineRecord {
  const moved: UpdateLineRecord = {
    schema: UPDATE_LINE_SCHEMA,
    line,
    rejected: record.rejected,
    changedAt: line === record.line ? record.changedAt : at,
  };
  return requestId === undefined ? moved : { ...moved, requestId };
}

/**
 * The record after a rollback off `from` (M60 spec 01): an Edge build is marked rejected and the
 * machine goes back to Stable. A rollback off a Stable build changes nothing here.
 */
export function afterRollback(record: UpdateLineRecord, from: string, at: number): UpdateLineRecord {
  const left = bare(from);
  if (!isEdgeBuild(left)) return record;
  const rejected = rejectBuild(record, left).rejected;
  return { schema: UPDATE_LINE_SCHEMA, line: "stable", rejected, changedAt: record.line === "stable" ? record.changedAt : at };
}

/**
 * An Edge build that FAILED ITS HEALTH CHECK and was rolled back by the updater itself (ADR 0110).
 *
 * The build is rejected, so the next check does not offer it again: without this a broken Edge
 * build fails, rolls back, is offered, fails again, which is the loop the Edge line exists to stop.
 * The line stays where the person set it. Only a rollback a person starts moves the machine to
 * Stable ({@link afterRollback}). A strict release that fails is not rejected: the next Stable is the
 * fix, and a strict release stays offered as before.
 */
export function afterFailedBuild(record: UpdateLineRecord, failed: string): UpdateLineRecord {
  const build = bare(failed.replace(/^v/, ""));
  if (!isEdgeBuild(build)) return record;
  return rejectBuild(record, build);
}

/** `record` with `build` in its rejected list, once, keeping the newest {@link REJECTED_MAX}. */
function rejectBuild(record: UpdateLineRecord, build: string): UpdateLineRecord {
  if (record.rejected.includes(build)) return record;
  return { ...record, rejected: [...record.rejected, build].slice(-REJECTED_MAX) };
}

/**
 * The state files the latest Stable cannot read, as this build writes them (ADR 0110).
 *
 * EMPTY BY RULE: a build changes no existing state file in a way the latest Stable cannot read; it
 * adds fields and files only, and `bridge/state-shapes.test.ts` loads the last Stable's fixtures to
 * hold that. A release that must break the rule names the file here, and the Updates page says so
 * before "Go back now".
 */
export const UNREADABLE_BY_LAST_STABLE: readonly string[] = [];

/** What the bridge's monitor reads on each check: the offer, the line, and the exceptions. */
export interface LineReading extends LineOffer {
  readonly line: ReleaseLine;
  readonly exceptions: readonly string[];
}

/** {@link lineOffer} over this machine's record. The monitor's one seam into this module. */
export function lineReading(record: UpdateLineRecord, tags: readonly string[], installed: string): LineReading {
  const offer = lineOffer({ tags, installed, line: record.line, rejected: record.rejected });
  return { ...offer, line: record.line, exceptions: UNREADABLE_BY_LAST_STABLE };
}

// ── WHAT A LINE OFFERS ─────────────────────────────────────────────────────────────────────────

/** What {@link lineOffer} answers. */
export interface LineOffer {
  /**
   * The newest build this install may take on its line, or null when there is none. It may be at or
   * below the installed one (then nothing is newer); `releaseAvailable` compares, as it always did.
   */
  readonly latest: string | null;
  /** Every build on the line strictly newer than the installed one, oldest first. */
  readonly newer: readonly string[];
  /**
   * BACK TO STABLE, case 2: the machine is on Stable, runs an Edge build, and no Stable release is
   * at or above it. The newest Stable release below it, which "Go back now" downgrades to. Null in
   * every other case.
   */
  readonly back: string | null;
}

/** The tags of `major` a line may offer an install at `installed`, as dotted versions. */
function candidatesOn(tags: readonly string[], major: number, installed: string, line: ReleaseLine): string[] {
  const parsed = tags.flatMap((tag) => {
    const p = parsePrereleaseTag(tag);
    return p === null || p.triple[0] !== major ? [] : [p];
  });
  const strict = parsed.filter((p) => p.prerelease === null).map(versionOfTag);
  if (line === "edge") {
    const edge = parsed.filter((p) => p.prerelease !== null && EDGE_TAIL.test(p.prerelease)).map(versionOfTag);
    return [...strict, ...edge];
  }
  // STABLE IS ADR 0020: strict releases, plus the legacy prerelease train for an install that is
  // itself on an old beta (`followsTrain`). An Edge build never rides that train, and Edge tags are
  // never part of it, so an Edge machine switched to Stable sees Stable releases only.
  if (isEdgeBuild(installed)) return strict;
  const strictBest = strict.reduce<string | null>((best, v) => (best === null || compareSemver(v, best) > 0 ? v : best), null);
  if (!followsTrain(installed, strictBest)) return strict;
  const train = parsed.filter((p) => p.prerelease !== null && !EDGE_TAIL.test(p.prerelease)).map(versionOfTag);
  return [...strict, ...train];
}

/**
 * What `line` offers an install at `installed`, from the published `tags` (names, `v1.2.3`).
 *
 * - **Stable**: strict releases of the installed major (ADR 0020), newer than the installed build.
 *   A final release supersedes its own Edge builds (`1.23.0` > `1.23.0-edge.4`), so an Edge machine
 *   switched to Stable is offered the release of its version as an ordinary update (case 1).
 * - **Edge**: the newest of strict releases and `-edge.N` builds of the installed major, by
 *   prerelease-aware semver.
 * - **Both**: a build in `rejected` is never offered. A major crossing is never offered here.
 *
 * `back` is the one downgrade a line ever names: Stable, an Edge build installed, nothing on Stable
 * at or above it. The page offers "Go back now" to it and "Wait for Stable" beside it.
 */
export function lineOffer(a: {
  tags: readonly string[];
  installed: string;
  line: ReleaseLine;
  rejected?: readonly string[];
}): LineOffer {
  const installed = bare(a.installed);
  const major = majorOf(installed);
  if (major === null) return { latest: null, newer: [], back: null };
  const rejected = new Set((a.rejected ?? []).map(bare));
  const offered = [...new Set(candidatesOn(a.tags, major, installed, a.line))]
    .filter((v) => !rejected.has(v))
    .toSorted(compareSemver);
  const newer = offered.filter((v) => compareSemver(v, installed) > 0);
  const latest = offered.at(-1) ?? null;
  let back: string | null = null;
  if (a.line === "stable" && isEdgeBuild(installed) && newer.length === 0) {
    back = offered.findLast((v) => isStrictRelease(v) && compareSemver(v, installed) < 0) ?? null;
  }
  return { latest, newer, back };
}
