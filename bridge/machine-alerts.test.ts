import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateMachineAlerts,
  judgeAlert,
  MACHINE_ALERTS_FILE,
  machineAlertMessage,
  MachineAlertStore,
  type AlertSubject,
} from "./machine-alerts.ts";
import { MachineHistory, MINUTE_MS, type MinuteReading } from "./machine-history.ts";
import { parseMachineAlerts } from "./machine-parse.ts";
import { hostFor } from "./host.ts";
import { MachineSampler, SAMPLE_IDLE_MS, SAMPLE_WATCHED_MS } from "./machine-stats.ts";
import { MACHINES_WATCH_MS, MachineWatch, type MachineRosterEntry, sameSample } from "./machines.ts";
import { machineTopic, type PushMessage } from "./push.ts";
import type { MachineSample } from "./types.ts";

// The evaluator is pure and judged as data; the store and the watch are driven over a temp folder.
// Five promises: it fires once, it needs coverage, it closes with hysteresis, it survives a restart,
// and it ignores a machine that is not answering.

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-machine-alerts-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Complete minutes ending just before `now`'s minute: `values[0]` is the oldest. */
function minutes(values: readonly (number | null)[], now: number): MinuteReading[] {
  const open = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return values.flatMap((v, i) =>
    v === null ? [] : [{ t: open - (values.length - i) * MINUTE_MS, cpu: v, mem: v, disk: v }],
  );
}

const RULE = { above: 0.9, forMin: 10 };
const NOW = T0 + 30 * MINUTE_MS + 15_000;

describe("judgeAlert — when a rule fires", () => {
  test("every complete minute of the window at or above the line fires, with the window's average", () => {
    const v = judgeAlert("cpu", RULE, false, minutes(Array(10).fill(0.95), NOW), NOW);
    expect(v.kind).toBe("fire");
    expect(v.kind === "fire" ? v.value : 0).toBeCloseTo(0.95, 10);
    // Exactly on the line counts.
    expect(judgeAlert("cpu", RULE, false, minutes(Array(10).fill(0.9), NOW), NOW).kind).toBe("fire");
  });

  test("one minute below the line holds", () => {
    const values = [...Array(9).fill(0.99), 0.89];
    expect(judgeAlert("cpu", RULE, false, minutes(values, NOW), NOW).kind).toBe("hold");
  });

  test("it needs data for at least 80 % of the window", () => {
    const eight = [null, null, ...Array(8).fill(0.99)];
    const seven = [null, null, null, ...Array(7).fill(0.99)];
    expect(judgeAlert("cpu", RULE, false, minutes(eight, NOW), NOW).kind).toBe("fire");
    expect(judgeAlert("cpu", RULE, false, minutes(seven, NOW), NOW).kind).toBe("hold");
    expect(judgeAlert("cpu", RULE, false, [], NOW).kind).toBe("hold");
  });

  test("the open minute is never judged, and a minute before the window does not count", () => {
    const open = Math.floor(NOW / MINUTE_MS) * MINUTE_MS;
    const nine = minutes(Array(9).fill(0.99), NOW);
    // Nine complete minutes is 90 % coverage of ten, so that fires on its own — but a low open minute
    // and a low minute just outside the window change nothing.
    const withNoise = [{ t: open - 11 * MINUTE_MS, cpu: 0.1, mem: 0.1, disk: 0.1 }, ...nine, { t: open, cpu: 0.1, mem: 0.1, disk: 0.1 }];
    expect(judgeAlert("cpu", RULE, false, withNoise, NOW).kind).toBe("fire");
  });

  test("memory is judged on the memory fraction", () => {
    const open = Math.floor(NOW / MINUTE_MS) * MINUTE_MS;
    const window: MinuteReading[] = Array.from({ length: 10 }, (_, i) => ({ t: open - (10 - i) * MINUTE_MS, cpu: 0.5, mem: 0.97, disk: null }));
    expect(judgeAlert("mem", RULE, false, window, NOW).kind).toBe("fire");
    expect(judgeAlert("cpu", RULE, false, window, NOW).kind).toBe("hold");
  });
});

