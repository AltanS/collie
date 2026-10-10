import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";

import { hostFor } from "./host.ts";
import { DiskWatch } from "./machine-disks.ts";
import {
  cpuFraction,
  cpuTimesFromOs,
  MachineSampler,
  netRate,
  parseMeminfo,
  isSkippedInterface,
  parseNetDev,
  parseProcStat,
  parseVmStat,
  procStatCores,
  SAMPLE_IDLE_MS,
  SAMPLE_WATCHED_MS,
  VM_STAT,
  type OsReader,
} from "./machine-stats.ts";

// The sampler's parsers and its one reader, with a Linux, a macOS-like and a Windows-like host
// injected. A pinned host changes which sources are read; nothing here reads the machine it runs on.

const T0 = 1_754_000_000_000;

/** A real `/proc/stat` head (Fedora, 2026-10-05), trimmed to the aggregate line and one core. */
const STAT_A = `cpu  624840727 7421670 337284805 3792041316 1153580026 17894637 25447350 0 1666299 0
cpu0 29897758 452351 17533705 243258911 76235356 1053229 3863494 0 55185 0
intr 1 2 3
`;

function statLine(user: number, nice: number, system: number, idle: number, iowait: number, irq: number, softirq: number, steal: number): string {
  return `cpu  ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 999 999\n`;
}

const MEMINFO = `MemTotal:       16000000 kB
MemFree:         2000000 kB
MemAvailable:   12000000 kB
Buffers:          500000 kB
Cached:          6000000 kB
`;

const NETDEV = (lo: number, eth: [number, number], wlan: [number, number]) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: ${lo} 10 0 0 0 0 0 0 ${lo} 10 0 0 0 0 0 0
  eth0: ${eth[0]} 100 0 0 0 0 0 0 ${eth[1]} 90 0 0 0 0 0 0
 wlan0: ${wlan[0]} 100 0 0 0 0 0 0 ${wlan[1]} 90 0 0 0 0 0 0
`;

function core(user: number, sys: number, idle: number): CpuInfo {
  return { model: "test", speed: 3000, times: { user, nice: 0, sys, idle, irq: 0 } };
}

describe("parseProcStat", () => {
  test("reads the aggregate line, counts iowait as idle, and leaves guest out", () => {
    const t = parseProcStat(STAT_A)!;
    const cols = [624840727, 7421670, 337284805, 3792041316, 1153580026, 17894637, 25447350, 0];
    const total = cols.reduce((a, b) => a + b, 0);
    expect(t.total).toBe(total);
    // idle + iowait are idle; guest (1666299) is already inside user and is not added again.
    expect(t.busy).toBe(total - 3792041316 - 1153580026);
  });

  test("an old kernel's four columns still parse; fewer, or garbage, do not", () => {
    expect(parseProcStat("cpu  10 0 10 80\n")).toEqual({ busy: 20, total: 100 });
    expect(parseProcStat("cpu  10 0 10\n")).toBeNull();
    expect(parseProcStat("cpu  10 x 10 80\n")).toBeNull();
    expect(parseProcStat("cpu0 1 2 3 4\n")).toBeNull();
    expect(parseProcStat("")).toBeNull();
  });
});

describe("procStatCores", () => {
  test("counts the cpuN lines, and nothing else", () => {
    expect(procStatCores(STAT_A)).toBe(1);
    const four = `cpu  1 2 3 4\n${[0, 1, 2, 3].map((n) => `cpu${n} 1 2 3 4`).join("\n")}\nintr 1 2\nctxt 5\n`;
    expect(procStatCores(four)).toBe(4);
    expect(procStatCores("cpu  1 2 3 4\n")).toBe(0);
    expect(procStatCores("")).toBe(0);
  });
});

describe("the cpu delta", () => {
  test("is the busy share of the time between two readings", () => {
    const a = parseProcStat(statLine(100, 0, 100, 700, 100, 0, 0, 0))!;
    const b = parseProcStat(statLine(150, 0, 130, 900, 120, 0, 0, 0))!;
    // busy +80, idle +200, iowait +20 → 80 / 300.
    expect(cpuFraction(a, b)).toBeCloseTo(80 / 300, 10);
  });

  test("os.cpus() is summed over every core", () => {
    const a = cpuTimesFromOs([core(100, 50, 850), core(0, 0, 1000)])!;
    const b = cpuTimesFromOs([core(400, 50, 1050), core(100, 100, 1300)])!;
    // busy +300 +200 = 500, idle +200 +300 = 500.
    expect(cpuFraction(a, b)).toBe(0.5);
    expect(cpuTimesFromOs([])).toBeNull();
  });

  test("no time passed, or a counter that went backwards, says nothing", () => {
    const a = { busy: 10, total: 100 };
    expect(cpuFraction(a, a)).toBeNull();
    expect(cpuFraction(a, { busy: 5, total: 200 })).toBeNull();
    expect(cpuFraction(a, { busy: 10, total: 50 })).toBeNull();
  });

  test("two reads that disagree by a tick are clamped into 0..1", () => {
    expect(cpuFraction({ busy: 0, total: 0 }, { busy: 101, total: 100 })).toBe(1);
  });
});

describe("parseMeminfo", () => {
  test("used is total minus available, in bytes", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ used: 4_000_000 * 1024, total: 16_000_000 * 1024 });
  });

  test("a kernel with no MemAvailable falls back to free + buffers + cached", () => {
    const old = MEMINFO.replace(/^MemAvailable.*\n/m, "");
    expect(parseMeminfo(old)).toEqual({ used: 7_500_000 * 1024, total: 16_000_000 * 1024 });
  });

  test("no MemTotal is no reading", () => {
    expect(parseMeminfo("MemFree: 10 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });
});

/**
 * `vm_stat` as a 32 GiB Apple silicon Mac prints it (16 KiB pages), in the layout of Apple's
 * vm_stat.c (system_cmds): the page size in the first line, then `label: count.` rows. The counts are
 * invented but shaped like a loaded machine: a large file cache (File-backed + inactive) that
 * `os.freemem()` reads as used.
 */
const VM_STAT_APPLE_SILICON = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            345678.
Pages inactive:                          311990.
Pages speculative:                         8123.
Pages throttled:                              0.
Pages wired down:                        189432.
Pages purgeable:                          23456.
"Translation faults":                 987654321.
Pages copy-on-write:                   12345678.
Pages zero filled:                    456789012.
Pages reactivated:                      3456789.
Pages purged:                           6789012.
File-backed pages:                       396512.
Anonymous pages:                         654321.
Pages stored in compressor:              410234.
Pages occupied by compressor:            101234.
Decompressions:                         9876543.
Compressions:                          12345678.
Pageins:                                2345678.
Pageouts:                                  1234.
Swapins:                                      0.
Swapouts:                                     0.
`;

