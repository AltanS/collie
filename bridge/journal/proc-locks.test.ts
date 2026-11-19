import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { fileKey, flocksOf, heldCandidates, mountDevice, type ProcReader } from "./proc-locks.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Linux's dev_t encoding of `<major>:<minor>`, the inverse of what fileKey decodes. */
function makedev(major: bigint, minor: bigint): bigint {
  return (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
}

/** A folder with real files (realpath needs them), and a mount table that puts it on `0:36`, btrfs. */
function btrfsFolder(names: readonly string[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "collie-proc-locks-")));
  temps.push(dir);
  for (const name of names) writeFileSync(join(dir, name), "");
  const mounts = [
    "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw",
    `61 22 0:36 /home ${dir.replaceAll(" ", "\\040")} rw,relatime shared:174 - btrfs /dev/mapper/luks rw,subvolid=257`,
  ].join("\n");
  return { dir, path: (name: string) => join(dir, name), mounts };
}

/** A reader whose lock rows are `table` and whose mount table is `mounts`. */
function reader(table: string, mounts: string | null | undefined): ProcReader {
  const proc: ProcReader = { flocks: async (pid) => flocksOf(table, pid) };
  if (mounts !== undefined) proc.mounts = async () => mounts;
  return proc;
}

/** A btrfs subvolume's anonymous device, as stat reports it: 0:57. */
const SUBVOLUME = makedev(0n, 57n);
const PID = 4242;

describe("mountDevice", () => {
  const table = [
    "22 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw",
    "61 22 0:36 /home /var/home rw shared:1 - btrfs /dev/sda1 rw",
    "62 61 0:40 / /var/home/a\\040b rw - tmpfs tmpfs rw",
    "63 22 0:41 / /var/home rw - tmpfs tmpfs rw",
    "garbage",
    "64 22 zz / /var/home/x rw - tmpfs tmpfs rw",
    "65 22 0:42 / relative rw - tmpfs tmpfs rw",
    "66 22 0:43 / /var/home/y",
  ].join("\n");

  test("names the deepest mount, the later of two at one point, and undoes escapes", () => {
    expect(mountDevice(table, "/etc/passwd")).toBe("259:2");
    expect(mountDevice(table, "/var/home/a b/file")).toBe("0:40");
    expect(mountDevice(table, "/var/home/ab")).toBe("0:41");
    expect(mountDevice(table, "/var/homework")).toBe("259:2");
  });

  test("skips rows of another shape", () => {
    expect(mountDevice(table, "/var/home/x/f")).toBe("0:41");
    expect(mountDevice(table, "/var/home/y/f")).toBe("0:41");
    expect(mountDevice("garbage\n\n", "/a")).toBeNull();
  });
});