describe("judgeAlert — when an episode closes", () => {
  test("five straight complete minutes below the line minus 0.05 close it", () => {
    expect(judgeAlert("cpu", RULE, true, minutes(Array(5).fill(0.84), NOW), NOW).kind).toBe("close");
  });

  test("a value between the two lines keeps it open: that gap is the hysteresis", () => {
    expect(judgeAlert("cpu", RULE, true, minutes([0.84, 0.84, 0.87, 0.84, 0.84], NOW), NOW).kind).toBe("hold");
  });

  test("a missing minute in those five keeps it open: missing is not low", () => {
    expect(judgeAlert("cpu", RULE, true, minutes([0.5, 0.5, null, 0.5, 0.5], NOW), NOW).kind).toBe("hold");
  });

  test("an open episode never fires again, however high", () => {
    expect(judgeAlert("cpu", RULE, true, minutes(Array(10).fill(0.99), NOW), NOW).kind).toBe("hold");
  });
});

describe("evaluateMachineAlerts", () => {
  const high = (_id: string, from: number) => minutes(Array(10).fill(0.99), NOW).filter((m) => m.t >= from);
  const low = (_id: string, from: number) => minutes(Array(10).fill(0.1), NOW).filter((m) => m.t >= from);
  const subject = (over: Partial<AlertSubject> = {}): AlertSubject => ({
    id: "desk",
    name: "desk",
    reachable: true,
    rules: { cpu: RULE },
    open: [],
    ...over,
  });

  test("a reachable machine fires and closes on the same minutes", () => {
    expect(evaluateMachineAlerts([subject()], high, NOW, true).opened.map((o) => o.metric)).toEqual(["cpu"]);
    expect(evaluateMachineAlerts([subject({ open: ["cpu"] })], low, NOW, true).closed).toEqual([{ id: "desk", metric: "cpu" }]);
  });

  test("an unreachable machine neither fires nor closes", () => {
    expect(evaluateMachineAlerts([subject({ reachable: false })], high, NOW, true)).toEqual({ opened: [], closed: [] });
    expect(evaluateMachineAlerts([subject({ reachable: false, open: ["cpu"] })], low, NOW, true)).toEqual({
      opened: [],
      closed: [],
    });
  });

  test("while it may not open (snoozed, or switched off) nothing opens, and an open episode still closes", () => {
    expect(evaluateMachineAlerts([subject()], high, NOW, false).opened).toEqual([]);
    expect(evaluateMachineAlerts([subject({ open: ["cpu"] })], low, NOW, false).closed).toEqual([
      { id: "desk", metric: "cpu" },
    ]);
  });

  test("a metric with no rule is never judged", () => {
    expect(evaluateMachineAlerts([subject({ rules: {} })], high, NOW, true)).toEqual({ opened: [], closed: [] });
  });
});

describe("the push", () => {
  test("names the machine, the metric, the value and the minutes; one tag per machine and metric", () => {
    const msg = machineAlertMessage({ id: "laptop", name: "laptop", metric: "mem", rule: { above: 0.9, forMin: 30 }, value: 0.934 });
    expect(msg).toEqual({
      type: "machine",
      tag: "collie:machine:laptop:mem",
      title: "Memory stays high on laptop",
      titleCode: "machine.mem",
      titleDetail: { machine: "laptop" },
      body: "laptop: memory 93% for 30 min (alert at 90%).",
      machine: "laptop",
      target: "machine",
      topic: machineTopic("laptop", "mem"),
      renotify: true,
    });
  });
});

