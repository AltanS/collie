import { renderHook } from "@testing-library/react";

import { resetBasePathForTests } from "./base-path";
import {
  decodeAnswer,
  encodeAnswer,
  forgetAnswers,
  readAnswer,
  ANSWER_PREFIX,
  useRememberedAnswer,
  writeAnswer,
} from "./remembered-shape";
import { wipeDevice } from "./wipe";

// A remembered shape is a first-frame hint: a flag, a small number or a fixed word, in localStorage,
// read synchronously. The cases pin what it may hold, that a broken storage is "no answer", the
// mount scope and the wipe.

const FACT = "settings-accounts-row";

/** The hook with a fresh answer that the test moves between renders; `undefined` is a read in flight. */
function mountHook(first: boolean | undefined) {
  return renderHook(({ fresh }: { fresh: boolean | undefined }) => useRememberedAnswer(FACT, fresh), { initialProps: { fresh: first } });
}

function setMount(content: string | null): void {
  document.head.querySelector('meta[name="collie-base"]')?.remove();
  if (content !== null) {
    const meta = document.createElement("meta");
    meta.name = "collie-base";
    meta.content = content;
    document.head.append(meta);
  }
  resetBasePathForTests();
}

beforeEach(() => {
  localStorage.clear();
  setMount(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setMount(null);
});

describe("remembered shape, the store", () => {
  it("round-trips a flag, and says nothing before it was written", () => {
    expect(readAnswer(FACT)).toBeUndefined();
    writeAnswer(FACT, true);
    expect(readAnswer(FACT)).toBe(true);
    writeAnswer(FACT, false);
    expect(readAnswer(FACT)).toBe(false);
  });

  it("keeps one key per fact under the prefix, holding one character", () => {
    writeAnswer(FACT, true);
    expect(localStorage.length).toBe(1);
    const key = localStorage.key(0) ?? "";
    expect(key.startsWith(ANSWER_PREFIX)).toBe(true);
    expect(key.endsWith(FACT)).toBe(true);
    expect(localStorage.getItem(key)).toBe("1");
  });

  it("refuses a value its kind does not allow, so no free text reaches storage", () => {
    // @ts-expect-error a flag holds a boolean, never a string
    writeAnswer(FACT, "alice@example.com");
    // @ts-expect-error a flag holds a boolean, never an object
    writeAnswer(FACT, { name: "alice" });
    // @ts-expect-error a name outside the table is not a fact
    readAnswer("alice@example.com");
    expect(localStorage.length).toBe(0);
    expect(encodeAnswer("flag", "yes")).toBeNull();
    expect(encodeAnswer("count", 1.5)).toBeNull();
    expect(encodeAnswer("count", 100)).toBeNull();
    expect(encodeAnswer("count", -1)).toBeNull();
    expect(encodeAnswer(["wide", "narrow"], "a path /home/alice")).toBeNull();
  });

  it("holds a small whole number and one word of a fixed list, and reads nothing else back", () => {
    expect(encodeAnswer("count", 7)).toBe("7");
    expect(decodeAnswer("count", "7")).toBe(7);
    expect(decodeAnswer("count", "700")).toBeUndefined();
    expect(decodeAnswer("count", "7 apples")).toBeUndefined();
    expect(encodeAnswer(["wide", "narrow"], "wide")).toBe("wide");
    expect(decodeAnswer(["wide", "narrow"], "wide")).toBe("wide");
    expect(decodeAnswer(["wide", "narrow"], "tall")).toBeUndefined();
    expect(decodeAnswer("flag", "maybe")).toBeUndefined();
  });

  it("reads a garbled stored value as no answer", () => {
    writeAnswer(FACT, true);
    localStorage.setItem(localStorage.key(0) ?? "", "{\"a\":1}");
    expect(readAnswer(FACT)).toBeUndefined();
  });

  it("never throws on a storage that is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAnswer(FACT)).toBeUndefined();
    expect(() => writeAnswer(FACT, true)).not.toThrow();
    expect(() => forgetAnswers()).not.toThrow();
  });

  it("scopes the key by the mount, so two Collies on one origin keep their own answers", () => {
    setMount("/a/");
    writeAnswer(FACT, true);
    setMount("/b/");
    expect(readAnswer(FACT)).toBeUndefined();
    writeAnswer(FACT, false);
    setMount("/a/");
    expect(readAnswer(FACT)).toBe(true);
    setMount("/b/");
    expect(readAnswer(FACT)).toBe(false);
  });

  it("is removed by forgetAnswers and by the device wipe, and nothing else goes", async () => {
    writeAnswer(FACT, true);
    localStorage.setItem("collie:theme:v1", "dark");
    forgetAnswers();
    expect(readAnswer(FACT)).toBeUndefined();
    expect(localStorage.getItem("collie:theme:v1")).toBe("dark");

    writeAnswer(FACT, true);
    setMount("/b/");
    writeAnswer(FACT, true);
    await wipeDevice("unpair");
    expect([...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).filter((k) => k?.startsWith(ANSWER_PREFIX))).toEqual([]);
    expect(localStorage.getItem("collie:theme:v1")).toBe("dark");
  });

  it("is left alone by a password wipe, which is about one pane", async () => {
    writeAnswer(FACT, true);
    await wipeDevice("password", { scope: undefined, paneId: "w1:p1" });
    expect(readAnswer(FACT)).toBe(true);
  });
});

describe("remembered shape, the hook", () => {
  it("returns the remembered answer on the first render, before the read lands", () => {
    writeAnswer(FACT, true);
    const { result } = mountHook(undefined);
    expect(result.current).toBe(true);
  });

  it("returns undefined with no memory and no answer", () => {
    const { result } = renderHook(() => useRememberedAnswer(FACT, undefined));
    expect(result.current).toBeUndefined();
  });

  it("prefers the fresh answer and writes it", () => {
    writeAnswer(FACT, true);
    const { result, rerender } = mountHook(undefined);
    rerender({ fresh: false });
    expect(result.current).toBe(false);
    expect(readAnswer(FACT)).toBe(false);
  });

  it("keeps the last fresh answer when the read starts over", () => {
    const { result, rerender } = mountHook(undefined);
    rerender({ fresh: true });
    rerender({ fresh: undefined });
    expect(result.current).toBe(true);
  });
});
