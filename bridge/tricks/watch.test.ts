import { afterAll, describe, expect, test } from "bun:test";
import { watch as fsWatch } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandWatchPath, TrickWatch, WATCH_DEBOUNCE_MS, WATCH_MAX_WAIT_MS, WATCH_POLL_MS, type FsWatchHandle, type WatchFactory, type WatchFire, type WatchOptions } from "./watch.ts";

// The file watch, against a real folder. The waits are short so the suite stays fast; the production
// numbers are pinned in the first test.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-watch-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const FAST: WatchOptions = { debounceMs: 40, maxWaitMs: 160, pollMs: 60 };

interface Probe {
  fires: WatchFire[];
  notes: string[];
  watch: TrickWatch;
  opened: string[];
  closed: string[];
}

// The production factory is not exported on purpose; a test needs one that opens a real `fs.watch`.
const realFactory: WatchFactory = (dir, onEvent, onError) => {
  const handle = fsWatch(dir, { persistent: false, encoding: "utf8" }, (_type, name) => onEvent(name === "" || name === null ? null : name));
  handle.on("error", onError);
  return { close: () => handle.close() };
};

/** A factory that counts opens and closes and forwards to the real `fs.watch`. */
function countingFactory(opened: string[], closed: string[], inner?: WatchFactory): WatchFactory {
  return (dir, onEvent, onError) => {
    opened.push(dir);
    const real = inner ?? realFactory;
    const handle = real(dir, onEvent, onError);
    const out: FsWatchHandle = {
      close: () => {
        closed.push(dir);
        handle.close();
      },
    };
    return out;
  };
}

function probe(paths: string[], opts: WatchOptions = {}): Probe {
  const fires: WatchFire[] = [];
  const notes: string[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const watch = new TrickWatch(paths, (fire) => fires.push(fire), (note) => notes.push(note), { ...FAST, factory: countingFactory(opened, closed), ...opts });
  watch.start();
  return { fires, notes, watch, opened, closed };
}

describe("the numbers", () => {
  test("300 ms after the last change, at most 2 s after the first, and a 5 s check", () => {
    expect(WATCH_DEBOUNCE_MS).toBe(300);
    expect(WATCH_MAX_WAIT_MS).toBe(2000);
    expect(WATCH_POLL_MS).toBe(5000);
  });

  test("~/ is the home folder given, and nothing else is rewritten", () => {
    // `join` is the product's own: it writes the platform's separator, so the expectation does too.
    expect(expandWatchPath("~/notes/a.md", "/home/x")).toBe(join("/home/x", "notes", "a.md"));
    expect(expandWatchPath("/etc/hosts", "/home/x")).toBe("/etc/hosts");
    expect(expandWatchPath("~other/a", "/home/x")).toBe("~other/a");
  });
});

describe("one file", () => {
  test("a plain write fires once, with the path as written and a count of 1", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const p = probe([file]);
    await writeFile(file, "ab");
    await Bun.sleep(250);
    expect(p.fires).toEqual([{ path: file, count: 1 }]);
    p.watch.close();
  });

  test("an editor's save (write a temp file, rename it over the old one) fires once", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "first");
    const p = probe([file]);
    await writeFile(join(dir, ".todo.md.swp"), "second");
    await rename(join(dir, ".todo.md.swp"), file);
    await Bun.sleep(250);
    expect(p.fires).toEqual([{ path: file, count: 1 }]);
    // And the next save of the replaced file is seen too: the watch is on the folder, not on the old inode.
    await writeFile(join(dir, ".todo.md.swp"), "third");
    await rename(join(dir, ".todo.md.swp"), file);
    await Bun.sleep(250);
    expect(p.fires.length).toBe(2);
    p.watch.close();
  });

  test("another file of the same folder fires nothing", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const p = probe([file]);
    await writeFile(join(dir, "other.md"), "x");
    await Bun.sleep(200);
    expect(p.fires).toEqual([]);
    p.watch.close();
  });

  test("a file that is not there yet fires when it is created, because its folder is watched", async () => {
    const dir = await tempDir();
    const file = join(dir, "later.md");
    const p = probe([file]);
    expect(p.watch.open().handles).toBe(1);
    await writeFile(file, "now");
    await Bun.sleep(250);
    expect(p.fires).toEqual([{ path: file, count: 1 }]);
    await unlink(file);
    await Bun.sleep(250);
    // The file going away is a change as well.
    expect(p.fires.length).toBe(2);
    p.watch.close();
  });

  test("a file whose folder is missing too is checked by the poll, and its watch opens when the folder appears", async () => {
    const dir = await tempDir();
    const file = join(dir, "deep", "later.md");
    const p = probe([file]);
    expect(p.watch.open().handles).toBe(0);
    expect(p.watch.open().timers).toBe(1);
    await mkdir(join(dir, "deep"));
    await writeFile(file, "now");
    await Bun.sleep(250);
    expect(p.fires).toEqual([{ path: file, count: 1 }]);
    // The folder exists now: the watch is open and the poll has stopped.
    expect(p.watch.open()).toEqual({ handles: 1, timers: 0 });
    p.watch.close();
  });
});

