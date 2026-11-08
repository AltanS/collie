import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import { readNewerEntry, readRegistryEntry, type RegistryEntry } from "../../web/src/lib/theme/registry.ts";

// ── THE COMMUNITY THEME REGISTRY ON THE HOST (M59 spec 06) ──────────────────────────────────
//
// The website's daily sweep writes one file of shared themes, each already checked with Collie's
// own parser. This store fetches that file on ONE act only: a tap on Refresh in the Theme card
// (`POST /api/themes/registry`, bridge/themes/registry-http.ts). A boot, a timer, a status read and
// an open of Settings fetch nothing. The page never fetches it: `connect-src 'self'` (ADR 0106).
//
//   • The address is {@link THEME_REGISTRY_URL}, a constant. No header or request body can change
//     it. The one exception is the operator's `COLLIE_THEME_REGISTRY_URL`, read once at boot, for a
//     test against a staged copy of the site ({@link resolveRegistryAddress}). A redirect is followed
//     only while it stays on the origin of the address in use, at most three times.
//   • A copy written for one address is never listed under another: a copy from an override names
//     its address in the file, and a copy without one belongs to the default address.
//   • One fetch in flight; a second tap joins it. The whole fetch, body included, has
//     {@link REGISTRY_TIMEOUT_MS}. A declared size over {@link REGISTRY_CAP_BYTES} is refused before
//     the body, and the body is counted against the cap as it arrives.
//   • The document must say `"v": 1` and hold at most {@link REGISTRY_MAX_ENTRIES} entries, else it
//     is refused whole. Each entry goes through `readRegistryEntry` (web/src/lib/theme/registry.ts):
//     the slug, the sha and the path patterns, and `parseTheme` on its text. One entry more is kept:
//     a file refused ONLY because it says a version newer than this Collie reads (`readNewerEntry`),
//     flagged `newer: true`, so Browse and About can say it needs a newer Collie instead of hiding it.
//     Any other failing entry is dropped and counted, never repaired. Only the checked fields are
//     stored.
//   • The copy is written to `<stateDir>/themes/registry.json` (folder 0700, file 0600) through an
//     exclusively created temp file and one rename, and held in memory for an hour; after that the
//     next read takes the file again, so two bridges on one state dir converge. The file is checked
//     again on every read from disk, with the same function.
//   • A failed fetch keeps the old copy and records one word for Settings, never a body or a path.

/** The one address the host fetches the registry from. */
export const THEME_REGISTRY_URL = "https://colliepwa.dev/themes/registry.json";

/** The operator's override of {@link THEME_REGISTRY_URL}, for a test against a staged copy of the site. */
export const THEME_REGISTRY_URL_ENV = "COLLIE_THEME_REGISTRY_URL";

/** The most bytes the registry may be. 500 themes of a few kilobytes each fit with room. */
export const REGISTRY_CAP_BYTES = 1024 * 1024;

/** The most entries a registry may hold. More refuses the whole document. */
export const REGISTRY_MAX_ENTRIES = 500;

/** How long one fetch may take, the first byte to the last. */
export const REGISTRY_TIMEOUT_MS = 10 * 1000;

/** How long the copy is held in memory before the next read takes the file again. */
export const REGISTRY_MEMORY_MS = 60 * 60 * 1000;
/** A refresh this soon after a good fetch answers the copy it has, and fetches nothing. */
export const REGISTRY_MIN_INTERVAL_MS = 60 * 1000;
/** A copy older than this is not listed: the host answers as if it had none, and the tap fetches. */
export const REGISTRY_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_REDIRECTS = 3;
/** The longest `generated` stamp kept: an ISO date with milliseconds and an offset fits. */
const GENERATED_MAX = 40;

/** The words Settings shows when a refresh fails. Collie's own, never an upstream body. */
export type RegistryError = "fetch-failed" | "too-big" | "bad-registry";

/** The address the host fetches from, and why an override was refused when one was. */
export interface RegistryAddress {
  url: string;
  /** Why the override was not used, for one boot warning. Absent when it was used or unset. */
  refused?: string;
}

