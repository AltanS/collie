// The machine-wide pane lock (M102 spec 16): one writer per pane across bridges, a stale lock taken over
// atomically, and no failure of the folder ever failing a send.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SPAN_MS, openPaneLock, paneLockDir, PaneLockFiles, processAlive, processStart, STALE_MARGIN_MS, TAKE_STALE_MS, type PaneLockOptions } from "./pane-lock.ts";

let dir: string;
let clock: number;
const living = new Map<number, string | null>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-lock-"));
  clock = 1_000_000;
  living.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A bridge with its own pid and start time, on the shared folder and the test clock. */
function bridge(pid: number, start: string | null = `s${String(pid)}`, extra: Partial<PaneLockOptions> = {}): PaneLockFiles {
  living.set(pid, start);
  return new PaneLockFiles({ dir, scope: "herdr\u0000/run/user/1/herdr.sock", pid, now: () => clock, alive: (p) => living.has(p), startOf: (p) => living.get(p) ?? null, ...extra });
}

function lockFiles(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".lock"));
}

describe("one writer per pane", () => {
  test("a second bridge is refused while the first holds the pane, and takes it after the release", () => {
    const one = bridge(101);
    const two = bridge(202);
    expect(one.take("w1:p1", "req-a", clock + 10_000)).toBe(true);
    expect(two.take("w1:p1", "req-b", clock + 10_000)).toBe(false);
    expect(two.heldElsewhere("w1:p1")).toBe(true);
    // Another pane is free.
    expect(two.take("w1:p2", "req-c", clock + 10_000)).toBe(true);
    one.release("w1:p1", "req-a");
    expect(two.take("w1:p1", "req-b", clock + 10_000)).toBe(true);
    expect(one.take("w1:p1", "req-d", clock + 10_000)).toBe(false);
  });

  test("the file holds the owner's pid, start time and times, never the pane id or any text", () => {
    const one = bridge(101);
    one.take("w1:p1", "req-secret-id", clock + 10_000);
    const [name] = lockFiles();
    const raw = readFileSync(join(dir, name!), "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 1, pid: 101, start: "s101", at: clock, until: clock + 10_000 });
    expect(raw).not.toContain("w1:p1");
    expect(raw).not.toContain("req-secret-id");
    expect(name).toMatch(/^[0-9a-f]{32}\.lock$/u);
  });

  test("another multiplexer socket is another lock", () => {
    const one = bridge(101);
    const other = new PaneLockFiles({ dir, scope: "herdr\u0000/run/user/1/other.sock", pid: 202, now: () => clock, alive: () => true, startOf: () => null });
    expect(one.take("w1:p1", "a", clock + 10_000)).toBe(true);
    expect(other.take("w1:p1", "b", clock + 10_000)).toBe(true);
  });

  test("two holders in one process share the file; it goes with the last one", () => {
    const one = bridge(101);
    const two = bridge(202);
    expect(one.take("w1:p1", "send", clock + 10_000)).toBe(true);
    expect(one.take("w1:p1", "press", clock + 1_000)).toBe(true);
    one.release("w1:p1", "press");
    expect(two.take("w1:p1", "x", clock + 10_000)).toBe(false);
    one.release("w1:p1", "send");
    expect(lockFiles()).toEqual([]);
    expect(two.take("w1:p1", "x", clock + 10_000)).toBe(true);
  });

  test("a holder whose bound grows rewrites its own file, so no one takes it by age in the meantime", () => {
    const one = bridge(101);
    const two = bridge(202);
    one.take("w1:p1", "send", clock + 10_000);
    one.take("w1:p1", "send", clock + 60_000);
    clock += 10_000 + STALE_MARGIN_MS + 1;
    expect(two.take("w1:p1", "x", clock + 1_000)).toBe(false);
  });

  test("a release that comes after a takeover leaves the new owner's file alone", () => {
    const one = bridge(101);
    const two = bridge(202);
    one.take("w1:p1", "send", clock + 1_000);
    clock += 1_000 + STALE_MARGIN_MS + 1;
    expect(two.take("w1:p1", "late", clock + 10_000)).toBe(true);
    one.release("w1:p1", "send");
    expect(lockFiles()).toHaveLength(1);
    expect(one.take("w1:p1", "again", clock + 10_000)).toBe(false);
  });
});

describe("a stale lock is taken over", () => {
  function plant(pid: number, start: string | null, until: number): string {
    const probe = bridge(9);
    const path = probe.pathOf("w1:p1");
    living.delete(9);
    writeFileSync(path, `${JSON.stringify({ v: 1, pid, start, at: clock, until })}\n`);
    return path;
  }

  test("a bridge killed while it held the lock (its pid is gone)", () => {
    plant(4242, "s4242", clock + 60_000);
    const two = bridge(202);
    expect(two.heldElsewhere("w1:p1")).toBe(false);
    expect(two.take("w1:p1", "x", clock + 10_000)).toBe(true);
    expect(JSON.parse(readFileSync(two.pathOf("w1:p1"), "utf8")).pid).toBe(202);
  });

  test("a reused pid: alive, with another start time", () => {
    plant(4242, "old-start", clock + 60_000);
    living.set(4242, "new-start");
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(true);
  });

  test("a live owner with the recorded start time holds", () => {
    plant(4242, "s4242", clock + 60_000);
    living.set(4242, "s4242");
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(false);
  });

  test("a live owner past its span plus the margin, and one whose span lies far ahead (the clock jumped back)", () => {
    plant(4242, "s4242", clock - STALE_MARGIN_MS - 1);
    living.set(4242, "s4242");
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(true);
    bridge(202).release("w1:p1", "x");
    rmSync(join(dir, lockFiles()[0]!), { force: true });
    plant(4242, "s4242", clock + MAX_SPAN_MS + 1);
    expect(bridge(303).take("w1:p1", "y", clock + 10_000)).toBe(true);
  });

  test("inside the margin a live owner still holds (a small clock skew is no takeover)", () => {
    plant(4242, "s4242", clock - STALE_MARGIN_MS + 100);
    living.set(4242, "s4242");
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(false);
  });

  test("two bridges that both saw the stale lock: the first takes it over, the second reads the fresh lock and is refused", () => {
    plant(4242, "s4242", clock + 60_000);
    const two = bridge(202);
    const three = bridge(303);
    expect(two.take("w1:p1", "x", clock + 10_000)).toBe(true);
    expect(three.take("w1:p1", "y", clock + 10_000)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith(".take") || name.endsWith(".tmp"))).toEqual([]);
  });

  test("a takeover in progress (a fresh mutex) makes a second taker give way, never wait", () => {
    const path = plant(4242, "s4242", clock + 60_000);
    writeFileSync(`${path}.take`, "");
    utimesSync(`${path}.take`, clock / 1000, clock / 1000);
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(false);
  });

  test("a mutex left by a crash in the middle of a takeover is moved aside", () => {
    const path = plant(4242, "s4242", clock + 60_000);
    writeFileSync(`${path}.take`, "");
    const old = (clock - TAKE_STALE_MS - 1_000) / 1000;
    utimesSync(`${path}.take`, old, old);
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(true);
    expect(existsSync(`${path}.take`)).toBe(false);
  });

  test("this process's own leftover (a release that failed) is taken again", () => {
    plant(202, "s202", clock + 60_000);
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(true);
  });

  test("an empty lock file is held while young and stale when old", () => {
    const path = plant(1, null, 0);
    writeFileSync(path, "");
    const now = clock / 1000;
    utimesSync(path, now, now);
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(false);
    const old = (clock - STALE_MARGIN_MS - 1_000) / 1000;
    utimesSync(path, old, old);
    expect(bridge(202).take("w1:p1", "x", clock + 10_000)).toBe(true);
  });
});

