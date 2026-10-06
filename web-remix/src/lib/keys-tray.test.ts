/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import {
  CONFIRM_MS,
  ECHO_DONE_MS,
  HOLD_DELAY_MS,
  KeyQueue,
  MAX_BATCH,
  MAX_HOLD_MS,
  REPEAT_MS,
  createActionEcho,
  createHoldRepeat,
  createPendingConfirm,
  pressPreset,
  takeForSend,
  type KeyTimers,
} from "./keys-tray";

/** Timers on a hand-cranked clock. */
class FakeTimers implements KeyTimers {
  now = 0;
  #next = 1;
  #queue = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): number {
    const id = this.#next++;
    this.#queue.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: number): void {
    this.#queue.delete(id);
  }
  get pending(): number {
    return this.#queue.size;
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.#queue) if (entry[1].at <= end && (first === null || entry[1].at < first[1].at)) first = entry;
      if (first === null) break;
      this.#queue.delete(first[0]);
      this.now = first[1].at;
      first[1].fn();
    }
    this.now = end;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("KeyQueue modifiers", () => {
  test("a tap cycles off, once, locked, off, one modifier at a time", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    expect(q.mods).toEqual({ ctrl: "once", alt: "off", shift: "off" });
    q.arm("ctrl");
    expect(q.mods.ctrl).toBe("locked");
    q.arm("shift");
    expect(q.mods).toEqual({ ctrl: "locked", alt: "off", shift: "once" });
    q.arm("ctrl");
    expect(q.mods.ctrl).toBe("off");
    expect(q.activeMods).toEqual(["shift"]);
  });

  test("active modifiers come in canonical order whatever the tap order", () => {
    const q = new KeyQueue();
    q.arm("shift");
    q.arm("alt");
    q.arm("ctrl");
    expect(q.activeMods).toEqual(["ctrl", "alt", "shift"]);
  });
});

describe("KeyQueue press", () => {
  test("idle: a press fires, nothing is staged", () => {
    const q = new KeyQueue();
    expect(q.press(["Up"])).toEqual({ mode: "fire", keys: ["Up"] });
    expect(q.queue).toEqual([]);
    expect(q.composing).toBe(false);
  });

  test("an armed modifier turns the press into a staged, composed key", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    expect(q.composing).toBe(true);
    expect(q.press(["g"])).toEqual({ mode: "queued" });
    expect(q.queue).toEqual(["ctrl+g"]);
  });

  test("once is consumed by the next key; the queue then keeps the tray composing", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    q.press(["g"]);
    expect(q.mods.ctrl).toBe("off");
    expect(q.composing).toBe(true);
    // No modifier now, but the queue is not empty: the next press stages, plain.
    expect(q.press(["Up"])).toEqual({ mode: "queued" });
    expect(q.queue).toEqual(["ctrl+g", "Up"]);
  });

  test("locked survives the press and composes every key", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    q.arm("ctrl");
    q.press(["a"]);
    q.press(["b"]);
    expect(q.mods.ctrl).toBe("locked");
    expect(q.queue).toEqual(["ctrl+a", "ctrl+b"]);
  });

  test("several modifiers combine into one chord", () => {
    const q = new KeyQueue();
    q.arm("shift");
    q.arm("ctrl");
    q.press(["p"]);
    expect(q.queue).toEqual(["ctrl+shift+p"]);
  });

  test("a preset chord passes through untouched", () => {
    const q = new KeyQueue();
    q.arm("alt");
    q.press(["ctrl+c"]);
    expect(q.queue).toEqual(["ctrl+c"]);
  });

  test("pushBase takes the last printable char, lower-cased, and settles once", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    expect(q.pushBase("xyG")).toBe(true);
    expect(q.queue).toEqual(["ctrl+g"]);
    expect(q.mods.ctrl).toBe("off");
    expect(q.pushBase("é")).toBe(false);
    expect(q.pushBase("")).toBe(false);
    expect(q.queue).toEqual(["ctrl+g"]);
  });

  test("removeAt drops one chip; an out-of-range index does nothing", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    q.press(["a"]);
    q.press(["Up"]);
    q.press(["Down"]);
    q.removeAt(1);
    expect(q.queue).toEqual(["ctrl+a", "Down"]);
    q.removeAt(9);
    expect(q.queue).toEqual(["ctrl+a", "Down"]);
  });

  test("the queue is a new array after each change", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    const before = q.queue;
    q.press(["a"]);
    expect(q.queue).not.toBe(before);
  });
});