describe("heldCandidates", () => {
  test("an exact device and inode match is a match", async () => {
    const dev = makedev(259n, 3n);
    const candidates = [
      { path: "/nowhere/a", dev, ino: 11n },
      { path: "/nowhere/b", dev, ino: 12n },
    ];
    const table = `1: FLOCK  ADVISORY  WRITE ${PID} 103:03:11 0 EOF`;
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, undefined))).toEqual([candidates[0]!]);
    expect(fileKey(dev, 11n)).toBe("259:3:11");
  });

  test("a btrfs-shaped row (the filesystem's device, the subvolume in stat) matches when unique", async () => {
    const { path, mounts } = btrfsFolder(["a.lock", "b.lock"]);
    const candidates = [
      { path: path("a.lock"), dev: SUBVOLUME, ino: 7n },
      { path: path("b.lock"), dev: SUBVOLUME, ino: 8n },
    ];
    // 00:24 is 0:36 in hex, as /proc/locks prints it.
    const table = `90: FLOCK  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`;
    // A mount table names POSIX mount points. On Windows the folder's real path is `C:\...`, which no row holds, so
    // nothing matches (the product never asks there: `LINUX_PROC` answers null off Linux).
    const held = HOST.platform === "win32" ? [] : [candidates[0]!];
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, mounts))).toEqual(held);
  });

  test("an exact match anywhere turns the btrfs rule off", async () => {
    const { path, mounts } = btrfsFolder(["a.lock", "b.lock"]);
    const candidates = [
      { path: path("a.lock"), dev: SUBVOLUME, ino: 7n },
      { path: path("b.lock"), dev: SUBVOLUME, ino: 8n },
    ];
    const table = [`1: FLOCK  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`, `2: FLOCK  ADVISORY  WRITE ${PID} 00:39:8 0 EOF`].join("\n");
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, mounts))).toEqual([candidates[1]!]);
  });

  test("two candidates with one inode number never match through the rule", async () => {
    const { path, mounts } = btrfsFolder(["a.lock", "b.lock"]);
    const candidates = [
      { path: path("a.lock"), dev: SUBVOLUME, ino: 7n },
      { path: path("b.lock"), dev: makedev(0n, 58n), ino: 7n },
    ];
    const table = `1: FLOCK  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`;
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, mounts))).toEqual([]);
  });

  test("a lock held by another pid does not match", async () => {
    const { path, mounts } = btrfsFolder(["a.lock"]);
    const candidates = [{ path: path("a.lock"), dev: SUBVOLUME, ino: 7n }];
    const table = [`1: FLOCK  ADVISORY  WRITE 99 00:24:7 0 EOF`, `2: FLOCK  ADVISORY  WRITE 99 00:39:7 0 EOF`].join("\n");
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, mounts))).toEqual([]);
  });

  test("the same inode number on a device the mount table does not name does not match", async () => {
    const { path, mounts } = btrfsFolder(["a.lock"]);
    const candidates = [{ path: path("a.lock"), dev: SUBVOLUME, ino: 7n }];
    // 0:99 is some other anonymous filesystem (a tmpfs), the case a bare inode match let through.
    const table = `1: FLOCK  ADVISORY  WRITE ${PID} 00:63:7 0 EOF`;
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, mounts))).toEqual([]);
  });

  test("a file on a block device, a reader without a mount table, or an unreadable one get exact matches only", async () => {
    const { path, mounts } = btrfsFolder(["a.lock"]);
    const table = `1: FLOCK  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`;
    const locked = flocksOf(table, PID);
    const onDisk = [{ path: path("a.lock"), dev: makedev(259n, 3n), ino: 7n }];
    expect(await heldCandidates(locked, onDisk, reader(table, mounts))).toEqual([]);
    const onSubvolume = [{ path: path("a.lock"), dev: SUBVOLUME, ino: 7n }];
    expect(await heldCandidates(locked, onSubvolume, reader(table, undefined))).toEqual([]);
    expect(await heldCandidates(locked, onSubvolume, reader(table, null))).toEqual([]);
    const failing: ProcReader = { flocks: async () => locked, mounts: () => Promise.reject(new Error("EACCES")) };
    expect(await heldCandidates(locked, onSubvolume, failing)).toEqual([]);
  });

  test("a file that is gone, or a path no mount holds, does not match", async () => {
    const { path, mounts } = btrfsFolder([]);
    const table = `1: FLOCK  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`;
    const gone = [{ path: path("gone.lock"), dev: SUBVOLUME, ino: 7n }];
    expect(await heldCandidates(flocksOf(table, PID), gone, reader(table, mounts))).toEqual([]);
    const { path: elsewhere } = btrfsFolder(["a.lock"]);
    const unmounted = [{ path: elsewhere("a.lock"), dev: SUBVOLUME, ino: 7n }];
    expect(await heldCandidates(flocksOf(table, PID), unmounted, reader(table, "61 1 0:36 / /mnt/other rw - btrfs x rw"))).toEqual([]);
  });

  test("malformed and other-kind rows are ignored", async () => {
    const { path, mounts } = btrfsFolder(["a.lock"]);
    const candidates = [{ path: path("a.lock"), dev: SUBVOLUME, ino: 7n }];
    const table = [
      `1: POSIX  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`,
      `2: -> FLOCK  ADVISORY  WRITE ${PID} 00:24:7 0 EOF`,
      `3: FLOCK  ADVISORY  READ  ${PID} 00:24:7 0 EOF`,
      `4: OFDLCK ADVISORY  WRITE -1 00:24:7 0 EOF`,
      `5: FLOCK  ADVISORY  WRITE ${PID} 00:24 0 EOF`,
      `6: FLOCK  ADVISORY  WRITE ${PID} xx:24:7 0 EOF`,
      "garbage",
    ].join("\n");
    expect(await heldCandidates(flocksOf(table, PID), candidates, reader(table, mounts))).toEqual([]);
  });
});