describe("a hold past its until (2026-11-17, second review)", () => {
  test("another bridge took the file over: this process's next join is refused, and its release leaves their file", () => {
    const one = bridge(101);
    const two = bridge(202);
    expect(one.take("w1:p1", "send-a", clock + 1_000)).toBe(true);
    clock += 1_000 + STALE_MARGIN_MS + 1;
    expect(two.take("w1:p1", "send-b", clock + 10_000)).toBe(true);
    // A person's key, or a new send, in the first bridge while its old hold is still counted.
    expect(one.take("w1:p1", "press", clock + 10_000)).toBe(false);
    one.release("w1:p1", "send-a");
    expect(JSON.parse(readFileSync(join(dir, lockFiles()[0]!), "utf8")).pid).toBe(202);
    expect(one.take("w1:p1", "press", clock + 10_000)).toBe(false);
    two.release("w1:p1", "send-b");
    expect(one.take("w1:p1", "press", clock + 10_000)).toBe(true);
  });

  test("the file still holds this process's bytes: the join goes ahead and the span grows", () => {
    const one = bridge(101);
    expect(one.take("w1:p1", "send-a", clock + 1_000)).toBe(true);
    clock += 2_000;
    expect(one.take("w1:p1", "press", clock + 10_000)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, lockFiles()[0]!), "utf8")).until).toBe(clock + 10_000);
    expect(bridge(202).take("w1:p1", "b", clock + 10_000)).toBe(false);
  });

  test("the file is gone (taken over and released): the join takes it again, and another bridge is refused", () => {
    const one = bridge(101);
    expect(one.take("w1:p1", "send-a", clock + 1_000)).toBe(true);
    clock += 2_000;
    rmSync(join(dir, lockFiles()[0]!));
    expect(one.take("w1:p1", "press", clock + 10_000)).toBe(true);
    expect(lockFiles()).toHaveLength(1);
    expect(bridge(202).take("w1:p1", "b", clock + 10_000)).toBe(false);
  });
});