describe("KeyQueue take and clear", () => {
  test("take returns the whole queue as ONE array and empties it", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    q.press(["a"]);
    q.press(["Up", "Down"]);
    const sent = q.take();
    expect(sent).toEqual(["ctrl+a", "Up", "Down"]);
    expect(q.queue).toEqual([]);
    expect(q.composing).toBe(false);
  });

  test("a locked modifier survives take, and keeps the tray composing", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    q.arm("ctrl");
    q.arm("alt");
    q.press(["a"]);
    q.take();
    expect(q.mods).toEqual({ ctrl: "locked", alt: "off", shift: "off" });
    expect(q.composing).toBe(true);
    expect(q.press(["b"])).toEqual({ mode: "queued" });
    expect(q.queue).toEqual(["ctrl+b"]);
  });

  test("clear drops the queue and releases locked modifiers too", () => {
    const q = new KeyQueue();
    q.arm("ctrl");
    q.arm("ctrl");
    q.press(["a"]);
    q.clear();
    expect(q.queue).toEqual([]);
    expect(q.mods).toEqual({ ctrl: "off", alt: "off", shift: "off" });
    expect(q.composing).toBe(false);
  });

  test("onChange fires per change and not for a no-op clear", () => {
    let n = 0;
    const q = new KeyQueue(() => n++);
    q.clear();
    expect(n).toBe(0);
    q.arm("ctrl");
    q.press(["a"]);
    q.take();
    q.clear();
    expect(n).toBe(3);
  });
});

describe("danger confirm", () => {
  const D = { label: "Ctrl D", keys: ["ctrl+d"], danger: true };
  const U = { label: "Ctrl U", keys: ["ctrl+u"] };

  test("idle: a danger chord arms on the first tap and fires on the second", () => {
    const timers = new FakeTimers();
    const q = new KeyQueue();
    const c = createPendingConfirm(timers, () => {});
    expect(pressPreset(q, c, D)).toEqual({ mode: "confirm" });
    expect(c.pending).toBe("Ctrl D");
    expect(pressPreset(q, c, D)).toEqual({ mode: "fire", keys: ["ctrl+d"] });
    expect(c.pending).toBeNull();
  });

  test("the arm times out after CONFIRM_MS", () => {
    const timers = new FakeTimers();
    let changes = 0;
    const c = createPendingConfirm(timers, () => changes++);
    c.confirm("x");
    timers.advance(CONFIRM_MS - 1);
    expect(c.pending).toBe("x");
    timers.advance(1);
    expect(c.pending).toBeNull();
    expect(changes).toBe(2);
    // The next tap is a first tap again.
    expect(c.confirm("x")).toBe(false);
  });

  test("a tap on another id re-arms that id and drops the first", () => {
    const timers = new FakeTimers();
    const c = createPendingConfirm(timers, () => {});
    c.confirm("a");
    expect(c.confirm("b")).toBe(false);
    expect(c.pending).toBe("b");
    expect(c.confirm("a")).toBe(false);
  });

  test("composing: a danger chord stages with no second tap", () => {
    const timers = new FakeTimers();
    const q = new KeyQueue();
    const c = createPendingConfirm(timers, () => {});
    q.arm("shift");
    expect(pressPreset(q, c, D)).toEqual({ mode: "queued" });
    expect(q.queue).toEqual(["ctrl+d"]);
    expect(c.pending).toBeNull();
  });

  test("a non-danger preset fires at once", () => {
    const q = new KeyQueue();
    const c = createPendingConfirm(new FakeTimers(), () => {});
    expect(pressPreset(q, c, U)).toEqual({ mode: "fire", keys: ["ctrl+u"] });
  });

  test("takeForSend hands back one array and resets a stray confirm", () => {
    const timers = new FakeTimers();
    const q = new KeyQueue();
    const c = createPendingConfirm(timers, () => {});
    q.arm("ctrl");
    q.press(["a"]);
    c.confirm("Ctrl Z");
    expect(takeForSend(q, c)).toEqual(["ctrl+a"]);
    expect(c.pending).toBeNull();
    expect(timers.pending).toBe(0);
  });
});

