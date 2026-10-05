import { describe, expect, test } from "bun:test";
import {
  DISK_READ_MS,
  DISK_STALE_MS,
  DiskWatch,
  diskOf,
  fullestFraction,
  MAX_DISKS,
  pickDisks,
  readOnlyMounts,
  type DiskReaders,
  type StatFsLike,
  windowsLabel,
} from "./machine-disks.ts";

const GiB = 1024 ** 3;

/** This machine on 2026-10-05: `/` a 34 MiB composefs at 100 %, `/var/home` a 953 GiB btrfs at 66 %. */
const COMPOSEFS: StatFsLike = { type: 2035054128, bsize: 4096, frsize: 4096, blocks: 8487, bfree: 0, bavail: 0 };
const BTRFS: StatFsLike = { type: 2435016766, bsize: 4096, frsize: 4096, blocks: 249630976, bfree: 94385390, bavail: 80650998 };
const MOUNTS = [
  "composefs / overlay ro,relatime,lowerdir+=/run/ostree/.private/cfsroot-lower 0 0",
  "/dev/mapper/luks-1 /sysroot btrfs ro,seclabel,relatime 0 0",
  "/dev/mapper/luks-1 /var/home btrfs rw,seclabel,relatime 0 0",
].join("\n");

/** Let every promise already settled run its callbacks. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

interface World {
  readonly platform?: NodeJS.Platform;
  readonly paths: string[];
  /** statfs per path: an answer, a rejection, or a read that never resolves. */
  fs: Record<string, StatFsLike | "reject" | "hang">;
  /** device id per path prefix, longest match wins. */
  readonly devs?: Record<string, number>;
  readonly mounts?: string | null;
}

function harness(world: World) {
  const clock = { now: 1_000_000 };
  const calls: string[] = [];
  const devOf = (path: string): number => {
    const keys = Object.keys(world.devs ?? {}).filter((k) => path === k || path.startsWith(k === "/" ? "/" : `${k}/`));
    const longest = keys.toSorted((a, b) => b.length - a.length)[0];
    if (longest === undefined) throw new Error(`no dev for ${path}`);
    return world.devs![longest]!;
  };
  const readers: DiskReaders = {
    platform: world.platform ?? "linux",
    paths: world.paths,
    statfs: (path) => {
      calls.push(path);
      const answer = world.fs[path];
      if (answer === undefined || answer === "reject") return Promise.reject(new Error("EIO"));
      if (answer === "hang") return new Promise<StatFsLike>(() => {});
      return Promise.resolve(answer);
    },
    dev: async (path) => devOf(path),
    realpath: async (path) => path,
    mounts: async () => world.mounts ?? null,
    now: () => clock.now,
  };
  return { watch: new DiskWatch(readers), clock, calls };
}

describe("diskOf: which filesystems count, and the numbers match df", () => {
  test("a read-only composefs root at 100 % is dropped", () => {
    expect(diskOf("/", COMPOSEFS, "42", true)).toBeNull();
  });

  test("a small filesystem is dropped even when writable", () => {
    expect(diskOf("/boot", { ...BTRFS, blocks: 200_000, bfree: 100_000, bavail: 100_000 }, "1", false)).toBeNull();
  });

  test("used / total is df's Use%, and total - used is what an unprivileged process may write", () => {
    const d = diskOf("/var/home", BTRFS, "37", false)!;
    expect(d.used).toBe((249630976 - 94385390) * 4096);
    expect(d.total - d.used).toBe(80650998 * 4096);
    // df on 2026-10-05: Used 635885920256, Avail 330346487808, Use% 66.
    expect(d.used).toBe(635885920256);
    expect(Math.ceil((d.used / d.total) * 100)).toBe(66);
  });

  test("a writable disk that filled up still counts off Linux: it has its root reserve left", () => {
    const full = { ...BTRFS, bfree: 1000, bavail: 0 };
    const d = diskOf("/", full, "1", false)!;
    expect(d.used / d.total).toBe(1);
  });

  test("no free block at all, on a platform that cannot say read-only, is an image", () => {
    expect(diskOf("/", { ...BTRFS, bfree: 0, bavail: 0 }, "1", false)).toBeNull();
  });

  test("nonsense numbers are dropped", () => {
    expect(diskOf("/", { ...BTRFS, blocks: Number.NaN }, "1", false)).toBeNull();
    expect(diskOf("/", { ...BTRFS, bsize: 0, frsize: 0 }, "1", false)).toBeNull();
    expect(diskOf("/", { ...BTRFS, bfree: -1 }, "1", false)).toBeNull();
  });

  test("frsize is the unit where present, bsize otherwise", () => {
    const withFr = diskOf("/", { ...BTRFS, bsize: 1_048_576, frsize: 4096 }, "1", false)!;
    const without = diskOf("/", { ...BTRFS, frsize: undefined }, "1", false)!;
    expect(withFr.total).toBe(without.total);
  });
});

