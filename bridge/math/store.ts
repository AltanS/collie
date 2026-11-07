import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { type FileHandle, chmod, lstat, mkdir, open, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

import type { JsonValue } from "../json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "../stt/json.ts";
import { MIRROR_FETCH, updateMirror } from "../update.ts";
import { developmentBase, readBuildInfo } from "../version.ts";
import { MAX_PACK_BYTES, PackRefusal, readPackTar } from "./tar.ts";

// ── THE MATH PACK ON THE HOST (ADR 0132) ───────────────────────────────────────────────────
//
// The KaTeX and MathJax engines are not in the install. They are one release asset,
// `collie-math-<version>.tar.gz`, and this store fetches it on ONE act only: a tap in Settings
// (`POST /api/math`, bridge/math/http.ts). A status read fetches nothing, not even the manifest.
//
//   • The trust is the release manifest of the RUNNING version, the document `collie update`
//     already stakes the install on: `releases/download/v<version>/collie-<version>.manifest.json`
//     on the update repo, its one `extras` entry with role `math-pack`. The asset's URL is built from
//     (repo, tag, name), never read from the document, and the name must be exactly the pack's.
//     The loopback rehearsal mirror (`COLLIE_UPDATE_MIRROR`) is honoured as the update honours it.
//   • A declared size above {@link MATH_PACK_CAP_BYTES} is refused before the body; the body is
//     counted against the cap and the manifest's size as it arrives, hashed as it arrives, and
//     streamed to `math/collie-math-<version>.<pid>.<seq>.part` (0600, created exclusively).
//   • The archive is inflated (bounded) and read here, never by a spawned `tar` (bridge/math/tar.ts).
//     Its files go to `math/<version>.tmp-<pid>-<seq>/` (folders 0700, files 0600) with `pack.json`,
//     and that folder is renamed to `math/<version>/` in one step. Other versions are then removed.
//   • A development build never fetches: its engines are `web/dist/math/` beside the build, or none.
//   • One download in flight per process; a second start joins it. Every failure removes this
//     download's part file and folder and records one word for Settings, never a path or a body.
//
// The bridge never writes under `web/dist`. `/math/*` is served from {@link MathPackStore.serveRoot}.

/** The most bytes a pack may be, compressed. The 1.28 pack is about 4 MB. */
export const MATH_PACK_CAP_BYTES = 64 * 1024 * 1024;

/** How long one download may take, manifest to rename. */
export const MATH_PACK_TIMEOUT_MS = 10 * 60 * 1000;

/** How long the manifest may take. It is a few kilobytes. */
const MANIFEST_TIMEOUT_MS = 30 * 1000;

/** The free space a download asks for, as a multiple of the pack: the part file, then the files. */
const SPACE_FACTOR = 5;

/** The words Settings shows under the rows. Collie's own, never an upstream body. */
export type MathPackError = "download-failed" | "low-space" | "hash-mismatch" | "bad-pack";

/** What `GET /api/math` answers. */
export type MathPackStatus =
  | { state: "absent"; error?: MathPackError }
  | { state: "downloading"; received: number; total: number | null }
  /** `bytes` is the pack's compressed size; null for the engines a source build carries. */
  | { state: "ready"; version: string; source: "store" | "build"; bytes: number | null }
  /** `dev-build`: a development build with no engines beside it. `no-pack`: this release has none. */
  | { state: "unavailable"; reason: "dev-build" | "no-pack" };

/** What `start()` did. */
export type MathPackStart =
  | { outcome: "downloading" | "joined" | "ready" | "unavailable"; status: MathPackStatus };

export type MathPackFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MathPackDeps {
  stateDir: string;
  /** The served web build, `web/dist`. Read only: its `build-info.json` and its `math/` folder. */
  webDist: string;
  /** The update repo, `owner/name`. */
  repo: string;
  /** The bridge's environment, for the rehearsal mirror. */
  env: Readonly<Record<string, string | undefined>>;
  fetch?: MathPackFetch;
  /** The clock `pack.json`'s `fetchedAt` reads. */
  now?: () => number;
  /** The free bytes where `dir` is. The disk unless a test names its own. */
  freeBytes?: (dir: string) => Promise<number | null>;
  capBytes?: number;
  timeoutMs?: number;
}

export interface MathPackStore {
  status(): Promise<MathPackStatus>;
  /** Start the download, or join the one in flight. Fetches only from here. */
  start(): Promise<MathPackStart>;
  /** Stop this process's download and delete every pack the state dir holds. */
  remove(): Promise<MathPackStatus>;
  /**
   * The folder `/math/*` is served from: one that holds `math/`. The store's pack of the running
   * version, else `web/dist` when it holds `math/`, else null (the route answers 404).
   */
  serveRoot(): string | null;
  /** Resolves when no download is in flight. For tests. */
  settled(): Promise<void>;
}

/** `pack.json`, written inside the folder before it is renamed into place. */
interface PackRecord {
  version: 1;
  pack: { version: string; name: string; sha256: string; bytes: number; files: number; fetchedAt: string };
}

/** A version that may name a folder: what a release tag carries, nothing a path could misread. */
const PLAIN_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;

/** The pack's asset name for a version: the one name the manifest entry may carry. */
export const mathPackName = (version: string): string => `collie-math-${version}.tar.gz`;

/** The folder of the packs under a state dir. */
export function mathPackDir(stateDir: string): string {
  // Spelled out, so the state-dir guard (solo-baseline.test.ts) reads the name.
  return join(stateDir, "math");
}

/**
 * The release version a build is, from its `build-info.json`: `1.28.0`, `1.28.0-edge.3`. Null for
 * a development build (`-dev`), a build with no stamp, and a version that cannot name a folder.
 */
export function releaseVersionOf(buildInfo: string | null): string | null {
  const stamp = readBuildInfo(buildInfo);
  if (stamp === null || developmentBase(stamp) !== null) return null;
  const core = stamp.split("+")[0]!;
  return PLAIN_VERSION.test(core) ? core : null;
}

/** A refusal with the one word Settings shows. */
class MathRefusal extends Error {
  readonly code: MathPackError | "no-pack";
  constructor(code: MathPackError | "no-pack") {
    super(code);
    this.code = code;
  }
}

interface InFlight {
  done: Promise<void>;
  received: number;
  total: number | null;
  controller: AbortController;
}

const inFlight = new Map<string, InFlight>();
/** The last failure per folder, until the next start or remove. In memory: a restart forgets it. */
const lastFailure = new Map<string, MathPackError>();
/** The versions a manifest was read for and named no pack. In memory, like the failure. */
const noPack = new Map<string, string>();
let writeSeq = 0;

/** Forget every download and failure this process holds. For tests. */
export function resetMathPackState(): void {
  for (const flight of inFlight.values()) flight.controller.abort();
  inFlight.clear();
  lastFailure.clear();
  noPack.clear();
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The `math-pack` entry of a manifest for `version`, or null when it names none that fits. */
export function mathPackEntry(data: JsonValue, version: string): { name: string; size: number; sha256: string } | null {
  const manifest = jsonRecord(data);
  if (manifest === null || jsonNumberField(manifest.schemaVersion) !== 1 || jsonStringField(manifest.version) !== version) return null;
  const extras = manifest.extras;
  if (!Array.isArray(extras)) return null;
  for (const item of extras) {
    const entry = jsonRecord(item);
    if (entry === null || jsonStringField(entry.role) !== "math-pack") continue;
    const name = jsonStringField(entry.name);
    const size = jsonNumberField(entry.size);
    const sha256 = jsonStringField(entry.sha256);
    if (name !== mathPackName(version)) return null;
    if (size === null || !Number.isSafeInteger(size) || size <= 0) return null;
    if (sha256 === null || !HEX64.test(sha256)) return null;
    return { name, size, sha256 };
  }
  return null;
}

async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Inflate a gzip file, refusing past `cap` bytes. */
async function inflate(path: string, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const gunzip = createGunzip();
  const source = Bun.file(path).stream();
  const done = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > cap) {
        gunzip.destroy(new PackRefusal("the math pack inflates past its cap"));
        return;
      }
      chunks.push(new Uint8Array(chunk));
    });
    gunzip.on("end", resolve);
    gunzip.on("error", reject);
  });
  try {
    for await (const chunk of source) {
      if (gunzip.destroyed) break;
      if (!gunzip.write(chunk)) await new Promise<void>((resolve) => gunzip.once("drain", resolve));
    }
    gunzip.end();
    await done;
  } catch (err) {
    if (err instanceof PackRefusal) throw err;
    throw new MathRefusal("bad-pack");
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function createMathPackStore(deps: MathPackDeps): MathPackStore {
  const dir = mathPackDir(deps.stateDir);
  const capBytes = deps.capBytes ?? MATH_PACK_CAP_BYTES;
  const timeoutMs = deps.timeoutMs ?? MATH_PACK_TIMEOUT_MS;
  const fetchImpl: MathPackFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const freeBytes = deps.freeBytes ?? diskFreeBytes;
  const now = deps.now ?? Date.now;

  /** The build's stamp, read each time: a dev lane rebuilds `web/dist` under a running bridge. */
  function buildInfo(): string | null {
    try {
      return readFileSync(join(deps.webDist, "build-info.json"), "utf8");
    } catch {
      return null;
    }
  }

  function buildHasEngines(): boolean {
    try {
      return statSync(join(deps.webDist, "math")).isDirectory();
    } catch {
      return false;
    }
  }

  /** The size of a stored pack, when its folder is whole: `pack.json` for this version and `math/`. */
  function stored(version: string): { bytes: number } | null {
    const folder = join(dir, version);
    try {
      if (!statSync(join(folder, "math")).isDirectory()) return null;
      // SAFETY: `JSON.parse` output IS a JsonValue by construction; every field read is narrowed below.
      const record = jsonRecord(JSON.parse(readFileSync(join(folder, "pack.json"), "utf8")) as JsonValue);
      const pack = jsonRecord(record?.pack);
      if (jsonNumberField(record?.version) !== 1 || jsonStringField(pack?.version) !== version) return null;
      const bytes = jsonNumberField(pack?.bytes);
      return bytes === null ? null : { bytes };
    } catch {
      return null;
    }
  }

  async function status(): Promise<MathPackStatus> {
    const flight = inFlight.get(dir);
    if (flight !== undefined) return { state: "downloading", received: flight.received, total: flight.total };
    const version = releaseVersionOf(buildInfo());
    if (version !== null) {
      const pack = stored(version);
      if (pack !== null) return { state: "ready", version, source: "store", bytes: pack.bytes };
    }
    if (buildHasEngines()) return { state: "ready", version: version ?? "dev", source: "build", bytes: null };
    if (version === null) return { state: "unavailable", reason: "dev-build" };
    if (noPack.get(dir) === version) return { state: "unavailable", reason: "no-pack" };
    const error = lastFailure.get(dir);
    return error === undefined ? { state: "absent" } : { state: "absent", error };
  }

  function serveRoot(): string | null {
    const version = releaseVersionOf(buildInfo());
    if (version !== null && stored(version) !== null) return join(dir, version);
    return buildHasEngines() ? deps.webDist : null;
  }

  /** The folder, 0700, and not a link. Throws a refusal. */
  async function prepareDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const entry = await lstat(dir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new MathRefusal("download-failed");
    await chmod(dir, 0o700);
  }

  /** A GET with the mirror's rules: no redirect off a mirror, GitHub's own redirects otherwise. */
  async function get(name: string, version: string, signal: AbortSignal, accept: string): Promise<Response> {
    const mirror = updateMirror(deps.env);
    if (!mirror.ok) throw new MathRefusal("download-failed");
    const url = `${mirror.base ?? "https://github.com"}/${deps.repo}/releases/download/v${version}/${name}`;
    const init: RequestInit = { headers: { accept, "user-agent": `Collie/${version}` }, signal };
    if (mirror.base !== null) init.redirect = MIRROR_FETCH.redirect;
    try {
      return await fetchImpl(url, init);
    } catch {
      throw new MathRefusal("download-failed");
    }
  }

  /** The `math-pack` entry of the running version's manifest. Throws `no-pack` when there is none. */
  async function readEntry(version: string, signal: AbortSignal): Promise<{ name: string; size: number; sha256: string }> {
    const res = await get(`collie-${version}.manifest.json`, version, AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]), "application/json");
    if (res.status === 404) throw new MathRefusal("no-pack");
    if (!res.ok) throw new MathRefusal("download-failed");
    let data: JsonValue;
    try {
      // SAFETY: `Response.json()` output IS a JsonValue by construction; `mathPackEntry` checks it.
      data = (await res.json()) as JsonValue;
    } catch {
      throw new MathRefusal("download-failed");
    }
    const entry = mathPackEntry(data, version);
    if (entry === null) throw new MathRefusal("no-pack");
    if (entry.size > capBytes) throw new MathRefusal("bad-pack");
    return entry;
  }

  /** Stream the pack into this download's part file, counting and hashing. Throws a refusal. */
  async function fetchPack(
    flight: InFlight,
    version: string,
    entry: { name: string; size: number; sha256: string },
    file: FileHandle,
    signal: AbortSignal,
  ): Promise<void> {
    const hash = createHash("sha256");
    try {
      const res = await get(entry.name, version, signal, "application/octet-stream");
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => undefined);
        throw new MathRefusal("download-failed");
      }
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > 0 && (declared > capBytes || declared !== entry.size)) {
        await res.body.cancel().catch(() => undefined);
        throw new MathRefusal(declared > capBytes ? "bad-pack" : "hash-mismatch");
      }
      const reader = res.body.getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw new MathRefusal("download-failed");
        }
        if (chunk.done) break;
        flight.received += chunk.value.byteLength;
        if (flight.received > entry.size || flight.received > capBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MathRefusal("hash-mismatch");
        }
        hash.update(chunk.value);
        await file.write(chunk.value);
      }
    } finally {
      await file.close();
    }
    if (flight.received !== entry.size || hash.digest("hex") !== entry.sha256) throw new MathRefusal("hash-mismatch");
  }

  /** Write the pack's files into a folder of this download's own, then rename it into place. */
  async function install(version: string, entry: { name: string; size: number; sha256: string }, part: string): Promise<void> {
    let contents;
    try {
      contents = readPackTar(await inflate(part, MAX_PACK_BYTES + 4 * 1024 * 1024));
    } catch (err) {
      if (err instanceof PackRefusal) throw new MathRefusal("bad-pack");
      throw err;
    }
    const temp = join(dir, `${version}.tmp-${process.pid}-${++writeSeq}`);
    try {
      await mkdir(temp, { mode: 0o700 });
      for (const folder of contents.folders) await mkdir(join(temp, folder), { mode: 0o700 });
      for (const { path, data } of contents.files) await writeFile(join(temp, path), data, { mode: 0o600, flag: "wx" });
      const record: PackRecord = {
        version: 1,
        pack: {
          version,
          name: entry.name,
          sha256: entry.sha256,
          bytes: entry.size,
          files: contents.files.length,
          fetchedAt: new Date(now()).toISOString(),
        },
      };
      await writeFile(join(temp, "pack.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const target = join(dir, version);
      // A half folder from a crash, or a pack of this version a remove left: this one replaces it.
      await rm(target, { recursive: true, force: true });
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Remove every other version, every leftover part file and every half folder but `keep`. */
  async function sweep(keep: string | null): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keep) continue;
      // `rm` on a link removes the link, never its target.
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function download(flight: InFlight, version: string): Promise<void> {
    const signal = AbortSignal.any([flight.controller.signal, AbortSignal.timeout(timeoutMs)]);
    await prepareDir();
    const entry = await readEntry(version, signal);
    flight.total = entry.size;
    const free = await freeBytes(dir);
    if (free !== null && free < entry.size * SPACE_FACTOR) throw new MathRefusal("low-space");
    const part = join(dir, `${entry.name}.${process.pid}.${++writeSeq}.part`);
    try {
      await fetchPack(flight, version, entry, await open(part, "wx", 0o600), signal);
      if (signal.aborted) throw new MathRefusal("download-failed");
      await install(version, entry, part);
    } finally {
      await rm(part, { force: true }).catch(() => undefined);
    }
    await sweep(version);
  }

  async function start(): Promise<MathPackStart> {
    const joined = inFlight.get(dir);
    if (joined !== undefined) return { outcome: "joined", status: await status() };
    const current = await status();
    if (current.state === "ready") return { outcome: "ready", status: current };
    const version = releaseVersionOf(buildInfo());
    if (version === null) return { outcome: "unavailable", status: current };
    lastFailure.delete(dir);
    noPack.delete(dir);
    const flight: InFlight = { done: Promise.resolve(), received: 0, total: null, controller: new AbortController() };
    flight.done = (async () => {
      try {
        await download(flight, version);
      } catch (err) {
        // A download stopped by `remove()` is not a failure: the person asked for nothing to be there.
        if (flight.controller.signal.aborted) return;
        if (err instanceof MathRefusal) {
          const { code } = err;
          if (code === "no-pack") noPack.set(dir, version);
          else lastFailure.set(dir, code);
        } else {
          const full = err instanceof Error && "code" in err && (err.code === "ENOSPC" || err.code === "EDQUOT");
          lastFailure.set(dir, full ? "low-space" : "download-failed");
        }
      } finally {
        if (inFlight.get(dir) === flight) inFlight.delete(dir);
      }
    })();
    inFlight.set(dir, flight);
    return { outcome: "downloading", status: await status() };
  }

  async function remove(): Promise<MathPackStatus> {
    const flight = inFlight.get(dir);
    if (flight !== undefined) {
      flight.controller.abort();
      await flight.done;
    }
    // The whole folder. A link at its path is removed as a link; its target is never followed.
    if (existsSync(dir) || (await lstat(dir).catch(() => null)) !== null) await rm(dir, { recursive: true, force: true });
    lastFailure.delete(dir);
    noPack.delete(dir);
    return status();
  }

  return {
    status,
    start,
    remove,
    serveRoot,
    async settled() {
      await inFlight.get(dir)?.done;
    },
  };
}