describe("disk", () => {
  test("disk is judged on the fullest disk's fraction, and a minute without one is a missing minute", () => {
    const open = Math.floor(NOW / MINUTE_MS) * MINUTE_MS;
    const full: MinuteReading[] = Array.from({ length: 10 }, (_, i) => ({ t: open - (10 - i) * MINUTE_MS, cpu: 0.1, mem: 0.1, disk: 0.96 }));
    expect(judgeAlert("disk", RULE, false, full, NOW).kind).toBe("fire");
    expect(judgeAlert("cpu", RULE, false, full, NOW).kind).toBe("hold");
    // Three of ten minutes carry no disk reading: under 80 % coverage, so nothing fires.
    const gappy = full.map((m, i) => (i < 3 ? Object.assign({}, m, { disk: null }) : m));
    expect(judgeAlert("disk", RULE, false, gappy, NOW).kind).toBe("hold");
    // And minutes without a disk reading never close an open episode.
    const none = full.map((m) => Object.assign({}, m, { disk: null }));
    expect(judgeAlert("disk", RULE, true, none, NOW).kind).toBe("hold");
  });

  test("the disk push names the machine, the mount, the percent and the minutes", () => {
    const msg = machineAlertMessage({ id: "nas", name: "nas", metric: "disk", rule: { above: 0.9, forMin: 15 }, value: 0.951 }, "/var/home");
    expect(msg).toEqual({
      type: "machine",
      tag: "collie:machine:nas:disk",
      title: "Disk stays full on nas",
      titleCode: "machine.disk",
      titleDetail: { machine: "nas" },
      body: "nas: disk /var/home 95% for 15 min (alert at 90%).",
      machine: "nas",
      target: "machine",
      topic: machineTopic("nas", "disk"),
      renotify: true,
    });
    expect(machineAlertMessage({ id: "nas", name: "nas", metric: "disk", rule: { above: 0.9, forMin: 15 }, value: 0.951 }).body).toBe(
      "nas: disk 95% for 15 min (alert at 90%).",
    );
    expect(machineTopic("nas", "disk")).not.toBe(machineTopic("nas", "mem"));
  });

  test("a disk rule parses inside the same bounds", () => {
    expect(parseMachineAlerts({ disk: { above: 0.9, forMin: 30 } })).toEqual({ disk: { above: 0.9, forMin: 30 } });
    expect(parseMachineAlerts({ disk: { above: 1, forMin: 30 } })).toBeNull();
  });
});

describe("parseMachineAlerts — the POST body", () => {
  test("a missing key is no rule; a present key must be inside the bounds", () => {
    expect(parseMachineAlerts({})).toEqual({});
    expect(parseMachineAlerts({ cpu: { above: 0.9, forMin: 10 } })).toEqual({ cpu: { above: 0.9, forMin: 10 } });
    expect(parseMachineAlerts({ cpu: { above: 0.5, forMin: 5 }, mem: { above: 0.99, forMin: 120 }, gpu: 1 })).toEqual({
      cpu: { above: 0.5, forMin: 5 },
      mem: { above: 0.99, forMin: 120 },
    });
    for (const bad of [
      { cpu: { above: 0.49, forMin: 10 } },
      { cpu: { above: 1, forMin: 10 } },
      { cpu: { above: 0.9, forMin: 4 } },
      { cpu: { above: 0.9, forMin: 121 } },
      { cpu: { above: 0.9, forMin: 7.5 } },
      { mem: null },
      { mem: { above: "0.9", forMin: 10 } },
    ]) {
      expect(parseMachineAlerts(bad)).toBeNull();
    }
    expect(parseMachineAlerts(null)).toBeNull();
    expect(parseMachineAlerts([])).toBeNull();
  });
});

// ── The watch, end to end over a temp state folder ──────────────────────────

// Every reading differs from the one before by a byte of memory, as a real machine's does: the watch
// skips a sample equal in every field to the last one, which is how a hung sampler looks.
let reading = 0;
function hot(cpu: number): MachineSample {
  reading += 1;
  return { cpu, cores: 4, memUsed: 1e9 + reading, memTotal: 8e9 };
}