describe("the folder", () => {
  test("XDG_RUNTIME_DIR first, then /run/user/<uid>, then the state home; never /tmp", () => {
    // The expected paths are built with `join`, as the code builds its own: on Windows `join` writes
    // backslashes, so a hand-typed "/run/user/..." would differ by the separator alone.
    expect(paneLockDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000, () => false, "/home/a")).toBe(join("/run/user/1000", "collie", "pane-locks"));
    expect(paneLockDir({}, 1000, (p) => p === "/run/user/1000", "/home/a")).toBe(join("/run/user/1000", "collie", "pane-locks"));
    expect(paneLockDir({}, 1000, () => false, "/home/a")).toBe(join("/home/a", ".local", "state", "collie-pane-locks"));
    expect(paneLockDir({ XDG_STATE_HOME: "/st" }, -1, () => true, "/home/a")).toBe(join("/st", "collie-pane-locks"));
    expect(paneLockDir({}, -1, () => false, "")).toBeNull();
  });

  test("a folder that cannot be made gives no lock and one log line: the in-memory lock alone", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    const lines: string[] = [];
    expect(openPaneLock({ dir: join(file, "locks"), scope: "s", log: (line) => lines.push(line) })).toBeNull();
    expect(lines).toHaveLength(1);
  });

  test("a folder gone after the start is made again on the next take: the lock holds across bridges again (2026-11-17)", () => {
    const lines: string[] = [];
    const sub = join(dir, "sub");
    const options = { dir: sub, scope: "s", now: () => clock, alive: () => true, startOf: () => null } as const;
    const one = openPaneLock({ ...options, pid: 101, log: (line) => lines.push(line) });
    const two = openPaneLock({ ...options, pid: 202 });
    rmSync(sub, { recursive: true, force: true });
    expect(one!.take("w1:p1", "a", clock + 1_000)).toBe(true);
    expect(readdirSync(sub).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
    expect(two!.take("w1:p1", "b", clock + 1_000)).toBe(false);
    expect(lines.filter((line) => line.includes("made it again"))).toHaveLength(1);
  });

  test("a folder that cannot be made again never fails a take: one try per take, the pane free here, logged once", () => {
    const lines: string[] = [];
    const parent = join(dir, "parent");
    const sub = join(parent, "locks");
    const one = openPaneLock({ dir: sub, scope: "s", pid: 101, now: () => clock, alive: () => true, startOf: () => null, log: (line) => lines.push(line) });
    rmSync(parent, { recursive: true, force: true });
    writeFileSync(parent, "a file where the folder was\n");
    expect(one!.take("w1:p1", "a", clock + 1_000)).toBe(true);
    expect(one!.take("w1:p2", "b", clock + 1_000)).toBe(true);
    one!.release("w1:p1", "a");
    expect(lines).toHaveLength(1);
  });

  test("the real process probes: this process is alive with a start time on Linux, a pid that cannot exist is not", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(-5)).toBe(false);
    if (process.platform === "linux") expect(processStart(process.pid)).toMatch(/^\d+$/u);
    expect(processStart(2 ** 30)).toBeNull();
  });
});
