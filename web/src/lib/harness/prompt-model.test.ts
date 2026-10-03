import { describe, expect, it } from "vitest";

import {
  commitKeysFor,
  identityDiff,
  promptsEqual,
  promptsSameIdentity,
  sameKeys,
  sameKeysModuloWalk,
  splitWalk,
  type PromptModel,
} from "./prompt-model";

describe("splitWalk", () => {
  it("splits (Up|Down|Left|Right)* Enter into the walk and the commit", () => {
    expect(splitWalk(["Enter"])).toEqual({ walk: [], commit: ["Enter"] });
    expect(splitWalk(["Down", "Enter"])).toEqual({ walk: ["Down"], commit: ["Enter"] });
    expect(splitWalk(["Up", "Up", "Up", "Enter"])).toEqual({
      walk: ["Up", "Up", "Up"],
      commit: ["Enter"],
    });
  });

  it("accepts horizontal walks: a chip row walks Right, then Enter", () => {
    expect(splitWalk(["Right", "Enter"])).toEqual({ walk: ["Right"], commit: ["Enter"] });
    expect(splitWalk(["Right", "Right", "Enter"])).toEqual({
      walk: ["Right", "Right"],
      commit: ["Enter"],
    });
    expect(splitWalk(["Left", "Enter"])).toEqual({ walk: ["Left"], commit: ["Enter"] });
  });

  it("a back key or a stray key is not a walk, horizontal or not", () => {
    expect(splitWalk(["Left"])).toBeNull(); // opencode's tab back key: no Enter to commit
    expect(splitWalk(["Right"])).toBeNull();
    expect(splitWalk(["Right", "Tab", "Enter"])).toBeNull();
    expect(splitWalk(["Enter", "Right", "Enter"])).toBeNull();
  });

  it("is null for everything that is not a pointer walk", () => {
    expect(splitWalk([])).toBeNull();
    expect(splitWalk(["1"])).toBeNull();
    expect(splitWalk(["y"])).toBeNull();
    expect(splitWalk(["Escape"])).toBeNull();
    expect(splitWalk(["1", "Enter"])).toBeNull();
    expect(splitWalk(["Down"])).toBeNull(); // arrows with nothing to commit
    expect(splitWalk(["Down", "Enter", "Enter"])).toBeNull();
    expect(splitWalk(["Tab", "Down", "Enter"])).toBeNull();
  });
});

describe("sameKeysModuloWalk", () => {
  it("treats horizontal walk plans as walk-class too", () => {
    expect(sameKeysModuloWalk(["Enter"], ["Right", "Right", "Enter"])).toBe(true);
    expect(sameKeysModuloWalk(["Right", "Enter"], ["Left", "Enter"])).toBe(true);
    expect(sameKeysModuloWalk(["Left"], ["Right"])).toBe(false);
  });

  it("treats any two walk-class plans as equal, whatever the count or direction", () => {
    expect(sameKeysModuloWalk(["Enter"], ["Down", "Down", "Enter"])).toBe(true);
    expect(sameKeysModuloWalk(["Up", "Enter"], ["Down", "Enter"])).toBe(true);
  });

  it("falls back to exact equality when either side is not a walk", () => {
    expect(sameKeysModuloWalk(["1"], ["1"])).toBe(true);
    expect(sameKeysModuloWalk(["1"], ["2"])).toBe(false);
    expect(sameKeysModuloWalk(["1"], ["Enter"])).toBe(false);
    expect(sameKeysModuloWalk(["1", "Enter"], ["Enter"])).toBe(false);
    expect(sameKeysModuloWalk(["1", "Enter"], ["1", "Enter"])).toBe(true);
  });
});

describe("a pointer walk in identity and equality", () => {
  const model = (keys: string[][], signature: string): PromptModel => ({
    question: "Which row?",
    family: "trust",
    options: [
      { label: "First", keys: keys[0]! },
      { label: "Second", keys: keys[1]! },
    ],
    coreSignature: "core",
    signature,
  });
  const here = model([["Enter"], ["Down", "Enter"]], "pointer on first");
  const moved = model([["Up", "Enter"], ["Enter"]], "pointer on second");

  it("models that differ only in the walk counts are the same identity", () => {
    expect(promptsSameIdentity(here, moved)).toBe(true);
  });

  it("promptsEqual still refuses them: the byte-faithful signature carries the pointer", () => {
    expect(promptsEqual(here, moved)).toBe(false);
    expect(promptsEqual(here, here)).toBe(true);
  });

  it("a changed label or a non-walk plan is still a different identity", () => {
    expect(promptsSameIdentity(here, { ...moved, options: [{ ...moved.options[0]!, label: "Other" }, moved.options[1]!] })).toBe(false);
    const digits = model([["1"], ["2"]], "x");
    expect(promptsSameIdentity(here, digits)).toBe(false);
    expect(sameKeys(digits.options[0]!.keys, ["1"])).toBe(true);
  });
});