// Hand calculation: app = 654321 - 23456 = 630865 pages; + wired 189432 + compressor 101234
// = 921531 pages; x 16384 bytes = 15_098_363_904 bytes (14.06 GiB).
const VM_STAT_USED = 15_098_363_904;

describe("parseVmStat", () => {
  test("used is anonymous minus purgeable, plus wired, plus the compressor, in the printed page size", () => {
    expect(parseVmStat(VM_STAT_APPLE_SILICON)).toEqual({ used: VM_STAT_USED, pageSize: 16384 });
    expect((654321 - 23456 + 189432 + 101234) * 16384).toBe(VM_STAT_USED);
  });

  test("the page size comes from the first line, so an Intel Mac counts 4 KiB pages", () => {
    const intel = VM_STAT_APPLE_SILICON.replace("page size of 16384 bytes", "page size of 4096 bytes");
    expect(parseVmStat(intel)).toEqual({ used: 921531 * 4096, pageSize: 4096 });
  });

  test("purgeable above anonymous counts app memory as zero, never negative", () => {
    const odd = VM_STAT_APPLE_SILICON.replace("Anonymous pages:                         654321.", "Anonymous pages:                          1000.");
    expect(parseVmStat(odd)!.used).toBe((189432 + 101234) * 16384);
  });

  test("a missing field, or a missing page size, is no answer", () => {
    for (const label of ["Anonymous pages", "Pages purgeable", "Pages wired down", "Pages occupied by compressor"]) {
      const without = VM_STAT_APPLE_SILICON.split("\n").filter((line) => !line.startsWith(`${label}:`)).join("\n");
      expect(parseVmStat(without)).toBeNull();
    }
    expect(parseVmStat(VM_STAT_APPLE_SILICON.replace("(page size of 16384 bytes)", ""))).toBeNull();
    expect(parseVmStat("")).toBeNull();
    expect(parseVmStat("vm_stat: command not found")).toBeNull();
  });

  test("a label that only ends the same way is not matched", () => {
    // `Pages purgeable:` must not be satisfied by a longer label that ends in it.
    const text = VM_STAT_APPLE_SILICON.replace("Pages purgeable:", "Total Pages purgeable:");
    expect(parseVmStat(text)).toBeNull();
  });
});

