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
// The upstream tag check is bounded — a hung request must never wedge the monitor's timer.
const TAGS_TIMEOUT_MS = 10_000;
// bridgeStale is read on every snapshot poll; recompute the on-disk stamp at most this often so a
// busy poll loop doesn't stat the source tree dozens of times a second (the value barely changes).
const STALE_TTL_MS = 5_000;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** Parse a strict `vX.Y.Z` tag into its numeric parts, or null (prereleases like `v1.0.0-rc` and any
 *  non-release ref are rejected by the anchor). Remote ref names are untrusted input. */
export function parseSemverTag(tag: string): [number, number, number] | null {
  const m = SEMVER_TAG.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two dotted `X.Y.Z` versions (no leading `v`). Returns -1 / 0 / 1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
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
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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

/** Anonymous HTTPS fetch of a GitHub repo's tags → their names (`["v0.11.0", …]`). Throws on a
 *  non-OK response or timeout so the caller keeps its previous result and retries next tick. */
export function githubTagsFetcher(repo: string): () => Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  return async () => {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "collie-update-check" },
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`github tags: HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((t) => (typeof (t as { name?: unknown }).name === "string" ? (t as { name: string }).name : ""))
      .filter(Boolean);
  };
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
      const raw = (await Bun.file(this.file).json()) as { lastNotified?: unknown };
      this.lastVersion = typeof raw.lastNotified === "string" ? raw.lastNotified : null;
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
  /** Fetch the upstream release tag names (throws on failure — the monitor is fail-soft). */
  fetchTags: () => Promise<string[]>;
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
      tags = await this.deps.fetchTags();
    } catch {
      return; // network / timeout — keep prior state, retry next tick
    }
    this.latest = latestReleaseTag(tags);
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
      bridgeStale: this.bridgeStale(),
      checkedAt: this.checkedAt,
    };
  }
}
