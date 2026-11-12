import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../../web/src/lib/json.ts";
import type { WireRepoFacts } from "../../web/src/lib/tricks/schema.ts";
import { tricksStateDir } from "./paths.ts";

// A TRICK'S REPOSITORY FACTS: its stars and the date of its last commit, for the About sheet. The first
// outbound read of the bridge for tricks, so it is narrow on purpose.
//
// WHAT IS READ. Exactly one request per repository, `GET https://api.github.com/repos/{owner}/{repo}`, and of
// its answer only `stargazers_count` (a whole number, 0 or more) and `pushed_at` (an ISO instant in UTC). The
// origin is fixed here; `owner` and `repo` come from a trick's stored source URL only when its host is exactly
// `github.com` and both names pass GitHub's own character rules and length caps ({@link githubRepoOf}). No
// token, no cookie, no credential: a plain user agent that names the feature and nothing about the person or
// the machine. A redirect is never followed (`redirect: "manual"`, and anything but a 200 is a failed read),
// the read gives up after {@link REPO_FACTS_TIMEOUT_MS}, and a body past {@link REPO_FACTS_BYTES_MAX} is
// refused while it streams. No other field of the answer is kept or passed on.
//
// WHEN IT IS READ. Lazily: only when a phone asks for the tricks list (`GET /api/tricks`) or the official list
// (`GET /api/tricks/official`), and only for an entry that is stale. Never on a timer. The answer never waits:
// it carries what the cache holds, the read runs in the background, and the next answer shows it.
//
// WHAT STOPS A LOOP. GitHub allows 60 unauthenticated requests per hour per IP address, shared by everything on
// that address (the update check's tags read is one more). One read here costs one of the 60. Three things keep
// the count small, whatever a phone or a bug does:
//   1. the cache: a good answer is kept {@link REPO_FACTS_GOOD_MS} (6 h), a failed read {@link REPO_FACTS_BAD_MS}
//      (1 h, the negative cache), per repository, in memory and in `<stateDir>/tricks/repo-facts.json`, so a
//      restart does not read again;
//   2. single flight: one read per repository at a time, however many lists ask;
//   3. a hard cap for the whole bridge: at most {@link REPO_FACTS_READS_PER_HOUR} (20) reads in any rolling
//      hour, kept in the same file. Above it the bridge serves the cache, or nothing, and reads nothing.
// So one repository costs at most 4 reads a day while it answers and 24 while it fails, and the bridge at most
// 20 an hour, a third of the address's limit.
//
// NO SWITCH. There is no setting for it. The install ping's off switches (`DO_NOT_TRACK`, `COLLIE_TELEMETRY`)
// gate that ping only; this read sends nothing about the install, so it does not read them. A firewall rule
// for `api.github.com` stops it, and the About sheet then shows no facts.

/** The one origin a read goes to. */
export const REPO_FACTS_ORIGIN = "https://api.github.com";
/** The fixed user agent: it names the feature and nothing about the person, the build or the machine. */
export const REPO_FACTS_USER_AGENT = "collie-trick-facts";
/** A read that has not answered by then is a failed read. */
export const REPO_FACTS_TIMEOUT_MS = 5000;
/** The most bytes of an answer read. GitHub's repository answer is a few KiB. */
export const REPO_FACTS_BYTES_MAX = 64 * 1024;
/** How long a good answer is kept before the next ask reads again. */
export const REPO_FACTS_GOOD_MS = 6 * 60 * 60 * 1000;
/** How long a failed read is kept: no read of that repository again before it ends. */
export const REPO_FACTS_BAD_MS = 60 * 60 * 1000;
/** How long a good answer is still shown while a new read is due or failed to start. Past it, nothing. */
export const REPO_FACTS_SHOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The most reads the whole bridge starts in any rolling hour. */
export const REPO_FACTS_READS_PER_HOUR = 20;
/** The most repositories the file keeps, the newest. */
export const REPO_FACTS_KEPT_MAX = 64;
/** The file in `<stateDir>/tricks/`. */
export const REPO_FACTS_FILE = "repo-facts.json";

const HOUR_MS = 60 * 60 * 1000;
/** The file is small: past this it is not read, and the cache starts empty. */
const FILE_BYTES_MAX = 64 * 1024;

/** A repository on GitHub, as its owner and its name. */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

// GitHub's own rules: an owner is 1 to 39 letters, digits and single hyphens, neither first nor last; a
// repository name is 1 to 100 letters, digits, `.`, `_` and `-`. A name of only dots is none.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/u;

/** Whether `owner` and `repo` pass GitHub's rules, with no `..` anywhere. */
function isRepoName(owner: string, repo: string): boolean {
  return OWNER_RE.test(owner) && REPO_RE.test(repo) && !repo.includes("..") && repo !== ".";
}