/** 100.64.0.0/10, the tailnet range. */
function inTailnetRange(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  return m !== null && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/** A host plain `http://` may be used for: loopback, the tailnet, or a single-label name. */
function plainHttpHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (inTailnetRange(host)) return true;
  if (host.endsWith(".ts.net")) return true;
  return host !== "" && !host.includes(".") && !host.includes(":") && !host.includes("[");
}

/**
 * The address the host fetches the registry from: {@link THEME_REGISTRY_URL}, or the operator's
 * override when it is one Collie accepts. `https://` to any host; `http://` only to a loopback
 * host, a 100.64.0.0/10 address, a `.ts.net` name or a single-label name such as `bluefin`. Pure;
 * the caller prints `refused` once.
 */
export function resolveRegistryAddress(raw: string | undefined): RegistryAddress {
  const value = (raw ?? "").trim();
  if (value === "") return { url: THEME_REGISTRY_URL };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: THEME_REGISTRY_URL, refused: "it is not a URL" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { url: THEME_REGISTRY_URL, refused: "it carries a user name or a password" };
  }
  if (parsed.protocol === "https:") return { url: parsed.href };
  if (parsed.protocol !== "http:") return { url: THEME_REGISTRY_URL, refused: `${parsed.protocol} is not http or https` };
  if (plainHttpHost(parsed.hostname)) return { url: parsed.href };
  return {
    url: THEME_REGISTRY_URL,
    refused: "http is accepted only for loopback, a tailnet address, a .ts.net name or a name without a dot",
  };
}

/** The address to use, from the override's raw value, saying a refusal in one line through `warn`. */
export function registryUrlFromEnv(raw: string | undefined, warn: (line: string) => void): string {
  const resolved = resolveRegistryAddress(raw);
  if (resolved.refused !== undefined) {
    warn(`[themes] ${THEME_REGISTRY_URL_ENV} is not used because ${resolved.refused}; using ${THEME_REGISTRY_URL}`);
  }
  return resolved.url;
}

/** What `GET /api/themes/registry` answers. */
export interface RegistryStatus {
  /** When this host last fetched a good copy, ISO, or null when it never did. */
  fetchedAt: string | null;
  /** Milliseconds since `fetchedAt`, or null. */
  ageMs: number | null;
  /** The `generated` stamp the site wrote into the copy, or null. */
  generated: string | null;
  themes: RegistryEntry[];
  /** How many entries of the copy failed the check and were left out. */
  dropped: number;
  fetching: boolean;
  /** Why the last refresh failed. Absent after a good one. */
  error?: RegistryError;
  /** The address in use, present only when the operator's override replaced the default. */
  address?: string;
}

/** What `refresh()` did, for the route's status code and audit line. */
export interface RegistryRefresh {
  /** `held`: a refresh under a minute after a good fetch, answered from that copy. */
  outcome: "fetched" | "joined" | "held" | RegistryError;
  status: RegistryStatus;
}

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ThemeRegistryDeps {
  stateDir: string;
  /** The running version, for the user-agent. */
  version: string;
  fetch?: RegistryFetch;
  now?: () => number;
  timeoutMs?: number;
  /** The address to fetch, from {@link resolveRegistryAddress}. Defaults to {@link THEME_REGISTRY_URL}. */
  url?: string;
}

export interface ThemeRegistryStore {
  status(): Promise<RegistryStatus>;
  /** Fetch the registry once, or join the fetch in flight. The only place this store fetches. */
  refresh(): Promise<RegistryRefresh>;
}

/** The copy as it is stored and held. */
interface Copy {
  fetchedAt: string;
  generated: string | null;
  themes: RegistryEntry[];
  dropped: number;
}

class RegistryRefusal extends Error {
  readonly word: RegistryError;
  constructor(word: RegistryError) {
    super(word);
    this.word = word;
  }
}