describe("network", () => {
  test("parseNetDev reads every interface but loopback", () => {
    const counters = parseNetDev(NETDEV(5, [1000, 200], [30, 40]))!;
    expect([...counters.keys()]).toEqual(["eth0", "wlan0"]);
    expect(counters.get("eth0")).toEqual({ rx: 1000, tx: 200 });
  });

  test("parseNetDev counts physical interfaces only: bridges, veth and tap ends, tunnels and aggregates are left out", () => {
    const row = (name: string) => `  ${name}: 100 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0`;
    const counted = ["eth0", "enp3s0", "eno1", "wlan0", "wlp2s0", "wwan0", "usb0", "ens5"];
    const skipped = [
      "lo",
      "veth1a2b3c",
      "docker0",
      "br-0123abcd",
      "br0",
      "virbr0",
      "vnet3",
      "tap0",
      "cni0",
      "flannel.1",
      "cali1234",
      "cilium_host",
      "podman0",
      "lxdbr0",
      "tailscale0",
      "wg0",
      "tun0",
      "ztabcdef",
      "bond0",
      "team0",
      "eth0.100",
    ];
    const text = ["Inter-|   Receive |  Transmit", " face |bytes |bytes", ...counted.map(row), ...skipped.map(row)].join("\n");
    expect([...parseNetDev(text)!.keys()]).toEqual(counted);
    for (const name of skipped) expect(isSkippedInterface(name)).toBe(true);
    for (const name of counted) expect(isSkippedInterface(name)).toBe(false);
  });

  test("the rate is per second over the interfaces present in both readings", () => {
    const a = parseNetDev(NETDEV(0, [1000, 200], [0, 0]))!;
    const b = parseNetDev(NETDEV(9e9, [6000, 1200], [500, 0]))!;
    // 5 s apart: eth0 +5000/+1000, wlan0 +500/0; loopback's jump counts for nothing.
    expect(netRate(a, b, 5000)).toEqual({ rx: 1100, tx: 200 });
  });

  test("an interface that appears, or a counter that resets, adds nothing", () => {
    const a = new Map([["eth0", { rx: 1000, tx: 1000 }]]);
    const b = new Map([
      ["eth0", { rx: 10, tx: 10 }],
      ["veth1", { rx: 9e9, tx: 9e9 }],
    ]);
    expect(netRate(a, b, 1000)).toEqual({ rx: 0, tx: 0 });
    expect(netRate(a, a, 0)).toBeNull();
  });
});

/** A fake host's sources. Each field can be changed between ticks. */
function fakeSources() {
  const state = {
    now: T0,
    files: new Map<string, string>(),
    cpus: [core(100, 100, 800)],
    total: 8e9,
    free: 6e9,
    load: [0.5, 0.4, 0.3],
    reads: new Array<string>(),
  };
  const os: OsReader = {
    cpus: () => state.cpus,
    totalmem: () => state.total,
    freemem: () => state.free,
    loadavg: () => state.load,
  };
  const readText = (path: string) => {
    state.reads.push(path);
    return state.files.get(path) ?? null;
  };
  return { state, os, readText, now: () => state.now };
}

