import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WHISTLE_MODEL } from "./whistle-pins.ts";
import {
  createWhistleModelStore,
  isPublicAddress,
  resetWhistleModelState,
  WHISTLE_MAX_REDIRECTS,
  whistleEngineDir,
  whistleEngineInPlace,
  whistlePartName,
  whistlePaths,
  type WhistleFetch,
  type WhistleLookup,
  type WhistleModelPin,
} from "./whistle-model.ts";

// No network: every download here is served by a fake fetch, from bytes the test made up and pinned.

const MODEL = new TextEncoder().encode("a tiny stand-in for whistle.cact, 40+ bytes long");
const SHA = createHash("sha256").update(MODEL).digest("hex");
const PIN: WhistleModelPin = { url: "https://models.invalid/whistle.cact", revision: "rev1", sha256: SHA, bytes: MODEL.byteLength };

let stateDir: string;
beforeEach(() => {
  resetWhistleModelState();
  stateDir = mkdtempSync(join(tmpdir(), "collie-whistle-model-"));
});
afterEach(() => {
  resetWhistleModelState();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A fetch that answers `body` in `chunks` pieces and records every call. */
function fakeFetch(body: Uint8Array = MODEL, opts: { status?: number; chunks?: number; length?: number | null; gate?: Promise<void> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: WhistleFetch = async (url, init) => {
    calls.push({ url, init });
    await opts.gate;
    const pieces = opts.chunks ?? 3;
    const size = Math.ceil(body.byteLength / pieces);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.byteLength; i += size) controller.enqueue(body.slice(i, i + size));
        controller.close();
      },
    });
    const headers: Record<string, string> = {};
    const length = opts.length === undefined ? body.byteLength : opts.length;
    if (length !== null) headers["content-length"] = String(length);
    return new Response(stream, { status: opts.status ?? 200, headers });
  };
  return { fn, calls };
}

/** DNS as a test sees it: every name is one public (documentation) address. */
const PUBLIC: WhistleLookup = async () => ["203.0.113.7"];

function store(fetchImpl: WhistleFetch, extra: { capBytes?: number; pin?: WhistleModelPin; lookup?: WhistleLookup; timeoutMs?: number } = {}) {
  return createWhistleModelStore({
    stateDir,
    version: "1.20.0",
    fetch: fetchImpl,
    lookup: extra.lookup ?? PUBLIC,
    pin: extra.pin ?? PIN,
    accepted: [SHA],
    capBytes: extra.capBytes,
    timeoutMs: extra.timeoutMs,
    now: () => Date.UTC(2026, 9, 11),
  });
}

/** What a download leaves in the folder while it runs: lock, part files, manifest temporaries. */
function leftovers(): string[] {
  const dir = whistlePaths(stateDir).dir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name === "whistle.lock" || name.endsWith(".part") || name.endsWith(".tmp"));
}

/** Another process's download, as it looks on disk: a lock naming its part file, and the part. */
function otherDownload(content: string, ageMs = 0) {
  const paths = whistlePaths(stateDir);
  mkdirSync(paths.dir, { recursive: true });
  const name = whistlePartName(999_999, 1);
  const part = join(paths.dir, name);
  writeFileSync(part, content);
  writeFileSync(paths.lock, `${JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString(), part: name })}\n`);
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(paths.lock, old, old);
    utimesSync(part, old, old);
  }
  return { part, lock: paths.lock };
}

/** A fetch that answers each URL from `routes`, in order of the calls, and records them. */
function routedFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: WhistleFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`no route for ${url}`);
    return route();
  };
  return { fn, calls };
}

const moved = (location: string, status = 302) => () => new Response("upstream body text", { status, headers: { location } });
const modelBody = () => new Response(MODEL, { headers: { "content-length": String(MODEL.byteLength) } });

