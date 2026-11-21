import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "../owner-only.ts";
import type { AgentView, WorkspaceView } from "../types.ts";
import { FACT_SESSIONS_MAX, FACT_SESSIONS_MAX_BYTES, parseFacts, TRICK_CONTRACT, TRICK_CONTRACT_DEFAULT } from "../../web/src/lib/tricks/schema.ts";
import { CODE_FILES_MAX, diskTrickFs, trickCodeHash, type TrickFs } from "./code-hash.ts";
import { createTrickScanner, MANIFEST_BYTES_MAX, readManifestText } from "./discover.ts";
import { buildFacts, crewFactsWorld, factsWorldOf } from "./facts.ts";
import { switchesPath } from "./paths.ts";
import { TRICKS_ROUTE_RIGHTS, tricksAutoRoute, tricksCodeRoute, tricksMediaRoute, tricksSwitchRoute, tricksTapRoute, tricksUndoRoute, parseSince } from "./routes.ts";
import type { TricksSurface } from "./service.ts";
import { createSwitchReader, parseSwitches, renderSwitches, SWITCH_LOCK_BLANK_MS, type LockFs, updateSwitches, withApproval, withEntry, withSwitch, withSwitchLock, writeSwitches } from "./switches.ts";

const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-units-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("the switch file", () => {
  test("written at 0600 in a 0700 folder, read back, off by default", async () => {
    const stateDir = await tempDir();
    // Windows: the bridge gives the state dir an owner-only access list at start (M43 spec 04), and what
    // the store writes inherits it. NTFS has no 0600 or 0700, so the check reads that list instead.
    if (process.platform === "win32") ensureOwnerOnlyDir(stateDir, HOST, { root: privateRoot("state"), repair: true });
    const warnings: string[] = [];
    const read = createSwitchReader(stateDir, (l) => warnings.push(l));
    expect((await read()).on.size).toBe(0);
    await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-08T09:00:00.000Z", HASH));
    for (const [path, mode] of [[switchesPath(stateDir), 0o600], [join(stateDir, "tricks"), 0o700]] as const) {
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(mode);
      else expect(isOwnerOnly(path, HOST)).toEqual({ state: "private" });
    }
    expect([...(await read()).on.entries()]).toEqual([["legs", { at: "2026-11-08T09:00:00.000Z", hash: HASH, auto: false, by: "cli", powers: null }]]);
    expect(warnings).toEqual([]);
  });

  test("a file that does not parse reads as every trick off, with one warning per change", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"));
    await writeFile(switchesPath(stateDir), "{ not json");
    const warnings: string[] = [];
    const read = createSwitchReader(stateDir, (l) => warnings.push(l));
    expect((await read()).on.size).toBe(0);
    expect((await read()).on.size).toBe(0);
    expect(warnings.length).toBe(1);
  });

  test("render is layout 3 as version 2 (B4) and stable, on/off round-trips, and switching on again stores the new hash", () => {
    const one = withSwitch({ on: new Map() }, "b", true, "t1", HASH);
    const two = withSwitch(one, "a", true, "t2");
    const entry = (at: string, hash: string | null) => `{\n      "at": "${at}",\n      "hash": ${hash === null ? "null" : `"${hash}"`},\n      "auto": false,\n      "by": "cli",\n      "powers": null\n    }`;
    expect(renderSwitches(two)).toBe(`{\n  "v": 2,\n  "layout": 3,\n  "on": {\n    "a": ${entry("t2", null)},\n    "b": ${entry("t1", HASH)}\n  }\n}\n`);
    expect(parseSwitches(renderSwitches(two)).switches.on.get("b")).toEqual({ at: "t1", hash: HASH, auto: false, by: "cli", powers: null });
    expect(parseSwitches(renderSwitches(two)).switches.version).toBe(3);
    expect(withSwitch(two, "b", true, "later", HASH2).on.get("b")).toEqual({ at: "later", hash: HASH2, auto: false, by: "cli", powers: null });
    expect([...withSwitch(two, "a", false, "x").on.keys()]).toEqual(["b"]);
  });

  test("a version 3 entry keeps auto, by, powers, previous and declined through a round trip", () => {
    const set = withApproval({ on: new Map() }, "legs", { at: "t1", hash: HASH, by: "cli", powers: "0123456789abcdef" });
    const auto = withEntry(set, "legs", { ...set.on.get("legs")!, auto: true });
    const next = withApproval(auto, "legs", { at: "t2", hash: HASH2, by: "auto", powers: "0123456789abcdef" });
    const declined = withEntry(next, "legs", { ...next.on.get("legs")!, declined: HASH });
    const back = parseSwitches(renderSwitches(declined)).switches.on.get("legs");
    expect(back).toEqual({ at: "t2", hash: HASH2, auto: true, by: "auto", powers: "0123456789abcdef", previous: { hash: HASH, at: "t1", by: "cli", powers: "0123456789abcdef" }, declined: HASH });
    // Approving the same hash again keeps the earlier `previous`; a new approval clears a decline.
    expect(withApproval(declined, "legs", { at: "t3", hash: HASH2, by: "phone", powers: null }).on.get("legs")?.previous?.hash).toBe(HASH);
    expect(withApproval(declined, "legs", { at: "t3", hash: HASH2, by: "phone", powers: null }).on.get("legs")?.declined).toBeUndefined();
  });

  test("a version 1 and a version 2 file still read, with their version; a newer one reads as all off", () => {
    const v1 = parseSwitches('{ "v": 1, "on": { "legs": "2026-11-08T09:00:00Z" } }');
    expect(v1.problem).toBeNull();
    expect(v1.switches.version).toBe(1);
    expect(v1.switches.on.get("legs")).toEqual({ at: "2026-11-08T09:00:00Z", hash: null, auto: false, by: "cli", powers: null });
    const v2 = parseSwitches(`{ "v": 2, "on": { "legs": { "at": "t", "hash": "${HASH}" } } }`);
    expect(v2.switches.version).toBe(2);
    expect(v2.switches.on.get("legs")?.hash).toBe(HASH);
    const v4 = parseSwitches('{ "v": 4, "on": { "legs": { "at": "t" } } }');
    expect(v4.switches.on.size).toBe(0);
    expect(v4.problem).toContain("not a version 1, 2 or 3");
  });

  test("two writers at once both land: each re-reads the file under the lock", async () => {
    const stateDir = await tempDir();
    await Promise.all(["a", "b", "c", "d"].map((id) => updateSwitches(stateDir, (now) => withSwitch(now, id, true, "t", HASH))));
    expect([...parseSwitches(readFileSync(switchesPath(stateDir), "utf8")).switches.on.keys()].toSorted()).toEqual(["a", "b", "c", "d"]);
    expect(existsSync(`${switchesPath(stateDir)}.lock`)).toBe(false);
  });

  test("a lock left by a writer that died is taken over at once", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    // The pid line alone, as an older build wrote it, and no age: a dead pid is the whole rule.
    await writeFile(lock, `${String(await deadPid())}\n`);
    await updateSwitches(stateDir, (now) => withSwitch(now, "legs", true, "t", HASH));
    expect(parseSwitches(readFileSync(switchesPath(stateDir), "utf8")).switches.on.has("legs")).toBe(true);
    expect(await leftovers(stateDir)).toEqual(["switches.json"]);
  });

  test("counsel A1: waiters that all find a stale lock take it one at a time", async () => {
    // Repeated, because the old take-overs (stat then unlink, then rename aside) lost the race only on some interleavings.
    const dead = await deadPid();
    for (let round = 0; round < 5; round += 1) {
      const stateDir = await tempDir();
      await mkdir(join(stateDir, "tricks"), { recursive: true });
      const lock = `${switchesPath(stateDir)}.lock`;
      await writeFile(lock, `${String(dead)}\nlong-dead-nonce\n`);
      const { most, done } = await race(stateDir, 8);
      expect(done).toBe(8);
      expect(most).toBe(1);
      expect(existsSync(lock)).toBe(false);
      // No door, prepared lock or temp file is left behind.
      expect(await leftovers(stateDir)).toEqual([]);
    }
  });

  test("counsel A1, third pass: a holder killed inside the lock is taken over by one waiter at a time", async () => {
    const stateDir = await tempDir();
    const lock = `${switchesPath(stateDir)}.lock`;
    const child = await holder(stateDir, 60_000);
    child.kill("SIGKILL");
    await child.exited;
    expect(readFileSync(lock, "utf8").startsWith(`${String(child.pid)}\n`)).toBe(true);
    const { most, done } = await race(stateDir, 6);
    expect(done).toBe(6);
    expect(most).toBe(1);
    expect(await leftovers(stateDir)).toEqual([]);
  }, 20_000);

  test("counsel A1, third pass: a door left by a dead waiter is cleared; a live waiter's door is waited for", async () => {
    const dead = await deadPid();
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    await writeFile(lock, `${String(dead)}\ndead-holder\n`);
    await writeFile(`${lock}.takeover`, `${String(dead)}\ndead-waiter\n`);
    await withSwitchLock(stateDir, async () => {});
    expect(await leftovers(stateDir)).toEqual([]);

    await writeFile(lock, `${String(dead)}\ndead-holder\n`);
    // A live waiter (this process, another nonce) holds the door: nobody else replaces the lock meanwhile.
    await writeFile(`${lock}.takeover`, `${String(process.pid)}\nlive-waiter\n`);
    let entered = false;
    const pending = withSwitchLock(stateDir, async () => {
      entered = true;
    });
    await Bun.sleep(200);
    expect(entered).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(`${String(dead)}\ndead-holder\n`);
    await rm(`${lock}.takeover`);
    await pending;
    expect(entered).toBe(true);
    expect(await leftovers(stateDir)).toEqual([]);
  });

  test("counsel A1: the lock file carries the holder's nonce beside its pid", async () => {
    const stateDir = await tempDir();
    const lock = `${switchesPath(stateDir)}.lock`;
    let text = "";
    await withSwitchLock(stateDir, async () => {
      text = readFileSync(lock, "utf8");
    });
    const [pid, nonce, rest] = text.split("\n");
    expect(pid).toBe(String(process.pid));
    expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(rest).toBe("");
  });

  test("counsel A1: a release with a foreign nonce leaves the lock alone", async () => {
    const stateDir = await tempDir();
    const lock = `${switchesPath(stateDir)}.lock`;
    await withSwitchLock(stateDir, async () => {
      // The lock was taken over while this writer was slow: another holder's file stands at the path.
      await writeFile(lock, "4242\nforeign-nonce\n");
    });
    expect(readFileSync(lock, "utf8")).toBe("4242\nforeign-nonce\n");
  });

  test("counsel A1: a release removes its own lock, also when the work throws", async () => {
    const stateDir = await tempDir();
    const lock = `${switchesPath(stateDir)}.lock`;
    await expect(
      withSwitchLock(stateDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });

  test("counsel A1: a live lock is waited for, not taken, and so is one that does not read as a lock", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    // This process's pid with another nonce: a holder that is alive. Then an empty file and one with no pid.
    for (const text of [`${String(process.pid)}\nlive-nonce\n`, "", "held"]) {
      await writeFile(lock, text);
      // A fake clock: the first reading puts the end of the wait far in the past, so the wait ends at once.
      let reads = 0;
      const clock = () => (reads++ === 0 ? Date.now() - 100_000 : Date.now());
      await expect(withSwitchLock(stateDir, async () => "never", clock)).rejects.toThrow("locked by another writer");
      expect(readFileSync(lock, "utf8")).toBe(text);
    }
  });

  test("counsel A1, blank locks: a fresh empty or pid-less lock makes every waiter fail and is left alone", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    for (const text of ["", "held"]) {
      await writeFile(lock, text);
      let entered = 0;
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => {
          // Each waiter's wait ends at once (first reading far in the past); the lock's age reads real time.
          let reads = 0;
          const clock = () => (reads++ === 0 ? Date.now() - 100_000 : Date.now());
          return withSwitchLock(
            stateDir,
            async () => {
              entered += 1;
            },
            clock,
          );
        }),
      );
      expect(entered).toBe(0);
      expect(results.every((result) => result.status === "rejected" && String(result.reason).includes("locked by another writer"))).toBe(true);
      expect(readFileSync(lock, "utf8")).toBe(text);
    }
  });

  test("counsel A1, blank locks: an empty or pid-less lock older than 30 s is taken over by one waiter at a time", async () => {
    const old = new Date(Date.now() - SWITCH_LOCK_BLANK_MS - 5000);
    for (const text of ["", "held"]) {
      const stateDir = await tempDir();
      await mkdir(join(stateDir, "tricks"), { recursive: true });
      const lock = `${switchesPath(stateDir)}.lock`;
      await writeFile(lock, text);
      await utimes(lock, old, old);
      const { most, done } = await race(stateDir, 6);
      expect(done).toBe(6);
      expect(most).toBe(1);
      expect(await leftovers(stateDir)).toEqual([]);
    }
  });

  test("Windows: a rename over the lock refused twice with EPERM is tried again; the waiter gets the lock and leaves nothing", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    await writeFile(lock, `${String(await deadPid())}\ndead-holder\n`);
    const fs = refusing({ rename: 2 });
    let entered = false;
    await withSwitchLock(
      stateDir,
      async () => {
        entered = true;
        expect(readFileSync(lock, "utf8").startsWith(`${String(process.pid)}\n`)).toBe(true);
      },
      Date.now,
      fs,
    );
    expect(entered).toBe(true);
    expect(fs.refused.rename).toBe(2);
    expect(await leftovers(stateDir)).toEqual([]);
  });

  test("Windows: a link onto the lock and its release refused with EBUSY and EACCES are tried again", async () => {
    const stateDir = await tempDir();
    const fs = refusing({ link: 2, unlinkLock: 1 });
    await withSwitchLock(stateDir, async () => {}, Date.now, fs);
    expect(fs.refused.link).toBe(2);
    expect(fs.refused.unlinkLock).toBe(1);
    expect(await leftovers(stateDir)).toEqual([]);
  });

  test("counsel A1, blank locks: an old empty door is cleared, a fresh empty door is waited for", async () => {
    const dead = await deadPid();
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    const door = `${lock}.takeover`;
    await writeFile(lock, `${String(dead)}\ndead-holder\n`);
    await writeFile(door, "");
    const old = new Date(Date.now() - SWITCH_LOCK_BLANK_MS - 5000);
    await utimes(door, old, old);
    await withSwitchLock(stateDir, async () => {});
    expect(await leftovers(stateDir)).toEqual([]);

    await writeFile(lock, `${String(dead)}\ndead-holder\n`);
    await writeFile(door, "");
    let entered = false;
    const pending = withSwitchLock(stateDir, async () => {
      entered = true;
    });
    await Bun.sleep(200);
    expect(entered).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(`${String(dead)}\ndead-holder\n`);
    await rm(door);
    await pending;
    expect(entered).toBe(true);
    expect(await leftovers(stateDir)).toEqual([]);
  });
});