describe("MachineSampler — a Linux host", () => {
  test("watched: the first reading yields nothing, the next one inside five seconds is skipped, then a sample", () => {
    const src = fakeSources();
    src.state.cpus = Array.from({ length: 16 }, () => core(0, 0, 0));
    src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
    src.state.files.set("/proc/meminfo", MEMINFO);
    src.state.files.set("/proc/net/dev", NETDEV(0, [1000, 200], [0, 0]));
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });

    expect(sampler.tick(SAMPLE_WATCHED_MS)).toBeNull();
    expect(sampler.latest()).toBeNull();

    src.state.now += SAMPLE_WATCHED_MS - 1;
    const readsBefore = src.state.reads.length;
    expect(sampler.tick(SAMPLE_WATCHED_MS)).toBeNull();
    // Too soon means nothing is READ, not merely nothing returned.
    expect(src.state.reads.length).toBe(readsBefore);

    src.state.now = T0 + 5000;
    src.state.files.set("/proc/stat", statLine(150, 0, 130, 900, 120, 0, 0, 0));
    src.state.files.set("/proc/net/dev", NETDEV(0, [6000, 1200], [0, 0]));
    const sample = sampler.tick(SAMPLE_WATCHED_MS)!;
    expect(sample.cpu).toBeCloseTo(80 / 300, 10);
    expect(sample.cores).toBe(16);
    expect(sample.memUsed).toBe(4_000_000 * 1024);
    expect(sample.memTotal).toBe(16_000_000 * 1024);
    expect(sample.load1).toBe(0.5);
    expect(sample.rxBps).toBe(1000);
    expect(sample.txBps).toBe(200);
    expect(sampler.latest()).toEqual(sample);
  });

  test("nobody watching: a reading at most every fifteen seconds, and nothing read in between", () => {
    const src = fakeSources();
    src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
    src.state.files.set("/proc/meminfo", MEMINFO);
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    // The first sample comes at the watched pace, so a fresh start shows its load within seconds.
    src.state.now = T0 + SAMPLE_WATCHED_MS;
    src.state.files.set("/proc/stat", statLine(150, 0, 130, 900, 120, 0, 0, 0));
    expect(sampler.tick()?.cpu).toBeCloseTo(80 / 300, 10);
    const reads = src.state.reads.length;
    const at = src.state.now;
    for (const step of [5_000, 12_000, SAMPLE_IDLE_MS - 1]) {
      src.state.now = at + step;
      expect(sampler.tick()).toBeNull();
    }
    expect(src.state.reads.length).toBe(reads);
    src.state.now = at + SAMPLE_IDLE_MS;
    src.state.files.set("/proc/stat", statLine(200, 0, 160, 1100, 140, 0, 0, 0));
    expect(sampler.tick()?.cpu).toBeCloseTo(80 / 300, 10);
  });

  test("a clock that steps back reads at once instead of waiting for the old time to come round", () => {
    const src = fakeSources();
    src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
    src.state.files.set("/proc/meminfo", MEMINFO);
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now = T0 + SAMPLE_WATCHED_MS;
    src.state.files.set("/proc/stat", statLine(150, 0, 130, 900, 120, 0, 0, 0));
    expect(sampler.tick()).not.toBeNull();
    // Ten minutes back, as an NTP step or a resume can do.
    src.state.now = T0 + SAMPLE_WATCHED_MS - 600_000;
    const reads = src.state.reads.length;
    src.state.files.set("/proc/stat", statLine(200, 0, 160, 1100, 140, 0, 0, 0));
    expect(sampler.tick(SAMPLE_IDLE_MS)).not.toBeNull();
    expect(src.state.reads.length).toBeGreaterThan(reads);
    // And it carries on at its own pace from there.
    const after = src.state.reads.length;
    src.state.now += SAMPLE_IDLE_MS - 1;
    expect(sampler.tick(SAMPLE_IDLE_MS)).toBeNull();
    expect(src.state.reads.length).toBe(after);
  });

  test("before its first sample, a sampler reads again after five seconds, never sooner", () => {
    const src = fakeSources();
    src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
    src.state.files.set("/proc/meminfo", MEMINFO);
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now = T0 + SAMPLE_WATCHED_MS - 1;
    expect(sampler.tick()).toBeNull();
    src.state.now = T0 + SAMPLE_WATCHED_MS;
    src.state.files.set("/proc/stat", statLine(150, 0, 130, 900, 120, 0, 0, 0));
    expect(sampler.tick()).not.toBeNull();
  });

  test("Linux counts its cores off /proc/stat and never asks os.cpus() while that file answers", () => {
    const src = fakeSources();
    let asked = 0;
    const os = { ...src.os, cpus: () => (asked++, src.state.cpus) };
    src.state.files.set("/proc/stat", STAT_A);
    src.state.files.set("/proc/meminfo", MEMINFO);
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os, now: src.now });
    sampler.tick();
    src.state.now += SAMPLE_IDLE_MS;
    src.state.files.set("/proc/stat", STAT_A.replace("cpu  624840727", "cpu  624841727"));
    expect(sampler.tick()?.cores).toBe(1);
    expect(asked).toBe(0);
  });

  test("a reading from /proc/stat and the next from node:os count in two units, so they give no sample", () => {
    const src = fakeSources();
    src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
    src.state.files.set("/proc/meminfo", MEMINFO);
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.files.delete("/proc/stat");
    src.state.now += SAMPLE_IDLE_MS;
    expect(sampler.tick()).toBeNull();
    // The next pair is from one source again, and samples.
    src.state.now += SAMPLE_IDLE_MS;
    src.state.cpus = [core(400, 100, 1000)];
    expect(sampler.tick()?.cpu).toBe(0.6);
  });

  test("an unreadable /proc falls back to node:os, and loses only the network", () => {
    const src = fakeSources();
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now += SAMPLE_IDLE_MS;
    src.state.cpus = [core(400, 100, 1000)];
    const sample = sampler.tick()!;
    // busy +300, idle +200.
    expect(sample.cpu).toBe(0.6);
    expect(sample).toEqual({ cpu: 0.6, cores: 1, memUsed: 2e9, memTotal: 8e9, load1: 0.5 });
  });

  test("a source that throws is a source that said nothing, and the tick survives it", () => {
    const src = fakeSources();
    const sampler = new MachineSampler({
      host: hostFor("linux"),
      readText: () => {
        throw new Error("EACCES");
      },
      os: {
        ...src.os,
        cpus: () => {
          throw new Error("sandboxed");
        },
      },
      now: src.now,
    });
    expect(sampler.tick()).toBeNull();
    src.state.now += SAMPLE_IDLE_MS;
    expect(sampler.tick()).toBeNull();
    expect(sampler.latest()).toBeNull();
  });
});

