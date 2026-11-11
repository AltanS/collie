import { describe, expect, it } from "vitest";

import { MORPH_HEAD_MAX,
  MORPH_HINT_MAX,
  MORPH_NOTE_MAX,
  MORPH_NOTES_MAX,
  MORPH_TITLE_MAX,
  morphBlocksOf,
  nextBlockId,
  parseMorphChoice,
  parseMorphView,
  readMorphAnswer,
  readMorphDrawing,
  readMorphSession,
  readMorphSwitchBody,
  readMorphView,
} from "./wire";

const SESSION = "local/%1#aaaa";
const HINT = "[morph: answer by drawing one screen]";

const goodView = [
  { kind: "para", text: "Two tests fail", attrs: { role: "heading" } },
  { kind: "list", kids: [{ kind: "row", text: "auth.test.ts", attrs: { end: "2 fail" } }] },
  { kind: "diff", text: "-old\n+new", attrs: { file: "src/a.ts" } },
  {
    kind: "bar",
    kids: [
      { kind: "button", attrs: { label: "Fix them", intent: "reply", value: "Fix the two failing tests." } },
      { kind: "button", attrs: { label: "Skip", intent: "reply", value: "Skip them for now.", confirm: "Sure?" } },
    ],
  },
];

describe("parseMorphView", () => {
  it("takes a part view with buttons, which the Decision reader refuses", () => {
    const parsed = parseMorphView(goodView);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.view).toHaveLength(4);
  });

  it("refuses with the parser's reason, under the caller's own path", () => {
    const parsed = parseMorphView([{ kind: "para", text: "ok" }, { kind: "bar", kids: [{ kind: "button", attrs: { label: "x" } }] }]);
    expect(parsed.view).toBeUndefined();
    expect(parsed.refusals[0]?.path.startsWith("/view/1")).toBe(true);
    expect(parsed.refusals[0]?.reason).toContain("intent");
  });

  it("refuses what the tolerant trick read would only drop: an unknown kind", () => {
    const parsed = parseMorphView([{ kind: "para", text: "ok" }, { kind: "hologram" }]);
    expect(parsed.view).toBeUndefined();
    expect(parsed.refusals.length).toBeGreaterThan(0);
  });

  it("refuses garbage without a throw", () => {
    for (const raw of [undefined, null, 3, "x", {}, [], [null]]) {
      expect(parseMorphView(raw).view).toBeUndefined();
    }
  });

  it("holds the root cap", () => {
    const many = Array.from({ length: 25 }, () => ({ kind: "para", text: "x" }));
    expect(parseMorphView(many).view).toBeUndefined();
  });
});

describe("readMorphView", () => {
  it("reads a stored view, with and without a title", () => {
    expect(readMorphView({ rev: 3, at: "2026-11-10T10:00:00.000Z", view: goodView })).toMatchObject({ rev: 3, at: "2026-11-10T10:00:00.000Z" });
    expect(readMorphView({ rev: 3, at: "2026-11-10T10:00:00.000Z", title: "Tests", view: goodView })?.title).toBe("Tests");
  });

  it("drops a bad rev, time, title or view", () => {
    const base = { rev: 1, at: "2026-11-10T10:00:00.000Z", view: goodView };
    expect(readMorphView({ ...base, rev: -1 })).toBeNull();
    expect(readMorphView({ ...base, rev: 1.5 })).toBeNull();
    expect(readMorphView({ ...base, at: "yesterday" })).toBeNull();
    expect(readMorphView({ ...base, title: "x".repeat(MORPH_TITLE_MAX + 1) })).toBeNull();
    expect(readMorphView({ ...base, title: "two\nlines" })).toBeNull();
    expect(readMorphView({ ...base, view: [{ kind: "nope" }] })).toBeNull();
  });
});