describe("the Whistle model store", () => {
  test("absent at first, with the pinned size always present", async () => {
    const s = store(fakeFetch().fn);
    expect(await s.status()).toEqual({ state: "absent", bytes: MODEL.byteLength });
    expect(await s.ready()).toBeNull();
  });

  test("a download lands the file at 0600 in a 0700 folder, with a manifest, and reads ready", async () => {
    const f = fakeFetch();
    const s = store(f.fn);
    const start = await s.start();
    expect(start.outcome).toBe("downloading");
    await s.settled();

    const paths = whistlePaths(stateDir);
    expect(readFileSync(paths.model)).toEqual(Buffer.from(MODEL));
    // No part file, no lock, no manifest temporary is left behind.
    expect(leftovers()).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.model).mode & 0o777).toBe(0o600);
      expect(statSync(paths.manifest).mode & 0o777).toBe(0o600);
    }
    expect(await s.status()).toEqual({
      state: "ready",
      bytes: MODEL.byteLength,
      sha256: SHA,
      revision: "rev1",
      fetchedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(await s.ready()).toEqual({ path: paths.model, sha256: SHA, bytes: MODEL.byteLength });
    expect(await s.manifest()).toEqual({
      version: 1,
      model: { sha256: SHA, bytes: MODEL.byteLength, revision: "rev1", source: PIN.url, fetchedAt: "2026-10-11T00:00:00.000Z" },
    });
  });

  test("the ready status carries the revision and fetch time only while the manifest describes the held file", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    const paths = whistlePaths(stateDir);
    const write = (model: { sha256: string; revision: string; fetchedAt: string }) =>
      writeFileSync(paths.manifest, JSON.stringify({ version: 1, model: { bytes: MODEL.byteLength, source: PIN.url, ...model } }));

    // A manifest for a different file says nothing about this one.
    write({ sha256: "0".repeat(64), revision: "rev1", fetchedAt: "2026-10-11T00:00:00.000Z" });
    expect(await s.status()).toEqual({ state: "ready", bytes: MODEL.byteLength, sha256: SHA });

    // A revision that is not a plain name, or a time that is not a time, is left out, not passed on.
    write({ sha256: SHA, revision: "../etc/passwd", fetchedAt: "yesterday" });
    expect(await s.status()).toEqual({ state: "ready", bytes: MODEL.byteLength, sha256: SHA });

    // No manifest at all: still ready, with no provenance.
    rmSync(paths.manifest);
    expect(await s.status()).toEqual({ state: "ready", bytes: MODEL.byteLength, sha256: SHA });
  });

  test("a status that is not ready carries no revision", async () => {
    const s = store(fakeFetch().fn);
    expect(await s.status()).not.toHaveProperty("revision");
  });

  test("the request goes to the pinned URL, takes redirects by hand, and says who it is", async () => {
    const f = fakeFetch();
    const s = store(f.fn);
    await s.start();
    await s.settled();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(PIN.url);
    expect(f.calls[0]!.init.redirect).toBe("manual");
    expect(new Headers(f.calls[0]!.init.headers).get("user-agent")).toBe("Collie/1.20.0");
  });

  test("the production pin is the Hugging Face commit URL", () => {
    expect(WHISTLE_MODEL.url).toBe(`https://huggingface.co/Cactus-Compute/whistle/resolve/${WHISTLE_MODEL.revision}/whistle.cact`);
  });

  test("a hash mismatch keeps nothing, and reports both hashes", async () => {
    const wrong = new TextEncoder().encode("not the pinned bytes at all, but the same idea");
    const s = store(fakeFetch(wrong).fn);
    await s.start();
    await s.settled();
    const paths = whistlePaths(stateDir);
    expect(existsSync(paths.model)).toBe(false);
    expect(leftovers()).toEqual([]);
    const status = await s.status();
    expect(status.state).toBe("failed");
    expect(status.reason).toContain(SHA);
    expect(status.reason).toContain(createHash("sha256").update(wrong).digest("hex"));
    expect(status.reason).not.toContain(stateDir);
  });

  test("the size cap stops a body that runs past it, declared or not", async () => {
    const big = new Uint8Array(4096);
    for (const length of [4096, null]) {
      resetWhistleModelState();
      const s = store(fakeFetch(big, { length, chunks: 8 }).fn, { capBytes: 1024 });
      await s.start();
      await s.settled();
      const status = await s.status();
      expect(status.state).toBe("failed");
      expect(status.reason).toContain("larger than");
      expect(leftovers()).toEqual([]);
    }
  });

  test("a body one byte over the pinned size stops there, before the hash, and leaves no part file", async () => {
    const over = new Uint8Array(MODEL.byteLength + 1);
    over.set(MODEL);
    for (const length of [over.byteLength, null]) {
      resetWhistleModelState();
      const s = store(fakeFetch(over, { length, chunks: 4 }).fn);
      await s.start();
      await s.settled();
      const status = await s.status();
      expect(status.state).toBe("failed");
      expect(status.reason).toBe(`the download is larger than ${MODEL.byteLength} bytes`);
      expect(leftovers()).toEqual([]);
      expect(existsSync(whistlePaths(stateDir).model)).toBe(false);
      expect(existsSync(whistlePaths(stateDir).manifest)).toBe(false);
    }
  });

  test("a body of exactly the pinned size still lands", async () => {
    const s = store(fakeFetch(MODEL).fn);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
  });

  test("an HTTP error and a network error each fail with a short reason", async () => {
    const s = store(fakeFetch(MODEL, { status: 404 }).fn);
    await s.start();
    await s.settled();
    expect((await s.status()).reason).toBe("the download answered HTTP 404");

    resetWhistleModelState();
    const broken = store(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND huggingface.co");
    });
    await broken.start();
    await broken.settled();
    expect((await broken.status()).reason).toBe("the download could not reach Hugging Face");
  });

  test("single flight: two starts while one runs make one request, and the second joins", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const f = fakeFetch(MODEL, { gate });
    const a = store(f.fn);
    const b = store(f.fn);
    const [first, second] = await Promise.all([a.start(), b.start()]);
    expect(first.outcome).toBe("downloading");
    expect(second.outcome).toBe("downloading");
    expect((await a.status()).state).toBe("downloading");
    open();
    await a.settled();
    expect(f.calls).toHaveLength(1);
    expect((await b.status()).state).toBe("ready");
  });

  test("idempotent when ready: a start fetches nothing", async () => {
    const f = fakeFetch();
    const s = store(f.fn);
    await s.start();
    await s.settled();
    const again = await s.start();
    expect(again.outcome).toBe("ready");
    expect(f.calls).toHaveLength(1);
  });

  test("a held file this build does not accept reads failed, and a start replaces it", async () => {
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.model, "an older model");
    const f = fakeFetch();
    const s = store(f.fn);
    expect((await s.status()).state).toBe("failed");
    expect(await s.ready()).toBeNull();
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
  });

  test("the hash is computed once per change of the file, not per ask", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    const paths = whistlePaths(stateDir);
    // Whole seconds, so the restored mtime is exactly the one that was hashed.
    utimesSync(paths.model, 1_700_000_000, 1_700_000_000);
    expect((await s.ready())?.sha256).toBe(SHA);
    // Same size, same mtime, same inode: a changed body is NOT re-read. This is the cache, observed.
    writeFileSync(paths.model, new Uint8Array(MODEL.byteLength).fill(65));
    utimesSync(paths.model, 1_700_000_000, 1_700_000_000);
    expect((await s.ready())?.sha256).toBe(SHA);
    writeFileSync(paths.model, "different length now");
    expect(await s.ready()).toBeNull();
  });

  test("a symlink at the model's path is refused, never followed", async () => {
    if (process.platform === "win32") return;
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    const target = join(stateDir, "elsewhere.cact");
    writeFileSync(target, MODEL);
    symlinkSync(target, paths.model);
    const s = store(fakeFetch().fn);
    expect((await s.status()).state).toBe("failed");
    expect(await s.ready()).toBeNull();
    const start = await s.start();
    expect(start.outcome).toBe("refused");
    expect(lstatSync(paths.model).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(Buffer.from(MODEL));
  });

  test("a symlinked folder is refused before anything is fetched", async () => {
    if (process.platform === "win32") return;
    const away = mkdtempSync(join(tmpdir(), "collie-whistle-away-"));
    symlinkSync(away, join(stateDir, "whistle"));
    const f = fakeFetch();
    const s = store(f.fn);
    const start = await s.start();
    expect(start).toMatchObject({ outcome: "refused" });
    expect(f.calls).toHaveLength(0);
    expect(readdirSync(away)).toEqual([]);
    rmSync(away, { recursive: true, force: true });
  });

  test("a stale lock and part file left by a crash are replaced, and a symlink at the lock is refused", async () => {
    const paths = whistlePaths(stateDir);
    // A crash's: older than the deadline.
    otherDownload("half a model", 11 * 60 * 1000);
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
    expect(leftovers()).toEqual([]);

    if (process.platform === "win32") return;
    await s.remove();
    mkdirSync(paths.dir, { recursive: true });
    symlinkSync(join(stateDir, "victim"), paths.lock);
    const again = await s.start();
    expect(again.outcome).toBe("refused");
    expect(existsSync(join(stateDir, "victim"))).toBe(false);
  });

  test("the model lives in <stateDir>/whistle/, one level down, and nothing is made under stt/", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    expect(whistlePaths(stateDir).dir).toBe(join(stateDir, "whistle"));
    expect(readdirSync(stateDir)).toEqual(["whistle"]);
    expect(readdirSync(join(stateDir, "whistle")).toSorted()).toEqual(["whistle.cact", "whistle.json"]);
  });

  test("a lock younger than the deadline is another process's download: nothing is fetched or touched", async () => {
    const paths = whistlePaths(stateDir);
    const other = otherDownload("half of it");
    const f = fakeFetch();
    const s = store(f.fn);
    // The size of the part file its lock names is what the other process has received so far.
    expect(await s.status()).toEqual({ state: "downloading", bytes: MODEL.byteLength, received: 10 });
    const start = await s.start();
    expect(start).toEqual({ outcome: "downloading", elsewhere: true, status: { state: "downloading", bytes: MODEL.byteLength, received: 10 } });
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(other.part, "utf8")).toBe("half of it");
    expect(existsSync(paths.lock)).toBe(true);
    await s.settled();
    // The other process finishing (its part renamed away, its lock removed) ends it.
    rmSync(other.part);
    rmSync(paths.lock);
    expect((await s.status()).state).toBe("absent");
  });

  test("a lock that is not JSON still counts by its age", async () => {
    const paths = whistlePaths(stateDir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, "torn");
    const f = fakeFetch();
    expect((await store(f.fn).start()).outcome).toBe("downloading");
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(paths.lock, "utf8")).toBe("torn");

    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(paths.lock, old, old);
    const s = store(f.fn);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
    expect(leftovers()).toEqual([]);
  });

  test("a lock at the deadline's edge is stale, and the next start replaces it", async () => {
    const other = otherDownload("ancient", 61_000);
    const f = fakeFetch();
    const s = store(f.fn, { timeoutMs: 60_000 });
    expect((await s.status()).state).toBe("absent");
    expect((await s.start()).outcome).toBe("downloading");
    await s.settled();
    expect((await s.status()).state).toBe("ready");
    expect(f.calls).toHaveLength(1);
    expect(existsSync(other.part)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("the lock is made before the request, holds the pid, the start and this download's own part file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fakeFetch(MODEL, { gate });
    const first = store(f.fn);
    await first.start();
    const paths = whistlePaths(stateDir);
    // SAFETY: the lock `prepare` just wrote, read back by its own test.
    const lock = JSON.parse(readFileSync(paths.lock, "utf8")) as { pid: number; startedAt: string; part: string };
    expect(lock.pid).toBe(process.pid);
    expect(Date.now() - Date.parse(lock.startedAt)).toBeLessThan(10_000);
    expect(lock.part).toMatch(new RegExp(`^whistle\\.cact\\.${process.pid}\\.\\d+\\.part$`));
    expect(existsSync(join(paths.dir, lock.part))).toBe(true);
    // The lock a second process sees is fresh.
    expect(Date.now() - statSync(paths.lock).mtimeMs).toBeLessThan(10_000);
    release();
    await first.settled();
    expect((await first.status()).state).toBe("ready");
    expect(leftovers()).toEqual([]);
  });

  test("a download renames only its own part file, never another one in the folder", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = store(fakeFetch(MODEL, { gate }).fn);
    await s.start();
    // Another writer's part file appears beside ours (two processes that judged one stale lock).
    const paths = whistlePaths(stateDir);
    const theirs = join(paths.dir, whistlePartName(999_999, 3));
    writeFileSync(theirs, "someone else's bytes");
    release();
    await s.settled();
    expect(readFileSync(paths.model)).toEqual(Buffer.from(MODEL));
    expect(readFileSync(theirs, "utf8")).toBe("someone else's bytes");
  });

  test("two downloads in one process never share a part file name", async () => {
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const s = store(fakeFetch(MODEL, { gate }).fn);
      await s.start();
      names.push(readdirSync(whistlePaths(stateDir).dir).find((name) => name.endsWith(".part"))!);
      release();
      await s.settled();
      await s.remove();
    }
    expect(names[0]).not.toBe(names[1]);
  });

  test("importFile takes a local file through the same hash gate and records where it came from", async () => {
    const src = join(stateDir, "..", `collie-whistle-src-${process.pid}.cact`);
    writeFileSync(src, MODEL);
    try {
      const f = fakeFetch();
      const s = store(f.fn);
      const start = await s.importFile(src);
      expect(start.outcome).toBe("downloading");
      await s.settled();
      expect(f.calls).toHaveLength(0);
      expect(await s.status()).toEqual({ state: "ready", bytes: MODEL.byteLength, sha256: SHA, revision: "rev1", fetchedAt: "2026-10-11T00:00:00.000Z" });
      expect(readFileSync(whistlePaths(stateDir).model)).toEqual(Buffer.from(MODEL));
      expect(leftovers()).toEqual([]);
      expect((await s.manifest())?.model).toMatchObject({ sha256: SHA, source: "a file the operator supplied" });
      // Idempotent: a second import of a held model is "ready", and copies nothing.
      expect((await s.importFile(src)).outcome).toBe("ready");
    } finally {
      rmSync(src, { force: true });
    }
  });

  test("importFile of the wrong bytes keeps nothing and names both hashes", async () => {
    const src = join(stateDir, "..", `collie-whistle-wrong-${process.pid}.cact`);
    // The pinned size exactly: a longer file is refused by the cap before it is ever hashed.
    const wrong = new TextEncoder().encode("x".repeat(MODEL.byteLength));
    writeFileSync(src, wrong);
    try {
      const s = store(fakeFetch().fn);
      await s.importFile(src);
      await s.settled();
      const status = await s.status();
      expect(status.state).toBe("failed");
      const wrongSha = createHash("sha256").update(wrong).digest("hex");
      expect(status.reason).toBe(`the file did not match the pinned model (got ${wrongSha}, expected ${SHA})`);
      expect(existsSync(whistlePaths(stateDir).model)).toBe(false);
      expect(leftovers()).toEqual([]);
    } finally {
      rmSync(src, { force: true });
    }
  });

  test("importFile refuses a symlink, a folder and a missing file before touching anything", async () => {
    const s = store(fakeFetch().fn);
    expect(await s.importFile(join(stateDir, "nope.cact"))).toMatchObject({ outcome: "refused" });
    expect(await s.importFile(stateDir)).toMatchObject({ outcome: "refused", reason: "that is not a regular file" });
    if (process.platform !== "win32") {
      const target = join(stateDir, "real.cact");
      writeFileSync(target, MODEL);
      const link = join(stateDir, "link.cact");
      symlinkSync(target, link);
      const refused = await s.importFile(link);
      expect(refused).toMatchObject({ outcome: "refused" });
      expect(refused.outcome === "refused" ? refused.reason : "").toContain("symlink");
    }
    expect(existsSync(whistlePaths(stateDir).dir)).toBe(false);
  });

  test("describe: absent, downloading, ready with its revision, not this release's, and unreadable", async () => {
    const s = store(fakeFetch().fn);
    expect(await s.describe()).toEqual({ kind: "absent" });
    await s.start();
    await s.settled();
    expect(await s.describe()).toEqual({ kind: "ready", sha256: SHA, bytes: MODEL.byteLength, revision: "rev1" });
    const paths = whistlePaths(stateDir);
    writeFileSync(paths.model, "another model, not one this release accepts");
    const other = await s.describe();
    expect(other).toMatchObject({ kind: "mismatch" });
    if (process.platform !== "win32") {
      rmSync(paths.model);
      symlinkSync(join(stateDir, "x"), paths.model);
      expect(await s.describe()).toMatchObject({ kind: "unreadable" });
      rmSync(paths.model);
    }
    // Windows skips the symlink case above, so the mismatched model is still there: clear it, or the
    // half download below would read as a mismatch.
    rmSync(paths.model, { force: true });
    otherDownload("half");
    expect(await s.describe()).toEqual({ kind: "downloading", received: 4 });
  });

  test("remove deletes the model, the manifest and the part, and stops a download in flight", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    expect(await s.remove()).toEqual({ state: "absent", bytes: MODEL.byteLength });
    const paths = whistlePaths(stateDir);
    expect(existsSync(paths.model)).toBe(false);
    expect(existsSync(paths.manifest)).toBe(false);
    expect(existsSync(paths.dir)).toBe(false);

    // A folder with something of the operator's in it stays.
    await s.start();
    await s.settled();
    writeFileSync(join(paths.dir, "notes.txt"), "mine");
    await s.remove();
    expect(readdirSync(paths.dir)).toEqual(["notes.txt"]);
    rmSync(paths.dir, { recursive: true });

    // A download stopped by a removal is not a failure.
    const stalled = new Promise<void>(() => undefined);
    const slow = createWhistleModelStore({
      stateDir,
      version: "1.20.0",
      pin: PIN,
      accepted: [SHA],
      lookup: PUBLIC,
      fetch: async (_url, init) => {
        await Promise.race([stalled, new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))]);
        throw new Error("unreachable");
      },
    });
    await slow.start();
    expect((await slow.status()).state).toBe("downloading");
    expect(await slow.remove()).toEqual({ state: "absent", bytes: MODEL.byteLength });
    // Its own lock and part file went with it.
    expect(leftovers()).toEqual([]);
  });

  test("remove leaves another process's live download alone, and clears a dead one's", async () => {
    const s = store(fakeFetch().fn);
    await s.start();
    await s.settled();
    const live = otherDownload("theirs, still arriving");
    await s.remove();
    expect(existsSync(whistlePaths(stateDir).model)).toBe(false);
    expect(readFileSync(live.part, "utf8")).toBe("theirs, still arriving");
    expect(existsSync(live.lock)).toBe(true);
    // A crash's part file that no live lock names goes, even beside a live one.
    const crashed = join(whistlePaths(stateDir).dir, whistlePartName(888_888, 1));
    writeFileSync(crashed, "dead");
    await s.remove();
    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(live.part)).toBe(true);

    // Once that lock is past the deadline, both go.
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(live.lock, old, old);
    await s.remove();
    expect(leftovers()).toEqual([]);
    expect(existsSync(whistlePaths(stateDir).dir)).toBe(false);
  });
});

