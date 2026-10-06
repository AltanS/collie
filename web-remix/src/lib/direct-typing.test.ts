/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import {
  MAX_BATCH,
  createDirectTyping,
  createOrderedKeySender,
  keyForInputType,
  keyForKeyDown,
  withoutCommitted,
  type DirectTypingOptions,
  type FieldEvent,
} from "./direct-typing";
import type { KeyTimers } from "./keys-tray";

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
  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of Array.from(this.#queue)) {
      if (entry.at > this.now) continue;
      this.#queue.delete(id);
      entry.fn();
    }
  }
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
  set(state: "hidden" | "visible"): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("wire names", () => {
  test("beforeinput types", () => {
    expect(keyForInputType("deleteContentBackward")).toBe("Backspace");
    expect(keyForInputType("insertLineBreak")).toBe("Enter");
    expect(keyForInputType("insertParagraph")).toBe("Enter");
    expect(keyForInputType("insertText")).toBeNull();
  });

  test("keydown keys: specials only, never an inherited property name", () => {
    expect(keyForKeyDown("ArrowUp")).toBe("Up");
    expect(keyForKeyDown("ArrowRight")).toBe("Right");
    expect(keyForKeyDown("Escape")).toBe("Escape");
    expect(keyForKeyDown("Tab")).toBe("Tab");
    expect(keyForKeyDown("Backspace")).toBe("Backspace");
    expect(keyForKeyDown("Enter")).toBe("Enter");
    expect(keyForKeyDown("a")).toBeUndefined();
    expect(keyForKeyDown("constructor")).toBeUndefined();
    expect(keyForKeyDown("toString")).toBeUndefined();
  });

  test("withoutCommitted strips the sent prefix, keeps a suffix, passes a mismatch through", () => {
    expect(withoutCommitted("hello", "hello")).toBe("");
    expect(withoutCommitted("hello ", "hello")).toBe(" ");
    expect(withoutCommitted("other", "hello")).toBe("other");
  });
});

describe("ordered key sender", () => {
  test("the first key leaves at once; later keys ride ONE next batch, in order", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const sent: string[][] = [];
    const s = createOrderedKeySender(
      (keys) => {
        sent.push(keys);
        return new Promise<boolean>((r) => answers.push(r));
      },
      () => {},
    );
    s.enqueue(["a"]);
    s.enqueue(["b", "c"]);
    s.enqueue(["d"]);
    expect(sent).toEqual([["a"]]);
    expect(s.busy).toBe(true);
    answers[0]?.(true);
    await flush();
    expect(sent).toEqual([["a"], ["b", "c", "d"]]);
    answers[1]?.(true);
    await flush();
    expect(s.busy).toBe(false);
  });

  test("a batch is capped at MAX_BATCH", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const sent: string[][] = [];
    const s = createOrderedKeySender(
      (keys) => {
        sent.push(keys);
        return new Promise<boolean>((r) => answers.push(r));
      },
      () => {},
    );
    s.enqueue(Array<string>(MAX_BATCH + 6).fill("x"));
    expect(sent[0]).toHaveLength(MAX_BATCH);
    answers[0]?.(true);
    await flush();
    expect(sent[1]).toHaveLength(6);
  });

  test("a failed batch drops what had not left and reports once", async () => {
    const sent: string[][] = [];
    let failures = 0;
    let resolve!: (ok: boolean) => void;
    const s = createOrderedKeySender(
      (keys) => {
        sent.push(keys);
        return new Promise<boolean>((r) => (resolve = r));
      },
      () => failures++,
    );
    s.enqueue(["a"]);
    s.enqueue(["b"]);
    resolve(false);
    await flush();
    expect(failures).toBe(1);
    expect(sent).toEqual([["a"]]);
    expect(s.busy).toBe(false);
  });

  test("a thrown send counts as a failure", async () => {
    let failures = 0;
    const s = createOrderedKeySender(() => Promise.reject(new Error("net")), () => failures++);
    s.enqueue(["a"]);
    await flush();
    expect(failures).toBe(1);
  });

  test("reset forgets queued keys but lets the call on the wire finish quietly", async () => {
    let failures = 0;
    const sent: string[][] = [];
    let resolve!: (ok: boolean) => void;
    const s = createOrderedKeySender(
      (keys) => {
        sent.push(keys);
        return new Promise<boolean>((r) => (resolve = r));
      },
      () => failures++,
    );
    s.enqueue(["a"]);
    s.enqueue(["b"]);
    s.reset();
    resolve(false);
    await flush();
    // The failure belonged to a generation that reset already retired.
    expect(failures).toBe(0);
    expect(sent).toEqual([["a"]]);
  });
});