describe("debounce", () => {
  test("five quick writes are one fire", async () => {
    const dir = await tempDir();
    const file = join(dir, "burst.md");
    await writeFile(file, "0");
    // Wider than FAST: with a 40 ms debounce the burst became two fires on a loaded Windows VM.
    const p = probe([file], { debounceMs: 150, maxWaitMs: 1000 });
    for (const text of ["1", "22", "333", "4444", "55555"]) {
      await writeFile(file, text);
      await Bun.sleep(5);
    }
    await Bun.sleep(600);
    expect(p.fires.length).toBe(1);
    p.watch.close();
  });

  test("a steady stream still fires at least once per longest wait", async () => {
    const dir = await tempDir();
    const file = join(dir, "stream.md");
    await writeFile(file, "0");
    // A debounce longer than the gap between writes would wait for ever without the longest wait.
    const p = probe([file], { debounceMs: 100, maxWaitMs: 200 });
    const started = Date.now();
    let n = 0;
    while (Date.now() - started < 650) {
      n += 1;
      await writeFile(file, `write ${String(n)}`);
      await Bun.sleep(20);
    }
    // Over 650 ms of writes every 20 ms, with a 200 ms longest wait: at least two fires before the stream ends.
    expect(p.fires.length).toBeGreaterThanOrEqual(2);
    expect(p.fires.length).toBeLessThanOrEqual(5);
    p.watch.close();
  });
});

describe("links", () => {
  test("a watch through a link follows the target; a retargeted link moves the watch to the new target", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    await writeFile(join(dir, "a", "one.md"), "one");
    await writeFile(join(dir, "b", "two.md"), "two!");
    const link = join(dir, "current.md");
    await symlink(join(dir, "a", "one.md"), link);
    const p = probe([link]);
    // Two folders: the real file's and the link's own.
    expect(p.opened.toSorted()).toEqual([join(dir, "a"), dir].toSorted());
    await writeFile(join(dir, "a", "one.md"), "one, changed");
    await Bun.sleep(250);
    expect(p.fires).toEqual([{ path: link, count: 1 }]);

    // Retarget the way `ln -sfn` does: a new link renamed over the old one. The file the path names changed.
    await symlink(join(dir, "b", "two.md"), join(dir, ".new"));
    await rename(join(dir, ".new"), link);
    await Bun.sleep(250);
    expect(p.fires.length).toBe(2);
    expect(p.fires[1]).toEqual({ path: link, count: 1 });
    // The folder of the old target is not watched any more; the new target's is.
    expect(p.closed).toContain(join(dir, "a"));
    expect(p.opened).toContain(join(dir, "b"));

    await writeFile(join(dir, "b", "two.md"), "two, changed");
    await Bun.sleep(250);
    expect(p.fires.length).toBe(3);
    // The old target is not the watched file now.
    await writeFile(join(dir, "a", "one.md"), "one, changed again");
    await Bun.sleep(200);
    expect(p.fires.length).toBe(3);
    p.watch.close();
  });
});

