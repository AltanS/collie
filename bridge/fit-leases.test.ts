import { describe, expect, test } from "bun:test";

import { FIT_BOUNDS, FIT_LAPSE_MS, FitLeases, fitSizeInBounds, type FitClock, type SizeHolder } from "./fit-leases.ts";
import { muxOk, muxRefused, type MuxOutcome, type MuxSize, type MuxSizeHold } from "./mux/types.ts";
import { decodeFitBody } from "./types.ts";

/** A clock whose timers fire only when the test says so. */
function manualClock() {
  const timers = new Set<{ run: () => void; at: number }>();
  let now = 0;
  const clock: FitClock = {
    schedule(run, ms) {
      const timer = { run, at: now + ms };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
      }
    },
  };
}

/** A hold whose `ended` the test can settle, recording each release. */
function fakeHold() {
  let end!: (reason: string) => void;
  const ended = new Promise<string>((resolve) => (end = resolve));
  const record = { released: 0 };
  const hold: MuxSizeHold = {
    release() {
      record.released += 1;
      end("released");
    },
    ended,
  };
  return { hold, record, end };
}

/** Only `holdSize` is exercised; the rest of the port is never called by the lease. */
function adapterWith(holdSize: (paneId: string, size: MuxSize) => Promise<MuxOutcome<MuxSizeHold>>): SizeHolder {
  return { holdSize };
}

const PHONE: MuxSize = { cols: 48, rows: 36 };

describe("the fit body and its bounds", () => {
  test("a body decodes to whole cells and a renew flag", () => {
    expect(decodeFitBody({ cols: 48, rows: 36 })).toEqual({ cols: 48, rows: 36, renew: false });
    expect(decodeFitBody({ cols: 48, rows: 36, renew: true })).toEqual({ cols: 48, rows: 36, renew: true });
  });

  test("fractions, strings, and missing fields are not a body", () => {
    expect(decodeFitBody({ cols: 48.5, rows: 36 })).toBeNull();
    expect(decodeFitBody({ cols: "48", rows: 36 })).toBeNull();
    expect(decodeFitBody({ rows: 36 })).toBeNull();
    expect(decodeFitBody([48, 36])).toBeNull();
    expect(decodeFitBody(null)).toBeNull();
  });

  test("the bounds are inclusive at both ends", () => {
    expect(fitSizeInBounds(PHONE)).toBe(true);
    expect(fitSizeInBounds({ cols: FIT_BOUNDS.minCols, rows: FIT_BOUNDS.minRows })).toBe(true);
    expect(fitSizeInBounds({ cols: FIT_BOUNDS.maxCols, rows: FIT_BOUNDS.maxRows })).toBe(true);
    expect(fitSizeInBounds({ cols: FIT_BOUNDS.minCols - 1, rows: 36 })).toBe(false);
    expect(fitSizeInBounds({ cols: 48, rows: FIT_BOUNDS.maxRows + 1 })).toBe(false);
  });
});