describe("promptsEqual compares the exact plans (a pointer drawn as a style)", () => {
  const chips = (keys: string[][]): PromptModel => ({
    question: "$ echo hi",
    family: "permission",
    options: ["Allow once", "Allow always", "Reject"].map((label, i) => ({ label, keys: keys[i]! })),
    coreSignature: "same text",
    signature: "same text",
  });
  const first = chips([["Enter"], ["Right", "Enter"], ["Right", "Right", "Enter"]]);
  const second = chips([["Right", "Right", "Enter"], ["Enter"], ["Right", "Enter"]]);

  it("two captures with the same text and the pointer on different chips are not equal", () => {
    expect(promptsSameIdentity(first, second)).toBe(true);
    expect(promptsEqual(first, second)).toBe(false);
    expect(promptsEqual(first, chips(first.options.map((o) => o.keys)))).toBe(true);
  });
});

describe("commitKeysFor", () => {
  it("is a bare Enter on horizontal walked plans, even if clampedEnds were set", () => {
    const chips: PromptModel = {
      question: "$ echo hi",
      family: "permission",
      options: [
        { label: "Allow once", keys: ["Enter"] },
        { label: "Allow always", keys: ["Right", "Enter"] },
        { label: "Reject", keys: ["Right", "Right", "Enter"] },
      ],
      coreSignature: "core",
      signature: "sig",
      clampedEnds: true,
    };
    for (let i = 0; i < 3; i++) expect(commitKeysFor(chips, i)).toEqual(["Enter"]);
  });

  const rows = (...plans: string[][]): PromptModel => ({
    question: "Which row?",
    family: "permission",
    options: plans.map((keys, i) => ({ label: `Row ${i}`, keys })),
    coreSignature: "core",
    signature: "sig",
  });
  const clamped = (m: PromptModel): PromptModel => ({ ...m, clampedEnds: true });
  const three = rows(["Enter"], ["Down", "Enter"], ["Down", "Down", "Enter"]);

  it("is a bare Enter when the list does not declare clampedEnds", () => {
    for (let i = 0; i < 3; i++) expect(commitKeysFor(three, i)).toEqual(["Enter"]);
  });

  it("commits the first row with Up and the last with Down on a clamped list", () => {
    expect(commitKeysFor(clamped(three), 0)).toEqual(["Up", "Enter"]);
    expect(commitKeysFor(clamped(three), 2)).toEqual(["Down", "Enter"]);
  });

  it("commits a middle row with a bare Enter", () => {
    expect(commitKeysFor(clamped(three), 1)).toEqual(["Enter"]);
  });

  it("lets the first row win on a one-row list", () => {
    expect(commitKeysFor(clamped(rows(["Enter"])), 0)).toEqual(["Up", "Enter"]);
  });

  it("counts only walk-class options as rows: a trailing Cancel is not the last row", () => {
    const m = clamped(rows(["Enter"], ["Down", "Enter"], ["Escape"]));
    expect(commitKeysFor(m, 0)).toEqual(["Up", "Enter"]);
    expect(commitKeysFor(m, 1)).toEqual(["Down", "Enter"]);
    expect(commitKeysFor(m, 2)).toEqual(["Enter"]); // not a row of the list
  });
});

describe("clampedEnds in identity", () => {
  const model = (clampedEnds?: true): PromptModel => {
    const m: PromptModel = {
      question: "Which row?",
      family: "permission",
      options: [{ label: "First", keys: ["Enter"] }, { label: "Second", keys: ["Down", "Enter"] }],
      coreSignature: "core",
      signature: "sig",
    };
    if (clampedEnds) m.clampedEnds = true;
    return m;
  };

  it("requires equal clampedEnds", () => {
    expect(promptsSameIdentity(model(true), model(true))).toBe(true);
    expect(promptsSameIdentity(model(), model())).toBe(true);
    expect(promptsSameIdentity(model(true), model())).toBe(false);
    expect(promptsSameIdentity(model(), model(true))).toBe(false);
    expect(promptsEqual(model(true), model())).toBe(false);
  });
});