/** A lock file system that refuses the first `n` calls of a kind as Windows does when another handle has the file open. */
function refusing(limits: { rename?: number; link?: number; unlinkLock?: number }) {
  const refused = { rename: 0, link: 0, unlinkLock: 0 };
  const no = (code: string): Error => Object.assign(new Error(`${code}: operation not permitted`), { code });
  const fs: LockFs & { refused: typeof refused } = {
    refused,
    rename: async (from, to) => {
      if (refused.rename < (limits.rename ?? 0)) {
        refused.rename += 1;
        throw no("EPERM");
      }
      await rename(from, to);
    },
    link: async (from, to) => {
      if (refused.link < (limits.link ?? 0)) {
        refused.link += 1;
        throw no("EBUSY");
      }
      await link(from, to);
    },
    unlink: async (path) => {
      if (path.endsWith(".lock") && refused.unlinkLock < (limits.unlinkLock ?? 0)) {
        refused.unlinkLock += 1;
        throw no("EACCES");
      }
      await unlink(path);
    },
  };
  return fs;
}

/** The pid of a process that ran and was reaped: no process has it now (a reuse in the test's few ms is not expected). */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

/** The files left in `<stateDir>/tricks`, sorted. */
async function leftovers(stateDir: string): Promise<string[]> {
  return (await readdir(join(stateDir, "tricks"))).toSorted();
}