describe("readMorphSession", () => {
  it("reads a session, and keeps it without a view that does not fit", () => {
    expect(readMorphSession({ session: SESSION, on: true, hint: HINT })).toEqual({ session: SESSION, on: true, hint: HINT });
    const kept = readMorphSession({ session: SESSION, on: false, hint: HINT, view: { rev: 1, at: "bad", view: goodView } });
    expect(kept).toEqual({ session: SESSION, on: false, hint: HINT });
  });

  it("reads the head and the drawing when they fit, and leaves a bad one out with the session kept", () => {
    const drawing = { at: "2026-11-10T10:00:00.000Z", note: "Checking the tests" };
    expect(readMorphSession({ session: SESSION, on: true, head: "[morph] from operator:", hint: HINT, drawing })).toEqual({ session: SESSION, on: true, head: "[morph] from operator:", hint: HINT, drawing });
    expect(readMorphSession({ session: SESSION, on: true, hint: HINT, drawing: { at: "2026-11-10T10:00:00.000Z" } })).toEqual({ session: SESSION, on: true, hint: HINT, drawing: { at: "2026-11-10T10:00:00.000Z" } });
    expect(readMorphSession({ session: SESSION, on: true, head: "a\nb", hint: HINT })).toEqual({ session: SESSION, on: true, hint: HINT });
    expect(readMorphSession({ session: SESSION, on: true, hint: HINT, drawing: { at: "soon" } })).toEqual({ session: SESSION, on: true, hint: HINT });
    expect(readMorphSession({ session: SESSION, on: true, hint: HINT, drawing: { at: drawing.at, note: "x".repeat(MORPH_NOTE_MAX + 1) } })).toEqual({ session: SESSION, on: true, hint: HINT });
  });

  it("reads a session with no hint (it holds the rules) and a head that names the session", () => {
    const head = `[morph ${SESSION}] from operator:`;
    expect(readMorphSession({ session: SESSION, on: true, head })).toEqual({ session: SESSION, on: true, head });
    expect(readMorphSession({ session: SESSION, on: true, head: `[morph ${"x".repeat(MORPH_HEAD_MAX)}] from operator:` })).toEqual({ session: SESSION, on: true });
  });

  it("drops a session with a bad key, switch or hint", () => {
    expect(readMorphSession({ session: "", on: true, hint: HINT })).toBeNull();
    expect(readMorphSession({ session: SESSION, on: "yes", hint: HINT })).toBeNull();
    expect(readMorphSession({ session: SESSION, on: true, hint: "a\nb" })).toBeNull();
    expect(readMorphSession({ session: SESSION, on: true, hint: "x".repeat(MORPH_HINT_MAX + 1) })).toBeNull();
  });
});

describe("readMorphAnswer", () => {
  it("reads the list and drops a session that does not fit", () => {
    const answer = readMorphAnswer({ rev: 7, sessions: [{ session: SESSION, on: true, hint: HINT }, { session: 4 }] });
    expect(answer).toEqual({ rev: 7, sessions: [{ session: SESSION, on: true, hint: HINT }] });
  });

  it("reads the short answer", () => {
    expect(readMorphAnswer({ rev: 7, unchanged: true })).toEqual({ rev: 7, unchanged: true, sessions: [] });
  });

  it("refuses a bad rev or a missing list", () => {
    expect(readMorphAnswer({ rev: "7", sessions: [] })).toBeNull();
    expect(readMorphAnswer({ rev: 7 })).toBeNull();
    expect(readMorphAnswer(null)).toBeNull();
  });
});

describe("readMorphSwitchBody", () => {
  it("reads exactly a session and a switch", () => {
    expect(readMorphSwitchBody({ session: SESSION, on: true })).toEqual({ session: SESSION, on: true });
    expect(readMorphSwitchBody({ session: SESSION, on: true, extra: 1 })).toBeNull();
    expect(readMorphSwitchBody({ session: SESSION })).toBeNull();
    expect(readMorphSwitchBody({ session: " padded ", on: false })).toBeNull();
    expect(readMorphSwitchBody([])).toBeNull();
  });
});