/**
 * The GitHub repository a trick's source URL names, or null. Only `https://github.com/<owner>/<repo>`, with an
 * optional `.git` and an optional trailing `/`: the host exactly `github.com` (no `www.`, no port, no user, no
 * password), no query, no fragment, no other path step.
 */
export function githubRepoOf(url: string): GitHubRepo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.host !== "github.com") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  // The raw text, not the parsed path: `URL` folds `/a/./b` and `%2e%2e`, and either would hide a step.
  const raw = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/u.exec(url);
  if (raw === null) return null;
  const owner = raw[1] ?? "";
  const repo = raw[2] ?? "";
  return isRepoName(owner, repo) ? { owner, repo } : null;
}

/** The one key a repository is cached under: GitHub's names are case-blind. */
function keyOf(repo: GitHubRepo): string {
  return `${repo.owner}/${repo.repo}`.toLowerCase();
}

/** The read's address, on the fixed origin. */
export function repoFactsUrl(repo: GitHubRepo): string {
  const url = new URL(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, REPO_FACTS_ORIGIN);
  if (url.origin !== REPO_FACTS_ORIGIN) throw new Error("repo facts: the address left its origin");
  return url.toString();
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/** The two facts of a repository answer, each checked for its type, or null. Nothing else is read. */
export function factsOf(starsRaw: JsonValue | undefined, pushedRaw: JsonValue | undefined): WireRepoFacts | null {
  const stars = asJsonNumber(starsRaw);
  const pushedAt = asJsonString(pushedRaw);
  if (stars === undefined || !Number.isSafeInteger(stars) || stars < 0) return null;
  if (pushedAt === undefined || !ISO_UTC.test(pushedAt) || !Number.isFinite(Date.parse(pushedAt))) return null;
  return { stars, pushedAt };
}

/** The facts of GitHub's answer text, or null. Only `stargazers_count` and `pushed_at` are looked at. */
export function parseRepoAnswer(text: string): WireRepoFacts | null {
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined) return null;
  return factsOf(doc.stargazers_count, doc.pushed_at);
}