function rig(
  dir: string,
  history: MachineHistory,
  alerts: MachineAlertStore,
  health: MachineRosterEntry["health"] = "reachable",
  saveHistory: (history: MachineHistory, now: number) => Promise<void> = async () => {},
) {
  const state = { now: T0, muted: false, enabled: true, health, active: true, laptop: true };
  const sent: PushMessage[] = [];
  const watch = new MachineWatch({
    now: () => state.now,
    roster: () => [
      { id: "desk", name: "desk", isLead: true, health: "reachable" },
      ...(state.laptop ? [{ id: "laptop", name: "laptop", isLead: false, health: state.health }] : []),
    ],
    history,
    alerts,
    saveHistory,
    muted: () => state.muted,
    enabled: () => state.enabled,
    send: (msg) => sent.push(msg),
    active: () => state.active,
  });
  /** One sample per minute for `n` minutes on `id`, ticking at each minute. */
  const run = async (id: string, values: readonly number[]) => {
    for (const v of values) {
      watch.observe(id, hot(v), state.now);
      state.now += MINUTE_MS;
      watch.tick();
      // The episode write is not awaited by the tick; let it land before the next minute.
      await Bun.sleep(1);
    }
  };
  return { state, sent, watch, run, dir };
}

describe("MachineWatch — one push per episode, and a restart does not push twice", () => {
  test("fires once, stays quiet while open, closes, and fires again on the next episode", async () => {
    const dir = await tempDir();
    const r = rig(dir, new MachineHistory(), await MachineAlertStore.load(dir));
    await r.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 5 } });

    await r.run("laptop", Array(5).fill(0.95));
    expect(r.sent.map((m) => m.tag)).toEqual(["collie:machine:laptop:cpu"]);
    expect(r.watch.rows().machines.find((m) => m.id === "laptop")?.firing).toEqual(["cpu"]);

    await r.run("laptop", Array(20).fill(0.99));
    expect(r.sent.length).toBe(1);

    await r.run("laptop", Array(5).fill(0.5));
    expect(r.watch.rows().machines.find((m) => m.id === "laptop")?.firing).toEqual([]);

    await r.run("laptop", Array(5).fill(0.95));
    expect(r.sent.length).toBe(2);
  });

  test("an episode open before a restart is still open after it, and nothing is sent again", async () => {
    const dir = await tempDir();
    const history = new MachineHistory();
    const first = rig(dir, history, await MachineAlertStore.load(dir));
    await first.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 5 } });
    await first.run("laptop", Array(5).fill(0.95));
    expect(first.sent.length).toBe(1);

    // A new process: the rules and the open episode come back off disk, the minutes are the same.
    const second = rig(dir, history, await MachineAlertStore.load(dir));
    second.state.now = first.state.now;
    await second.run("laptop", Array(3).fill(0.97));
    expect(second.sent).toEqual([]);
    expect(second.watch.rows().machines.find((m) => m.id === "laptop")?.firing).toEqual(["cpu"]);
  });

  test("an unreachable machine's episode is neither opened nor closed", async () => {
    const dir = await tempDir();
    const r = rig(dir, new MachineHistory(), await MachineAlertStore.load(dir), "unreachable");
    await r.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 5 } });
    await r.run("laptop", Array(6).fill(0.99));
    expect(r.sent).toEqual([]);
  });

  test("a snooze sends nothing and records nothing, so a high value that outlasts it still pushes", async () => {
    const dir = await tempDir();
    const r = rig(dir, new MachineHistory(), await MachineAlertStore.load(dir));
    await r.watch.setAlerts("desk", { cpu: { above: 0.9, forMin: 5 } });
    r.state.muted = true;
    await r.run("desk", Array(6).fill(0.99));
    expect(r.sent).toEqual([]);
    expect(r.watch.rows().machines[0]!.firing).toEqual([]);
    r.state.muted = false;
    await r.run("desk", [0.99]);
    expect(r.sent.map((m) => m.tag)).toEqual(["collie:machine:desk:cpu"]);
  });

  test("the operator's switch off is the same: nothing sent", async () => {
    const dir = await tempDir();
    const r = rig(dir, new MachineHistory(), await MachineAlertStore.load(dir));
    await r.watch.setAlerts("desk", { mem: { above: 0.5, forMin: 5 } });
    r.state.enabled = false;
    await r.run("desk", Array(6).fill(0.1));
    expect(r.sent).toEqual([]);
  });
});

