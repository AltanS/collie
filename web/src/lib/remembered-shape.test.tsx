import { renderHook } from "@testing-library/react";

import { resetBasePathForTests } from "./base-path";
import {
  ANSWERS,
  PER_MACHINE,
  type AnswerName,
  type AnswerValue,
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

const PER_MACHINE_FACT = "home-launch-count";

function keysUnderPrefix(): string[] {
  return [...Array(localStorage.length).keys()].map((i) => localStorage.key(i) ?? "").filter((k) => k.startsWith(ANSWER_PREFIX));
}

describe("remembered shape, one machine of a crew", () => {
  it("names the facts that are per machine, and every one is a real fact", () => {
    expect([...PER_MACHINE].toSorted()).toEqual(["home-launch-count", "new-profile-pick"]);
    for (const name of PER_MACHINE) expect(name in ANSWERS).toBe(true);
  });

  it("does not read a fact written for machine A as machine B's, nor the lead's", () => {
    writeAnswer(PER_MACHINE_FACT, 4, "alpha");
    expect(readAnswer(PER_MACHINE_FACT, "alpha")).toBe(4);
    expect(readAnswer(PER_MACHINE_FACT, "beta")).toBeUndefined();
    expect(readAnswer(PER_MACHINE_FACT)).toBeUndefined();
    writeAnswer(PER_MACHINE_FACT, 2);
    expect(readAnswer(PER_MACHINE_FACT)).toBe(2);
    expect(readAnswer(PER_MACHINE_FACT, "alpha")).toBe(4);
  });

  it("keeps an id with odd characters apart from a neighbour", () => {
    writeAnswer(PER_MACHINE_FACT, 5, "a@b");
    expect(readAnswer(PER_MACHINE_FACT, "a")).toBeUndefined();
    expect(readAnswer(PER_MACHINE_FACT, "a@b")).toBe(5);
  });

  it("reads a key from before the machine was part of it as absent", () => {
    localStorage.setItem(`${ANSWER_PREFIX}/:${PER_MACHINE_FACT}`, "7");
    expect(readAnswer(PER_MACHINE_FACT)).toBeUndefined();
    expect(readAnswer(PER_MACHINE_FACT, "alpha")).toBeUndefined();
  });

  it("gives a fact of the lead one key whatever machine is named", () => {
    writeAnswer(FACT, true);
    expect(keysUnderPrefix()).toHaveLength(1);
    expect(keysUnderPrefix()[0]).not.toContain("@");
  });

  it("is removed in full by forgetAnswers and by the unpair wipe, per-machine keys and old keys too", async () => {
    writeAnswer(PER_MACHINE_FACT, 4, "alpha");
    writeAnswer(PER_MACHINE_FACT, 3, "beta");
    writeAnswer(PER_MACHINE_FACT, 2);
    localStorage.setItem(`${ANSWER_PREFIX}/:${PER_MACHINE_FACT}`, "7");
    expect(keysUnderPrefix()).toHaveLength(4);
    forgetAnswers();
    expect(keysUnderPrefix()).toEqual([]);

    writeAnswer(PER_MACHINE_FACT, 4, "alpha");
    writeAnswer(PER_MACHINE_FACT, 3, "beta");
    localStorage.setItem(`${ANSWER_PREFIX}/:${PER_MACHINE_FACT}`, "7");
    await wipeDevice("unpair");
    expect(keysUnderPrefix()).toEqual([]);
  });

  it("the hook paints the new machine's answer on the render after a switch, never the other's", () => {
    writeAnswer(PER_MACHINE_FACT, 4, "alpha");
    writeAnswer(PER_MACHINE_FACT, 1, "beta");
    const { result, rerender } = renderHook(({ machine }: { machine: string }) => useRememberedAnswer(PER_MACHINE_FACT, undefined, machine), {
      initialProps: { machine: "alpha" },
    });
    expect(result.current).toBe(4);
    rerender({ machine: "beta" });
    expect(result.current).toBe(1);
    rerender({ machine: "gamma" });
    expect(result.current).toBeUndefined();
  });

  it("the hook writes a fresh answer under the machine it was given", () => {
    const { rerender } = renderHook(({ fresh }: { fresh: number | undefined }) => useRememberedAnswer(PER_MACHINE_FACT, fresh, "alpha"), {
      // SAFETY: undefined is the read in flight.
      initialProps: { fresh: undefined as number | undefined },
    });
    rerender({ fresh: 6 });
    expect(readAnswer(PER_MACHINE_FACT, "alpha")).toBe(6);
    expect(readAnswer(PER_MACHINE_FACT)).toBeUndefined();
  });
});

// Every fact: a remembered "no" paints, then the real read says "yes" and replaces it, so the control shows.
// A fact added to ANSWERS without a row here fails the typecheck.
const NO_THEN_YES = {
  "settings-accounts-row": [false, true],
  "settings-install-card": [false, true],
  "mux-paneGrid": ["no", "yes"],
  "mux-gridScrollback": ["no", "yes"],
  "mux-agentDetection": ["no", "yes"],
  "mux-agentSessionRef": ["no", "yes"],
  "mux-typeText": ["no", "yes"],
  "mux-sendKeys": ["no", "yes"],
  "mux-renamePane": ["no", "yes"],
  "mux-closePane": ["no", "yes"],
  "mux-setFocus": ["no", "yes"],
  "mux-createTab": ["no", "yes"],
  "mux-renameTab": ["no", "yes"],
  "mux-closeTab": ["no", "yes"],
  "mux-createSpace": ["no", "yes"],
  "mux-createWorktree": ["no", "yes"],
  "mux-pushTopologyEvents": ["no", "yes"],
  "mux-pushPaneEvents": ["no", "yes"],
  "mux-steerTurn": ["no", "yes"],
  "mux-abortTurn": ["no", "yes"],
  "mux-starters": ["no", "yes"],
  "mux-renameSpace": ["no", "yes"],
  "mux-programActions": ["no", "yes"],
  "mux-programHistory": ["no", "yes"],
  "mux-reopenConversation": ["no", "yes"],
  "mux-spaces": ["one", "many"],
  "stt-offered": [false, true],
  "home-launch-count": [0, 3],
  "settings-math-pack": ["absent", "ready"],
  "belt-operator-bar": [false, true],
  "new-profile-pick": [false, true],
} as const satisfies { [N in AnswerName]: readonly [AnswerValue<N>, AnswerValue<N>] };

/** One fact, for the lead's key (a per-machine fact for the machine given): a remembered no paints, the real yes replaces it. */
function checkNoThenYes<N extends AnswerName>(name: N, no: AnswerValue<N>, yes: AnswerValue<N>): void {
  writeAnswer(name, no);
  const { result, rerender } = renderHook(({ fresh }: { fresh: AnswerValue<N> | undefined }) => useRememberedAnswer(name, fresh), {
    // SAFETY: undefined is the read in flight, which every fact's hook takes.
    initialProps: { fresh: undefined as AnswerValue<N> | undefined },
  });
  expect(result.current).toBe(no);
  rerender({ fresh: yes });
  expect(result.current).toBe(yes);
  expect(readAnswer(name)).toBe(yes);
}

describe("remembered shape, every fact", () => {
  // SAFETY: the keys of ANSWERS are its fact names.
  const names = Object.keys(ANSWERS) as AnswerName[];

  it("has a row in the table for each fact, and no other", () => {
    expect(Object.keys(NO_THEN_YES).toSorted()).toEqual(names.toSorted());
  });

  it.each(names)("%s: a remembered no paints first, the real yes replaces it and is kept", (name) => {
    const [no, yes] = NO_THEN_YES[name];
    // SAFETY: the table above gives every fact a no and a yes of its own kind, and `name` is one of its keys.
    checkNoThenYes(name, no as never, yes as never);
  });
});