describe("the download's redirects", () => {
  test("a redirect to another https host is followed, by hand, each hop checked", async () => {
    const f = routedFetch({ [PIN.url]: moved("https://cdn.models.invalid/blob?sig=1", 307), "https://cdn.models.invalid/blob?sig=1": modelBody });
    const asked: string[] = [];
    const s = store(f.fn, {
      lookup: async (host) => {
        asked.push(host);
        return ["203.0.113.7", "2001:db8::7"];
      },
    });
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
    expect(f.calls.map((c) => c.url)).toEqual([PIN.url, "https://cdn.models.invalid/blob?sig=1"]);
    expect(f.calls.every((c) => c.init.redirect === "manual")).toBe(true);
    expect(asked).toEqual(["models.invalid", "cdn.models.invalid"]);
  });

  test("a relative Location resolves against the hop it came from", async () => {
    const f = routedFetch({ [PIN.url]: moved("/blob/whistle.cact"), "https://models.invalid/blob/whistle.cact": modelBody });
    const s = store(f.fn);
    await s.start();
    await s.settled();
    expect((await s.status()).state).toBe("ready");
  });

  test(`at most ${WHISTLE_MAX_REDIRECTS} hops`, async () => {
    const chain = (hops: number) => {
      const routes: Record<string, () => Response> = {};
      let at = PIN.url;
      for (let i = 1; i <= hops; i++) {
        const next = `https://cdn.models.invalid/${i}`;
        routes[at] = moved(next);
        at = next;
      }
      routes[at] = modelBody;
      return routedFetch(routes);
    };
    const ok = chain(WHISTLE_MAX_REDIRECTS);
    const fine = store(ok.fn);
    await fine.start();
    await fine.settled();
    expect((await fine.status()).state).toBe("ready");
    await fine.remove();

    resetWhistleModelState();
    const long = chain(WHISTLE_MAX_REDIRECTS + 1);
    const tooMany = store(long.fn);
    await tooMany.start();
    await tooMany.settled();
    expect((await tooMany.status()).reason).toBe("the download was redirected too many times");
    expect(long.calls).toHaveLength(WHISTLE_MAX_REDIRECTS + 1);
    expect(existsSync(whistlePaths(stateDir).model)).toBe(false);
  });

  test("a hop to plain http, or to a local, private, link-local or unique-local address, is refused before it is asked", async () => {
    const refusals: [string, string][] = [
      ["http://cdn.models.invalid/x", "the download was sent to an address that is not https"],
      ["https://localhost/x", "the download was sent to a local or private address"],
      ["https://api.localhost./x", "the download was sent to a local or private address"],
      ["https://127.0.0.1/x", "the download was sent to a local or private address"],
      ["https://2130706433/x", "the download was sent to a local or private address"],
      ["https://10.1.2.3/x", "the download was sent to a local or private address"],
      ["https://100.64.10.1/x", "the download was sent to a local or private address"],
      ["https://169.254.169.254/latest/meta-data", "the download was sent to a local or private address"],
      ["https://192.168.1.1/x", "the download was sent to a local or private address"],
      ["https://[::1]/x", "the download was sent to a local or private address"],
      ["https://[fd12::1]/x", "the download was sent to a local or private address"],
      ["https://[fe80::1]/x", "the download was sent to a local or private address"],
      ["https://[::ffff:127.0.0.1]/x", "the download was sent to a local or private address"],
    ];
    for (const [location, reason] of refusals) {
      resetWhistleModelState();
      const f = routedFetch({ [PIN.url]: moved(location), [location]: modelBody });
      const s = store(f.fn);
      await s.start();
      await s.settled();
      const status = await s.status();
      expect([location, status.reason]).toEqual([location, reason]);
      expect(f.calls).toHaveLength(1);
      expect(existsSync(whistlePaths(stateDir).model)).toBe(false);
    }
  });

  test("a hop whose name resolves to a private address is refused, even when one answer is public", async () => {
    for (const answers of [["192.168.1.20"], ["203.0.113.7", "10.0.0.8"], ["fd00::8"], []]) {
      resetWhistleModelState();
      const f = routedFetch({ [PIN.url]: moved("https://rebind.invalid/x"), "https://rebind.invalid/x": modelBody });
      const s = store(f.fn, { lookup: async (host) => (host === "rebind.invalid" ? answers : ["203.0.113.7"]) });
      await s.start();
      await s.settled();
      const status = await s.status();
      expect(status.reason).toBe("the download was sent to a local or private address");
      // Neither the address nor the upstream's body reaches the reason.
      for (const answer of answers) expect(status.reason).not.toContain(answer);
      expect(status.reason).not.toContain("upstream body");
      expect(f.calls).toHaveLength(1);
    }
  });

  test("the pinned address itself is held to the same rule", async () => {
    const f = fakeFetch();
    const s = store(f.fn, { pin: { ...PIN, url: "https://127.0.0.1/whistle.cact" } });
    await s.start();
    await s.settled();
    expect((await s.status()).reason).toBe("the download was sent to a local or private address");
    expect(f.calls).toHaveLength(0);
  });

  test("a resolver that never answers ends at the download's deadline", async () => {
    const f = fakeFetch();
    const s = store(f.fn, { lookup: () => new Promise<readonly string[]>(() => undefined), timeoutMs: 100 });
    await s.start();
    await s.settled();
    expect((await s.status()).reason).toBe("the download took too long");
    expect(f.calls).toHaveLength(0);
    expect(leftovers()).toEqual([]);
  });

  test("a redirect with no Location fails with its status and nothing else", async () => {
    const f = routedFetch({ [PIN.url]: () => new Response("upstream body text", { status: 301 }) });
    const s = store(f.fn);
    await s.start();
    await s.settled();
    expect((await s.status()).reason).toBe("the download answered HTTP 301 with no usable address");
  });

  test("which addresses count as public", () => {
    for (const address of ["203.0.113.7", "8.8.8.8", "2001:db8::1", "2606:4700::1111"]) expect([address, isPublicAddress(address)]).toEqual([address, true]);
    for (const address of ["0.0.0.0", "127.0.0.1", "10.0.0.1", "100.100.100.100", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "not an address"]) {
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
  });
});

describe("the engine files", () => {
  test("the served copy is preferred, and the vendored copy is the source-mode fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-whistle-root-"));
    const vendored = whistleEngineDir(root);
    expect(vendored).toContain(join("web", "public", "stt"));
    expect(whistleEngineInPlace(root)).toBe(false);
    const served = vendored.replace(join("web", "public"), join("web", "dist"));
    mkdirSync(served, { recursive: true });
    writeFileSync(join(served, "needle.js"), "x");
    expect(whistleEngineDir(root)).toBe(served);
    // Present but not the pinned size: not in place.
    writeFileSync(join(served, "needle.wasm"), "y");
    expect(whistleEngineInPlace(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("this checkout's vendored engine is in place", () => {
    expect(whistleEngineInPlace(join(import.meta.dir, "..", ".."))).toBe(true);
  });
});