describe("a lease", () => {
  test("takes a hold at the phone's size and answers the lapse", async () => {
    const { clock } = manualClock();
    const { hold } = fakeHold();
    const asked: MuxSize[] = [];
    const leases = new FitLeases(clock);
    const held = await leases.take(
      adapterWith((_pane, size) => {
        asked.push(size);
        return Promise.resolve(muxOk(hold));
      }),
      "default",
      "w1:p1",
      PHONE,
    );
    expect(held).toEqual({ ok: true, value: { size: PHONE, lapseMs: FIT_LAPSE_MS } });
    expect(asked).toEqual([PHONE]);
    expect(leases.size).toBe(1);
  });

  test("lapses two minutes after the last renewal, releasing the hold", async () => {
    const time = manualClock();
    const { hold, record } = fakeHold();
    const leases = new FitLeases(time.clock);
    await leases.take(adapterWith(() => Promise.resolve(muxOk(hold))), "default", "w1:p1", PHONE);
    time.advance(FIT_LAPSE_MS - 1000);
    expect(leases.renew("default", "w1:p1")).not.toBeNull();
    time.advance(FIT_LAPSE_MS - 1000);
    expect(record.released).toBe(0);
    time.advance(1000);
    expect(record.released).toBe(1);
    expect(leases.size).toBe(0);
  });

  test("a renewal never takes a lease: after the lapse it answers null", async () => {
    const time = manualClock();
    const { hold } = fakeHold();
    let holds = 0;
    const leases = new FitLeases(time.clock);
    await leases.take(
      adapterWith(() => {
        holds += 1;
        return Promise.resolve(muxOk(hold));
      }),
      "default",
      "w1:p1",
      PHONE,
    );
    time.advance(FIT_LAPSE_MS);
    expect(leases.renew("default", "w1:p1")).toBeNull();
    expect(holds).toBe(1);
  });

  test("release lets go at once and is idempotent", async () => {
    const { clock } = manualClock();
    const { hold, record } = fakeHold();
    const leases = new FitLeases(clock);
    await leases.take(adapterWith(() => Promise.resolve(muxOk(hold))), "default", "w1:p1", PHONE);
    leases.release("default", "w1:p1");
    leases.release("default", "w1:p1");
    expect(record.released).toBe(1);
    expect(leases.renew("default", "w1:p1")).toBeNull();
  });

  test("the same size again is a renewal, not a second hold", async () => {
    const { clock } = manualClock();
    const { hold } = fakeHold();
    let holds = 0;
    const adapter = adapterWith(() => {
      holds += 1;
      return Promise.resolve(muxOk(hold));
    });
    const leases = new FitLeases(clock);
    await leases.take(adapter, "default", "w1:p1", PHONE);
    await leases.take(adapter, "default", "w1:p1", PHONE);
    expect(holds).toBe(1);
  });

  test("a new size lets Collie's own hold go BEFORE taking the next, so it is not refused as busy", async () => {
    const { clock } = manualClock();
    const first = fakeHold();
    const second = fakeHold();
    const order: string[] = [];
    const holds = [first.hold, second.hold];
    const leases = new FitLeases(clock);
    const adapter = adapterWith((_pane, size) => {
      order.push(`hold ${size.cols}x${size.rows} (first released: ${first.record.released})`);
      return Promise.resolve(muxOk(holds.shift()!));
    });
    await leases.take(adapter, "default", "w1:p1", PHONE);
    const moved = await leases.take(adapter, "default", "w1:p1", { cols: 90, rows: 20 });
    expect(moved.ok).toBe(true);
    expect(order).toEqual(["hold 48x36 (first released: 0)", "hold 90x20 (first released: 1)"]);
  });

  test("a terminal held by somebody else passes the refusal through untouched", async () => {
    const { clock } = manualClock();
    const leases = new FitLeases(clock);
    const refused = await leases.take(
      adapterWith(() => Promise.resolve(muxRefused("already has an attached client"))),
      "default",
      "w1:p1",
      PHONE,
    );
    expect(refused).toMatchObject({ ok: false, reason: "refused" });
    expect(leases.size).toBe(0);
  });

  test("a hold lost underneath the lease ends the lease, so the next renewal answers null", async () => {
    const { clock } = manualClock();
    const { hold, end } = fakeHold();
    const leases = new FitLeases(clock);
    await leases.take(adapterWith(() => Promise.resolve(muxOk(hold))), "default", "w1:p1", PHONE);
    end("Herdr closed the hold");
    await hold.ended;
    await Promise.resolve();
    expect(leases.renew("default", "w1:p1")).toBeNull();
  });

  test("a release that arrives while the hold is still starting wins", async () => {
    const { clock } = manualClock();
    const { hold, record } = fakeHold();
    let grant!: () => void;
    const leases = new FitLeases(clock);
    const pending = leases.take(
      adapterWith(
        () =>
          new Promise((resolve) => {
            grant = () => resolve(muxOk(hold));
          }),
      ),
      "default",
      "w1:p1",
      PHONE,
    );
    await Promise.resolve();
    leases.release("default", "w1:p1");
    grant();
    expect((await pending).ok).toBe(false);
    expect(record.released).toBe(1);
    expect(leases.size).toBe(0);
  });

  test("leases are per session: the same pane id in two sessions is two leases", async () => {
    const { clock } = manualClock();
    const leases = new FitLeases(clock);
    const adapter = adapterWith(() => Promise.resolve(muxOk(fakeHold().hold)));
    await leases.take(adapter, "default", "w1:p1", PHONE);
    await leases.take(adapter, "work", "w1:p1", PHONE);
    expect(leases.size).toBe(2);
    leases.release("work", "w1:p1");
    expect(leases.renew("default", "w1:p1")).not.toBeNull();
  });

  test("closeAll releases everything and refuses new leases", async () => {
    const { clock } = manualClock();
    const a = fakeHold();
    const b = fakeHold();
    const holds = [a.hold, b.hold];
    const adapter = adapterWith(() => Promise.resolve(muxOk(holds.shift()!)));
    const leases = new FitLeases(clock);
    await leases.take(adapter, "default", "w1:p1", PHONE);
    await leases.take(adapter, "default", "w1:p2", PHONE);
    leases.closeAll();
    expect(a.record.released + b.record.released).toBe(2);
    expect(await leases.take(adapter, "default", "w1:p3", PHONE)).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