describe("MachineWatch — what it takes in, and what it lets go", () => {
  test("a sample equal in every field to the last is skipped: not recorded, and sampledAt does not move", async () => {
    const dir = await tempDir();
    const history = new MachineHistory();
    const r = rig(dir, history, await MachineAlertStore.load(dir));
    const stuck: MachineSample = { cpu: 0.4, cores: 4, memUsed: 2e9, memTotal: 8e9, load1: 0.5, rxBps: 1200, txBps: 300 };
    r.watch.observe("laptop", stuck, T0);
    // A hung sampler keeps answering with this very reading; the lead must not stamp it fresh.
    for (let i = 1; i <= 10; i++) r.watch.observe("laptop", { ...stuck }, T0 + i * MINUTE_MS);
    const row = r.watch.rows().machines.find((m) => m.id === "laptop")!;
    expect(row.sampledAt).toBe(T0);
    expect(history.points("laptop", T0 + 11 * MINUTE_MS).map((p) => p[0])).toEqual([T0]);
    // The next reading that differs in any field records as usual.
    r.watch.observe("laptop", { ...stuck, txBps: 301 }, T0 + 11 * MINUTE_MS);
    expect(r.watch.rows().machines.find((m) => m.id === "laptop")!.sampledAt).toBe(T0 + 11 * MINUTE_MS);
    // A missing optional field differs from a present one.
    const { load1: _dropped, ...noLoad } = stuck;
    expect(sameSample(stuck, noLoad)).toBe(false);
    expect(sameSample(stuck, { ...stuck })).toBe(true);
    // Disks are compared too, entry by entry.
    const disks = [{ mount: "/", used: 1, total: 4 }];
    expect(sameSample({ ...stuck, disks }, { ...stuck, disks: [{ ...disks[0]! }] })).toBe(true);
    expect(sameSample({ ...stuck, disks }, { ...stuck, disks: [{ ...disks[0]!, used: 2 }] })).toBe(false);
    expect(sameSample({ ...stuck, disks }, stuck)).toBe(false);
  });

  test("a deposed lead records, judges and pushes nothing", async () => {
    const dir = await tempDir();
    const history = new MachineHistory();
    const r = rig(dir, history, await MachineAlertStore.load(dir));
    await r.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 5 } });
    r.state.active = false;
    await r.run("laptop", Array(8).fill(0.99));
    expect(r.sent).toEqual([]);
    expect(history.points("laptop", r.state.now)).toEqual([]);
    expect(r.watch.rows().machines.find((m) => m.id === "laptop")!.sample).toBeUndefined();
  });

  test("a member that leaves takes its alert rules and open episode with it, live and on the next save", async () => {
    const dir = await tempDir();
    const store = await MachineAlertStore.load(dir);
    const r = rig(dir, new MachineHistory(), store);
    await r.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 5 } });
    await r.watch.setAlerts("desk", { mem: { above: 0.9, forMin: 5 } });
    await r.run("laptop", Array(5).fill(0.95));
    expect(store.open("laptop")).toEqual(["cpu"]);

    r.watch.forget("laptop");
    await store.settled();
    expect(store.rules("laptop")).toEqual({});
    expect(store.open("laptop")).toEqual([]);
    expect((await MachineAlertStore.load(dir)).rules("laptop")).toEqual({});

    // Removed while the bridge was down: the save's prune to the roster drops it too.
    await r.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 5 } });
    r.state.laptop = false;
    r.watch.observe("desk", hot(0.1), r.state.now);
    await r.watch.flush();
    expect((await MachineAlertStore.load(dir)).rules("laptop")).toEqual({});
    expect((await MachineAlertStore.load(dir)).rules("desk")).toEqual({ mem: { above: 0.9, forMin: 5 } });
  });

  test("history writes run one after another, and flush waits for the one under way", async () => {
    const dir = await tempDir();
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const save = async (_h: MachineHistory, now: number) => {
      calls += 1;
      const n = calls;
      log.push(`start ${n}`);
      if (n === 1) await gate;
      log.push(`end ${n} ${now}`);
    };
    const r = rig(dir, new MachineHistory(), await MachineAlertStore.load(dir), "reachable", save);
    // A tick past the five-minute mark starts a save that hangs on the gate.
    r.watch.observe("desk", hot(0.2), r.state.now);
    r.state.now += 6 * MINUTE_MS;
    r.watch.tick();
    await Bun.sleep(1);
    // More arrives, and shutdown flushes while the first write is still open.
    r.watch.observe("desk", hot(0.3), r.state.now);
    let flushed = false;
    const done = (async () => {
      await r.watch.flush();
      flushed = true;
    })();
    await Bun.sleep(1);
    expect(log).toEqual(["start 1"]);
    expect(flushed).toBe(false);
    release();
    await done;
    expect(log).toEqual(["start 1", `end 1 ${T0 + 6 * MINUTE_MS}`, "start 2", `end 2 ${T0 + 6 * MINUTE_MS}`]);
  });
});