describe("pickDisks: one per device, one per shared pool, at most four", () => {
  const r = (mount: string, dev: string | null, used: number, total = 100 * GiB, type = 1) => ({
    mount,
    used,
    total,
    dev,
    type,
    avail: total - used,
  });

  test("two paths on one device are one disk", () => {
    expect(pickDisks([r("/var/home", "37", 60 * GiB), r("/var/home", "37", 60 * GiB)])).toHaveLength(1);
  });

  test("no device ids: the same type, size and free space are one pool, the fuller kept", () => {
    const a = { ...r("/System/Volumes/Data", null, 60 * GiB), avail: 40 * GiB };
    const b = { ...r("/", null, 10 * GiB), avail: 40 * GiB };
    expect(pickDisks([b, a])).toEqual([{ mount: "/System/Volumes/Data", used: 60 * GiB, total: 100 * GiB }]);
  });

  test("at most four, in the order given", () => {
    const many = ["/a", "/b", "/c", "/d", "/e"].map((m, i) => r(m, String(i), i * GiB, (100 + i) * GiB));
    expect(pickDisks(many).map((d) => d.mount)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(MAX_DISKS).toBe(4);
  });
});

describe("helpers", () => {
  test("readOnlyMounts reads the ro flag and decodes escaped spaces", () => {
    const ro = readOnlyMounts(`${MOUNTS}\n/dev/sdb1 /mnt/my\\040disk ext4 ro 0 0`);
    expect([...ro].toSorted()).toEqual(["/", "/mnt/my disk", "/sysroot"]);
  });

  test("windowsLabel is the drive letter, upper case, or the UNC share", () => {
    expect(windowsLabel("C:\\Users\\me")).toBe("C:");
    expect(windowsLabel("d:\\")).toBe("D:");
    expect(windowsLabel("\\\\nas\\share\\folder")).toBe("\\\\nas\\share");
  });

  test("fullestFraction is the highest used / total, null with no disks", () => {
    expect(fullestFraction(undefined)).toBeNull();
    expect(fullestFraction([])).toBeNull();
    expect(fullestFraction([{ mount: "/", used: 1, total: 4 }, { mount: "/x", used: 3, total: 4 }])).toBe(0.75);
  });
});

describe("DiskWatch", () => {
  test("composefs root, home on /var/home: only /var/home shows", async () => {
    const { watch } = harness({
      paths: ["/var/home/me", "/", "/var/home/me/.local/state/collie"],
      fs: { "/var/home/me": BTRFS, "/": COMPOSEFS, "/var/home/me/.local/state/collie": BTRFS },
      devs: { "/": 42, "/var": 42, "/var/home": 37 },
      mounts: MOUNTS,
    });
    watch.tick();
    await flush();
    expect(watch.current()).toEqual([{ mount: "/var/home", used: 635885920256, total: 635885920256 + 80650998 * 4096 }]);
  });

  test("home and root on one device: one disk, labelled by its mount point", async () => {
    const { watch } = harness({
      paths: ["/home/me", "/", "/home/me/.local/state/collie"],
      fs: { "/home/me": BTRFS, "/": BTRFS, "/home/me/.local/state/collie": BTRFS },
      devs: { "/": 1 },
    });
    watch.tick();
    await flush();
    expect(watch.current().map((d) => d.mount)).toEqual(["/"]);
  });

  test("home on its own device: two disks", async () => {
    const root = { ...BTRFS, type: 61267, blocks: 50_000_000, bfree: 10_000_000, bavail: 8_000_000 };
    const { watch } = harness({
      paths: ["/home/me", "/", "/home/me/.local/state/collie"],
      fs: { "/home/me": BTRFS, "/": root, "/home/me/.local/state/collie": BTRFS },
      devs: { "/": 1, "/home": 2 },
    });
    watch.tick();
    await flush();
    expect(watch.current().map((d) => d.mount)).toEqual(["/home", "/"]);
  });

  test("Windows: drive letters label the disks, and C: twice is one", async () => {
    const d = { ...BTRFS, type: 0, blocks: 60_000_000, bfree: 20_000_000, bavail: 20_000_000 };
    const { watch } = harness({
      platform: "win32",
      paths: ["C:\\Users\\me", "C:\\", "D:\\collie\\state"],
      fs: { "C:\\Users\\me": BTRFS, "C:\\": BTRFS, "D:\\collie\\state": d },
      devs: { "C:\\Users\\me": 7, "C:\\": 7, "D:\\collie\\state": 9 },
    });
    watch.tick();
    await flush();
    expect(watch.current().map((x) => x.mount)).toEqual(["C:", "D:"]);
  });

  test("a statfs that rejects reports nothing for that path, and the rest still shows", async () => {
    const { watch } = harness({
      paths: ["/mnt/gone", "/"],
      fs: { "/mnt/gone": "reject", "/": BTRFS },
      devs: { "/": 1, "/mnt/gone": 2 },
    });
    watch.tick();
    await flush();
    expect(watch.current().map((d) => d.mount)).toEqual(["/"]);
    expect(watch.pendingReads()).toBe(0);
  });

  test("a statfs that never resolves: the tick returns, the read is skipped not stacked, the others go on", async () => {
    const { watch, clock, calls } = harness({
      paths: ["/mnt/nfs", "/"],
      fs: { "/mnt/nfs": "hang", "/": BTRFS },
      devs: { "/": 1, "/mnt/nfs": 2 },
    });
    watch.tick();
    await flush();
    expect(watch.current().map((d) => d.mount)).toEqual(["/"]);
    expect(watch.pendingReads()).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      clock.now += DISK_READ_MS;
      watch.tick();
      await flush();
    }
    expect(calls.filter((p) => p === "/mnt/nfs")).toHaveLength(1);
    expect(calls.filter((p) => p === "/")).toHaveLength(6);
    expect(watch.pendingReads()).toBe(1);
    expect(watch.current().map((d) => d.mount)).toEqual(["/"]);
  });

  test("at most one round a minute; between rounds the last answer stands", async () => {
    const { watch, clock, calls } = harness({ paths: ["/"], fs: { "/": BTRFS }, devs: { "/": 1 } });
    watch.tick();
    await flush();
    for (let i = 0; i < 30; i += 1) {
      clock.now += 1_500;
      watch.tick();
    }
    await flush();
    expect(calls).toHaveLength(1);
    expect(watch.current()).toHaveLength(1);
    clock.now += DISK_READ_MS;
    watch.tick();
    await flush();
    expect(calls).toHaveLength(2);
  });

  test("an answer older than the stale limit is withheld", async () => {
    const fs: World["fs"] = { "/": BTRFS };
    const { watch, clock } = harness({ paths: ["/"], fs, devs: { "/": 1 } });
    watch.tick();
    await flush();
    expect(watch.current()).toHaveLength(1);
    fs["/"] = "hang";
    clock.now += DISK_READ_MS;
    watch.tick();
    await flush();
    clock.now += DISK_STALE_MS;
    expect(watch.current()).toEqual([]);
  });

  test("tick never throws when every reader fails", () => {
    const { watch } = harness({ paths: ["/"], fs: {}, mounts: null });
    expect(() => watch.tick()).not.toThrow();
  });
});