/** The fetch a read goes through: the global one in the bridge, a fake in a test. */
export type RepoFactsFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The body as text, or null when it is longer than `max` bytes. Stops reading at the cap. */
async function cappedText(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Bounded by the cap: each pass adds at least one byte, ends the stream, or stops past the cap.
  for (let pass = 0; pass <= max; pass += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (size > max) return null;
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

/** One read of one repository: its facts, or null for any failure. Never throws. */
export async function readRepoFacts(fetchFn: RepoFactsFetch, repo: GitHubRepo, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<WireRepoFacts | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REPO_FACTS_TIMEOUT_MS);
  try {
    const res = await fetchFn(repoFactsUrl(repo), {
      method: "GET",
      headers: { accept: "application/vnd.github+json", "user-agent": REPO_FACTS_USER_AGENT },
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    // A redirect, a rate limit, a missing repository: all a failed read. Nothing is followed.
    if (res.status !== 200 || res.redirected || res.type === "opaqueredirect") return null;
    const text = await cappedText(res, opts.maxBytes ?? REPO_FACTS_BYTES_MAX);
    return text === null ? null : parseRepoAnswer(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What the phone would show of an entry, as one string to compare: a read that changes nothing moves no rev. */
function shownWords(facts: WireRepoFacts | null): string {
  return facts === null ? "" : `${String(facts.stars)} ${facts.pushedAt}`;
}

/** One repository in the cache: when it was last read, and what came back (null: the read failed). */
interface Entry {
  at: number;
  facts: WireRepoFacts | null;
}

/** What the tricks service and the official list need: a look at the cache, and an ask for a fresh read. */
export interface RepoFactsPort {
  /** The facts the cache holds for a source URL, or undefined. Never reads. */
  facts(url: string): WireRepoFacts | undefined;
  /** A list wants these sources: a stale one is read in the background, within the cap. Never waits. */
  want(urls: Iterable<string>): void;
}

export interface RepoFactsDeps {
  stateDir: string;
  fetch: RepoFactsFetch;
  now?: () => number;
  /** Called once a read changed what the cache serves, so the lists can carry it. */
  onChange?: () => void;
  warn?: (line: string) => void;
  /** TEST SEAM: a shorter timeout and a lower byte cap. The bridge never sets them. */
  timeoutMs?: number;
  maxBytes?: number;
}

/** The cache of repository facts, in memory and in `<stateDir>/tricks/repo-facts.json`. */
export class RepoFacts implements RepoFactsPort {
  private readonly entries = new Map<string, Entry>();
  /** When each read of the last hour started, for the cap. */
  private reads: number[] = [];
  private readonly flying = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly path: string;
  private writing: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(private readonly deps: RepoFactsDeps) {
    this.now = deps.now ?? Date.now;
    this.path = join(tricksStateDir(deps.stateDir), REPO_FACTS_FILE);
    this.load();
  }

  facts(url: string): WireRepoFacts | undefined {
    const repo = githubRepoOf(url);
    if (repo === null) return undefined;
    const entry = this.entries.get(keyOf(repo));
    if (entry === undefined || entry.facts === null) return undefined;
    const age = this.now() - entry.at;
    return age >= 0 && age < REPO_FACTS_SHOW_MS ? entry.facts : undefined;
  }

  want(urls: Iterable<string>): void {
    for (const url of urls) {
      const repo = githubRepoOf(url);
      if (repo === null) continue;
      const key = keyOf(repo);
      if (this.flying.has(key) || !this.stale(key)) continue;
      if (!this.takeRead()) return;
      const read = this.read(key, repo).finally(() => this.flying.delete(key));
      this.flying.set(key, read);
    }
  }

  /** Every read in flight and the file write after it, done. For a test and a clean stop. */
  async settled(): Promise<void> {
    await Promise.all(this.flying.values());
    await this.writing;
  }

  /** Whether a repository is due a read: never read, or its answer past its time (a clock moved back counts). */
  private stale(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return true;
    const age = this.now() - entry.at;
    return age < 0 || age >= (entry.facts === null ? REPO_FACTS_BAD_MS : REPO_FACTS_GOOD_MS);
  }

  /** Take one read from the hour's budget, or say there is none left. */
  private takeRead(): boolean {
    const now = this.now();
    this.reads = this.reads.filter((at) => at <= now && now - at < HOUR_MS);
    if (this.reads.length >= REPO_FACTS_READS_PER_HOUR) return false;
    this.reads.push(now);
    return true;
  }

  private async read(key: string, repo: GitHubRepo): Promise<void> {
    const facts = await readRepoFacts(this.deps.fetch, repo, { timeoutMs: this.deps.timeoutMs, maxBytes: this.deps.maxBytes });
    const was = this.entries.get(key);
    this.entries.set(key, { at: this.now(), facts });
    this.save();
    if (shownWords(was?.facts ?? null) !== shownWords(facts)) this.deps.onChange?.();
  }

  private load(): void {
    let text: string;
    try {
      const bytes = readFileSync(this.path);
      if (bytes.byteLength > FILE_BYTES_MAX) return;
      text = new TextDecoder().decode(bytes);
    } catch {
      return;
    }
    const doc = asJsonObject(parseJson(text));
    if (doc === undefined || asJsonNumber(doc.v) !== 1) return;
    const repos = asJsonObject(doc.repos);
    for (const [key, raw] of Object.entries(repos ?? {}).slice(0, REPO_FACTS_KEPT_MAX)) {
      const slash = key.indexOf("/");
      if (slash <= 0 || !isRepoName(key.slice(0, slash), key.slice(slash + 1)) || key !== key.toLowerCase()) continue;
      const entry = asJsonObject(raw);
      const at = asJsonNumber(entry?.at);
      if (entry === undefined || at === undefined || !Number.isSafeInteger(at) || at < 0) continue;
      const stored = asJsonObject(entry.facts);
      const facts = entry.facts === null ? null : factsOf(stored?.stars, stored?.pushedAt);
      if (facts === null && entry.facts !== null) continue;
      this.entries.set(key, { at, facts });
    }
    const reads = Array.isArray(doc.reads) ? doc.reads : [];
    for (const at of reads) {
      const n = asJsonNumber(at);
      if (n !== undefined && Number.isSafeInteger(n) && this.reads.length < REPO_FACTS_READS_PER_HOUR) this.reads.push(n);
    }
  }

  /** Write the file whole, through a temp sibling, owner only. One write at a time, in order. */
  private save(): void {
    const newest = [...this.entries.entries()].toSorted((a, b) => b[1].at - a[1].at).slice(0, REPO_FACTS_KEPT_MAX);
    const repos: Record<string, Entry> = {};
    for (const [key, entry] of newest) repos[key] = entry;
    const text = `${JSON.stringify({ v: 1, repos, reads: this.reads })}\n`;
    this.writing = this.writing.then(() => this.write(text));
  }

  private async write(text: string): Promise<void> {
    const dir = tricksStateDir(this.deps.stateDir);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.path);
      await chmod(dir, 0o700).catch(() => {});
    } catch (err) {
      if (this.warned) return;
      this.warned = true;
      this.deps.warn?.(`repo facts: could not write ${REPO_FACTS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