describe("direct typing controller", () => {
  function setup(extra: Partial<DirectTypingOptions> = {}) {
    const timers = new FakeTimers();
    const doc = new FakeDocument();
    const ctl = new AbortController();
    const sent: string[][] = [];
    const notes: string[] = [];
    const log: string[] = [];
    let changes = 0;
    const field = { focus: () => log.push("focus"), blur: () => log.push("blur") };
    const dt = createDirectTyping({
      send: (keys) => {
        sent.push(keys);
        return Promise.resolve(true);
      },
      signal: ctl.signal,
      onChange: () => changes++,
      notify: (text) => notes.push(text),
      field: () => field,
      focusInput: () => log.push("focusInput"),
      timers,
      visibility: doc,
      ...extra,
    });
    return { dt, timers, doc, ctl, sent, notes, log, changes: () => changes };
  }

  const inputEvent = (value: string, isComposing = false): FieldEvent & { currentTarget: { value: string } } => ({
    currentTarget: { value },
    isComposing,
  });

  test("starts disarmed, and every handler is a no-op until armed", async () => {
    const { dt, sent } = setup();
    expect(dt.active).toBe(false);
    dt.onInput(inputEvent("abc"));
    dt.onKeyDown({ key: "Enter", preventDefault: () => {} });
    dt.onBeforeInput({ inputType: "deleteContentBackward", isComposing: false, preventDefault: () => {} });
    await flush();
    expect(sent).toEqual([]);
  });

  test("arm focuses the field, reports a change and says so", () => {
    const { dt, log, changes, notes } = setup();
    expect(dt.arm()).toBe(true);
    expect(dt.active).toBe(true);
    expect(log).toEqual(["focus", "focusInput"]);
    expect(changes()).toBe(1);
    expect(notes).toHaveLength(1);
  });

  test("arm is refused while a reply draft waits, or the pane takes no keys", () => {
    const draft = setup({ replyDraft: () => "rm -rf" });
    expect(draft.dt.arm()).toBe(false);
    expect(draft.dt.active).toBe(false);
    expect(draft.notes).toHaveLength(1);
    const gated = setup({ canActivate: () => false });
    expect(gated.dt.arm()).toBe(false);
    expect(gated.notes).toEqual([]);
  });

  test("typed text goes out as keys with no trailing Enter, and the field is cleared", async () => {
    const { dt, sent } = setup();
    dt.arm();
    const ev = inputEvent("a b");
    dt.onInput(ev);
    await flush();
    expect(sent).toEqual([["a", "Space", "b"]]);
    expect(ev.currentTarget.value).toBe("");
  });

  test("input mid-composition is left alone, then sent once on compositionend", async () => {
    const { dt, sent } = setup();
    dt.arm();
    dt.onCompositionStart();
    const mid = inputEvent("hel");
    dt.onInput(mid);
    expect(mid.currentTarget.value).toBe("hel");
    const end = inputEvent("hello");
    dt.onCompositionEnd(end);
    expect(end.currentTarget.value).toBe("");
    // Gboard follows with one ordinary input carrying the same word and a space: only the space goes.
    dt.onInput(inputEvent("hello "));
    await flush();
    expect(sent).toEqual([["h", "e", "l", "l", "o"], ["Space"]]);
  });

  test("an input flagged isComposing is not sent", async () => {
    const { dt, sent } = setup();
    dt.arm();
    dt.onInput(inputEvent("x", true));
    await flush();
    expect(sent).toEqual([]);
  });

  test("an empty input sends nothing", async () => {
    const { dt, sent } = setup();
    dt.arm();
    dt.onInput(inputEvent(""));
    await flush();
    expect(sent).toEqual([]);
  });

  test("special keys: keydown is prevented and sent; beforeinput Backspace and Enter too", async () => {
    const { dt, sent } = setup();
    dt.arm();
    let prevented = 0;
    const prevent = (): void => void prevented++;
    dt.onKeyDown({ key: "ArrowDown", preventDefault: prevent });
    dt.onKeyDown({ key: "a", preventDefault: prevent });
    await flush();
    dt.onBeforeInput({ inputType: "deleteContentBackward", isComposing: false, preventDefault: prevent });
    await flush();
    dt.onBeforeInput({ inputType: "insertParagraph", isComposing: true, preventDefault: prevent });
    await flush();
    // Backspace inside an IME edits the candidate and is left to the IME.
    dt.onBeforeInput({ inputType: "deleteContentBackward", isComposing: true, preventDefault: prevent });
    dt.onBeforeInput({ inputType: "insertText", isComposing: false, preventDefault: prevent });
    await flush();
    expect(sent).toEqual([["Down"], ["Backspace"], ["Enter"]]);
    expect(prevented).toBe(3);
  });

  test("disarm: stopped and interrupted both speak, silent does not; idle is a no-op", () => {
    const stopped = setup();
    stopped.dt.arm();
    stopped.notes.length = 0;
    stopped.dt.disarm("stopped");
    expect(stopped.dt.active).toBe(false);
    expect(stopped.notes).toHaveLength(1);
    stopped.dt.disarm("stopped");
    expect(stopped.notes).toHaveLength(1);

    const idle = setup();
    idle.dt.arm();
    idle.notes.length = 0;
    idle.dt.disarm();
    expect(idle.notes).toHaveLength(1);

    const quiet = setup();
    quiet.dt.arm();
    quiet.notes.length = 0;
    quiet.dt.disarm("silent");
    expect(quiet.dt.active).toBe(false);
    expect(quiet.notes).toEqual([]);
  });

  test("a hidden document disarms, drops the keyboard next turn, and announces on the way back", () => {
    const { dt, doc, timers, log, notes } = setup();
    dt.arm();
    log.length = 0;
    notes.length = 0;
    doc.set("hidden");
    expect(dt.active).toBe(false);
    expect(notes).toEqual([]);
    expect(log).toEqual([]);
    timers.advance(0);
    expect(log).toEqual(["blur"]);
    doc.set("visible");
    expect(notes).toHaveLength(1);
    // Only once.
    doc.set("hidden");
    doc.set("visible");
    expect(notes).toHaveLength(1);
  });

  test("a hidden document with the mode off owes no notice", () => {
    const { doc, notes } = setup();
    doc.set("hidden");
    doc.set("visible");
    expect(notes).toEqual([]);
  });

  test("a failed batch disarms and puts the keyboard away", async () => {
    const { dt, timers, log } = setup({ send: () => Promise.resolve(false) });
    dt.arm();
    log.length = 0;
    dt.onInput(inputEvent("x"));
    await flush();
    expect(dt.active).toBe(false);
    timers.advance(0);
    expect(log).toEqual(["blur"]);
  });

  test("a re-arm cancels the blur an older disarm scheduled", () => {
    const { dt, doc, timers, log } = setup();
    dt.arm();
    doc.set("hidden");
    doc.set("visible");
    dt.arm();
    log.length = 0;
    timers.advance(0);
    expect(log).toEqual([]);
  });

  test("the signal aborting disarms silently, ends the visibility listener and drops queued keys", async () => {
    const { dt, ctl, doc, notes, changes } = setup();
    dt.arm();
    notes.length = 0;
    const before = changes();
    ctl.abort();
    expect(dt.active).toBe(false);
    doc.set("hidden");
    doc.set("visible");
    expect(notes).toEqual([]);
    expect(changes()).toBe(before);
    expect(dt.arm()).toBe(false);
  });

  test("busy follows the batch in flight", async () => {
    let resolve!: (ok: boolean) => void;
    const { dt, changes } = setup({ send: () => new Promise<boolean>((r) => (resolve = r)) });
    dt.arm();
    dt.onInput(inputEvent("x"));
    expect(dt.busy).toBe(true);
    const mid = changes();
    resolve(true);
    await flush();
    expect(dt.busy).toBe(false);
    expect(changes()).toBeGreaterThan(mid);
  });
});