describe("pictures by ref", () => {
  const button = { kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship it", intent: "reply" } }] };

  it("takes a button and an image by ref on one screen, keeping the picture node as drawn", () => {
    const parsed = parseMorphView([{ kind: "image", attrs: { ref: "0", focus: "50 20 2" } }, button], "/view", { images: 1 });
    expect(parsed.refusals).toEqual([]);
    expect(parsed.view?.[0]).toMatchObject({ kind: "image", attrs: { ref: "0", focus: "50 20 2" } });
    expect(parsed.view?.[1]?.kind).toBe("bar");
  });

  it("takes a compare of two pictures inside a group, beside a button", () => {
    const compare = { kind: "compare", kids: [{ kind: "image", attrs: { ref: "0" } }, { kind: "image", attrs: { ref: "1", caption: "New" } }] };
    const parsed = parseMorphView([{ kind: "group", attrs: { label: "Look" }, kids: [{ kind: "para", text: "Before and after" }, compare] }, button], "/view", { images: 2 });
    expect(parsed.refusals).toEqual([]);
    const group = parsed.view?.[0];
    expect(group?.kind === "group" ? group.kids[1]?.kind : null).toBe("compare");
  });

  it("refuses a ref past the pictures, with the picture's own path", () => {
    const parsed = parseMorphView([{ kind: "para", text: "Look" }, { kind: "group", kids: [{ kind: "image", attrs: { ref: "2" } }] }], "/view", { images: 2 });
    expect(parsed.view).toBeUndefined();
    expect(parsed.refusals.map((r) => r.path)).toContain("/view/1/kids/0/attrs/ref");
  });

  it("still reads a src image as the part parser does", () => {
    const src = [{ kind: "image", attrs: { src: "shot.png", alt: "A shot", w: "300", h: "200" } }];
    expect(parseMorphView(src)).toEqual(parseMorphView(src, "/view", { images: 0 }));
    expect(parseMorphView([{ kind: "image", attrs: { alt: "no src" } }]).view).toBeUndefined();
  });

  it("refuses a part-parser fault beside a picture under its real path", () => {
    const parsed = parseMorphView([{ kind: "image", attrs: { ref: "0" } }, { kind: "bar", kids: [{ kind: "button", attrs: { label: "x" } }] }], "/view", { images: 1 });
    expect(parsed.refusals.some((r) => r.path.startsWith("/view/1/kids/0"))).toBe(true);
  });

  it("serves a view with its set, its pictures and a picture placed by ref", () => {
    const media = [{ id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 120, width: 390, height: 844, caption: "Now" }];
    const read = readMorphView({ rev: 2, at: "2026-11-10T10:00:00.000Z", set: "dc_aaaaaaaaaaaa", media, view: [{ kind: "image", attrs: { ref: "0" } }] });
    expect(read?.set).toBe("dc_aaaaaaaaaaaa");
    expect(read?.media).toHaveLength(1);
    expect(readMorphView({ rev: 2, at: "2026-11-10T10:00:00.000Z", view: [{ kind: "image", attrs: { ref: "0" } }] })).toBeNull();
    expect(readMorphView({ rev: 2, at: "2026-11-10T10:00:00.000Z", set: "../etc", media, view: [{ kind: "para", text: "x" }] })).toBeNull();
  });
});

describe("parseMorphChoice", () => {
  it("reads a question, options with every field, and a recommendation", () => {
    const parsed = parseMorphChoice(
      {
        question: "Which layout?",
        options: [
          { label: "Cards", detail: "One per row", value: "Use cards.", preview: 0 },
          { label: "Table", confirm: "Sure?", preview: 1 },
        ],
        recommends: { option: 0, why: "Reads better on a phone" },
      },
      "/choice",
      { images: 2 },
    );
    expect(parsed.refusals).toEqual([]);
    expect(parsed.choice?.options[0]).toEqual({ label: "Cards", detail: "One per row", value: "Use cards.", preview: 0 });
    expect(parsed.choice?.recommends).toEqual({ option: 0, why: "Reads better on a phone" });
  });

  it("refuses too many options, a long label, an unknown key, a preview past the pictures and a stray recommendation", () => {
    expect(parseMorphChoice({ options: [] }, "/choice", { images: 0 }).refusals[0]?.path).toBe("/choice/options");
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `O${String(i)}` }));
    expect(parseMorphChoice({ options: six }, "/choice", { images: 0 }).choice).toBeUndefined();
    const paths = parseMorphChoice({ colour: "red", options: [{ label: "x".repeat(41) }, { label: "B", preview: 1 }], recommends: { option: 5 } }, "/choice", { images: 1 }).refusals.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/choice/colour", "/choice/options/0/label", "/choice/options/1/preview", "/choice/recommends/option"]));
  });

  it("refuses two options with the same label, since the pick is sent by its label", () => {
    expect(parseMorphChoice({ options: [{ label: "A" }, { label: "A" }] }, "/choice", { images: 0 }).refusals[0]?.code).toBe("duplicate");
  });
});