/** `n` writers at once on the switch lock, each inside for 10 ms: how many were ever inside together, and how many finished. */
async function race(stateDir: string, n: number): Promise<{ most: number; done: number }> {
  let inside = 0;
  let most = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, () =>
      withSwitchLock(stateDir, async () => {
        inside += 1;
        most = Math.max(most, inside);
        await Bun.sleep(10);
        inside -= 1;
        done += 1;
      }),
    ),
  );
  return { most, done };
}

/** A child process that takes the switch lock and holds it for `ms`; answered once it holds it. */
async function holder(stateDir: string, ms: number): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
  const code = `import { withSwitchLock } from ${JSON.stringify(join(import.meta.dir, "switches.ts"))};
await withSwitchLock(${JSON.stringify(stateDir)}, async () => { console.log("held"); await Bun.sleep(${String(ms)}); });`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!seen.includes("held")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the holder exited before it held the lock: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return child;
}

/** A trick folder under `root` with a manifest and files (nested paths allowed). */
async function trickDir(root: string, id: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), `id = "${id}"\nname = "${id}"\nrun = "./p.sh"\nplaces = ["belt"]\n`);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

/** A file system that counts reads of `trick.toml`. */
function counting() {
  let reads = 0;
  const fs: TrickFs = {
      ...diskTrickFs,
      read: (p, max) => {
        if (p.endsWith("trick.toml")) reads += 1;
        return diskTrickFs.read(p, max);
      },
  };
  return { fs, reads: () => reads };
}