describe("styledSignature in equality", () => {
  const model = (styledSignature?: string): PromptModel => {
    const m: PromptModel = {
      question: "$ echo hi",
      family: "permission",
      options: [{ label: "Allow once", keys: ["Enter"] }, { label: "Reject", keys: ["Right", "Enter"] }],
      coreSignature: "text",
      signature: "text",
    };
    if (styledSignature !== undefined) m.styledSignature = styledSignature;
    return m;
  };

  it("promptsEqual compares it, so a stale tap on a moved style is refused", () => {
    expect(promptsEqual(model("a"), model("a"))).toBe(true);
    expect(promptsEqual(model("a"), model("b"))).toBe(false);
    expect(promptsEqual(model("a"), model())).toBe(false);
  });

  it("promptsSameIdentity ignores it: the pointer is the one thing a walk moves", () => {
    expect(promptsSameIdentity(model("a"), model("b"))).toBe(true);
    expect(identityDiff(model("a"), model("b"))).toBeNull();
  });
});

// `identityDiff` names the first field in which two derivations are not one dialog, and
// `promptsSameIdentity` is defined through it, so the verdict and its explanation cannot disagree.
describe("identityDiff", () => {
  const base = (): PromptModel => ({
    question: "Which row?",
    family: "permission",
    options: [
      { label: "First", keys: ["Enter"] },
      { label: "Second", keys: ["Down", "Enter"] },
    ],
    coreSignature: "line one\nline two\nline three",
    signature: "sig",
    feedback: { key: "3", focused: false, text: "" },
    clampedEnds: true,
  });

  it("is null for the same dialog, including a moved walk pointer", () => {
    expect(identityDiff(base(), base())).toBeNull();
    const moved = base();
    moved.options = [
      { label: "First", keys: ["Up", "Enter"] },
      { label: "Second", keys: ["Enter"] },
    ];
    expect(identityDiff(base(), moved)).toBeNull();
  });

  // One mutation per field, in the order the function checks them. Each names its own field.
  const mutations: [string, (m: PromptModel) => void, RegExp][] = [
    ["family", (m) => void (m.family = "select"), /^family: permission vs select$/],
    ["question", (m) => void (m.question = "Another?"), /^question$/],
    [
      "coreSignature",
      (m) => void (m.coreSignature = "line one\nline 2\nline three"),
      /^coreSignature line 2: "line two" vs "line 2"$/,
    ],
    ["feedback key", (m) => void (m.feedback = { key: "4", focused: false, text: "" }), /^feedback$/],
    ["feedback purpose", (m) => void (m.feedback = { key: "3", focused: false, text: "", purpose: "free-text" }), /^feedback$/],
    ["feedback gone", (m) => void (m.feedback = undefined), /^feedback$/],
    ["options.length", (m) => void m.options.pop(), /^options\.length: 2 vs 1$/],
    ["clampedEnds", (m) => void (m.clampedEnds = undefined), /^clampedEnds$/],
    ["option label", (m) => void (m.options[1] = { label: "Other", keys: ["Down", "Enter"] }), /^option\[1\]\.label: "Second" vs "Other"$/],
    ["option keys", (m) => void (m.options[1] = { label: "Second", keys: ["2"] }), /^option\[1\]\.keys: Down,Enter vs 2$/],
  ];
  for (const [name, mutate, expected] of mutations) {
    it(`names ${name}`, () => {
      const changed = base();
      mutate(changed);
      expect(identityDiff(base(), changed)).toMatch(expected);
      // The boolean is the diff, not a second opinion.
      expect(promptsSameIdentity(base(), changed)).toBe(false);
    });
  }

  it("reports the FIRST differing field when several differ", () => {
    const changed = base();
    changed.family = "select";
    changed.question = "Another?";
    changed.options.pop();
    expect(identityDiff(base(), changed)).toMatch(/^family/);
  });

  it("cuts both lines of a coreSignature difference to 120 characters", () => {
    const a = base();
    const b = base();
    a.coreSignature = "x".repeat(300);
    b.coreSignature = "y".repeat(300);
    const diff = identityDiff(a, b)!;
    expect(diff.startsWith("coreSignature line 1: ")).toBe(true);
    expect(diff).toContain(`"${"x".repeat(120)}..."`);
    expect(diff).toContain(`"${"y".repeat(120)}..."`);
    expect(diff).not.toContain("x".repeat(121));
  });

  it("names a line that exists on one side only", () => {
    const a = base();
    const b = base();
    b.coreSignature = `${a.coreSignature}\nline four`;
    expect(identityDiff(a, b)).toBe('coreSignature line 4: "(none)" vs "line four"');
  });
});
