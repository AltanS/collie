import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type MathPackFetch,
  createMathPackStore,
  mathPackDir,
  mathPackEntry,
  releaseVersionOf,
  resetMathPackState,
} from "./store.ts";
import { readPackTar } from "./tar.ts";

// ── A tar writer for the cases: ustar headers, by hand, so a bad entry can be made on purpose ──

interface TarEntry {
  name: string;
  /** `0` a file (the default), `5` a folder, `2` a symlink, `x` a pax header. */
  type?: string;
  data?: string | Uint8Array;
  linkname?: string;
}

function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (text: string, at: number, length: number) => block.set(enc.encode(text).subarray(0, length), at);
  put(entry.name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  block[156] = (entry.type ?? "0").charCodeAt(0);
  put(entry.linkname ?? "", 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function makeTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data = entry.data instanceof Uint8Array ? entry.data : new TextEncoder().encode(entry.data ?? "");
    parts.push(header(entry, data.byteLength));
    const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
    padded.set(data);
    parts.push(padded);
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const GOOD = makeTar([
  { name: "math/", type: "5" },
  { name: "math/katex/", type: "5" },
  { name: "math/katex/katex-abc123.js", data: "export const katexRenderer = 1;\n" },
  { name: "math/katex/KaTeX_Main-Regular-xyz.woff2", data: new Uint8Array([1, 2, 3, 4]) },
  { name: "math/math-markup-def.js", data: "export {};\n" },
]);

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const VERSION = "1.29.0-edge.1";
const PACK_NAME = `collie-math-${VERSION}.tar.gz`;

let root: string;
let stateDir: string;
let webDist: string;

function writeBuildInfo(version: string, extra: Record<string, string> = {}) {
  writeFileSync(join(webDist, "build-info.json"), JSON.stringify({ version, sha: "abc1234", ...extra }));
}

function manifest(version: string, pack: { name?: string; size: number; sha256: string } | null) {
  const extras: object[] = [{ name: `web-dist-${version}.tar.gz`, role: "web-bundle", size: 10, sha256: "0".repeat(64) }];
  if (pack !== null) extras.push({ name: pack.name ?? `collie-math-${version}.tar.gz`, role: "math-pack", size: pack.size, sha256: pack.sha256 });
  return { schemaVersion: 1, repo: "AltanS/collie", tag: `v${version}`, version, prerelease: true, artifacts: [], extras };
}

/** A fake GitHub: the manifest and the pack under `releases/download/v<version>/`, and a log. */
function fakeGithub(opts: { pack: Uint8Array; manifest?: object | null; packHeaders?: Record<string, string>; hold?: Promise<void> }) {
  const asked: string[] = [];
  const fetch: MathPackFetch = async (url) => {
    asked.push(url);
    const name = url.slice(url.lastIndexOf("/") + 1);
    if (name.endsWith(".manifest.json")) {
      if (opts.manifest === null) return new Response("not found", { status: 404 });
      const body = opts.manifest ?? manifest(VERSION, { size: opts.pack.byteLength, sha256: sha(opts.pack) });
      return Response.json(body);
    }
    if (name === PACK_NAME) {
      await opts.hold;
      return new Response(opts.pack, { headers: { "content-length": String(opts.pack.byteLength), ...opts.packHeaders } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, asked };
}

function store(fetch: MathPackFetch, extra: Partial<Parameters<typeof createMathPackStore>[0]> = {}) {
  return createMathPackStore({ stateDir, webDist, repo: "AltanS/collie", env: {}, fetch, freeBytes: async () => 1e12, ...extra });
}

/** Everything under a folder, as relative names. */
function tree(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }).map(String).toSorted();
  } catch {
    return [];
  }
}

beforeEach(() => {
  resetMathPackState();
  root = mkdtempSync(join(tmpdir(), "collie-math-"));
  stateDir = join(root, "state");
  webDist = join(root, "web", "dist");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(webDist, { recursive: true });
  writeBuildInfo(VERSION);
});

afterEach(() => {
  resetMathPackState();
  rmSync(root, { recursive: true, force: true });
});

describe("the running version", () => {
  test("is the build's stamp for a release, and none for a development build", () => {
    expect(releaseVersionOf(JSON.stringify({ version: "1.28.0", sha: "abc1234" }))).toBe("1.28.0");
    expect(releaseVersionOf(JSON.stringify({ version: "1.29.0-edge.3" }))).toBe("1.29.0-edge.3");
    expect(releaseVersionOf(JSON.stringify({ version: "1.28.0-dev", sha: "abc1234" }))).toBeNull();
    expect(releaseVersionOf(null)).toBeNull();
    expect(releaseVersionOf(JSON.stringify({ version: "../../etc" }))).toBeNull();
  });
});

describe("the manifest entry", () => {
  const pack = { size: 4, sha256: "a".repeat(64) };

  test("is the one extra with role math-pack and this version's name", () => {
    expect(mathPackEntry(manifest(VERSION, pack), VERSION)).toEqual({ name: PACK_NAME, ...pack });
  });

  test("is refused under another name, another version, a bad hash or a bad size", () => {
    expect(mathPackEntry(manifest(VERSION, { ...pack, name: "evil.tar.gz" }), VERSION)).toBeNull();
    expect(mathPackEntry(manifest(VERSION, pack), "1.29.0")).toBeNull();
    expect(mathPackEntry(manifest(VERSION, { ...pack, sha256: "zz" }), VERSION)).toBeNull();
    expect(mathPackEntry(manifest(VERSION, { ...pack, size: -1 }), VERSION)).toBeNull();
    expect(mathPackEntry(manifest(VERSION, null), VERSION)).toBeNull();
    expect(mathPackEntry({ ...manifest(VERSION, pack), schemaVersion: 2 }, VERSION)).toBeNull();
  });
});

describe("the download", () => {
  test("is absent before a tap, and a status read fetches nothing", async () => {
    const github = fakeGithub({ pack: Bun.gzipSync(GOOD) });
    const s = store(github.fetch);
    expect(await s.status()).toEqual({ state: "absent" });
    expect(s.serveRoot()).toBeNull();
    expect(github.asked).toEqual([]);
  });

  test("checks the pack against the manifest, extracts it and serves it from the state dir", async () => {
    const pack = Bun.gzipSync(GOOD);
    const github = fakeGithub({ pack });
    const s = store(github.fetch);
    const started = await s.start();
    expect(started.outcome).toBe("downloading");
    await s.settled();
    expect(await s.status()).toEqual({ state: "ready", version: VERSION, source: "store", bytes: pack.byteLength });
    expect(github.asked).toEqual([
      `https://github.com/AltanS/collie/releases/download/v${VERSION}/collie-${VERSION}.manifest.json`,
      `https://github.com/AltanS/collie/releases/download/v${VERSION}/${PACK_NAME}`,
    ]);
    const served = s.serveRoot();
    expect(served).toBe(join(mathPackDir(stateDir), VERSION));
    expect(readFileSync(join(served!, "math/katex/katex-abc123.js"), "utf8")).toContain("katexRenderer");
    expect(statSync(join(served!, "math/katex/katex-abc123.js")).mode & 0o777).toBe(0o600);
    expect(statSync(join(served!, "math/katex")).mode & 0o777).toBe(0o700);
    expect(statSync(mathPackDir(stateDir)).mode & 0o777).toBe(0o700);
    // Nothing but the version's folder is left: no part file, no temporary folder.
    expect(readdirSync(mathPackDir(stateDir))).toEqual([VERSION]);
    // The bridge never writes under web/dist.
    expect(tree(webDist)).toEqual(["build-info.json"]);
  });

  test("keeps nothing when the hash is not the manifest's", async () => {
    const pack = Bun.gzipSync(GOOD);
    const github = fakeGithub({ pack, manifest: manifest(VERSION, { size: pack.byteLength, sha256: "b".repeat(64) }) });
    const s = store(github.fetch);
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "hash-mismatch" });
    expect(tree(mathPackDir(stateDir))).toEqual([]);
    expect(s.serveRoot()).toBeNull();
  });

  test("keeps nothing when the body is longer than the manifest says", async () => {
    const pack = Bun.gzipSync(GOOD);
    const github = fakeGithub({ pack, manifest: manifest(VERSION, { size: pack.byteLength - 1, sha256: sha(pack) }), packHeaders: { "content-length": "" } });
    const s = store(github.fetch);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("absent");
    expect(tree(mathPackDir(stateDir))).toEqual([]);
  });

  test("refuses a pack over the cap before it asks for the body", async () => {
    const pack = Bun.gzipSync(GOOD);
    const github = fakeGithub({ pack, manifest: manifest(VERSION, { size: 100 * 1024 * 1024, sha256: sha(pack) }) });
    const s = store(github.fetch);
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "bad-pack" });
    expect(github.asked.some((url) => url.endsWith(PACK_NAME))).toBe(false);
  });

  test("refuses a declared length over the cap before it reads the body", async () => {
    const pack = Bun.gzipSync(GOOD);
    const github = fakeGithub({ pack, packHeaders: { "content-length": String(65 * 1024 * 1024) } });
    const s = store(github.fetch);
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "bad-pack" });
    expect(tree(mathPackDir(stateDir))).toEqual([]);
  });

  test("says low-space and fetches no pack when the disk is short", async () => {
    const github = fakeGithub({ pack: Bun.gzipSync(GOOD) });
    const s = store(github.fetch, { freeBytes: async () => 10 });
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "low-space" });
    expect(github.asked.some((url) => url.endsWith(PACK_NAME))).toBe(false);
  });

  test("says download-failed when the network fails", async () => {
    const s = store(async () => {
      throw new Error("offline");
    });
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "download-failed" });
  });

  test("reports no-pack for a release whose manifest is missing or names none", async () => {
    for (const github of [fakeGithub({ pack: GOOD, manifest: null }), fakeGithub({ pack: GOOD, manifest: manifest(VERSION, null) })]) {
      resetMathPackState();
      const s = store(github.fetch);
      await s.start();
      await s.settled();
      expect(await s.status()).toEqual({ state: "unavailable", reason: "no-pack" });
    }
  });

  test("a second start joins the download in flight and fetches once", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const github = fakeGithub({ pack: Bun.gzipSync(GOOD), hold });
    const s = store(github.fetch);
    expect((await s.start()).outcome).toBe("downloading");
    const second = await s.start();
    expect(second.outcome).toBe("joined");
    expect(second.status.state).toBe("downloading");
    release();
    await s.settled();
    expect(github.asked.filter((url) => url.endsWith(PACK_NAME))).toHaveLength(1);
    expect((await s.start()).outcome).toBe("ready");
  });

  test("takes the mirror when one is set, and nothing else", async () => {
    const github = fakeGithub({ pack: Bun.gzipSync(GOOD) });
    const s = store(github.fetch, { env: { COLLIE_UPDATE_MIRROR: "http://127.0.0.1:9999/m" } });
    await s.start();
    await s.settled();
    expect(github.asked[0]).toBe(`http://127.0.0.1:9999/m/AltanS/collie/releases/download/v${VERSION}/collie-${VERSION}.manifest.json`);
    expect((await s.status()).state).toBe("ready");
  });

  test("a mirror that is not loopback is refused, never GitHub in its place", async () => {
    const github = fakeGithub({ pack: Bun.gzipSync(GOOD) });
    const s = store(github.fetch, { env: { COLLIE_UPDATE_MIRROR: "https://example.com" } });
    await s.start();
    await s.settled();
    expect(github.asked).toEqual([]);
    expect(await s.status()).toEqual({ state: "absent", error: "download-failed" });
  });

  test("removes every other version once a new one is in", async () => {
    mkdirSync(join(mathPackDir(stateDir), "1.28.0", "math"), { recursive: true });
    writeFileSync(join(mathPackDir(stateDir), "collie-math-1.28.0.tar.gz.1.1.part"), "x");
    const s = store(fakeGithub({ pack: Bun.gzipSync(GOOD) }).fetch);
    await s.start();
    await s.settled();
    expect(readdirSync(mathPackDir(stateDir))).toEqual([VERSION]);
  });
});