describe("discovery", () => {
  test("a manifest is parsed again only when the folder's fingerprint moves", async () => {
    const root = await tempDir();
    await trickDir(root, "legs");
    const { fs, reads } = counting();
    // A clock past the racy window of every write (stat-held.ts), so a settled read is reused.
    const scanner = createTrickScanner(root, { fs, now: () => Date.now() + 10_000 });
    const first = await scanner.scan();
    expect(first.tricks[0]?.manifest?.name).toBe("legs");
    // Once for the manifest, once for the code hash.
    expect(reads()).toBe(2);
    await scanner.scan();
    expect(reads()).toBe(2);
    await Bun.sleep(5);
    await writeFile(join(root, "legs", "trick.toml"), 'id = "legs"\nname = "Legs 2"\nrun = "./x"\nplaces = ["belt"]\n');
    const third = await scanner.scan();
    expect(reads()).toBe(4);
    expect(third.tricks[0]?.manifest?.name).toBe("Legs 2");
  });

  test("a log, media/ and captures/ move nothing; code moves the code hash; config.toml moves only its own hash", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "legs", { "p.sh": "#!/bin/sh\n", "lib/util.sh": "x=1\n", "config.toml": "a = 1\n" });
    const { fs, reads } = counting();
    const scanner = createTrickScanner(root, { fs, now: () => Date.now() + 10_000 });
    const first = (await scanner.scan()).tricks[0]!;
    expect(first.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.configHash).toMatch(/^[0-9a-f]{64}$/);
    await Bun.sleep(5);
    await writeFile(join(dir, "run.log"), "a line\n");
    await mkdir(join(dir, "media"));
    await writeFile(join(dir, "media", "shot.png"), "png");
    await mkdir(join(dir, "captures"));
    await writeFile(join(dir, "captures", "c.json"), "{}");
    await writeFile(join(dir, ".cache"), "x");
    const quiet = (await scanner.scan()).tricks[0]!;
    expect(quiet).toBe(first);
    expect(reads()).toBe(2);
    await writeFile(join(dir, "config.toml"), "a = 2\n");
    const configured = (await scanner.scan()).tricks[0]!;
    expect(configured.codeHash).toBe(first.codeHash);
    expect(configured.configHash).not.toBe(first.configHash);
    await writeFile(join(dir, "lib", "util.sh"), "x=2\n");
    const edited = (await scanner.scan()).tricks[0]!;
    expect(edited.codeHash).not.toBe(first.codeHash);
    expect((await trickCodeHash(dir)).ok && (await trickCodeHash(dir))).toEqual({ ok: true, hash: edited.codeHash! });
  });

  test("B3: a symlink is refused, never followed: the row says why and the trick has no code hash", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "legs");
    const outside = join(root, "outside.sh");
    await writeFile(outside, "one\n");
    await symlink(outside, join(dir, "p.sh"));
    expect(await trickCodeHash(dir)).toMatchObject({ ok: false, code: "link" });
    const found = (await createTrickScanner(root).scan()).tricks[0]!;
    expect(found.codeHash).toBeUndefined();
    expect(found.manifest).toBeUndefined();
    expect(found.refusals.map((r) => r.reason)).toContain("p.sh is a symbolic link. A trick holds regular files only: put the file itself there.");
  });

  test("more than 2000 files refuses the trick with a reason", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "big");
    await mkdir(join(dir, "lib"));
    await Promise.all(Array.from({ length: CODE_FILES_MAX + 1 }, (_, i) => writeFile(join(dir, "lib", `f${String(i)}.ts`), "")));
    const found = (await createTrickScanner(root).scan()).tricks[0]!;
    expect(found.manifest).toBeUndefined();
    expect(found.refusals.at(-1)?.reason).toContain(`more than ${String(CODE_FILES_MAX)} files`);
  });

  test.skipIf(process.platform === "win32")("a FIFO as trick.toml or config.toml is refused and never hangs the scan", async () => {
    const root = await tempDir();
    const dir = join(root, "fifo");
    await mkdir(dir);
    expect(Bun.spawnSync(["mkfifo", join(dir, "trick.toml")]).exitCode).toBe(0);
    const other = await trickDir(root, "other", { "p.sh": "" });
    expect(Bun.spawnSync(["mkfifo", join(other, "config.toml")]).exitCode).toBe(0);
    const scan = await createTrickScanner(root, { timeoutMs: 2000 }).scan();
    expect(scan.kept).toBeUndefined();
    expect(scan.tricks.find((t) => t.id === "fifo")?.refusals[0]?.reason).toBe("trick.toml is not a regular file.");
    const found = scan.tricks.find((t) => t.id === "other");
    expect(found?.manifest).toBeUndefined();
    expect(found?.refusals.map((r) => r.reason)).toContain("config.toml is not a regular file.");
  });

  test("a trick.toml over 64 KiB is refused unread", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "huge");
    await writeFile(join(dir, "trick.toml"), `# ${"x".repeat(MANIFEST_BYTES_MAX)}\n`);
    const found = (await createTrickScanner(root).scan()).tricks[0]!;
    expect(found.manifest).toBeUndefined();
    expect(found.refusals[0]).toMatchObject({ code: "size", reason: "trick.toml is larger than 64 KiB." });
  });

  test("a scan that runs over keeps the last good result, and no second scan starts while it hangs", async () => {
    const root = await tempDir();
    await trickDir(root, "legs");
    let hang = false;
    let lists = 0;
    const stuck: TrickFs = {
      ...diskTrickFs,
      list: (dir) => {
        if (dir === root) lists += 1;
        return hang && dir === root ? new Promise(() => {}) : diskTrickFs.list(dir);
      },
    };
    const warnings: string[] = [];
    const scanner = createTrickScanner(root, { fs: stuck, timeoutMs: 50, warn: (l) => warnings.push(l) });
    const good = await scanner.scan();
    hang = true;
    const kept = await scanner.scan();
    expect(kept.kept).toContain("longer than");
    expect(kept.tricks).toEqual(good.tricks);
    const again = await scanner.scan();
    expect(again.kept).toContain("still running");
    expect(lists).toBe(2);
    expect(warnings.length).toBe(2);
  });

  test("only ENOENT means no tricks; any other listing error keeps the last scan", async () => {
    const root = await tempDir();
    await trickDir(root, "legs");
    let fail = false;
    const flaky: TrickFs = { ...diskTrickFs, list: (dir) => (fail && dir === root ? Promise.resolve({ ok: false, missing: false, error: "EACCES" }) : diskTrickFs.list(dir)) };
    const scanner = createTrickScanner(root, { fs: flaky });
    const good = await scanner.scan();
    fail = true;
    const kept = await scanner.scan();
    expect(kept.kept).toContain("EACCES");
    expect(kept.tricks.map((t) => t.id)).toEqual(["legs"]);
    expect(good.exists).toBe(true);
    expect(await createTrickScanner("/nonexistent/collie-tricks").scan()).toEqual({ exists: false, tricks: [] });
  });

  test("no folder is `exists: false`; TOML that does not parse is one refusal", async () => {
    expect(await createTrickScanner("/nonexistent/collie-tricks").scan()).toEqual({ exists: false, tricks: [] });
    const read = readManifestText("id = ", "x");
    expect(read.manifest).toBeUndefined();
    expect(read.refusals[0]?.reason).toStartWith("trick.toml is not TOML");
    expect(readManifestText(null, "x").refusals[0]?.code).toBe("missing");
  });

  test("the folder name must match the id", () => {
    const read = readManifestText('id = "legs"\nname = "L"\nrun = "./x"\nplaces = ["belt"]\n', "other");
    expect(read.manifest).toBeUndefined();
    expect(read.refusals[0]?.path).toBe("/id");
  });

  test("env in the manifest: names only, each one listed once", () => {
    const read = readManifestText('id = "x"\nname = "X"\nrun = "./x"\nplaces = ["belt"]\nenv = ["GH_TOKEN", "GH_TOKEN", "DBUS_SESSION_BUS_ADDRESS"]\n', "x");
    expect(read.manifest?.env).toEqual(["GH_TOKEN", "DBUS_SESSION_BUS_ADDRESS"]);
    const bad = readManifestText('id = "x"\nname = "X"\nrun = "./x"\nplaces = ["belt"]\nenv = ["1BAD"]\n', "x");
    expect(bad.manifest).toBeUndefined();
    expect(bad.refusals[0]?.path).toBe("/env/0");
  });
});