/** A registry document read: its kept entries, or the word that refuses it whole. */
export type RegistryRead =
  | { ok: true; generated: string | null; themes: RegistryEntry[]; dropped: number }
  | { ok: false; error: RegistryError };

/** The folder the copy lives in. */
export function themesDir(stateDir: string): string {
  // Spelled out, so the state-dir guard (solo-baseline.test.ts) reads the name.
  return join(stateDir, "themes");
}

/**
 * A registry document's kept entries, or the word that refuses it whole. Pure: the store runs it
 * over a fetched body and again over its own file.
 */
export function readRegistry(text: string): RegistryRead {
  const doc = parseJsonObject(text);
  if (doc === undefined || asJsonNumber(doc.v) !== 1 || !Array.isArray(doc.themes)) return { ok: false, error: "bad-registry" };
  if (doc.themes.length > REGISTRY_MAX_ENTRIES) return { ok: false, error: "bad-registry" };
  const stamp = asJsonString(doc.generated);
  const generated = stamp !== undefined && stamp.length <= GENERATED_MAX && /^[0-9A-Za-z:.+-]+$/.test(stamp) ? stamp : null;
  const themes: RegistryEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of doc.themes) {
    const entry = keptEntry(value);
    if (entry === undefined) {
      dropped += 1;
      continue;
    }
    // The same file at the same commit, listed twice, is one theme. The phone keys its rows on these three.
    const key = JSON.stringify([entry.repo, entry.path, entry.sha]);
    if (seen.has(key)) continue;
    seen.add(key);
    themes.push(entry);
  }
  return { ok: true, generated, themes, dropped };
}

/**
 * One registry entry as the copy keeps it: a theme this Collie reads, or one refused ONLY because its
 * file says a newer version, kept with `newer: true` so Browse can say it needs a newer Collie and
 * About can say the listed version does (`readNewerEntry`). Every other entry is dropped. Both are
 * re-read from the four checked fields every time the copy is read, so the flag is never trusted.
 */
function keptEntry(value: JsonValue): RegistryEntry | undefined {
  const read = readRegistryEntry(value);
  if (read !== undefined) return read.entry;
  const newer = readNewerEntry(value);
  const text = asJsonString(asJsonObject(value)?.text);
  if (newer === undefined || text === undefined) return undefined;
  const entry: RegistryEntry = { repo: newer.repo, sha: newer.sha, path: newer.path, text, newer: true };
  if (newer.stars !== undefined) entry.stars = newer.stars;
  return entry;
}

