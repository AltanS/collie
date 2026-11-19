// The slow cases of units.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrickScanner, TRICKS_MAX } from "./discover.ts";
import { switchesPath } from "./paths.ts";
import { SWITCH_LOCK_WAIT_MS, type LockFs, withSwitchLock } from "./switches.ts";

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
  test("counsel A1, third pass: a live holder that sleeps 7 s is never taken over; its waiters give up with the error", async () => {
    const stateDir = await tempDir();
    const lock = `${switchesPath(stateDir)}.lock`;
    const child = await holder(stateDir, 7000);
    const text = readFileSync(lock, "utf8");
    expect(text.startsWith(`${String(child.pid)}\n`)).toBe(true);
    let entered = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        withSwitchLock(stateDir, async () => {
          entered += 1;
        }),
      ),
    );
    expect(entered).toBe(0);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(String(result.reason)).toContain("locked by another writer");
    }
    // The holder's own file stood the whole time, and its own release removes it.
    expect(readFileSync(lock, "utf8")).toBe(text);
    expect(await child.exited).toBe(0);
    expect(existsSync(lock)).toBe(false);
  }, 20_000);

  test("Windows: a rename that keeps being refused ends in the existing error at the limit, never before, and leaves nothing of the waiter's", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    const dead = `${String(await deadPid())}\ndead-holder\n`;
    await writeFile(lock, dead);
    const fs = refusing({ rename: Number.POSITIVE_INFINITY });
    const started = Date.now();
    await expect(withSwitchLock(stateDir, async () => "never", Date.now, fs)).rejects.toThrow("locked by another writer");
    expect(Date.now() - started).toBeGreaterThanOrEqual(SWITCH_LOCK_WAIT_MS);
    expect(fs.refused.rename).toBeGreaterThan(10);
    expect(readFileSync(lock, "utf8")).toBe(dead);
    expect(await leftovers(stateDir)).toEqual(["switches.json.lock"]);
  }, 20_000);
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

describe("discovery", () => {
  test("past 64 folders the rest are listed as refused, and a new folder never pushes out one already read", async () => {
    const root = await tempDir();
    await Promise.all(Array.from({ length: TRICKS_MAX + 1 }, (_, i) => trickDir(root, `t${String(i).padStart(3, "0")}`)));
    const scanner = createTrickScanner(root);
    const first = await scanner.scan();
    expect(first.tricks).toHaveLength(TRICKS_MAX + 1);
    const over = first.tricks.filter((t) => t.manifest === undefined);
    expect(over.map((t) => t.id)).toEqual([`t${String(TRICKS_MAX).padStart(3, "0")}`]);
    expect(over[0]?.refusals[0]?.reason).toContain("more than 64 trick folders");
    await trickDir(root, "a-first");
    const second = await scanner.scan();
    expect(second.tricks[0]?.id).toBe("a-first");
    expect(second.tricks[0]?.manifest).toBeUndefined();
    expect(second.tricks.find((t) => t.id === "t000")?.manifest).toBeDefined();
    // A fresh scanner (a restart) reads the ones switched on first.
    const fresh = await createTrickScanner(root).scan(new Set(["a-first"]));
    expect(fresh.tricks[0]?.manifest).toBeDefined();
  });
});

