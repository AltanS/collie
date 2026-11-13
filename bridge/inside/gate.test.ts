import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.ts";
import { insideGate, insideWanted, linkReader, watchLink } from "./gate.ts";

const at = (setting: boolean | null, linked: boolean, over: { edges?: boolean; platform?: string } = {}) =>
  insideGate({ setting, linked, edges: over.edges ?? true, platform: over.platform ?? "linux" });

describe("the inside socket opens while a harness is linked (M99 spec 09)", () => {
  test("no setting and no link: closed, as unlinked", () => {
    const cfg = loadConfig({});
    expect(cfg.inside).toBeNull();
    expect(at(cfg.inside, false)).toBe("unlinked");
    expect(insideWanted(cfg.inside, false)).toBe(false);
  });

  test("no setting and a linked harness: open", () => {
    expect(at(loadConfig({}).inside, true)).toBe("open");
    expect(at(null, true, { platform: "darwin" })).toBe("open");
  });

  test("COLLIE_INSIDE=1 is the override: open with no link", () => {
    const cfg = loadConfig({ COLLIE_INSIDE: "1" });
    expect(cfg.inside).toBe(true);
    expect(at(cfg.inside, false)).toBe("open");
  });

  test("COLLIE_INSIDE=0 is the kill switch, a link or not", () => {
    const cfg = loadConfig({ COLLIE_INSIDE: "0" });
    expect(cfg.inside).toBe(false);
    expect(at(cfg.inside, true)).toBe("off");
    expect(insideWanted(cfg.inside, true)).toBe(false);
  });

  test("on, but no edges or Windows: still closed", () => {
    expect(at(true, true, { edges: false })).toBe("no-edges");
    expect(at(null, true, { platform: "win32" })).toBe("platform");
  });

  test("the link read is cached for its interval, and a throw reads as not linked", () => {
    let now = 0;
    let linked = false;
    let reads = 0;
    const read = linkReader(() => ((reads += 1), linked), () => now, 1000);
    expect(read()).toBe(false);
    linked = true;
    now = 500;
    expect(read()).toBe(false);
    now = 1000;
    expect(read()).toBe(true);
    expect(reads).toBe(2);
    const broken = linkReader(() => {
      throw new Error("no folder");
    });
    expect(broken()).toBe(false);
  });
});

describe("a link made while the bridge runs opens the socket (M99 spec 09, review 3 item 7)", () => {
  function rig(starts: boolean[]) {
    let tick: (() => void) | null = null;
    let cancelled = 0;
    let on = true;
    let opened = 0;
    const tries: number[] = [];
    const stop = watchLink({
      on: () => on,
      start: () => {
        tries.push(tries.length);
        return Promise.resolve(starts.shift() ?? false);
      },
      opened: () => (opened += 1),
      schedule: (fn) => ((tick = fn), "handle"),
      cancel: () => (cancelled += 1),
    });
    const read = async (): Promise<void> => {
      tick?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { read, stop, tries, get opened() { return opened; }, get cancelled() { return cancelled; }, setOn: (value: boolean) => (on = value) };
  }

  test("a failed start keeps the timer: the next read tries again, and a success stops it", async () => {
    const r = rig([false, true]);
    await r.read();
    expect(r.tries).toHaveLength(1);
    expect(r.cancelled).toBe(0);
    expect(r.opened).toBe(0);
    await r.read();
    expect(r.tries).toHaveLength(2);
    expect(r.opened).toBe(1);
    expect(r.cancelled).toBe(1);
    await r.read();
    expect(r.tries).toHaveLength(2);
  });

  test("no link, no start; stop ends the watch", async () => {
    const r = rig([true]);
    r.setOn(false);
    await r.read();
    expect(r.tries).toEqual([]);
    r.stop();
    r.setOn(true);
    await r.read();
    expect(r.tries).toEqual([]);
  });
});