describe("blocks", () => {
  const AT = "2026-11-10T10:00:00.000Z";
  const two = [{ kind: "para", text: "a" }, { kind: "para", text: "b" }];

  it("takes the ids off the top-level nodes and answers them in order, null for a node with none", () => {
    const parsed = parseMorphView([{ id: "intro", ...two[0] }, two[1]]);
    expect(parsed.view).toEqual(two);
    expect(parsed.ids).toEqual(["intro", null]);
  });

  it("refuses an id off its pattern, the reserved word, and two nodes with one id, each at its path", () => {
    expect(parseMorphView([{ id: "Intro", ...two[0] }]).refusals[0]).toMatchObject({ code: "id", path: "/view/0/id" });
    expect(parseMorphView([{ id: "choice", ...two[0] }]).refusals[0]).toMatchObject({ code: "id" });
    expect(parseMorphView([{ id: "x".repeat(33), ...two[0] }]).refusals[0]).toMatchObject({ code: "id" });
    expect(parseMorphView([{ id: "a", ...two[0] }, { id: "a", ...two[1] }]).refusals[0]).toMatchObject({ code: "duplicate", path: "/view/1/id" });
  });

  it("an id below the top level stays the part parser's to refuse", () => {
    expect(parseMorphView([{ kind: "card", kids: [{ id: "deep", kind: "para", text: "x" }] }]).view).toBeUndefined();
  });

  it("reads a stored view's blocks, one per node, a pending label kept; a list that does not fit drops the view", () => {
    const blocks = [{ id: "a", at: AT }, { id: "b", at: AT, pending: "Running the tests" }];
    expect(readMorphView({ rev: 1, at: AT, view: two, blocks })?.blocks).toEqual(blocks);
    expect(readMorphView({ rev: 1, at: AT, view: two, blocks: [blocks[0]!] })).toBeNull();
    expect(readMorphView({ rev: 1, at: AT, view: two, blocks: [blocks[0]!, { id: "a", at: AT }] })).toBeNull();
    expect(readMorphView({ rev: 1, at: AT, view: two, blocks: [blocks[0]!, { id: "b", at: AT, pending: "a\nb" }] })).toBeNull();
  });

  it("a view stored before blocks reads as b1, b2 at its own time", () => {
    const view = readMorphView({ rev: 1, at: AT, view: two });
    expect(view === null ? null : morphBlocksOf(view)).toEqual([{ id: "b1", at: AT }, { id: "b2", at: AT }]);
  });

  it("the next minted id is the first free b<n>", () => {
    expect(nextBlockId(new Set())).toBe("b1");
    expect(nextBlockId(new Set(["b1", "b3"]))).toBe("b2");
    expect(nextBlockId(new Set(["b1", "x"]))).toBe("b2");
  });

  it("a choice's time defaults to the screen's, and a choice may carry the option picked", () => {
    const choice = { options: [{ label: "Yes" }, { label: "No" }], picked: 1 };
    expect(readMorphView({ rev: 1, at: AT, view: two, choice })).toMatchObject({ choiceAt: AT, choice: { picked: 1 } });
    expect(parseMorphChoice({ ...choice, picked: 2 }, "/choice", { images: 0 }).refusals[0]).toMatchObject({ code: "range", path: "/choice/picked" });
  });

  it("a drawing keeps its run's notes, newest last, at most eight, and leaves out one that does not fit", () => {
    const notes = Array.from({ length: MORPH_NOTES_MAX + 2 }, (_, i) => ({ at: AT, note: `Step ${String(i)}` }));
    const read = readMorphDrawing({ at: AT, notes: [...notes, { at: AT, note: "a\nb" }] });
    expect(read?.notes).toHaveLength(MORPH_NOTES_MAX - 1);
    expect(read?.notes?.at(-1)?.note).toBe(`Step ${String(MORPH_NOTES_MAX + 1)}`);
    expect(readMorphDrawing({ at: AT })?.notes).toBeUndefined();
  });
});