describe("action echo", () => {
  test("pending on the press, done on success, idle after ECHO_DONE_MS", async () => {
    const timers = new FakeTimers();
    let buzzed = 0;
    const echo = createActionEcho(timers, () => {}, { onPress: () => buzzed++ });
    let resolve!: (ok: boolean) => void;
    const done = echo.run("Enter", () => new Promise<boolean>((r) => (resolve = r)));
    expect(echo.phaseOf("Enter")).toBe("pending");
    expect(buzzed).toBe(1);
    resolve(true);
    await done;
    expect(echo.phaseOf("Enter")).toBe("done");
    timers.advance(ECHO_DONE_MS);
    expect(echo.phaseOf("Enter")).toBe("idle");
  });

  test("a refused or thrown press goes straight back to idle", async () => {
    const echo = createActionEcho(new FakeTimers(), () => {});
    await echo.run("a", () => Promise.resolve(false));
    expect(echo.phaseOf("a")).toBe("idle");
    await echo.run("b", () => Promise.reject(new Error("net")));
    expect(echo.phaseOf("b")).toBe("idle");
  });

  test("pressing the same key again restarts its cycle", async () => {
    const timers = new FakeTimers();
    const echo = createActionEcho(timers, () => {});
    await echo.run("k", () => Promise.resolve(true));
    timers.advance(ECHO_DONE_MS - 100);
    await echo.run("k", () => Promise.resolve(true));
    timers.advance(ECHO_DONE_MS - 100);
    expect(echo.phaseOf("k")).toBe("done");
    timers.advance(100);
    expect(echo.phaseOf("k")).toBe("idle");
  });

  test("a dispose mid-flight writes nothing afterwards", async () => {
    const timers = new FakeTimers();
    let changes = 0;
    const echo = createActionEcho(timers, () => changes++);
    let resolve!: (ok: boolean) => void;
    const done = echo.run("k", () => new Promise<boolean>((r) => (resolve = r)));
    echo.dispose();
    const seen = changes;
    resolve(true);
    await done;
    expect(changes).toBe(seen);
    expect(timers.pending).toBe(0);
  });
});

