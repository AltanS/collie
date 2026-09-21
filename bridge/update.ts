import type { JsonValue } from "./json.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Environment } from "./config-source.ts";
import { herdrActionCommand } from "./front-door.ts";
import type { CrewMode, UpdateLinkChange, UpdateStatus } from "./types.ts";
import type { UpdateRun } from "./update-run.ts";

// Update-availability signal, surfaced on the (access-gated) /api/snapshot as `update`. Two
// independent questions the running plugin can answer about itself:
//
//   • releaseAvailable — is a newer Collie RELEASE published upstream? We read the repo's git tags
//     over anonymous HTTPS (the repo is public) and compare the newest `vX.Y.Z` to the running
//     version. No `git` subprocess (the SSH origin has no agent under systemd --user, and a
//     non-git install has no origin at all), no auth (the 60/hr anonymous limit is irrelevant at a
//     few-hours cadence), and the fetch is trivially injectable for `bun test`.
//   • bridgeStale — is the running bridge PROCESS behind the on-disk bridge source? The frontend
//     build id can't answer this (it's read fresh from disk, so a stale bridge reports the NEW
//     bundle). We stamp the bridge sources at process start and compare; a rebuilt-but-not-restarted
//     bridge (the "#1 my change didn't take" trap) then reads as stale.
//
// The pure pieces (semver compare, tag selection, notify gating, the source stamp) are exported and
// unit-tested; the network + filesystem live behind injected seams on {@link UpdateMonitor}, matching
// the NotificationCoordinator/Snooze injection style.

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
// The same anchor with an OPTIONAL `-prerelease` tail (`v1.0.0-beta.44`, `v1.0.0-rc.1`). Dot-separated
// identifiers of `[0-9A-Za-z-]` only, anchored at both ends, so a ref name with a slash, an empty
// identifier (`v1.0.0-beta..1`) or a bare trailing hyphen (`v1.0.0-`) is still rejected — remote refs
// stay untrusted input.
const PRERELEASE_SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// The upstream tag check is bounded — a hung request must never wedge the monitor's timer.
const TAGS_TIMEOUT_MS = 10_000;
// The release reading (`collie-release.json`, M27/06) is bounded far tighter than the tag list,
// because it is an EXTRA inside the same check budget: the tags are the answer, this is a footnote
// on it. A release that does not answer in three seconds reads as one that says nothing.
const RELEASE_READING_TIMEOUT_MS = 3_000;
// bridgeStale is read on every snapshot poll; recompute the on-disk stamp at most this often so a
// busy poll loop doesn't stat the source tree dozens of times a second (the value barely changes).
const STALE_TTL_MS = 5_000;
// The digest window: after one update push, no second one for a day. Sibling of STALE_TTL_MS above —
// a time-bounded recheck, not a new mechanism. Releases inside a closed window are folded, not dropped.
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
// The patch window: a delta that is ONLY a patch bump rides a WEEKLY digest instead of the daily one.
// It is a wait, not a mute — an install that only ever sees patch releases is still nudged, once a
// week. A minor or major keeps the daily cadence, because it is the kind of release worth reading
// notes for; a patch train is not, until enough of it has piled up to be worth one interruption.
const DIGEST_PATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// How many of the newest releases in the delta are asked whether they are urgent. A machine that has
// been off for a year can be a hundred releases behind, and the check's budget is the tag list, not a
// hundred small GETs. Ten is the newest ten: an urgent fix older than that has been superseded by
// every release above it, and the operator is being nudged about the pile, not about that one.
const URGENT_READING_CAP = 10;
// The earliest HOST-LOCAL hour a digest may be pushed. A release published at 03:00 waits for morning;
// the update banner is already showing it, so nothing is lost by not buzzing a phone at night.
const DIGEST_EARLIEST_HOUR = 9;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** Parse a STRICT `vX.Y.Z` tag into its numeric parts, or null. A prerelease (`v1.0.0-beta.44`) is
 *  rejected here on purpose — this is the "strict releases only" question, and every caller that asks
 *  it means it. Remote ref names are untrusted input. Ask {@link parsePrereleaseTag} for the wider one.
 *
 *  THE RULE THIS SERVES (ADR 0020, amended 2026-08-30): prerelease-following is a property of the
 *  INSTALLED version, never a flag. An install on a strict release only ever sees strict release tags
 *  — the banner and `update` both stay blind to the whole `v1.0.0-beta.N` train. An install that
 *  carries a prerelease tail PREFERS strict releases too, and falls back to its own major's train
 *  only when no strict release of that major is newer than it. The consent taken with a beta was to
 *  the road TO its release, not to that major's prereleases forever — so the final release supersedes
 *  every beta that led to it, and a LATER minor's prerelease is as invisible to a beta install as it
 *  is to a stable one. See {@link followsTrain}. Crossing a major is still `update --major`, and
 *  still strict-only.
 *
 *  Anything outside Collie resolving "the newest release" must read git tags, never
 *  `releases/latest`: docs/upgrading.md -> *Resolving the newest release from a script*. */
export function parseSemverTag(tag: string): [number, number, number] | null {
  const m = SEMVER_TAG.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** A tag parsed by {@link parsePrereleaseTag}: the numeric triple, plus the `-` tail kept apart
 *  because a prerelease sorts BELOW the release it leads to. */
export interface PrereleaseTag {
  triple: [number, number, number];
  /** `beta.44`, `rc.1` — or null when the tag is a strict release. */
  prerelease: string | null;
}

/** Parse `vX.Y.Z` OR `vX.Y.Z-<tail>` into its parts, or null. The prerelease-aware sibling of
 *  {@link parseSemverTag}, and just as strict about everything else: both ends are anchored, so
 *  `v1.0.0-`, `v1.0.0-beta..1` and any ref with a slash are rejected. */
export function parsePrereleaseTag(tag: string): PrereleaseTag | null {
  const m = PRERELEASE_SEMVER_TAG.exec(tag.trim());
  if (!m) return null;
  const tail = m[4];
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: tail === undefined ? null : tail,
  };
}

/** The dotted version a parsed tag names (`1.0.0`, `1.0.0-beta.44`) — what {@link compareSemver} eats. */
export function versionOfTag(parsed: PrereleaseTag): string {
  const triple = parsed.triple.join(".");
  return parsed.prerelease === null ? triple : `${triple}-${parsed.prerelease}`;
}

/** The numeric triple of a dotted version, with any `+build` tail dropped. The `-prerelease` tail is
 *  reported separately, AS A STRING, because a prerelease sorts BELOW the release it leads to and
 *  prereleases sort among themselves (`beta.9` < `beta.10`). Null means "no tail". */
function versionParts(v: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?/.exec(v.trim());
  if (!m) return { triple: [0, 0, 0] as const, prerelease: null };
  const tail = m[4];
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
    prerelease: tail === undefined || tail === "" ? null : tail,
  };
}

const NUMERIC_IDENTIFIER = /^\d+$/;

/**
 * Compare two `-prerelease` tails by semver §11. Split on `.`; a numeric identifier compares
 * numerically and sorts BELOW an alphanumeric one; alphanumerics compare as strings; and when one
 * tail is a prefix of the other the shorter sorts first (`beta` < `beta.1`). `null` — no tail at all
 * — sorts ABOVE every tail, which is what makes `1.0.0` an update from `1.0.0-beta.44`.
 */
