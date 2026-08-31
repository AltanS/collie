import type { JsonValue } from "./json.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { UpdateStatus } from "./types.ts";

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
// bridgeStale is read on every snapshot poll; recompute the on-disk stamp at most this often so a
// busy poll loop doesn't stat the source tree dozens of times a second (the value barely changes).
const STALE_TTL_MS = 5_000;

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

/** Whether a NEW-version push should fire: a strictly-newer release we haven't already notified for.
 *  Comparing against `current` (not the raw `latest`) means a restart after updating self-heals — the
 *  new `current` catches up and the condition falls false with no state reset. */
export function shouldNotify(a: {
  current: string;
  latest: string | null;
  lastNotified: string | null;
}): boolean {
  if (!a.latest) return false;
  if (compareSemver(a.latest, a.current) <= 0) return false;
  return a.latest !== a.lastNotified;
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

/** Anonymous HTTPS fetch of a GitHub repo's tags. Throws on a non-OK response or timeout so the
 *  caller keeps its previous result and retries next tick. */
export function githubTagsFetcher(repo: string): () => Promise<ApiTag[]> {
  const url = githubTagsUrl(repo);
  return async () => {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "collie-update-check" },
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`github tags: HTTP ${res.status}`);
    // SAFETY: `Response.json()` output IS a JsonValue by construction; every field below is checked
    // before it is kept.
    return parseTagsResponse((await res.json()) as JsonValue);
  };
}

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
  private readonly file: string;

  constructor(private readonly cfg: Config) {
    this.file = join(cfg.stateDir, "update-state.json");
  }

  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; `lastNotified` is
      // checked before it is believed.
      const raw = (await Bun.file(this.file).json()) as JsonValue;
      const last =
        raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw.lastNotified : undefined;
      this.lastVersion = typeof last === "string" ? last : null;
    } catch {
      /* none saved yet */
    }
  }

  lastNotified(): string | null {
    return this.lastVersion;
  }

  async setLastNotified(version: string): Promise<void> {
    this.lastVersion = version;
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    // Atomic write (tmp + rename), matching Push/NotifyPrefs/Snooze — a crash mid-write can't leave a
    // corrupt file that would re-nag (or worse) on the next load.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ lastNotified: version }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

// ── The monitor ───────────────────────────────────────────────────────────────

/** Persistence seam — just what the monitor needs from {@link UpdateStateStore}. */
export interface UpdateStore {
  lastNotified(): string | null;
  setLastNotified(version: string): Promise<void>;
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
  store: UpdateStore;
  now: () => number;
  /** Whether update pushes are enabled (the `updates` notify pref — the user's off-switch). */
  updatesEnabled: () => boolean;
  /** Fire the update-available push for `latest`. */
  notify: (latest: string) => void;
}

export class UpdateMonitor {
  private latest: string | null = null;
  private majorAvailable: string | null = null;
  private checkedAt: number | null = null;
  private staleAt = Number.NEGATIVE_INFINITY;
  private staleValue = false;
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
    this.checkedAt = this.deps.now();

    const { current, store } = this.deps;
    if (
      this.latest &&
      this.deps.updatesEnabled() &&
      shouldNotify({ current, latest: this.latest, lastNotified: store.lastNotified() })
    ) {
      await store.setLastNotified(this.latest);
      this.deps.notify(this.latest);
    }
  }

  /** Recompute (throttled) whether the running process is behind the on-disk bridge source. */
  private bridgeStale(): boolean {
    const now = this.deps.now();
    if (now - this.staleAt < STALE_TTL_MS) return this.staleValue;
    this.staleValue = this.deps.bridgeStamp() !== this.deps.startupStamp;
    this.staleAt = now;
    return this.staleValue;
  }

  /** The snapshot-facing status. Cheap: `latest` is cached from the last check, `bridgeStale` throttled. */
  status(): UpdateStatus {
    const { current } = this.deps;
    return {
      current,
      latest: this.latest,
      latestUrl: this.latest ? githubReleaseUrl(this.deps.repo, this.latest) : null,
      releaseAvailable: this.latest !== null && compareSemver(this.latest, current) > 0,
      majorAvailable: this.majorAvailable,
      majorUrl:
        this.majorAvailable === null
          ? null
          : githubReleaseUrl(this.deps.repo, this.majorAvailable),
      bridgeStale: this.bridgeStale(),
      checkedAt: this.checkedAt,
    };
  }
}
