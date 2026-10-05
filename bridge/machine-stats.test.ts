import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";

import { hostFor } from "./host.ts";
import {
  cpuFraction,
  cpuTimesFromOs,
  MachineSampler,
  netRate,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  SAMPLE_MIN_INTERVAL_MS,
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

describe("network", () => {
  test("parseNetDev reads every interface but loopback", () => {
    const counters = parseNetDev(NETDEV(5, [1000, 200], [30, 40]))!;
    expect([...counters.keys()]).toEqual(["eth0", "wlan0"]);
    expect(counters.get("eth0")).toEqual({ rx: 1000, tx: 200 });
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
  test("the first reading yields nothing, the next one inside five seconds is skipped, then a sample", () => {
    const src = fakeSources();
    src.state.cpus = Array.from({ length: 16 }, () => core(0, 0, 0));
    src.state.files.set("/proc/stat", statLine(100, 0, 100, 700, 100, 0, 0, 0));
    src.state.files.set("/proc/meminfo", MEMINFO);
    src.state.files.set("/proc/net/dev", NETDEV(0, [1000, 200], [0, 0]));
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });

    expect(sampler.tick()).toBeNull();
    expect(sampler.latest()).toBeNull();

    src.state.now += SAMPLE_MIN_INTERVAL_MS - 1;
    const readsBefore = src.state.reads.length;
    expect(sampler.tick()).toBeNull();
    // Too soon means nothing is READ, not merely nothing returned.
    expect(src.state.reads.length).toBe(readsBefore);

    src.state.now = T0 + 5000;
    src.state.files.set("/proc/stat", statLine(150, 0, 130, 900, 120, 0, 0, 0));
    src.state.files.set("/proc/net/dev", NETDEV(0, [6000, 1200], [0, 0]));
    const sample = sampler.tick()!;
    expect(sample.cpu).toBeCloseTo(80 / 300, 10);
    expect(sample.cores).toBe(16);
    expect(sample.memUsed).toBe(4_000_000 * 1024);
    expect(sample.memTotal).toBe(16_000_000 * 1024);
    expect(sample.load1).toBe(0.5);
    expect(sample.rxBps).toBe(1000);
    expect(sample.txBps).toBe(200);
    expect(sampler.latest()).toEqual(sample);
  });

  test("an unreadable /proc falls back to node:os, and loses only the network", () => {
    const src = fakeSources();
    const sampler = new MachineSampler({ host: hostFor("linux"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now += 6000;
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
    src.state.now += 6000;
    expect(sampler.tick()).toBeNull();
    expect(sampler.latest()).toBeNull();
  });
});

describe("MachineSampler — a macOS-like host", () => {
  test("cpu from os.cpus(), memory from node:os, a load average, no network, and no file read", () => {
    const src = fakeSources();
    const sampler = new MachineSampler({ host: hostFor("darwin"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now += 5000;
    src.state.cpus = [core(150, 150, 1000)];
    src.state.free = 2e9;
    expect(sampler.tick()).toEqual({ cpu: 100 / 300, cores: 1, memUsed: 6e9, memTotal: 8e9, load1: 0.5 });
    expect(src.state.reads).toEqual([]);
  });
});

describe("MachineSampler — a Windows-like host", () => {
  test("no load average (node answers zeros there), no network, and no file read", () => {
    const src = fakeSources();
    src.state.load = [0, 0, 0];
    const sampler = new MachineSampler({ host: hostFor("win32"), readText: src.readText, os: src.os, now: src.now });
    sampler.tick();
    src.state.now += 5000;
    src.state.cpus = [core(200, 100, 900)];
    const sample = sampler.tick()!;
    expect(sample).toEqual({ cpu: 0.5, cores: 1, memUsed: 2e9, memTotal: 8e9 });
    expect("load1" in sample).toBe(false);
    expect(src.state.reads).toEqual([]);
  });
});