describe("MachineSampler — a macOS-like host", () => {
  test("cpu from os.cpus(), memory from node:os, a load average, no network, and no file read", () => {
    const src = fakeSources();
    const sampler = new MachineSampler({ host: hostFor("darwin"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now += SAMPLE_IDLE_MS;
    src.state.cpus = [core(150, 150, 1000)];
    src.state.free = 2e9;
    expect(sampler.tick()).toEqual({ cpu: 100 / 300, cores: 1, memUsed: 6e9, memTotal: 8e9, load1: 0.5 });
    expect(src.state.reads).toEqual([]);
  });
});

describe("MachineSampler — macOS memory from vm_stat", () => {
  const TOTAL = 34_359_738_368;
  const FALLBACK = TOTAL - 1.2e9;

  /** A macOS-like host whose async runner answers with `answer()`, every call recorded. */
  function macWith(answer: () => Promise<string | null>) {
    const src = fakeSources();
    src.state.total = TOTAL;
    // `os.freemem()` on macOS: free + speculative only, so 1.2 GB reads as 33.2 GB used.
    src.state.free = 1.2e9;
    const calls: string[][] = [];
    const run = (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return answer();
    };
    return { src, calls, run };
  }

  function sampler(platform: "darwin" | "linux" | "win32", src: ReturnType<typeof fakeSources>, run?: ReturnType<typeof macWith>["run"]) {
    return new MachineSampler({ host: hostFor(platform), readText: src.readText, os: src.os, now: src.now, run });
  }

  /** Advance one idle interval and move the cpu counters so a sample is produced. */
  function step(src: ReturnType<typeof fakeSources>, n: number) {
    src.state.now += SAMPLE_IDLE_MS;
    src.state.cpus = [core(100 + 50 * n, 100 + 50 * n, 800 + 200 * n)];
  }

  async function settle() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  test("the first sample falls back, the next one serves the vm_stat answer", async () => {
    const { src, calls, run } = macWith(async () => VM_STAT_APPLE_SILICON);
    const s = sampler("darwin", src, run);
    s.tick();
    // Started, not awaited: the tick returned before the answer exists.
    expect(calls).toEqual([[VM_STAT]]);
    step(src, 1);
    expect(s.tick()!.memUsed).toBe(FALLBACK);
    await settle();
    step(src, 2);
    const sample = s.tick()!;
    expect(sample.memUsed).toBe(VM_STAT_USED);
    expect(sample.memTotal).toBe(TOTAL);
    expect(VM_STAT).toBe("/usr/bin/vm_stat");
  });

  test("no second vm_stat starts while one is in flight", async () => {
    let release: (text: string | null) => void = () => {};
    const { src, calls, run } = macWith(() => new Promise<string | null>((resolve) => (release = resolve)));
    const s = sampler("darwin", src, run);
    for (let n = 0; n < 4; n += 1) {
      s.tick();
      step(src, n + 1);
    }
    expect(calls).toHaveLength(1);
    release(VM_STAT_APPLE_SILICON);
    await settle();
    expect(s.tick()!.memUsed).toBe(VM_STAT_USED);
    // The answer arrived, so that tick started the next run.
    expect(calls).toHaveLength(2);
  });

  test("a failing, throwing or unparsable run falls back to total - free", async () => {
    const answers: Array<() => Promise<string | null>> = [
      async () => null,
      async () => {
        throw new Error("spawn failed");
      },
      async () => "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\n",
    ];
    for (const answer of answers) {
      const { src, run } = macWith(answer);
      const s = sampler("darwin", src, run);
      s.tick();
      await settle();
      step(src, 1);
      expect(s.tick()!.memUsed).toBe(FALLBACK);
      await settle();
      step(src, 2);
      expect(s.tick()!.memUsed).toBe(FALLBACK);
    }
  });

  test("an answer older than three idle intervals is not served, and a later failure keeps the old one until then", async () => {
    let healthy = true;
    const { src, run } = macWith(async () => (healthy ? VM_STAT_APPLE_SILICON : null));
    const s = sampler("darwin", src, run);
    s.tick();
    await settle();
    healthy = false;
    step(src, 1);
    expect(s.tick()!.memUsed).toBe(VM_STAT_USED);
    await settle();
    // The answer was held at T0. At 30 s and at 45 s (3 x 15 s) it is still served.
    for (const n of [2, 3]) {
      step(src, n);
      expect(s.tick()!.memUsed).toBe(VM_STAT_USED);
      await settle();
    }
    // At 60 s it is too old, and every run since has failed.
    step(src, 4);
    expect(s.tick()!.memUsed).toBe(FALLBACK);
  });

  test("no runner at all falls back to total - free", () => {
    const src = fakeSources();
    const s = sampler("darwin", src);
    s.tick();
    step(src, 1);
    expect(s.tick()!.memUsed).toBe(2e9);
  });

  test("a reading above the total is clamped to the total", async () => {
    const { src, run } = macWith(async () => VM_STAT_APPLE_SILICON);
    src.state.total = 1e9;
    const s = sampler("darwin", src, run);
    s.tick();
    await settle();
    step(src, 1);
    expect(s.tick()!.memUsed).toBe(1e9);
  });

  test("linux and windows never run the command", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const { src, calls, run } = macWith(async () => VM_STAT_APPLE_SILICON);
      src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
      src.state.files.set("/proc/meminfo", MEMINFO);
      const s = sampler(platform, src, run);
      s.tick();
      await settle();
      step(src, 1);
      s.tick();
      expect(calls).toEqual([]);
    }
  });
});

describe("MachineSampler — disks ride along", () => {
  test("the tick starts the disk round without waiting, and the next sample carries its answer", async () => {
    const src = fakeSources();
    let statfsCalls = 0;
    const disks = new DiskWatch({
      platform: "darwin",
      paths: ["/"],
      statfs: async () => {
        statfsCalls += 1;
        return { type: 1, bsize: 4096, blocks: 1_000_000, bfree: 400_000, bavail: 400_000 };
      },
      dev: async () => 1,
      realpath: async (p) => p,
      mounts: async () => null,
      now: src.now,
    });
    const sampler = new MachineSampler({ host: hostFor("darwin"), readText: src.readText, os: src.os, now: src.now, disks });
    sampler.tick();
    // Started, not awaited: the tick has returned before the read is even issued.
    expect(statfsCalls).toBe(0);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(statfsCalls).toBe(1);
    src.state.now += SAMPLE_IDLE_MS;
    src.state.cpus = [core(150, 150, 1000)];
    const sample = sampler.tick()!;
    expect(sample.disks).toEqual([{ mount: "/", used: 600_000 * 4096, total: 1_000_000 * 4096 }]);
    // Fifteen seconds later is inside the minute: no second round.
    expect(statfsCalls).toBe(1);
  });
});

describe("MachineSampler — a Windows-like host", () => {
  test("no load average (node answers zeros there), no network, and no file read", () => {
    const src = fakeSources();
    src.state.load = [0, 0, 0];
    const sampler = new MachineSampler({ host: hostFor("win32"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now += SAMPLE_IDLE_MS;
    src.state.cpus = [core(200, 100, 900)];
    const sample = sampler.tick()!;
    expect(sample).toEqual({ cpu: 0.5, cores: 1, memUsed: 2e9, memTotal: 8e9 });
    expect("load1" in sample).toBe(false);
    expect(src.state.reads).toEqual([]);
  });
});