describe("a bad archive", () => {
  const cases: [string, TarEntry[]][] = [
    ["a symlink", [{ name: "math/katex/link.js", type: "2", linkname: "/etc/passwd" }]],
    ["a hard link", [{ name: "math/katex/link.js", type: "1", linkname: "math/a.js" }]],
    ["a path out of the root", [{ name: "math/../../escape.js", data: "x" }]],
    ["an absolute path", [{ name: "/math/a.js", data: "x" }]],
    ["a file outside math/", [{ name: "assets/index.js", data: "x" }]],
    ["a backslash", [{ name: "math\\a.js", data: "x" }]],
    ["a device", [{ name: "math/dev", type: "3" }]],
    ["no files at all", [{ name: "math/", type: "5" }]],
  ];

  test.each(cases)("is refused whole when it holds %s", async (_label, entries) => {
    const bad = makeTar([{ name: "math/ok.js", data: "fine" }, ...entries]);
    if (entries.every((e) => e.type === "5")) {
      expect(() => readPackTar(makeTar(entries))).toThrow();
    } else {
      expect(() => readPackTar(bad)).toThrow();
    }
    const pack = Bun.gzipSync(entries.every((e) => e.type === "5") ? makeTar(entries) : bad);
    const s = store(fakeGithub({ pack }).fetch);
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "bad-pack" });
    expect(tree(mathPackDir(stateDir))).toEqual([]);
    expect(tree(root).some((name) => name.includes("escape"))).toBe(false);
  });

  test("a header with a wrong checksum is refused", () => {
    const tar = makeTar([{ name: "math/a.js", data: "x" }]);
    tar[0] = "n".charCodeAt(0);
    expect(() => readPackTar(tar)).toThrow();
  });

  test("a body that is not gzip is refused as a bad pack", async () => {
    const s = store(fakeGithub({ pack: GOOD }).fetch);
    await s.start();
    await s.settled();
    expect(await s.status()).toEqual({ state: "absent", error: "bad-pack" });
  });

  test("a pax path is read, and still held to the rules", () => {
    const record = (path: string) => {
      const body = ` path=${path}\n`;
      let length = body.length;
      length += String(length + String(length).length).length;
      return `${length}${body}`;
    };
    const good = readPackTar(makeTar([{ name: "PaxHeader", type: "x", data: record("math/long/name.js") }, { name: "ignored", data: "x" }]));
    expect(good.files.map((f) => f.path)).toEqual(["math/long/name.js"]);
    expect(() => readPackTar(makeTar([{ name: "PaxHeader", type: "x", data: record("math/../x.js") }, { name: "math/a.js", data: "x" }]))).toThrow();
  });
});