describe("a trick that writes the file it watches", () => {
  test("recordOwn right after the write absorbs it, so one run does not become two", async () => {
    const dir = await tempDir();
    const file = join(dir, "state.json");
    await writeFile(file, "{}");
    const p = probe([file]);
    // A change from outside: one fire.
    await writeFile(file, '{"a":1}');
    await Bun.sleep(200);
    expect(p.fires.length).toBe(1);
    // The run that fire started writes the file, and its end records the stat.
    await writeFile(file, '{"a":2,"own":true}');
    p.watch.recordOwn();
    await Bun.sleep(250);
    expect(p.fires.length).toBe(1);
    // The next outside change, after the run, fires again.
    await writeFile(file, '{"a":3}');
    await Bun.sleep(200);
    expect(p.fires.length).toBe(2);
    p.watch.close();
  });

  test("an outside write that landed during the run is absorbed with the run's own", async () => {
    const dir = await tempDir();
    const file = join(dir, "state.json");
    await writeFile(file, "{}");
    const p = probe([file]);
    // The events of this write are still waiting out the debounce when the run ends.
    await writeFile(file, "outside, during the run");
    p.watch.recordOwn();
    await Bun.sleep(250);
    expect(p.fires).toEqual([]);
    p.watch.close();
  });

  test("a touch that moves only the time is a change, a repeat of the same stat is not", async () => {
    const dir = await tempDir();
    const file = join(dir, "t.md");
    await writeFile(file, "x");
    const p = probe([file]);
    await utimes(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    await Bun.sleep(200);
    expect(p.fires.length).toBe(1);
    await utimes(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    await Bun.sleep(200);
    expect(p.fires.length).toBe(1);
    p.watch.close();
  });
});

describe("several files", () => {
  test("two files changed in one burst are one fire that names the first and counts two", async () => {
    const dir = await tempDir();
    const one = join(dir, "one.md");
    const two = join(dir, "two.md");
    await writeFile(one, "1");
    await writeFile(two, "2");
    const p = probe([one, two]);
    await writeFile(one, "11");
    await writeFile(two, "22");
    await Bun.sleep(250);
    expect(p.fires).toEqual([{ path: one, count: 2 }]);
    p.watch.close();
  });

  test("a path written twice is watched once", async () => {
    const dir = await tempDir();
    const file = join(dir, "same.md");
    await writeFile(file, "1");
    const p = probe([file, file]);
    await writeFile(file, "22");
    await Bun.sleep(200);
    expect(p.fires).toEqual([{ path: file, count: 1 }]);
    p.watch.close();
  });
});

describe("when fs.watch cannot be set up", () => {
  const enospc: WatchFactory = () => {
    throw new Error("ENOSPC: System limit for number of file watchers reached, watch '/x'");
  };

  test("the files' stats are checked on the poll instead, the note is told once, and a changed mtime fires", async () => {
    const dir = await tempDir();
    const file = join(dir, "polled.md");
    await writeFile(file, "a");
    const p = probe([file], { factory: enospc });
    expect(p.watch.polling).toBe(true);
    // The system's error code is handed on, once, for the log; the row's sentence has none.
    expect(p.notes).toEqual(["ENOSPC"]);
    expect(p.watch.open()).toEqual({ handles: 0, timers: 1 });
    await writeFile(file, "ab");
    await Bun.sleep(220);
    expect(p.fires).toEqual([{ path: file, count: 1 }]);
    // Nothing moved since: the next checks fire nothing.
    await Bun.sleep(220);
    expect(p.fires.length).toBe(1);
    // And its existence is checked: a deleted file is a change.
    await unlink(file);
    await Bun.sleep(220);
    expect(p.fires.length).toBe(2);
    expect(p.notes.length).toBe(1);
    p.watch.close();
    expect(p.watch.open()).toEqual({ handles: 0, timers: 0 });
  });

  test("a watch that fails after it opened (the system's error event) falls back the same way", async () => {
    const dir = await tempDir();
    const file = join(dir, "later-failed.md");
    await writeFile(file, "a");
    let fail: (err: Error) => void = () => {};
    const factory: WatchFactory = (_dir, _onEvent, onError) => {
      fail = onError;
      return { close: () => {} };
    };
    const p = probe([file], { factory });
    expect(p.watch.polling).toBe(false);
    fail(new Error("EMFILE: too many open files"));
    expect(p.watch.polling).toBe(true);
    expect(p.notes).toEqual(["EMFILE"]);
    p.watch.close();
  });
});

describe("closing", () => {
  test("close frees every handle and every timer, and a later event or poll fires nothing", async () => {
    const dir = await tempDir();
    const file = join(dir, "closing.md");
    await writeFile(file, "a");
    const p = probe([file, join(dir, "gone", "x.md")]);
    expect(p.watch.open().handles).toBe(1);
    // The missing folder keeps the poll on; a write puts the debounce on.
    await writeFile(file, "b");
    await Bun.sleep(10);
    expect(p.watch.open().timers).toBe(2);
    p.watch.close();
    expect(p.watch.open()).toEqual({ handles: 0, timers: 0 });
    expect(p.closed).toEqual([dir]);
    await Bun.sleep(250);
    expect(p.fires).toEqual([]);
  });
});