const pane = (over: Partial<AgentView>): AgentView => ({
  paneId: "w6X:3",
  workspaceId: "w6X",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w6X:t1",
  agent: "claude",
  status: "working",
  cwd: "/work/collie",
  focused: false,
  ...over,
});
function space(label: string, folder?: string): WorkspaceView {
  const ws: WorkspaceView = { workspaceId: label, number: 1, label, focused: false, activeTabId: "t", tabCount: 1, paneCount: 1 };
  if (folder !== undefined) ws.folder = folder;
  return ws;
}

describe("the facts", () => {
  test("sessions by scope key, spaces with folders, and the document the schema reads back", () => {
    const world = factsWorldOf({
      memberId: "lodge-hc",
      machine: "lodge",
      runtimes: [
        {
          name: "default",
          agents: [pane({ paneLabel: "composer", tabLabel: "fix", agentSession: { kind: "path", value: "/secret/path.jsonl" } })],
          shellPanes: [pane({ paneId: "w6X:4", kind: "shell", agent: "shell", status: "idle", workspaceLabel: "home" })],
          workspaces: [space("collie", "/work/collie-workspace"), space("home")],
        },
        { name: "yt", agents: [], shellPanes: [], workspaces: [] },
      ],
      folderOf: (name) => (name === "yt" ? "/work/yt" : undefined),
      labelOf: (name) => (name === "yt" ? "YouTube" : undefined),
      activeAt: () => Date.parse("2026-11-08T09:41:00Z"),
    });
    expect(world.sessions).toEqual([
      {
        id: "lodge-hc:w6X:3",
        memberId: "lodge-hc",
        sessionId: "lodge-hc:w6X:3",
        paneId: "w6X:3",
        host: "lodge",
        status: "working",
        name: "composer",
        agent: "claude",
        cwd: "/work/collie",
        space: "collie",
        tab: "fix",
        lastActiveAt: "2026-11-08T09:41:00.000Z",
      },
      { id: "lodge-hc:w6X:4", memberId: "lodge-hc", sessionId: "lodge-hc:w6X:4", paneId: "w6X:4", host: "lodge", status: "idle", name: "shell", cwd: "/work/collie", space: "home", lastActiveAt: "2026-11-08T09:41:00.000Z" },
    ]);
    expect(world.spaces).toEqual([{ name: "collie", folder: "/work/collie-workspace" }, { name: "home" }, { name: "YouTube", folder: "/work/yt" }]);
    expect(world.memberId).toBe("lodge-hc");
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(JSON.stringify(facts)).not.toContain("/secret/path.jsonl");
    const back = parseFacts(JSON.parse(JSON.stringify(facts)));
    expect(back.refusals).toEqual([]);
    expect(back.facts).toEqual(facts);
    // The member id is the key a program keeps; `host` is the machine's name, for display only.
    expect(facts.memberId).toBe("lodge-hc");
    expect(facts.host).toBe("lodge");
    // One contract number on the facts, no `v` beside it: the trick's own, 1 when it names none.
    expect(facts.contract).toBe(TRICK_CONTRACT_DEFAULT);
    expect(buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" }, TRICK_CONTRACT).contract).toBe(TRICK_CONTRACT);
    expect(Object.keys(facts)).not.toContain("v");
  });

  test("a solo install keys its sessions on its install id, never on the host name", () => {
    const world = factsWorldOf({
      memberId: "m_k3x9q2w7ab",
      machine: "lodge.lan",
      runtimes: [{ name: "default", agents: [pane({})], shellPanes: [], workspaces: [] }],
    });
    expect(world.sessions[0]).toMatchObject({ id: "m_k3x9q2w7ab:w6X:3", memberId: "m_k3x9q2w7ab", sessionId: "m_k3x9q2w7ab:w6X:3", host: "lodge.lan" });
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(facts).toMatchObject({ memberId: "m_k3x9q2w7ab", host: "lodge.lan" });
    expect(JSON.stringify(facts)).not.toContain('"lodge.lan:');
    expect(parseFacts(JSON.parse(JSON.stringify(facts))).refusals).toEqual([]);
    // A solo bridge's facts carry no crew field.
    expect(Object.keys(facts)).not.toContain("sessionsOmitted");
    expect(Object.keys(world.sessions[0] ?? {})).not.toContain("reachable");
  });
});

describe("the facts on a crew's lead (M99 slice 5)", () => {
  const own = factsWorldOf({ memberId: "lodge", machine: "lodge", runtimes: [{ name: "default", agents: [pane({})], shellPanes: [], workspaces: [space("collie", "/work/collie")] }] });
  const isOwn = (id: string): boolean => id === "lodge";

  test("every member's sessions, each with its own memberId, its machine's name and reachable; the lead's first", () => {
    const world = crewFactsWorld(
      own,
      [
        { memberId: "workshop", name: "workshop", reachable: true, body: { agents: [pane({ paneId: "%1", paneLabel: "builder" })], shellPanes: [pane({ paneId: "%2", kind: "shell", agent: "shell" })] } },
        { memberId: "laptop", name: "laptop", reachable: false, body: { agents: [pane({ paneId: "w1:2" })], shellPanes: [] } },
        { memberId: "fresh", name: "fresh", reachable: false, body: null },
      ],
      isOwn,
    );
    expect(world.sessions.map((s) => [s.id, s.memberId, s.host, s.reachable])).toEqual([
      ["lodge:w6X:3", "lodge", "lodge", true],
      ["workshop:%1", "workshop", "workshop", true],
      ["workshop:%2", "workshop", "workshop", true],
      ["laptop:w1:2", "laptop", "laptop", false],
    ]);
    // The spaces stay the lead's own.
    expect(world.spaces).toEqual(own.spaces);
    // A trick tells its own sessions from the others by memberId.
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(facts.sessions.filter((s) => s.memberId === facts.memberId).map((s) => s.id)).toEqual(["lodge:w6X:3"]);
    const back = parseFacts(JSON.parse(JSON.stringify(facts)));
    expect(back.refusals).toEqual([]);
    expect(back.facts).toEqual(facts);
  });

  test("no member can pose as the lead: a contribution under the lead's own id is skipped", () => {
    const world = crewFactsWorld(own, [{ memberId: "lodge", name: "imposter", reachable: true, body: { agents: [pane({ paneId: "w6X:9" })], shellPanes: [] } }], isOwn);
    expect(world.sessions.map((s) => s.id)).toEqual(["lodge:w6X:3"]);
  });

  test("past the session count or the byte cap the rest are left out and counted, never the lead's own", () => {
    const many = Array.from({ length: FACT_SESSIONS_MAX + 5 }, (_, i) => pane({ paneId: `%${String(i)}` }));
    const world = crewFactsWorld(own, [{ memberId: "workshop", name: "workshop", reachable: true, body: { agents: many, shellPanes: [] } }], isOwn);
    expect(world.sessions).toHaveLength(FACT_SESSIONS_MAX);
    expect(world.sessions[0]?.id).toBe("lodge:w6X:3");
    expect(world.sessionsOmitted).toBe(6);
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(facts.sessionsOmitted).toBe(6);
    expect(parseFacts(JSON.parse(JSON.stringify(facts))).facts?.sessionsOmitted).toBe(6);

    const wide = Array.from({ length: 200 }, (_, i) => pane({ paneId: `%${String(i)}`, cwd: `/${"x".repeat(4000)}` }));
    const heavy = crewFactsWorld(own, [{ memberId: "workshop", name: "workshop", reachable: true, body: { agents: wide, shellPanes: [] } }], isOwn);
    const bytes = new TextEncoder().encode(JSON.stringify(heavy.sessions)).length;
    expect(bytes).toBeLessThanOrEqual(FACT_SESSIONS_MAX_BYTES + heavy.sessions.length + 2);
    expect(heavy.sessionsOmitted).toBe(201 - heavy.sessions.length);
  });
});

describe("the routes", () => {
  test("since is a whole number or every part", () => {
    expect(parseSince(null)).toBeUndefined();
    expect(parseSince("0")).toBe(0);
    expect(parseSince("1762595000123")).toBe(1762595000123);
    expect(parseSince("-1")).toBeUndefined();
    expect(parseSince("1e3")).toBeUndefined();
    expect(parseSince("99999999999999999")).toBeUndefined();
  });

  test("the tap path is decoded and handed on", async () => {
    const calls: [string, string][] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      switchedOn: () => true,
      switchTo: () => null,
      gateLine: () => null,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      sessionPanes: () => undefined,
      tap: async (host, id) => {
        calls.push([host, id]);
        return { status: 404, body: { error: "unknown-trick" } };
      },
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      media: async () => null,
      code: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/tap$/;
    const match = route.exec("/api/tricks/lod%67e/legs/tap");
    if (match === null) throw new Error("no match");
    await tricksTapRoute(surface, match, {});
    expect(calls).toEqual([["lodge", "legs"]]);
    const broken = route.exec("/api/tricks/%E0%A4%A/legs/tap");
    if (broken === null) throw new Error("no match");
    expect(await tricksTapRoute(surface, broken, {})).toEqual({ status: 404, body: { error: "unknown-host" } });
  });

  test("the switch path is decoded, the body must be exactly { on: boolean }", async () => {
    const calls: [string, string, boolean][] = [];
    const hashes: (string | null)[] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      switchedOn: () => true,
      switchTo: () => null,
      gateLine: () => null,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async (host, id, on, hash) => {
        if (calls.length > 0 || hash !== undefined) hashes.push(hash ?? null);
        calls.push([host, id, on]);
        return { status: 404, body: { error: "unknown-trick" } };
      },
      media: async () => null,
      code: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/switch$/;
    const match = route.exec("/api/tricks/lod%67e/legs/switch");
    if (match === null) throw new Error("no match");
    await tricksSwitchRoute(surface, match, { on: false });
    expect(calls).toEqual([["lodge", "legs", false]]);
    for (const body of [undefined, null, [], {}, { on: "yes" }, { on: true, extra: 1 }]) {
      expect(await tricksSwitchRoute(surface, match, body)).toEqual({ status: 400, body: { error: "switch-invalid" } });
    }
    expect(calls.length).toBe(1);
    // Review 8 V-N1: a switch on names the code the person read; the route passes it on, null when absent.
    const hash = "a".repeat(64);
    await tricksSwitchRoute(surface, match, { on: true, hash });
    await tricksSwitchRoute(surface, match, { on: true });
    expect(hashes).toEqual([null, hash, null]);
    for (const body of [{ on: true, hash: 3 }, { on: true, hash: "short" }, { on: true, hash, extra: 1 }]) {
      expect(await tricksSwitchRoute(surface, match, body)).toEqual({ status: 400, body: { error: "switch-invalid" } });
    }
    const broken = route.exec("/api/tricks/%E0%A4%A/legs/switch");
    if (broken === null) throw new Error("no match");
    expect(await tricksSwitchRoute(surface, broken, { on: true })).toEqual({ status: 404, body: { error: "unknown-host" } });
  });

  test("auto takes exactly { on: boolean } and undo exactly {}; both decode the path; server.ts gates both as writes", async () => {
    const calls: string[] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      switchedOn: () => true,
      switchTo: () => null,
      gateLine: () => null,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      media: async () => null,
      code: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      autoRoute: async (host, id, on) => {
        calls.push(`auto ${host} ${id} ${String(on)}`);
        return { status: 409, body: { error: "off", message: "The trick is off." } };
      },
      undoRoute: async (host, id) => {
        calls.push(`undo ${host} ${id}`);
        return { status: 409, body: { error: "no-previous", message: "There is no earlier version to go back to." } };
      },
    };
    const auto = /^\/api\/tricks\/([^/]+)\/([^/]+)\/auto$/.exec("/api/tricks/lod%67e/legs/auto");
    const undo = /^\/api\/tricks\/([^/]+)\/([^/]+)\/undo$/.exec("/api/tricks/lodge/legs/undo");
    if (auto === null || undo === null) throw new Error("no match");
    expect(await tricksAutoRoute(surface, auto, { on: true })).toEqual({ status: 409, body: { error: "off", message: "The trick is off." } });
    expect(await tricksUndoRoute(surface, undo, {})).toMatchObject({ status: 409, body: { error: "no-previous" } });
    for (const body of [undefined, null, [], {}, { on: "yes" }, { on: true, extra: 1 }]) {
      expect(await tricksAutoRoute(surface, auto, body)).toEqual({ status: 400, body: { error: "auto-invalid" } });
    }
    for (const body of [undefined, null, [], { hash: "a" }]) {
      expect(await tricksUndoRoute(surface, undo, body)).toEqual({ status: 400, body: { error: "undo-invalid" } });
    }
    expect(calls).toEqual(["auto lodge legs true", "undo lodge legs"]);
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    expect(src).toContain("const TRICKS_AUTO_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/auto$/;");
    expect(src).toContain("const TRICKS_UNDO_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/undo$/;");
    const block = src.slice(src.indexOf("const tricksVersion = TRICKS_AUTO_ROUTE.exec(pathname)"));
    expect(block.slice(0, 400)).toContain("guard(req, cfg, auto ? TRICKS_ROUTE_RIGHTS.auto : TRICKS_ROUTE_RIGHTS.undo, pairingGate)");
  });

  test("the media path is decoded and handed on; a segment that does not decode is a miss", async () => {
    const calls: [string, string, string][] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      switchedOn: () => true,
      switchTo: () => null,
      gateLine: () => null,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      media: async (host, id, rel) => {
        calls.push([host, id, rel]);
        return null;
      },
      code: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/(media\/.+)$/;
    const match = route.exec("/api/tricks/lod%67e/legs/media/shots/case%2024.png");
    if (match === null) throw new Error("no match");
    expect(await tricksMediaRoute(surface, match)).toBeNull();
    expect(calls).toEqual([["lodge", "legs", "media/shots/case 24.png"]]);
    for (const path of ["/api/tricks/%E0%A4%A/legs/media/a.png", "/api/tricks/lodge/legs/media/%E0%A4%A.png"]) {
      const broken = route.exec(path);
      if (broken === null) throw new Error("no match");
      expect(await tricksMediaRoute(surface, broken)).toBeNull();
    }
    expect(calls.length).toBe(1);
    expect(route.exec("/api/tricks/lodge/legs/trick.toml")).toBeNull();
  });

  test("the code path is decoded and handed on, with the file named by the query; an odd name is a miss", async () => {
    const calls: [string, string, string | null][] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      switchedOn: () => true,
      switchTo: () => null,
      gateLine: () => null,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      media: async () => null,
      code: async (host, id, file) => {
        calls.push([host, id, file]);
        return { status: 404, body: { error: "unknown-trick" } };
      },
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/code$/;
    const match = route.exec("/api/tricks/lod%67e/legs/code");
    if (match === null) throw new Error("no match");
    await tricksCodeRoute(surface, match, new URLSearchParams());
    await tricksCodeRoute(surface, match, new URLSearchParams({ file: "src/main.ts" }));
    expect(calls).toEqual([
      ["lodge", "legs", null],
      ["lodge", "legs", "src/main.ts"],
    ]);
    for (const file of ["", "x".repeat(513)]) expect(await tricksCodeRoute(surface, match, new URLSearchParams({ file }))).toEqual({ status: 404, body: { error: "no-file" } });
    expect(calls.length).toBe(2);
    const broken = route.exec("/api/tricks/%E0%A4%A/legs/code");
    if (broken === null) throw new Error("no match");
    expect(await tricksCodeRoute(surface, broken, new URLSearchParams())).toEqual({ status: 404, body: { error: "unknown-host" } });
    expect(route.exec("/api/tricks/lodge/legs/code/x")).toBeNull();
    expect(route.exec("/api/tricks/lodge/legs/media/code")).toBeNull();
  });

  test("server.ts gates the list as a read and the tap as a write, stamps the watch for a paired phone only, the switch as a write, and declares both routes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const list = src.slice(src.indexOf('if (pathname === "/api/tricks" && req.method === "GET")'));
    // The rights live in one table in routes.ts; server.ts reads each route's level from it.
    expect(TRICKS_ROUTE_RIGHTS).toEqual({ reply: "read", tap: "write", switch: "write", media: "read", code: "read", auto: "write", undo: "write", official: "read", officialAdd: "write", repoList: "write", repoAdd: "write", feature: "write", value: "write", remove: "write" });
    expect(list.slice(0, 400)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.reply, pairingGate)");
    expect(list.slice(0, 600)).toContain("if (pairedLabel(req, pairingGate) !== null) tricks.noteWatched();");
    // The runner's PATH for the host's own CLI only is held by a real request in the crew harness
    // (integration/crew-harness.test.ts, "the tricks list: the runner's PATH").
    const tap = src.slice(src.indexOf("const tricksTap = TRICKS_TAP_ROUTE.exec(pathname);"));
    expect(tap.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.tap, pairingGate)");
    const sw = src.slice(src.indexOf("const tricksSwitch = TRICKS_SWITCH_ROUTE.exec(pathname);"));
    expect(sw.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.switch, pairingGate)");
    expect(src).toContain("const TRICKS_SWITCH_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/switch$/;");
    expect(src).toContain("const TRICKS_TAP_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/tap$/;");
    // A picture: read-gated, the hill image's headers, and one 404 for every miss.
    expect(src).toContain("const TRICKS_MEDIA_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/(media\\/.+)$/;");
    const media = src.slice(src.indexOf("const tricksMedia = TRICKS_MEDIA_ROUTE.exec(pathname);"));
    expect(media.slice(0, 200)).toContain('req.method === "GET"');
    expect(media.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.media, pairingGate)");
    expect(media.slice(0, 900)).toContain("secure(new Response(file.bytes, { headers: { \"content-type\": file.mime, ...HILL_MEDIA_HEADERS } }))");
    // A trick's code for the About sheet's folds: read-gated like the list, a GET only.
    expect(src).toContain("const TRICKS_CODE_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/code$/;");
    const code = src.slice(src.indexOf("const tricksCode = TRICKS_CODE_ROUTE.exec(pathname);"));
    expect(code.slice(0, 200)).toContain('req.method === "GET"');
    expect(code.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.code, pairingGate)");
    // The official list: its read gated like the list, its add and update like the switch.
    expect(src).toContain("const TRICKS_OFFICIAL_ROUTE = /^\\/api\\/tricks\\/official\\/([^/]+)\\/(add|update)$/;");
    const officialList = src.slice(src.indexOf('if (pathname === "/api/tricks/official" && req.method === "GET")'));
    expect(officialList.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.official, pairingGate)");
    const officialAdd = src.slice(src.indexOf("const tricksOfficial = TRICKS_OFFICIAL_ROUTE.exec(pathname);"));
    expect(officialAdd.slice(0, 200)).toContain('req.method === "POST"');
    expect(officialAdd.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.officialAdd, pairingGate)");
    expect(src).toContain("if (poller !== null) opts.tricks?.noteWatched();");
    expect(src).toContain("if (tricksRev !== undefined) body.tricksRev = tricksRev;");
  });
});