function comparePrereleaseTails(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const xs = a.split(".");
  const ys = b.split(".");
  const shared = Math.min(xs.length, ys.length);
  for (let i = 0; i < shared; i++) {
    const x = xs[i] ?? "";
    const y = ys[i] ?? "";
    if (x === y) continue;
    const xNum = NUMERIC_IDENTIFIER.test(x);
    const yNum = NUMERIC_IDENTIFIER.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  if (xs.length === ys.length) return 0;
  return xs.length < ys.length ? -1 : 1;
}

/**
 * Compare two dotted `X.Y.Z` versions (no leading `v`). Returns -1 / 0 / 1.
 *
 * The running version can be a PRERELEASE (`1.0.0-beta.44`), and so can the tags it is compared
 * against, so the tail is compared by semver §11 rather than reduced to "has one / has none":
 * `1.0.0-beta.9` < `1.0.0-beta.10` < `1.0.0-rc.1` < `1.0.0`. That last step is what makes the release
 * at the end of a beta train read as an upgrade from the last beta.
 */
export function compareSemver(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (const [x, y] of [
    [pa.triple[0], pb.triple[0]],
    [pa.triple[1], pb.triple[1]],
    [pa.triple[2], pb.triple[2]],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrereleaseTails(pa.prerelease, pb.prerelease);
}

/** The major of a dotted version (`1.0.0-beta.5` → 1), or null when it names none (`unknown`). */
export function majorOf(version: string): number | null {
  const m = /^(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/** Whether a dotted version carries a `-prerelease` tail (`1.0.0-beta.44` -> true, `1.0.0` -> false,
 *  `unknown` -> false). THE one predicate that decides whether an install follows a prerelease train:
 *  the answer is a property of the installed version, never a flag (ADR 0020, amended 2026-08-30). */
export function isPrereleaseVersion(version: string): boolean {
  return versionParts(version).prerelease !== null;
}

/** The newest STRICT release WITHIN `major`, dotted, or null — the target a routine `update` may take
 *  (ADR 0020). */
export function latestReleaseInMajor(tags: string[], major: number): string | null {
  return latestReleaseTag(tags.filter((t) => parseSemverTag(t)?.[0] === major));
}

/**
 * Whether the prerelease TRAIN is in play for this install — THE one place the rule lives, shared by
 * the banner ({@link latestUpdateInMajor}) and the `update` verb (`cli/update.ts`'s `planUpdate`), so
 * the two can never drift.
 *
 * A prerelease install PREFERS strict releases and falls back to its train only when strict offers it
 * nothing: `strictBest` is the highest strict release in the installed major, and the train applies
 * only when there is none, or none newer than what is installed.
 *
 * The consent taken with a beta was to the road TO its release, not to that major's prereleases
 * forever. So `1.0.0-beta.5` with `v1.0.0` published lands on `v1.0.0` and a sibling `v1.1.0-rc.1`
 * stays as invisible to it as it is to every stable install; `1.0.0-beta.44` with only
 * `v1.0.0-beta.45` published lands on `v1.0.0-beta.45`; and once `v1.0.0` exists it supersedes every
 * beta that led to it, so beta.44 goes straight there and skips beta.45.
 */
export function followsTrain(installed: string, strictBest: string | null): boolean {
  if (!isPrereleaseVersion(installed)) return false;
  return strictBest === null || compareSemver(strictBest, installed) <= 0;
}

/**
 * The newest tag inside `major` that an install running `installed` may take on a ROUTINE update —
 * the ONE resolver behind both the banner ({@link UpdateMonitor}) and the `update` verb.
 *
 * A strict install sees strict releases only: byte-for-byte the old behaviour, and the regression to
 * guard hardest. A prerelease install sees strict releases first and its own major's train only as a
 * fallback — see {@link followsTrain} for the rule and why it is that way round.
 */
export function latestUpdateInMajor(tags: string[], major: number, installed: string): string | null {
  const strict = latestReleaseInMajor(tags, major);
  if (!followsTrain(installed, strict)) return strict;
  let best: string | null = null;
  for (const tag of tags) {
    const parsed = parsePrereleaseTag(tag);
    if (parsed === null || parsed.triple[0] !== major) continue;
    const v = versionOfTag(parsed);
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** The newest STRICT release of any major ABOVE `major`, dotted, or null. Crossing to it is consented to by
 *  `update --major`, never inherited — so it is reported separately from {@link latestReleaseInMajor}. */
export function latestReleaseAboveMajor(tags: string[], major: number): string | null {
  return latestReleaseTag(
    tags.filter((t) => {
      const parts = parseSemverTag(t);
      return parts !== null && parts[0] > major;
    }),
  );
}

/** The newest release among `tags`, as a dotted `X.Y.Z` (leading `v` stripped to match
 *  package.json's `version`), or null if none parse as a strict release tag. */
export function latestReleaseTag(tags: string[]): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    const parts = parseSemverTag(tag);
    if (!parts) continue;
    const v = parts.join(".");
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** Every version among `tags` that this install may routinely update TO and that is strictly newer
 *  than `current`, oldest first. The list form of {@link latestUpdateInMajor} — same visibility rule
 *  (own major only; that major's prereleases IFF this install is on one), so its last element IS what
 *  that function returns whenever anything is newer. The digest needs the whole list, not the top of
 *  it: a push has to be able to name the releases it folded. */
export function updatesNewerThan(tags: string[], current: string): string[] {
  const major = majorOf(current);
  const train = major !== null && followsTrain(current, latestReleaseInMajor(tags, major));
  const seen = new Set<string>();
  for (const tag of tags) {
    const parsed = parsePrereleaseTag(tag);
    if (parsed === null) continue;
    if (parsed.prerelease !== null && !train) continue;
    if (major !== null && parsed.triple[0] !== major) continue;
    const v = versionOfTag(parsed);
    if (compareSemver(v, current) <= 0) continue;
    seen.add(v);
  }
  return [...seen].toSorted(compareSemver);
}

/** Whether two dotted versions differ ONLY in their patch component — `1.3.0` vs `1.3.1`, but not
 *  `1.3.0` vs `1.4.0` and not `1.0.0-beta.44` vs `1.0.0-beta.45` (same patch, different train stop). */
function isPatchOnlyDelta(current: string, candidate: string): boolean {
  const a = versionParts(current);
  const b = versionParts(candidate);
  if (a.triple[0] !== b.triple[0] || a.triple[1] !== b.triple[1]) return false;
  return a.triple[2] !== b.triple[2];
}

/** The gate's answer: send nothing, or send a digest naming every folded version (oldest first). */
export type NotifyVerdict = { send: false } | { send: true; versions: string[] };

/**
 * Whether a NEW-version push should fire, and what it should name. Pure, and time-aware: `now` is an
 * argument, so the whole rule is testable without a timer.
 *
 * The push is a DAILY DIGEST, not a per-release announcement:
 *   • nothing to say — no `latest`, or `latest` is not newer than `current`, or we already announced
 *     it. Comparing against `current` (not the raw `latest`) means a restart after updating self-heals;
 *   • the window — one push per {@link DIGEST_WINDOW_MS}, measured from `lastPushedAt`;
 *   • the hour — never before {@link DIGEST_EARLIEST_HOUR} host-local;
 *   • patch alone waits LONGER — a delta that is only a patch bump needs {@link DIGEST_PATCH_WINDOW_MS}
 *     since the last push, not 24 h, so a patch train folds into a weekly digest. It is a wait, not a
 *     mute: with no push on record it goes out at once, and a minor or major arriving meanwhile carries
 *     the waiting patches with it. Releases held back this way are folded, never dropped;
 *   • an URGENT release breaks the window once — `urgent` names a release in the delta that asked to
 *     reach operators today (ADR 0046). While that version has NOT been announced yet, the window is
 *     not consulted at all, so an urgent fix published after this morning's digest still goes out
 *     this morning. The 09:00 floor still holds, so the worst case is the next 09:00 host-local after
 *     the release. Once that version HAS been announced, the ordinary windows are back, and the
 *     urgent marker then only keeps the delta on the daily one rather than the weekly patch one;
 *   • the payload is every version newer than what we last announced, so the operator can tell a patch
 *     train from a feature release without opening the app.
 */
export function shouldNotify(a: {
  current: string;
  latest: string | null;
  newerVersions: readonly string[];
  lastNotified: string | null;
  lastPushedAt: string | null;
  now: Date;
  /**
   * The newest release in the delta that marked itself urgent in its own `collie-release.json`
   * (ADR 0046), or absent when none did — which is every ordinary release and every read that
   * failed. The RECORD, not a flag: the version is what tells a fix nobody has been told about yet
   * from one this install already pushed, and it is the same object the snapshot shows.
   */
  urgent?: UpdateUrgentReading;
}): NotifyVerdict {
  if (!a.latest) return { send: false };
  if (compareSemver(a.latest, a.current) <= 0) return { send: false };
  if (a.latest === a.lastNotified) return { send: false };

  const candidates = a.newerVersions.length > 0 ? [...a.newerVersions] : [a.latest];
  const patchOnly = candidates.every((v) => isPatchOnlyDelta(a.current, v));

  // THE ONE CASE THAT SKIPS THE WINDOW (ADR 0046): an urgent release this install has not announced
  // yet. A fix for data loss published at 11:00 must not wait for tomorrow because a digest went out
  // at 09:00, and the window is the only thing that would make it wait. It is spent ONCE: after that
  // version is announced, `lastNotified` is no longer below it and the ordinary windows are back.
  const unannouncedUrgent =
    a.urgent !== undefined &&
    (a.lastNotified === null || compareSemver(a.lastNotified, a.urgent.version) < 0);

  const pushedAt = a.lastPushedAt === null ? Number.NaN : Date.parse(a.lastPushedAt);
  // An unreadable stamp reads as "no push yet" — the same fail-open a legacy record gets, and the one
  // that lets a first-ever patch digest go out instead of waiting a week for a push that never was.
  // An urgent delta that has already been announced is a patch train on the DAILY window: the
  // interruption was spent, and what is left is the ordinary cadence for the kind of release it is.
  const window = patchOnly && a.urgent === undefined ? DIGEST_PATCH_WINDOW_MS : DIGEST_WINDOW_MS;
  if (!unannouncedUrgent && !Number.isNaN(pushedAt) && a.now.getTime() - pushedAt < window) {
    return { send: false };
  }
  // THE FLOOR IS NEVER SKIPPED, not even by an urgent release. "Today" is what urgent asks for, not
  // "now", and a phone buzzing at 03:00 about a fix nobody can take until morning is the trade this
  // whole mechanism exists to avoid making.
  if (a.now.getHours() < DIGEST_EARLIEST_HOUR) return { send: false };

  const announced = a.lastNotified;
  const folded =
    announced === null ? candidates : candidates.filter((v) => compareSemver(v, announced) > 0);
  return { send: true, versions: folded.length > 0 ? folded : [a.latest] };
}

/** The push body for a digest: one version names itself, several name the count AND every version —
 *  a count alone can't tell a patch train from a feature release.
 *
 *  A release that moves the CREW WIRE adds one sentence (M27/06), and adds it here rather than in
 *  the sender, so the push says what the band and the card say. Without a link change the body is
 *  byte-identical to what it always was.
 *
 *  An URGENT release puts its own sentence FIRST (ADR 0046), because that sentence is why the phone
 *  buzzed at all. It is the release's own English, quoted, never translated — the push has no locale
 *  to read, which is the same reason {@link LINK_CHANGE_SENTENCE} is written here. The TITLE does not
 *  move: the notification is still "Collie update available", and the urgency is in what it says. */
export function updateDigestBody(
  current: string,
  versions: readonly string[],
  linkChange: UpdateLinkChange | null = null,
  urgent: UpdateUrgentReading | null = null,
): string {
  const first = versions[0];
  const body =
    versions.length <= 1
      ? `Collie ${first ?? current} is available`
      : `${versions.length} updates since ${current}: ${versions.join(", ")}`;
  const withLink = linkChange === null ? body : `${body}. ${LINK_CHANGE_SENTENCE}`;
  return urgent === null ? withLink : `${urgent.reason} ${withLink}`;
}

/** A stable, comparable stamp of source files by (path, mtime, size). Order-independent. Equality is
 *  all we need — any content edit changes size or mtime, and a pull/rebuild touches the changed files. */
export function stampOf(entries: { path: string; mtimeMs: number; size: number }[]): string {
  return entries
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}:${e.mtimeMs}:${e.size}`)
    .join("\n");
}

// ── Impure seams (injected into the monitor; not unit-tested) ─────────────────

/** Stamp the running bridge's source: every `bridge/*.ts` (EXCLUDING `*.test.ts` — a test-only edit
 *  needs no restart), plus the root `package.json` + `bun.lock` (a dep bump needs a restart and is
 *  otherwise invisible from `bridge/`). Re-`readdir`s each call so an added/deleted source counts. */
export function bridgeStampSync(bridgeDir: string, rootDir: string): string {
  const entries: { path: string; mtimeMs: number; size: number }[] = [];
  const add = (path: string) => {
    try {
      const s = statSync(path);
      entries.push({ path, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* a missing file is itself a change vs the startup stamp — just omit it */
    }
  };
  let names: string[] = [];
  try {
    names = readdirSync(bridgeDir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  } catch {
    /* unreadable bridge dir → an empty stamp; startup captured the same, so not "stale" */
  }
  for (const n of names) add(join(bridgeDir, n));
  add(join(rootDir, "package.json"));
  add(join(rootDir, "bun.lock"));
  return stampOf(entries);
}

/** The GitHub release page for a version, e.g. `…/releases/tag/v0.12.0`. Collie tags are `vX.Y.Z`
 *  (the versioning convention), so the `v` prefix is reconstructed from the bare version. GitHub
 *  serves the tag page even when there's no formal release attached, so this is always a live link. */
export function githubReleaseUrl(repo: string, version: string): string {
  return `https://github.com/${repo}/releases/tag/v${version}`;
}

/** One tag as GitHub's `/tags` endpoint reports it: the ref name and the commit it points at. */
export interface ApiTag {
  name: string;
  /** `commit.sha` — carried so the CLI can fill a `ReleaseTag` without a second request. */
  sha: string;
}

/** The endpoint the banner AND the binary updater read — never `releases/latest`, which hides
 *  prereleases and stalls a whole beta train (docs/upgrading.md). */
export function githubTagsUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/tags?per_page=100`;
}

// ── The GitHub credential (#254) ─────────────────────────────────────────────
// GitHub allows an anonymous caller 60 API calls an hour, counted per network address, so every
// machine behind one router shares a budget the release check can exhaust. A token makes the limit
// the caller's own. Collie READS one and never asks for one: the tag list is public, so a token
// with no scopes at all is enough. It is sent to `api.github.com` alone — a release asset lives on
// github.com, which counts nothing, and redirects to a storage host that must never see it.

/** The names read for a GitHub token, in the order they win. `GH_TOKEN` and `GITHUB_TOKEN` are the
 *  two the `gh` CLI and Actions already set; the first is Collie's own, for a service's `.env`. */
export const GITHUB_TOKEN_ENVS = ["COLLIE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** A token and the NAME it was read from. A message names the variable and never the value. */
export interface GithubCredential {
  token: string;
  source: (typeof GITHUB_TOKEN_ENVS)[number];
}

/** The first of {@link GITHUB_TOKEN_ENVS} with a non-blank value, or null: anonymous, as before. */
export function githubCredential(env: Environment): GithubCredential | null {
  for (const source of GITHUB_TOKEN_ENVS) {
    const token = env[source]?.trim();
    if (token !== undefined && token !== "") return { token, source };
  }
  return null;
}

/** Whether `url` is one the credential may go to: GitHub's API host, by exact host match. */
export function isGithubApiUrl(url: string): boolean {
  try {
    return new URL(url).host === "api.github.com";
  } catch {
    return false;
  }
}

/** `base`, plus the bearer header when there is a credential AND `url` is the API. */
export function githubHeaders(
  url: string,
  credential: GithubCredential | null,
  base: Record<string, string>,
) {
  if (credential === null || !isGithubApiUrl(url)) return base;
  return { ...base, authorization: `Bearer ${credential.token}` };
}

/**
 * GitHub's `/tags` payload → {@link ApiTag}[]. The ONE parser of that document: the bridge's banner
 * fetches it over `fetch`, and `collie update`'s binary path fetches it through the CLI's `net`
 * seam, and both land here (M14/01 §2.3).
 *
 * A tag with no readable name is dropped, and so is one with no `commit.sha`: an EMPTY sha is worse
 * than a missing tag, because `planUpdate`'s "already there" arm compares the candidate's commit
 * against the installed head — and on a binary install that head is `""`, so an empty sha would
 * match it and report a real update as "already current".
 */
export function parseTagsResponse(data: JsonValue): ApiTag[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((t) => {
    if (t === null || typeof t !== "object" || Array.isArray(t)) return [];
    if (typeof t.name !== "string" || t.name === "") return [];
    const commit = t.commit;
    if (commit === null || typeof commit !== "object" || Array.isArray(commit)) return [];
    if (typeof commit.sha !== "string" || commit.sha === "") return [];
    return [{ name: t.name, sha: commit.sha }];
  });
}

/** HTTPS fetch of a GitHub repo's tags, with the credential when there is one. Throws on a non-OK
 *  response or timeout so the caller keeps its previous result and retries next tick. A refused
 *  token is said ONCE in the log, because the banner would otherwise stall in silence on it. */
export function githubTagsFetcher(
  repo: string,
  credential: GithubCredential | null = null,
): () => Promise<ApiTag[]> {
  const url = githubTagsUrl(repo);
  let refusedSaid = false;
  return async () => {
    const res = await fetch(url, {
      headers: githubHeaders(url, credential, {
        accept: "application/vnd.github+json",
        "user-agent": "collie-update-check",
      }),
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    // Once, not every tick: the check runs for the life of the process, and a line an hour is the
    // sort of log nobody reads. The price is that a token revoked later is said once and then only
    // shows as a banner that stops moving; `collie update --check` names it any time it is asked.
    if (res.status === 401 && credential !== null && !refusedSaid) {
      refusedSaid = true;
      console.warn(
        `[update] GitHub refused the token in ${credential.source} (HTTP 401); the release check fails until it is fixed or unset`,
      );
    }
    if (!res.ok) throw new Error(`github tags: HTTP ${res.status}`);
    // SAFETY: `Response.json()` output IS a JsonValue by construction; every field below is checked
    // before it is kept.
    return parseTagsResponse((await res.json()) as JsonValue);
  };
}

// ── The release reading (`collie-release.json`, M27/06) ──────────────────────
// One tiny document per release, published beside the payloads by `.github/workflows/release.yml`:
// the version, and the CREW WIRE VERSION that release speaks. It exists so an install can be told,
// BEFORE it confirms, that the update changes the link its crew talks over — and be told generically,
// off a number, rather than off a hard-coded release name that would have to be edited every time.
//
// It is a courtesy, never a gate. Absent, unreachable, truncated or foreign all read the same way:
// no change. Every release before 1.8.0 published none at all.

/** What a release says about itself. Unknown fields are ignored — additive is free. */
export interface ReleaseReading {
  version: string;
  /** The crew wire version that release speaks — see `CREW_PROTOCOL_VERSION`. */
  crewProtocol: number;
  /**
   * The release asked to reach operators today (ADR 0046). Present only when the person who cut it
   * put an `**Urgent.**` line under the heading in `CHANGELOG.md`, and `reason` is that line's own
   * sentence, in the release's English.
   *
   * ABSENT is the ordinary release, and absent is also what a malformed field reads as: urgency is a
   * courtesy on the cadence, never a gate, so nothing here may turn a bad document into an error.
   */
  urgent?: { reason: string };
}

/** The newest urgent release in a delta, and why — the shape the snapshot carries. */
export interface UpdateUrgentReading {
  version: string;
  reason: string;
}

/** Where the asset sits. Constructed from (repo, version), never taken from a document, for the
 *  reason the manifest carries no URLs: a release must not be able to redirect a read to another
 *  host. The trust boundary stays "which repo", which is what COLLIE_UPDATE_REPO names. */
export function releaseReadingUrl(repo: string, version: string): string {
  return `https://github.com/${repo}/releases/download/v${version}/collie-release.json`;
}

/** The asset, parsed. Null for anything that is not the document we asked for — a wrong shape, a
 *  non-integer protocol, a GitHub 404 page served as JSON. */
export function parseReleaseReading(data: JsonValue): ReleaseReading | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { version, crewProtocol } = data;
  if (typeof version !== "string" || version === "") return null;
  if (typeof crewProtocol !== "number" || !Number.isInteger(crewProtocol)) return null;
  const reading: ReleaseReading = { version, crewProtocol };
  // The urgent marker is read LAST and can only add. Anything that is not an object with a non-empty
  // `reason` string is dropped on the floor, and the reading is still the reading — a release that
  // wrote the field badly is an ordinary release, never an unreadable one.
  const urgent = data.urgent;
  if (urgent !== null && typeof urgent === "object" && !Array.isArray(urgent)) {
    const reason = urgent.reason;
    if (typeof reason === "string" && reason.trim() !== "") reading.urgent = { reason: reason.trim() };
  }
  return reading;
}

/** The newest release in a delta that called itself urgent, or null when none did. `readings` is one
 *  entry per version asked about, in any order; a version with no reading simply cannot be urgent. */
export function newestUrgent(
  readings: readonly { version: string; reading: ReleaseReading | null }[],
): UpdateUrgentReading | null {
  let found: UpdateUrgentReading | null = null;
  for (const { version, reading } of readings) {
    const urgent = reading?.urgent;
    if (urgent === undefined) continue;
    if (found !== null && compareSemver(version, found.version) <= 0) continue;
    found = { version, reason: urgent.reason };
  }
  return found;
}

/**
 * What one read of a release's sidecar came back with.
 *
 * THREE ANSWERS, NOT TWO, and the third is the one that can be remembered: a reading, a definite
 * ABSENCE (the release published no such asset — GitHub says 404, which is every release before
 * 1.8.0), and a failure (a timeout, a 5xx, a body that is not the document). An absence is a fact
 * about a published release and never changes; a failure is a fact about this minute. The monitor
 * caches the first two for its lifetime and asks again after the third.
 */
export type ReleaseReadingResult = ReleaseReading | "absent" | null;

/** Fetch one release's reading. Never throws and never waits long: the caller is a check whose
 *  answer is the tag list, and this is a footnote on it. */
export function releaseReadingFetcher(
  repo: string,
): (version: string) => Promise<ReleaseReadingResult> {
  return async (version) => {
    try {
      const res = await fetch(releaseReadingUrl(repo, version), {
        headers: { accept: "application/json", "user-agent": "collie-update-check" },
        signal: AbortSignal.timeout(RELEASE_READING_TIMEOUT_MS),
      });
      // 404 is the ordinary answer for every release before 1.8.0, and it is DEFINITE: that release
      // is published and will never grow the asset. Every other bad status is this minute's problem.
      if (res.status === 404) return "absent";
      if (!res.ok) return null;
      // SAFETY: `Response.json()` output IS a JsonValue by construction; the parser checks it.
      const parsed = parseReleaseReading((await res.json()) as JsonValue);
      // A body that is not the document is a FAILURE, not an absence: a proxy's error page and a
      // truncated download both land here, and neither is a claim about the release.
      return parsed;
    } catch {
      return null; // timeout, DNS, unparseable body — all of it reads as "ask again next time"
    }
  };
}

/**
 * Does the newest release change the link, and from what to what?
 *
 * Three ways to be null, and they are all "nothing to say to this operator": no crew (a solo install
 * has no link), no reading (the release published none, or it could not be read), and the same number
 * on both ends (an update that changes nothing about the wire).
 */
export function linkChangeOf(a: {
  mode: CrewMode;
  own: number;
  reading: ReleaseReading | null;
}): UpdateLinkChange | null {
  if (a.mode === "solo") return null;
  if (a.reading === null) return null;
  if (a.reading.crewProtocol === a.own) return null;
  return { from: a.own, to: a.reading.crewProtocol };
}

/** The one sentence the notice adds, in the bridge's own English — the push has no locale to read
 *  (the phone's surfaces take theirs from `updateRibbon.linkChange`). */
export const LINK_CHANGE_SENTENCE = "Changes the crew link. Update the lead first, members follow.";

// ── The per-release integrity manifest (M14/01 §2.1) ─────────────────────────
// One document per release, attached to the GitHub Release and copied into every tarball as
// `RELEASE.json`. It carries NO URLs: every download URL is constructed from (repo, version, name),
// so a manifest can never redirect a download to another host. The trust boundary stays "which
// repo", which is exactly what COLLIE_UPDATE_REPO names.

/** The schema this build understands. An unknown one aborts loudly — never "try anyway". */
export const MANIFEST_SCHEMA_VERSION = 1;

export interface ReleaseArtifact {
  /** The release asset's filename, e.g. `collie-1.1.0-linux-x64.tar.gz`. */
  name: string;
  /** The canonical platform id (`linux-x64`, `macos-arm64`) — see `cli/update.ts`'s `platformId`. */
  platform: string;
  sha256: string;
  /** Byte length, cross-checked against the download. Null when the manifest omits it. */
  size: number | null;
  /** The single top-level directory inside the tarball — asserted after extraction. */
  payloadRoot: string;
}

export interface ReleaseManifest {
  schemaVersion: number;
  version: string;
  tag: string;
  artifacts: ReleaseArtifact[];
}

export type ManifestVerdict =
  | { ok: true; manifest: ReleaseManifest }
  /** Readable JSON, wrong shape — a truncated or foreign document. */
  | { ok: false; reason: "unreadable" }
  /** A schema this build does not understand. `schemaVersion` is reported so the message can say so. */
  | { ok: false; reason: "schema"; schemaVersion: number };

/** The release manifest, parsed and schema-gated. Unknown FIELDS are ignored — additive is free;
 *  a `schemaVersion` we do not know is not. */
export function parseReleaseManifest(data: JsonValue): ManifestVerdict {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "unreadable" };
  const schema = data.schemaVersion;
  if (typeof schema !== "number") return { ok: false, reason: "unreadable" };
  if (schema !== MANIFEST_SCHEMA_VERSION) return { ok: false, reason: "schema", schemaVersion: schema };
  const { version, tag, artifacts } = data;
  if (typeof version !== "string" || typeof tag !== "string" || !Array.isArray(artifacts)) {
    return { ok: false, reason: "unreadable" };
  }
  const parsed = artifacts.flatMap((a) => {
    if (a === null || typeof a !== "object" || Array.isArray(a)) return [];
    if (typeof a.name !== "string" || typeof a.platform !== "string" || typeof a.sha256 !== "string") return [];
    if (typeof a.payloadRoot !== "string") return [];
    return [
      {
        name: a.name,
        platform: a.platform,
        sha256: a.sha256,
        size: typeof a.size === "number" ? a.size : null,
        payloadRoot: a.payloadRoot,
      },
    ];
  });
  return { ok: true, manifest: { schemaVersion: schema, version, tag, artifacts: parsed } };
}

// ── Persistence (edge-trigger de-dupe across restarts) ────────────────────────

/** Records the last release we pushed a notification for, so the periodic re-check doesn't re-nag the
 *  same version. Its own tiny store (NOT piggybacked on push-subscriptions.json), owner-only. */
export class UpdateStateStore {
  private lastVersion: string | null = null;
  private pushedAt: string | null = null;
  private dismissed: string | null = null;
  private dismissedCrew: string | null = null;
  private readonly file: string;

  constructor(private readonly cfg: Config) {
    this.file = join(cfg.stateDir, "update-state.json");
  }

  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; both fields are checked
      // before they are believed.
      const raw = (await Bun.file(this.file).json()) as JsonValue;
      const rec = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
      const last = rec === null ? undefined : rec.lastNotified;
      const pushed = rec === null ? undefined : rec.lastPushedAt;
      const closed = rec === null ? undefined : rec.dismissedVersion;
      const closedCrew = rec === null ? undefined : rec.dismissedCrewVersion;
      this.lastVersion = typeof last === "string" ? last : null;
      // A record written before M17/08 carries neither dismissal. Both read as "nothing dismissed",
      // which is the band's own default — an operator who closed the band on an older build simply
      // sees it once more.
      this.dismissed = typeof closed === "string" ? closed : null;
      this.dismissedCrew = typeof closedCrew === "string" ? closedCrew : null;
      // A LEGACY record carries no timestamp. It reads as "no push yet" — the window opens at once
      // rather than crashing the monitor or pinning it shut for a day.
      this.pushedAt = typeof pushed === "string" ? pushed : null;
    } catch {
      /* none saved yet */
    }
  }

  lastNotified(): string | null {
    return this.lastVersion;
  }

  /** When the last update push went out, ISO-8601, or null when none ever did. */
  lastPushedAt(): string | null {
    return this.pushedAt;
  }

  /** The release whose OFFER the operator closed, or null when none was. */
  dismissedVersion(): string | null {
    return this.dismissed;
  }

  /** The version whose quiet CREW notice the operator closed, or null. A different decision from
   *  the one above, and so a different field — see {@link DismissScope}. */
  dismissedCrewVersion(): string | null {
    return this.dismissedCrew;
  }

  async setLastNotified(version: string, pushedAt: string): Promise<void> {
    this.lastVersion = version;
    this.pushedAt = pushedAt;
    await this.write();
  }

  /**
   * Remember the version whose band the operator closed, in the scope they closed.
   *
   * It lives HERE, beside `lastNotified`, rather than in a browser: a dismissal is a decision about
   * this machine's update, and a decision kept per browser leaves the band up on the phone after it
   * was closed on the laptop (M17/08).
   *
   * `notified` folds the digest snooze into the SAME write. Two writes can be interrupted between
   * them and leave half a decision on disk: a band closed with a push still armed for the version
   * just declined, or the reverse.
   */
  async setDismissed(
    scope: DismissScope,
    version: string,
    notified?: { version: string; pushedAt: string },
  ): Promise<void> {
    if (scope === "offer") this.dismissed = version;
    else this.dismissedCrew = version;
    if (notified !== undefined) {
      this.lastVersion = notified.version;
      this.pushedAt = notified.pushedAt;
    }
    await this.write();
  }

  /** One record, one atomic write (tmp + rename), matching Push/NotifyPrefs/Snooze — a crash
   *  mid-write can't leave a corrupt file that would re-nag (or worse) on the next load. */
  private async write(): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const body = {
      lastNotified: this.lastVersion,
      lastPushedAt: this.pushedAt,
      dismissedVersion: this.dismissed,
      dismissedCrewVersion: this.dismissedCrew,
    };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/**
 * The command that restarts THIS Collie, spelled for the install kind — the one place it is spelled.
 *
 * TWO spellings, and the split is Herdr-managed against everything else (M14/01 §5.3):
 *   • `detached-checkout` is Herdr-managed, and Herdr resolves the plugin's checkout, so its action
 *     runs from any directory where `bin/collie` would not.
 *   • Everything else — a linked clone, a binary install, an unknown layout and a PACKAGED install —
 *     takes the `collie` verb, which drives the `systemd --user` unit and works anywhere the CLI is
 *     on PATH.
 *
 * **A packaged install is not a system unit**, which is the mistake worth naming here because it is
 * the obvious guess. Our package ships NO unit file: `collie start` writes the operator's own
 * `~/.config/systemd/user` unit and drives it with `systemctl --user`
 * (`packaging/aur/PKGBUILD`). So `sudo systemctl restart collie` names a unit that does not exist,
 * and asks for a password to do it. Only UPDATING is someone else's on a packaged install (ADR
 * 0035); restarting is still the operator's own, exactly as `update-banner.tsx` already had it.
 *
 * Pure and exported: the phone renders what the host answered, so this is the only derivation.
 */
export function restartCommandFor(kind: UpdateStatus["installKind"], instance: string | null): string {
  return kind === "detached-checkout" ? herdrActionCommand("restart", instance) : "collie restart";
}

// ── The monitor ───────────────────────────────────────────────────────────────

/**
 * WHICH band was closed. Two decisions, never one key.
 *
 * `offer` is "a release is available on this machine". `crew` is "another machine is standing
 * behind, and a package manager owns it". They are about different machines and they are put down
 * separately: hiding a peer's quiet notice must not also hide this host's own offer, even when the
 * two name the same version.
 */
export type DismissScope = "offer" | "crew";

/** Persistence seam — just what the monitor needs from {@link UpdateStateStore}. */
export interface UpdateStore {
  lastNotified(): string | null;
  /** ISO-8601 stamp of the last push, or null — the digest window is measured from it. */
  lastPushedAt(): string | null;
  setLastNotified(version: string, pushedAt: string): Promise<void>;
  /** The release whose OFFER was closed, or null. Reported on the snapshot, so the decision holds
   *  on every screen rather than in the browser that made it. */
  dismissedVersion(): string | null;
  /** The version whose quiet CREW notice was closed, or null. */
  dismissedCrewVersion(): string | null;
  /** Record a dismissal, folding the digest snooze into the same write when one is asked for. */
  setDismissed(
    scope: DismissScope,
    version: string,
    notified?: { version: string; pushedAt: string },
  ): Promise<void>;
}

export interface UpdateMonitorDeps {
  /** The `owner/name` repo the release check + release links point at (default `AltanS/collie`). */
  repo: string;
  /** The running plugin version (captured at process start — never re-read from disk, or a post-pull
   *  package.json would mask the very update we're detecting). */
  current: string;
  /** The bridge source stamp captured at process start (see {@link bridgeStampSync}). */
  startupStamp: string;
  /** Fetch the upstream release tags (throws on failure — the monitor is fail-soft). One fetcher and
   *  one JSON parser, shared with `collie update`'s binary path; this consumer maps to names at its
   *  own edge and its pure resolver chain is untouched. */
  fetchTags: () => Promise<readonly ApiTag[]>;
  /** Recompute the on-disk bridge source stamp for the staleness check. */
  bridgeStamp: () => string;
  /** How this Collie is installed, probed once at startup — it cannot change under a running process
   *  (an update restarts the service), so the monitor just reports it. */
  installKind: UpdateStatus["installKind"];
  /** `COLLIE_INSTANCE`, or `null` for the host's first Collie — it names the plugin id the restart
   *  command prints. Injected, not read here: the monitor resolves nothing from the environment. */
  instance: string | null;
  /**
   * The version this process was running when it started, read the way `collie version` reads it.
   *
   * Captured ONCE, at boot, beside the install kind — for the same reason the kind is: it cannot
   * change under a running process. `liveVersion` re-reads the same files, and a difference between
   * the two is the whole of the restart-needed signal. No new state file and no new mechanism.
   */
  bootVersion: string;
  /** The same reading, taken NOW. Throttled by the monitor, never called per request unthrottled. */
  liveVersion: () => string;
  /**
   * Has the binary this process is EXECUTING been replaced on disk (`bridge/exe-replaced.ts`)?
   *
   * The half {@link liveVersion} cannot see. A package manager that rebuilds the SAME version — a
   * new Arch pkgrel, say — replaces `bin/collie` under the live service and moves no version string
   * at all, so the version comparison stays quiet while the process serves the old code. The
   * executable is the only witness to that, and it is one readlink plus two `stat`s.
   *
   * Injected, and throttled by the monitor exactly as {@link liveVersion} is. Answering `false` is
   * what an install this cannot be asked about looks like — the version comparison then decides
   * alone, as it did before.
   */
  exeReplaced: () => boolean;
  /** The package manager's upgrade command for this root, or null when there is none to name.
   *  Resolved once at startup beside the kind, for the reason the kind is: it cannot change under a
   *  running process, and the phone must never derive it. */
  packageCommand: string | null;
  store: UpdateStore;
  now: () => number;
  /** Whether update pushes are enabled (the `updates` notify pref — the user's off-switch). */
  updatesEnabled: () => boolean;
  /** Fire the update-available push for the digest — every version folded into it, oldest first.
   *  Never empty; the last element is the newest available version. The link change rides along so
   *  the body can name it (M27/06), and so does the urgent record, whose sentence opens the body
   *  (ADR 0046); null is the ordinary release for both. */
  notify: (
    versions: string[],
    linkChange: UpdateLinkChange | null,
    urgent: UpdateUrgentReading | null,
  ) => void;
  /** This build's own crew wire version (`CREW_PROTOCOL_VERSION`). Injected rather than imported so
   *  the monitor resolves nothing for itself and a test can name both ends of a difference. */
  crewProtocol: number;
  /**
   * This install's crew mode, read at each check. A `solo` install has no link, so it is never told
   * that one changed — the mode is resolved at boot and cannot move under a running process, but it
   * is a function so the monitor holds no copy of a fact it does not own.
   */
  crewMode: () => CrewMode;
  /**
   * Read one release's own `collie-release.json` (M27/06). Never throws, and answers one of three
   * things — see {@link ReleaseReadingResult}: the reading, `"absent"` for a release that published
   * none (every release before 1.8.0), and null for a read that failed.
   *
   * Called for the newest release, and for each of the newest few in the delta when the monitor asks
   * whether any of them is urgent (ADR 0046). The monitor remembers a reading and an absence for its
   * lifetime, so a published release is asked about once; a failure is asked again next check.
   */
  fetchReleaseReading: (version: string) => Promise<ReleaseReadingResult>;
  /**
   * The detached updater's run record, read from disk (M15/04). Injected rather than read here so
   * the monitor stays a pure poller over seams — and read PER CALL, never cached, because the file
   * is written by another process and the whole point is to notice its transitions.
   *
   * **The bridge reads it at startup through this.** A bridge coming up mid-update must resume
   * reporting `verifying` or `rolled-back`, not come up with nothing to say: the operator taps
   * update, the app goes blank, and it comes back claiming there was no update.
   */
  runState: () => UpdateRun | null;
}

export class UpdateMonitor {
  private latest: string | null = null;
  private newerVersions: string[] = [];
  private majorAvailable: string | null = null;
  private checkedAt: number | null = null;
  // CACHED WITH THE READING, never in a store of its own (M27/06): it is a fact about the release
  // the last check found, so it lives and dies with `latest`.
  private linkChange: UpdateLinkChange | null = null;
  // THE NEWEST URGENT RELEASE IN THE DELTA, or null (ADR 0046). Cached beside `linkChange` and for
  // the same reason: it is a fact about the releases the last check found.
  private urgent: UpdateUrgentReading | null = null;
  // One reading per version, for this process's lifetime. A published release's sidecar never
  // changes, so a second read of the same version would spend a request to learn what we know. Only
  // an ANSWER is kept: a failed or absent read stays out, so tomorrow's check asks again rather than
  // remembering a timeout forever.
  private readonly readings = new Map<string, ReleaseReading | "absent">();
  // The answers of THIS check, failures included, cleared when the next one starts. The link-change
  // read and the urgency sweep both ask about the newest release, and a failed read is not kept in
  // the map above — without this, one check would spend two requests on one version to learn the
  // same "could not read it" twice.
  private checkReadings = new Map<string, ReleaseReading | null>();
  private staleAt = Number.NEGATIVE_INFINITY;
  private staleValue = false;
  private swappedAt = Number.NEGATIVE_INFINITY;
  private swappedValue = false;
  private exeAt = Number.NEGATIVE_INFINITY;
  private exeValue = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: UpdateMonitorDeps) {}

  /**
   * Trigger a release-check cycle. De-dupes concurrent callers (the periodic timer and a manual
   * "check now" landing together await the SAME fetch, never two), so the on-demand endpoint can't
   * hammer the API. Always fail-soft — see {@link runCheck}.
   */
  checkRelease(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * One release-check cycle: fetch tags, recompute `latest`, and fire an at-most-once push for a new
   * version. Fail-soft — a fetch error keeps the previous `latest`/`checkedAt`. The push is gated on
   * the `updates` pref and de-duped against `lastNotified`; the version is persisted BEFORE the send
   * so a crash mid-send leaves an under-delivered nag rather than a duplicate.
   */
  private async runCheck(): Promise<void> {
    let tags: string[];
    try {
      tags = (await this.deps.fetchTags()).map((t) => t.name);
    } catch {
      return; // network / timeout — keep prior state, retry next tick
    }
    // Two answers, never one (ADR 0020): the newest tag the operator can take on a routine `update` —
    // which stays inside the running major, and which includes that major's prereleases IFF this
    // install is itself on one — and, separately, whether a MAJOR is out at all. The banner and the
    // verb share `latestUpdateInMajor`, so the verb can never land where the banner would not have
    // announced. A version we can't parse a major out of (`unknown`) falls back to the old "newest of
    // anything", because an install that can't name its major can't be gated on it either.
    const major = majorOf(this.deps.current);
    this.latest =
      major === null ? latestReleaseTag(tags) : latestUpdateInMajor(tags, major, this.deps.current);
    this.majorAvailable = major === null ? null : latestReleaseAboveMajor(tags, major);
    // The whole list, not just its top: a digest has to be able to NAME the releases it folded.
    this.newerVersions = updatesNewerThan(tags, this.deps.current);
    // A fresh page of "what did this check learn", so a read that failed last time is tried again.
    this.checkReadings = new Map();
    this.checkedAt = this.deps.now();
    // ONE SMALL GET INSIDE THIS CHECK'S BUDGET (M27/06), and only when there is a release to ask
    // about. It cannot fail the check: the fetcher answers null for everything that is not the
    // document, and null reads as "no change".
    this.linkChange =
      this.latest === null
        ? null
        : linkChangeOf({
            mode: this.deps.crewMode(),
            own: this.deps.crewProtocol,
            reading: await this.reading(this.latest),
          });
    // URGENCY IS A PROPERTY OF THE WHOLE DELTA, NOT OF ITS TOP (ADR 0046). An urgent 1.9.1 with a
    // quiet 1.9.2 above it is still an urgent train, so every version in the delta is asked — the
    // newest URGENT_READING_CAP of them, through the same cache, and all at once so the wait is one
    // timeout rather than ten. It cannot fail the check: every read answers null or a reading.
    this.urgent = await this.urgencyOf(this.newerVersions);

    const { current, store } = this.deps;
    // The snapshot above is already updated — suppressing a push must never suppress state.
    if (!this.deps.updatesEnabled()) return;
    const verdict = shouldNotify({
      current,
      latest: this.latest,
      newerVersions: this.newerVersions,
      lastNotified: store.lastNotified(),
      lastPushedAt: store.lastPushedAt(),
      now: new Date(this.deps.now()),
      urgent: this.urgent ?? undefined,
    });
    if (!verdict.send) return;
    await store.setLastNotified(verdict.versions[verdict.versions.length - 1] ?? current, this.nowIso());
    this.deps.notify(verdict.versions, this.linkChange, this.urgent);
  }

  /**
   * One release's `collie-release.json`, memoised. Never throws. A reading and a definite absence are
   * both kept; a FAILED read is kept out of the map, so a network blip is never remembered as "this
   * release says nothing" and the next check asks again.
   */
  private async reading(version: string): Promise<ReleaseReading | null> {
    const held = this.readings.get(version);
    if (held !== undefined) return held === "absent" ? null : held;
    const thisCheck = this.checkReadings.get(version);
    if (thisCheck !== undefined) return thisCheck;
    const fetched = await this.deps.fetchReleaseReading(version);
    this.checkReadings.set(version, fetched === "absent" ? null : fetched);
    // A reading and an ABSENCE are both facts about a published release, and a published release does
    // not change. A failure is a fact about this minute, so it is not remembered.
    if (fetched !== null) this.readings.set(version, fetched);
    return fetched === "absent" ? null : fetched;
  }

  /** The newest urgent release among the newest {@link URGENT_READING_CAP} of `versions`, or null. */
  private async urgencyOf(versions: readonly string[]): Promise<UpdateUrgentReading | null> {
    const asked = versions.slice(-URGENT_READING_CAP);
    if (asked.length === 0) return null;
    const readings = await Promise.all(
      asked.map(async (version) => ({ version, reading: await this.reading(version) })),
    );
    return newestUrgent(readings);
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /**
   * "Remind me next digest" — the dismiss seam the PWA can call on the update card. It closes the
   * window and marks the current `latest` as announced, so the next push waits for BOTH a newer
   * release and a fresh window. It is not a mute: `updatesEnabled()` remains the only off switch.
   */
  async snoozeDigest(): Promise<void> {
    if (this.latest === null) return;
    await this.deps.store.setLastNotified(this.latest, this.nowIso());
  }

  /**
   * The band was closed, for `version`, in the scope it was closed in.
   *
   * Closing the OFFER for the release this host is actually being offered also snoozes the digest,
   * in the SAME write: being pushed tomorrow morning about a version just declined is the app
   * arguing with a decision the operator already made. Two conditions gate that, and both matter:
   *
   *   • Scope. A quiet CREW notice is about another machine and the push is about this one, so
   *     hiding it must never silence a release this host was never told about.
   *   • The version. An offer for anything other than the release upstream currently names is not
   *     the release the digest would push, and moving `lastNotified` there would either swallow the
   *     current version or re-announce an old one.
   *
   * A NEWER release is a different version and raises the band again — this is not a mute, and it
   * carries no clock of its own (the digest owns the clock).
   */
  async dismiss(version: string, scope: DismissScope = "offer"): Promise<void> {
    const snoozes = scope === "offer" && this.latest !== null && version === this.latest;
    await this.deps.store.setDismissed(
      scope,
      version,
      snoozes ? { version, pushedAt: this.nowIso() } : undefined,
    );
  }

  /** Recompute (throttled) whether the running process is behind the on-disk bridge source. */
  private bridgeStale(): boolean {
    const now = this.deps.now();
    if (now - this.staleAt < STALE_TTL_MS) return this.staleValue;
    this.staleValue = this.deps.bridgeStamp() !== this.deps.startupStamp;
    this.staleAt = now;
    return this.staleValue;
  }

  /**
   * Have the files on disk stopped naming the version this process is running?
   *
   * Throttled exactly as {@link bridgeStale} is, and for the same reason: this is two small file
   * reads and the snapshot is polled. Latching is deliberately NOT done — a package manager that
   * rolls its change back leaves a process whose code matches disk again, and a latched flag would
   * keep asking for a restart nobody needs.
   */
  private versionSwapped(): boolean {
    const now = this.deps.now();
    if (now - this.swappedAt < STALE_TTL_MS) return this.swappedValue;
    this.swappedValue = this.deps.liveVersion() !== this.deps.bootVersion;
    this.swappedAt = now;
    return this.swappedValue;
  }

  /**
   * Has the executable moved under this process? Throttled as {@link versionSwapped} is, and not
   * latched for the same reason: a package manager that rolls its change back leaves a process
   * running the file that is on disk again.
   */
  private exeSwapped(): boolean {
    const now = this.deps.now();
    if (now - this.exeAt < STALE_TTL_MS) return this.exeValue;
    this.exeValue = this.deps.exeReplaced();
    this.exeAt = now;
    return this.exeValue;
  }

  /** The snapshot-facing status. Cheap: `latest` is cached from the last check, `bridgeStale` throttled. */
  status(): UpdateStatus {
    const { current } = this.deps;
    const run = this.deps.runState();
    const status: UpdateStatus = {
      current,
      latest: this.latest,
      latestUrl: this.latest ? githubReleaseUrl(this.deps.repo, this.latest) : null,
      releaseAvailable: this.latest !== null && compareSemver(this.latest, current) > 0,
      majorAvailable: this.majorAvailable,
      majorUrl:
        this.majorAvailable === null
          ? null
          : githubReleaseUrl(this.deps.repo, this.majorAvailable),
      installKind: this.deps.installKind,
      dismissedVersion: this.deps.store.dismissedVersion(),
      dismissedCrewVersion: this.deps.store.dismissedCrewVersion(),
      bridgeStale: this.bridgeStale(),
      // Two witnesses to one fact, and either is enough: the version files stopped naming what this
      // process runs, or the executable itself was replaced. The second catches the rebuild of an
      // identical version, which the first cannot see.
      restartNeeded: this.versionSwapped() || this.exeSwapped(),
      checkedAt: this.checkedAt,
      // The whole list, oldest first — the card names what a single update folds in (M15/05). Empty
      // until the first successful check, which reads as "nothing to name", the same as up to date.
      newerVersions: this.newerVersions,
    };
    // Assigned, never conditionally spread: an install that has never updated through the runner
    // must carry NO `run` key rather than one whose value is `undefined`. The same for the package
    // command, which most installs have none of.
    if (run !== null) status.run = run;
    // The link change (M27/06), on the same rule: absent when there is nothing to say, which is
    // every solo install, every ordinary release and every check that has not run yet.
    if (this.linkChange !== null) status.linkChange = this.linkChange;
    // The urgent marker (ADR 0046), on the same rule: absent when no release in the delta asked for
    // the daily cadence, which is every ordinary release and every check that has not run yet.
    if (this.urgent !== null) status.urgent = this.urgent;
    if (this.deps.packageCommand !== null) status.packageCommand = this.deps.packageCommand;
    if (status.restartNeeded) status.restartCommand = restartCommandFor(this.deps.installKind, this.deps.instance);
    return status;
  }
}