// ── The sample rate, against the alert rules' minute buckets ─────────────────

/**
 * A sampler over a fake macOS-like host at a steady 95 % CPU. Memory moves by one byte per reading,
 * as a real machine's does, so no two samples are equal in every field.
 */
function busySampler(clock: { now: number }): MachineSampler {
  let busy = 0;
  let idle = 0;
  let reads = 0;
  return new MachineSampler({
    host: hostFor("darwin"),
    readText: () => null,
    os: {
      cpus: () => {
        busy += 95;
        idle += 5;
        return [{ model: "t", speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
      },
      totalmem: () => 8e9,
      freemem: () => 4e9 - (reads += 1),
      loadavg: () => [1, 1, 1],
    },
    now: () => clock.now,
  });
}

describe("the sample rate follows the phone, and an idle bridge still fills every minute", () => {
  test("15 s by default, 5 s for 30 s after a phone asked for the list", async () => {
    const dir = await tempDir();
    const r = rig(dir, new MachineHistory(), await MachineAlertStore.load(dir));
    expect(r.watch.sampleEveryMs()).toBe(SAMPLE_IDLE_MS);
    r.watch.rows();
    expect(r.watch.sampleEveryMs()).toBe(SAMPLE_WATCHED_MS);
    r.state.now += MACHINES_WATCH_MS;
    expect(r.watch.sampleEveryMs()).toBe(SAMPLE_WATCHED_MS);
    r.state.now += 1;
    expect(r.watch.sampleEveryMs()).toBe(SAMPLE_IDLE_MS);
    // Reading the history, or a machine's page asking for nothing, does not count as watching.
    r.watch.history("desk");
    expect(r.watch.sampleEveryMs()).toBe(SAMPLE_IDLE_MS);
  });

  for (const tickMs of [12_000, 1_500, 30_000, 60_000]) {
    test(`a lead nobody watches, on a ${tickMs / 1000} s tick: every minute holds a sample, and a 10-minute rule fires`, async () => {
      const dir = await tempDir();
      const history = new MachineHistory();
      const r = rig(dir, history, await MachineAlertStore.load(dir));
      await r.watch.setAlerts("desk", { cpu: { above: 0.9, forMin: 10 } });
      r.state.now = T0 + 7_000;
      const sampler = busySampler(r.state);
      const end = T0 + 13 * MINUTE_MS;
      let samples = 0;
      while (r.state.now < end) {
        const sample = sampler.tick(r.watch.sampleEveryMs());
        if (sample !== null) {
          samples += 1;
          r.watch.observe("desk", sample, r.state.now);
        }
        r.watch.tick();
        await Bun.sleep(0);
        r.state.now += tickMs;
      }
      // The first reading only primes the counters, so the count starts at the second minute.
      const complete = history.minutes("desk", T0 + MINUTE_MS, end);
      expect(complete.map((m) => m.t)).toEqual(Array.from({ length: 12 }, (_, i) => T0 + (i + 1) * MINUTE_MS));
      // Never faster than the idle floor: at most four samples a minute, whatever the tick.
      expect(samples).toBeLessThanOrEqual(13 * 4);
      expect(r.sent.map((m) => m.tag)).toEqual(["collie:machine:desk:cpu"]);
    });
  }

  test("a member sampling at the idle rate, swept faster than it samples: every minute holds a sample, and the rule fires", async () => {
    const dir = await tempDir();
    const history = new MachineHistory();
    const r = rig(dir, history, await MachineAlertStore.load(dir));
    await r.watch.setAlerts("laptop", { cpu: { above: 0.9, forMin: 10 } });
    // The member's own clock and tick: 12 s, out of phase with the lead's 1.5 s sweep.
    const member = { now: T0 + 5_000 };
    const sampler = busySampler(member);
    const end = T0 + 13 * MINUTE_MS;
    let observed = 0;
    for (r.state.now = T0; r.state.now < end; r.state.now += 1_500) {
      while (member.now <= r.state.now) {
        sampler.tick();
        member.now += 12_000;
      }
      // The sweep: the member answers with the sample it holds, every time.
      const held = sampler.latest();
      if (held !== null) {
        r.watch.observe("laptop", held, r.state.now);
        observed += 1;
      }
      r.watch.tick();
      await Bun.sleep(0);
    }
    // The lead heard the same sample on most sweeps and recorded each one once.
    expect(observed).toBeGreaterThan(400);
    expect(history.minutes("laptop", T0 + MINUTE_MS, end).map((m) => m.t)).toEqual(
      Array.from({ length: 12 }, (_, i) => T0 + (i + 1) * MINUTE_MS),
    );
    expect(r.sent.map((m) => m.tag)).toEqual(["collie:machine:laptop:cpu"]);
  });
});

describe("MachineAlertStore — written on a change only", () => {
  test("no rule, no file; a rule writes it; removing a rule drops its open episode", async () => {
    const dir = await tempDir();
    const store = await MachineAlertStore.load(dir);
    await store.apply({ opened: [], closed: [] });
    expect(await readdir(dir)).toEqual([]);

    await store.set("desk", { cpu: { above: 0.9, forMin: 10 } });
    expect(await readdir(dir)).toEqual([MACHINE_ALERTS_FILE]);
    await store.apply({ opened: [{ id: "desk", name: "desk", metric: "cpu", rule: { above: 0.9, forMin: 10 }, value: 0.95 }], closed: [] });
    expect((await MachineAlertStore.load(dir)).open("desk")).toEqual(["cpu"]);

    await store.set("desk", { mem: { above: 0.8, forMin: 5 } });
    const back = await MachineAlertStore.load(dir);
    expect(back.rules("desk")).toEqual({ mem: { above: 0.8, forMin: 5 } });
    expect(back.open("desk")).toEqual([]);
  });

  test("an unreadable file is no rule at all", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, MACHINE_ALERTS_FILE), "[]");
    expect((await MachineAlertStore.load(dir)).rules("desk")).toEqual({});
  });
});