describe("hold repeat", () => {
  function setup(opts: { enabled?: () => boolean; result?: () => Promise<boolean> } = {}) {
    const timers = new FakeTimers();
    const sent: string[][] = [];
    let engages = 0;
    let changes = 0;
    const hold = createHoldRepeat(
      (keys) => {
        sent.push(keys);
        return opts.result?.() ?? Promise.resolve(true);
      },
      timers,
      { enabled: opts.enabled, onChange: () => changes++, onEngage: () => engages++ },
    );
    return { timers, sent, hold, engages: () => engages, changes: () => changes };
  }

  test("a release before HOLD_DELAY_MS is a tap: nothing sent, click not swallowed", () => {
    const { timers, sent, hold } = setup();
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS - 1);
    hold.pointerUp();
    timers.advance(1000);
    expect(sent).toEqual([]);
    expect(hold.holding).toBeNull();
    expect(hold.consumeClick()).toBe(false);
  });

  test("engages at HOLD_DELAY_MS: one buzz, one key sent, count 1, click then swallowed once", async () => {
    const { timers, sent, hold, engages } = setup();
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS);
    expect(hold.holding).toBe("Down");
    expect(hold.count).toBe(1);
    expect(engages()).toBe(1);
    expect(sent).toEqual([["Down"]]);
    await flush();
    hold.pointerUp();
    expect(hold.holding).toBeNull();
    expect(hold.count).toBe(0);
    expect(hold.consumeClick()).toBe(true);
    expect(hold.consumeClick()).toBe(false);
  });

  test("count rises each REPEAT_MS and the buzz fires once only", async () => {
    const { timers, hold, engages } = setup();
    hold.pointerDown("Up");
    timers.advance(HOLD_DELAY_MS);
    for (let i = 0; i < 3; i++) {
      timers.advance(REPEAT_MS);
      await flush();
    }
    expect(hold.count).toBe(4);
    expect(engages()).toBe(1);
    hold.pointerUp();
  });

  test("one call in flight: repeats pile up and leave as ONE array when the call answers", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const { timers, sent, hold } = setup({ result: () => new Promise<boolean>((r) => answers.push(r)) });
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS);
    expect(sent).toEqual([["Down"]]);
    timers.advance(REPEAT_MS * 3);
    // Still the first call: no second one went out.
    expect(sent).toEqual([["Down"]]);
    expect(answers).toHaveLength(1);
    answers[0]?.(true);
    await flush();
    expect(sent).toEqual([["Down"], ["Down", "Down", "Down"]]);
    expect(answers).toHaveLength(2);
    answers[1]?.(true);
    await flush();
    hold.pointerUp();
  });

  test("a batch is capped at MAX_BATCH keys", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const { timers, sent, hold } = setup({ result: () => new Promise<boolean>((r) => answers.push(r)) });
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS);
    timers.advance(REPEAT_MS * (MAX_BATCH + 10));
    answers[0]?.(true);
    await flush();
    expect(sent[1]).toHaveLength(MAX_BATCH);
    answers[1]?.(true);
    await flush();
    expect(sent[2]).toHaveLength(10);
    hold.pointerUp();
  });

  test("release flushes what is left", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const { timers, sent, hold } = setup({ result: () => new Promise<boolean>((r) => answers.push(r)) });
    hold.pointerDown("Left");
    timers.advance(HOLD_DELAY_MS + REPEAT_MS * 2);
    hold.pointerUp();
    answers[0]?.(true);
    await flush();
    expect(sent).toEqual([["Left"], ["Left", "Left"]]);
    answers[1]?.(true);
    await flush();
    // No more timers once released.
    timers.advance(1000);
    expect(sent).toHaveLength(2);
  });

  test("a refused flush stops the hold and the timers", async () => {
    const { timers, sent, hold } = setup({ result: () => Promise.resolve(false) });
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS);
    await flush();
    expect(hold.holding).toBeNull();
    timers.advance(1000);
    expect(sent).toHaveLength(1);
    expect(timers.pending).toBe(0);
  });

  test("the dead-man stops a hold whose pointerup was lost", async () => {
    const { timers, hold } = setup();
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS);
    timers.advance(MAX_HOLD_MS);
    await flush();
    expect(hold.holding).toBeNull();
    expect(timers.pending).toBe(0);
  });

  test("a pointercancel ends it like a pointerup", async () => {
    const { timers, hold } = setup();
    hold.pointerDown("Right");
    timers.advance(HOLD_DELAY_MS);
    hold.pointerCancel();
    await flush();
    expect(hold.holding).toBeNull();
    expect(timers.pending).toBe(0);
  });

  test("disabled (composing): pointerdown arms nothing", () => {
    const { timers, sent, hold } = setup({ enabled: () => false });
    hold.pointerDown("Down");
    timers.advance(5000);
    expect(sent).toEqual([]);
    expect(timers.pending).toBe(0);
    expect(hold.consumeClick()).toBe(false);
  });

  test("dispose ends every timer and stops the pump", () => {
    const { timers, sent, hold } = setup();
    hold.pointerDown("Down");
    timers.advance(HOLD_DELAY_MS);
    hold.dispose();
    timers.advance(5000);
    expect(timers.pending).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