/** A response body as text, refusing past `cap` bytes before it is parsed. */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryRefusal("too-big");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createThemeRegistryStore(deps: ThemeRegistryDeps): ThemeRegistryStore {
  const dir = themesDir(deps.stateDir);
  const file = join(dir, "registry.json");
  const fetchImpl: RegistryFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const address = deps.url ?? THEME_REGISTRY_URL;
  const origin = new URL(address).origin;
  const overridden = address !== THEME_REGISTRY_URL;

  let held: { copy: Copy | null; at: number } | null = null;
  let lastError: RegistryError | undefined;
  let flight: Promise<RegistryRefresh> | null = null;
  let seq = 0;

  async function readDisk(): Promise<Copy | null> {
    let text: string;
    try {
      const folder = await lstat(dir);
      if (folder.isSymbolicLink() || !folder.isDirectory()) return null;
      const entry = await lstat(file);
      if (!entry.isFile() || entry.size > REGISTRY_CAP_BYTES * 2) return null;
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    const doc = parseJsonObject(text);
    const fetchedAt = asJsonString(doc?.fetchedAt);
    if (doc === undefined || fetchedAt === undefined || Number.isNaN(Date.parse(fetchedAt))) return null;
    // A copy names its address only when an override wrote it; without one it is the default's.
    if ((doc.url === undefined ? THEME_REGISTRY_URL : asJsonString(doc.url)) !== address) return null;
    const read = readRegistry(text);
    if (!read.ok) return null;
    return { fetchedAt, generated: read.generated, themes: read.themes, dropped: read.dropped };
  }

  async function current(): Promise<Copy | null> {
    if (held !== null && now() - held.at < REGISTRY_MEMORY_MS) return held.copy;
    const copy = await readDisk();
    held = { copy, at: now() };
    return copy;
  }

  /** The copy the routes list: none when it is older than a week, so the next tap fetches. */
  function listed(copy: Copy | null): Copy | null {
    if (copy === null || now() - Date.parse(copy.fetchedAt) > REGISTRY_STALE_MS) return null;
    return copy;
  }

  function statusOf(found: Copy | null, fetching = flight !== null): RegistryStatus {
    const copy = listed(found);
    const status: RegistryStatus = {
      fetchedAt: copy?.fetchedAt ?? null,
      ageMs: copy === null ? null : Math.max(0, now() - Date.parse(copy.fetchedAt)),
      generated: copy?.generated ?? null,
      themes: copy?.themes ?? [],
      dropped: copy?.dropped ?? 0,
      fetching,
    };
    if (lastError !== undefined) status.error = lastError;
    if (overridden) status.address = address;
    return status;
  }

  async function prepareDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const entry = await lstat(dir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new RegistryRefusal("fetch-failed");
    await chmod(dir, 0o700);
  }

  async function write(copy: Copy): Promise<void> {
    await prepareDir();
    seq += 1;
    const temp = join(dir, `registry.json.${process.pid}.${seq}.part`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(overridden ? { v: 1, url: address, ...copy } : { v: 1, ...copy }));
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  /** GET the address, following a redirect only while it stays on that address's origin. */
  async function get(signal: AbortSignal): Promise<Response> {
    let url = address;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": `Collie/${deps.version}` },
          redirect: "manual",
          signal,
        });
      } catch {
        throw new RegistryRefusal("fetch-failed");
      }
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (location === null) throw new RegistryRefusal("fetch-failed");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new RegistryRefusal("fetch-failed");
      }
      if (next.origin !== origin) throw new RegistryRefusal("fetch-failed");
      url = next.href;
    }
    throw new RegistryRefusal("fetch-failed");
  }

  async function fetchOnce(): Promise<Copy> {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await get(signal);
    if (!res.ok || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      throw new RegistryRefusal("fetch-failed");
    }
    if (!/^application\/json\s*(?:;|$)/i.test(res.headers.get("content-type")?.trim() ?? "")) {
      await res.body.cancel().catch(() => undefined);
      throw new RegistryRefusal("bad-registry");
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > REGISTRY_CAP_BYTES) {
      await res.body.cancel().catch(() => undefined);
      throw new RegistryRefusal("too-big");
    }
    let text: string;
    try {
      text = await readCapped(res.body, REGISTRY_CAP_BYTES);
    } catch (err) {
      if (err instanceof RegistryRefusal) throw err;
      throw new RegistryRefusal("fetch-failed");
    }
    const read = readRegistry(text);
    if (!read.ok) throw new RegistryRefusal(read.error);
    return { fetchedAt: new Date(now()).toISOString(), generated: read.generated, themes: read.themes, dropped: read.dropped };
  }

  async function run(): Promise<RegistryRefresh> {
    try {
      const copy = await fetchOnce();
      await write(copy);
      held = { copy, at: now() };
      lastError = undefined;
      return { outcome: "fetched", status: statusOf(copy, false) };
    } catch (err) {
      lastError = err instanceof RegistryRefusal ? err.word : "fetch-failed";
      return { outcome: lastError, status: statusOf(await current(), false) };
    }
  }

  return {
    async status() {
      return statusOf(await current());
    },
    async refresh() {
      if (flight !== null) {
        const joined = await flight;
        return { outcome: "joined", status: joined.status };
      }
      const copy = listed(await current());
      if (copy !== null && now() - Date.parse(copy.fetchedAt) < REGISTRY_MIN_INTERVAL_MS) {
        return { outcome: "held", status: statusOf(copy, false) };
      }
      flight = run();
      try {
        return await flight;
      } finally {
        flight = null;
      }
    },
  };
}