describe("a development build", () => {
  test("serves web/dist/math beside the build and reports ready from it", async () => {
    writeBuildInfo("1.29.0-dev");
    mkdirSync(join(webDist, "math", "katex"), { recursive: true });
    const github = fakeGithub({ pack: GOOD });
    const s = store(github.fetch);
    expect(await s.status()).toEqual({ state: "ready", version: "dev", source: "build", bytes: null });
    expect(s.serveRoot()).toBe(webDist);
    expect((await s.start()).outcome).toBe("ready");
    expect(github.asked).toEqual([]);
  });

  test("with no engines beside it is unavailable and never fetches a manifest", async () => {
    writeBuildInfo("1.29.0-dev");
    const github = fakeGithub({ pack: GOOD });
    const s = store(github.fetch);
    expect(await s.status()).toEqual({ state: "unavailable", reason: "dev-build" });
    const started = await s.start();
    expect(started.outcome).toBe("unavailable");
    await s.settled();
    expect(github.asked).toEqual([]);
    expect(s.serveRoot()).toBeNull();
  });

  test("a release build with engines beside it serves them too", async () => {
    mkdirSync(join(webDist, "math"), { recursive: true });
    const s = store(fakeGithub({ pack: GOOD }).fetch);
    expect(await s.status()).toEqual({ state: "ready", version: VERSION, source: "build", bytes: null });
    expect(s.serveRoot()).toBe(webDist);
  });
});

describe("remove", () => {
  test("deletes every pack and returns to absent", async () => {
    const s = store(fakeGithub({ pack: Bun.gzipSync(GOOD) }).fetch);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
    expect(await s.remove()).toEqual({ state: "absent" });
    expect(tree(stateDir)).toEqual([]);
    expect(s.serveRoot()).toBeNull();
  });

  test("stops a download in flight and keeps nothing of it", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = store(fakeGithub({ pack: Bun.gzipSync(GOOD), hold }).fetch);
    await s.start();
    const removed = s.remove();
    release();
    expect(await removed).toEqual({ state: "absent" });
    await s.settled();
    expect(tree(stateDir)).toEqual([]);
  });
});
