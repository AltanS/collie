import { describe, expect, it } from "vitest";

import { VIEW_HEAD_MAX,
  VIEW_NO_PICKED,
  VIEW_HINT_MAX,
  VIEW_NOTE_MAX,
  VIEW_NOTES_MAX,
  VIEW_TITLE_MAX,
  viewBlocksOf,
  nextBlockId,
  parseViewChoice,
  parseAgentView,
  readTrickViewsAnswer,
  readViewDrawing,
  readTrickViewSession,
  readTrickViewSwitchBody,
  readViewScreen,
} from "./wire";

const SESSION = "local/%1#aaaa";
const TRICK = "morph";
const HINT = "[morph: answer by drawing one screen]";

const goodView = [
  { kind: "para", text: "Two tests fail", attrs: { role: "heading" } },
  { kind: "list", kids: [{ kind: "row", text: "auth.test.ts", attrs: { end: "2 fail" } }] },
  { kind: "diff", text: "-old\n+new", attrs: { file: "src/a.ts" } },
  {
    kind: "bar",
    kids: [
      { kind: "button", attrs: { label: "Fix them", intent: "reply" } },
      { kind: "button", attrs: { label: "Skip", intent: "reply", confirm: "Sure?" } },
    ],
  },
];

describe("parseAgentView", () => {
  it("takes a part view with buttons, which the Decision reader refuses", () => {
    const parsed = parseAgentView(goodView);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.view).toHaveLength(4);
  });

  it("refuses with the parser's reason, under the caller's own path", () => {
    const parsed = parseAgentView([{ kind: "para", text: "ok" }, { kind: "bar", kids: [{ kind: "button", attrs: { label: "x" } }] }]);
    expect(parsed.view).toBeUndefined();
    expect(parsed.refusals[0]?.path.startsWith("/view/1")).toBe(true);
    expect(parsed.refusals[0]?.reason).toContain("intent");
  });

  it("refuses what the tolerant trick read would only drop: an unknown kind", () => {
    const parsed = parseAgentView([{ kind: "para", text: "ok" }, { kind: "hologram" }]);
    expect(parsed.view).toBeUndefined();
    expect(parsed.refusals.length).toBeGreaterThan(0);
  });

  it("refuses garbage without a throw", () => {
    for (const raw of [undefined, null, 3, "x", {}, [], [null]]) {
      expect(parseAgentView(raw).view).toBeUndefined();
    }
  });

  it("holds the root cap", () => {
    const many = Array.from({ length: 25 }, () => ({ kind: "para", text: "x" }));
    expect(parseAgentView(many).view).toBeUndefined();
  });
});

describe("readViewScreen", () => {
  it("reads a stored view, with and without a title", () => {
    expect(readViewScreen({ rev: 3, at: "2026-11-10T10:00:00.000Z", view: goodView })).toMatchObject({ rev: 3, at: "2026-11-10T10:00:00.000Z" });
    expect(readViewScreen({ rev: 3, at: "2026-11-10T10:00:00.000Z", title: "Tests", view: goodView })?.title).toBe("Tests");
  });

  it("drops a bad rev, time, title or view", () => {
    const base = { rev: 1, at: "2026-11-10T10:00:00.000Z", view: goodView };
    expect(readViewScreen({ ...base, rev: -1 })).toBeNull();
    expect(readViewScreen({ ...base, rev: 1.5 })).toBeNull();
    expect(readViewScreen({ ...base, at: "yesterday" })).toBeNull();
    expect(readViewScreen({ ...base, title: "x".repeat(VIEW_TITLE_MAX + 1) })).toBeNull();
    expect(readViewScreen({ ...base, title: "two\nlines" })).toBeNull();
    expect(readViewScreen({ ...base, view: [{ kind: "nope" }] })).toBeNull();
  });
});

describe("readTrickViewSession", () => {
  it("reads a session, and keeps it without a view that does not fit", () => {
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, hint: HINT })).toEqual({ trick: TRICK, session: SESSION, on: true, hint: HINT });
    const kept = readTrickViewSession({ trick: TRICK, session: SESSION, on: false, hint: HINT, view: { rev: 1, at: "bad", view: goodView } });
    expect(kept).toEqual({ trick: TRICK, session: SESSION, on: false, hint: HINT });
  });

  it("reads the head and the drawing when they fit, and leaves a bad one out with the session kept", () => {
    const drawing = { at: "2026-11-10T10:00:00.000Z", note: "Checking the tests" };
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, head: "[morph] from operator:", hint: HINT, drawing })).toEqual({ trick: TRICK, session: SESSION, on: true, head: "[morph] from operator:", hint: HINT, drawing });
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, hint: HINT, drawing: { at: "2026-11-10T10:00:00.000Z" } })).toEqual({ trick: TRICK, session: SESSION, on: true, hint: HINT, drawing: { at: "2026-11-10T10:00:00.000Z" } });
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, head: "a\nb", hint: HINT })).toEqual({ trick: TRICK, session: SESSION, on: true, hint: HINT });
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, hint: HINT, drawing: { at: "soon" } })).toEqual({ trick: TRICK, session: SESSION, on: true, hint: HINT });
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, hint: HINT, drawing: { at: drawing.at, note: "x".repeat(VIEW_NOTE_MAX + 1) } })).toEqual({ trick: TRICK, session: SESSION, on: true, hint: HINT });
  });

  it("reads a session with no hint (it holds the rules) and a head that names the session", () => {
    const head = `[morph ${SESSION}] from operator:`;
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, head })).toEqual({ trick: TRICK, session: SESSION, on: true, head });
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, head: `[morph ${"x".repeat(VIEW_HEAD_MAX)}] from operator:` })).toEqual({ trick: TRICK, session: SESSION, on: true });
  });

  it("drops a session with a bad key, switch or hint", () => {
    expect(readTrickViewSession({ trick: TRICK, session: "", on: true, hint: HINT })).toBeNull();
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: "yes", hint: HINT })).toBeNull();
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, hint: "a\nb" })).toBeNull();
    expect(readTrickViewSession({ trick: TRICK, session: SESSION, on: true, hint: "x".repeat(VIEW_HINT_MAX + 1) })).toBeNull();
  });
});

describe("readTrickViewsAnswer", () => {
  it("reads the list and drops a session that does not fit", () => {
    const answer = readTrickViewsAnswer({ rev: 7, views: [{ trick: TRICK, session: SESSION, on: true, hint: HINT }, { trick: TRICK, session: 4 }] });
    expect(answer).toEqual({ rev: 7, views: [{ trick: TRICK, session: SESSION, on: true, hint: HINT }] });
  });

  it("reads the short answer", () => {
    expect(readTrickViewsAnswer({ rev: 7, unchanged: true })).toEqual({ rev: 7, unchanged: true, views: [] });
  });

  it("refuses a bad rev or a missing list", () => {
    expect(readTrickViewsAnswer({ rev: "7", views: [] })).toBeNull();
    expect(readTrickViewsAnswer({ rev: 7 })).toBeNull();
    expect(readTrickViewsAnswer(null)).toBeNull();
  });
});

describe("readTrickViewSwitchBody", () => {
  it("reads exactly a trick, a session and a switch", () => {
    expect(readTrickViewSwitchBody({ trick: TRICK, session: SESSION, on: true })).toEqual({ trick: TRICK, session: SESSION, on: true });
    expect(readTrickViewSwitchBody({ trick: TRICK, session: SESSION, on: true, extra: 1 })).toBeNull();
    expect(readTrickViewSwitchBody({ trick: TRICK, session: SESSION })).toBeNull();
    expect(readTrickViewSwitchBody({ session: SESSION, on: true })).toBeNull();
    expect(readTrickViewSwitchBody({ trick: TRICK, session: " padded ", on: false })).toBeNull();
    expect(readTrickViewSwitchBody([])).toBeNull();
  });
});

describe("pictures by ref", () => {
  const button = { kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship it", intent: "reply" } }] };

  it("takes a button and an image by ref on one screen, keeping the picture node as drawn", () => {
    const parsed = parseAgentView([{ kind: "image", attrs: { ref: "0", focus: "50 20 2" } }, button], "/view", { images: 1 });
    expect(parsed.refusals).toEqual([]);
    expect(parsed.view?.[0]).toMatchObject({ kind: "image", attrs: { ref: "0", focus: "50 20 2" } });
    expect(parsed.view?.[1]?.kind).toBe("bar");
  });

  it("takes a compare of two pictures inside a group, beside a button", () => {
    const compare = { kind: "compare", kids: [{ kind: "image", attrs: { ref: "0" } }, { kind: "image", attrs: { ref: "1", caption: "New" } }] };
    const parsed = parseAgentView([{ kind: "group", attrs: { label: "Look" }, kids: [{ kind: "para", text: "Before and after" }, compare] }, button], "/view", { images: 2 });
    expect(parsed.refusals).toEqual([]);
    const group = parsed.view?.[0];
    expect(group?.kind === "group" ? group.kids[1]?.kind : null).toBe("compare");
  });

  it("refuses a ref past the pictures, with the picture's own path", () => {
    const parsed = parseAgentView([{ kind: "para", text: "Look" }, { kind: "group", kids: [{ kind: "image", attrs: { ref: "2" } }] }], "/view", { images: 2 });
    expect(parsed.view).toBeUndefined();
    expect(parsed.refusals.map((r) => r.path)).toContain("/view/1/kids/0/attrs/ref");
  });

  it("still reads a src image as the part parser does", () => {
    const src = [{ kind: "image", attrs: { src: "shot.png", alt: "A shot", w: "300", h: "200" } }];
    expect(parseAgentView(src)).toEqual(parseAgentView(src, "/view", { images: 0 }));
    expect(parseAgentView([{ kind: "image", attrs: { alt: "no src" } }]).view).toBeUndefined();
  });

  it("refuses a part-parser fault beside a picture under its real path", () => {
    const parsed = parseAgentView([{ kind: "image", attrs: { ref: "0" } }, { kind: "bar", kids: [{ kind: "button", attrs: { label: "x" } }] }], "/view", { images: 1 });
    expect(parsed.refusals.some((r) => r.path.startsWith("/view/1/kids/0"))).toBe(true);
  });

  it("serves a view with its set, its pictures and a picture placed by ref", () => {
    const media = [{ id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 120, width: 390, height: 844, caption: "Now" }];
    const read = readViewScreen({ rev: 2, at: "2026-11-10T10:00:00.000Z", set: "dc_aaaaaaaaaaaa", media, view: [{ kind: "image", attrs: { ref: "0" } }] });
    expect(read?.set).toBe("dc_aaaaaaaaaaaa");
    expect(read?.media).toHaveLength(1);
    expect(readViewScreen({ rev: 2, at: "2026-11-10T10:00:00.000Z", view: [{ kind: "image", attrs: { ref: "0" } }] })).toBeNull();
    expect(readViewScreen({ rev: 2, at: "2026-11-10T10:00:00.000Z", set: "../etc", media, view: [{ kind: "para", text: "x" }] })).toBeNull();
  });
});

describe("parseViewChoice", () => {
  it("reads a question, options with every field, and a recommendation", () => {
    const parsed = parseViewChoice(
      {
        question: "Which layout?",
        options: [
          { label: "Cards", detail: "One per row", preview: 0 },
          { label: "Table", confirm: "Sure?", preview: 1 },
        ],
        recommends: { option: 0, why: "Reads better on a phone" },
      },
      "/choice",
      { images: 2 },
    );
    expect(parsed.refusals).toEqual([]);
    expect(parsed.choice?.options[0]).toEqual({ label: "Cards", detail: "One per row", preview: 0 });
    expect(parsed.choice?.recommends).toEqual({ option: 0, why: "Reads better on a phone" });
  });

  it("refuses too many options, a long label, an unknown key, a preview past the pictures and a stray recommendation", () => {
    expect(parseViewChoice({ options: [] }, "/choice", { images: 0 }).refusals[0]?.path).toBe("/choice/options");
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `O${String(i)}` }));
    expect(parseViewChoice({ options: six }, "/choice", { images: 0 }).choice).toBeUndefined();
    const paths = parseViewChoice({ colour: "red", options: [{ label: "x".repeat(41) }, { label: "B", preview: 1 }], recommends: { option: 5 } }, "/choice", { images: 1 }).refusals.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/choice/colour", "/choice/options/0/label", "/choice/options/1/preview", "/choice/recommends/option"]));
  });

  it("refuses two options with the same label, since the pick is sent by its label", () => {
    expect(parseViewChoice({ options: [{ label: "A" }, { label: "A" }] }, "/choice", { images: 0 }).refusals[0]?.code).toBe("duplicate");
  });
});

describe("blocks", () => {
  const AT = "2026-11-10T10:00:00.000Z";
  const two = [{ kind: "para", text: "a" }, { kind: "para", text: "b" }];

  it("takes the ids off the top-level nodes and answers them in order, null for a node with none", () => {
    const parsed = parseAgentView([{ id: "intro", ...two[0] }, two[1]]);
    expect(parsed.view).toEqual(two);
    expect(parsed.ids).toEqual(["intro", null]);
  });

  it("refuses an id off its pattern, the reserved word, and two nodes with one id, each at its path", () => {
    expect(parseAgentView([{ id: "Intro", ...two[0] }]).refusals[0]).toMatchObject({ code: "id", path: "/view/0/id" });
    expect(parseAgentView([{ id: "choice", ...two[0] }]).refusals[0]).toMatchObject({ code: "id" });
    expect(parseAgentView([{ id: "x".repeat(33), ...two[0] }]).refusals[0]).toMatchObject({ code: "id" });
    expect(parseAgentView([{ id: "a", ...two[0] }, { id: "a", ...two[1] }]).refusals[0]).toMatchObject({ code: "duplicate", path: "/view/1/id" });
  });

  it("an id below the top level stays the part parser's to refuse", () => {
    expect(parseAgentView([{ kind: "card", kids: [{ id: "deep", kind: "para", text: "x" }] }]).view).toBeUndefined();
  });

  it("reads a stored view's blocks, one per node, a pending label kept; a list that does not fit drops the view", () => {
    const blocks = [{ id: "a", at: AT }, { id: "b", at: AT, pending: "Running the tests" }];
    expect(readViewScreen({ rev: 1, at: AT, view: two, blocks })?.blocks).toEqual(blocks);
    expect(readViewScreen({ rev: 1, at: AT, view: two, blocks: [blocks[0]!] })).toBeNull();
    expect(readViewScreen({ rev: 1, at: AT, view: two, blocks: [blocks[0]!, { id: "a", at: AT }] })).toBeNull();
    expect(readViewScreen({ rev: 1, at: AT, view: two, blocks: [blocks[0]!, { id: "b", at: AT, pending: "a\nb" }] })).toBeNull();
  });

  it("a view stored before blocks reads as b1, b2 at its own time", () => {
    const view = readViewScreen({ rev: 1, at: AT, view: two });
    expect(view === null ? null : viewBlocksOf(view)).toEqual([{ id: "b1", at: AT }, { id: "b2", at: AT }]);
  });

  it("the next minted id is the first free b<n>", () => {
    expect(nextBlockId(new Set())).toBe("b1");
    expect(nextBlockId(new Set(["b1", "b3"]))).toBe("b2");
    expect(nextBlockId(new Set(["b1", "x"]))).toBe("b2");
  });

  it("a choice's time defaults to the screen's; review 10 W7: a choice carries no picked, the screen carries Collie's picks", () => {
    const choice = { options: [{ label: "Yes" }, { label: "No" }] };
    expect(readViewScreen({ rev: 1, at: AT, view: two, choice })).toMatchObject({ choiceAt: AT, choice });
    expect(parseViewChoice({ ...choice, picked: 1 }, "/choice", { images: 0 }).refusals[0]).toMatchObject({ code: "unknown-key", path: "/choice/picked", reason: VIEW_NO_PICKED });
    expect(readViewScreen({ rev: 1, at: AT, view: two, choice, picks: [{ block: "choice", path: "1" }] })?.picks).toEqual([{ block: "choice", path: "1" }]);
    expect(readViewScreen({ rev: 1, at: AT, view: two, choice, picks: [{ block: "choice", path: "x" }] })).toBeNull();
  });

  it("a drawing keeps its run's notes, newest last, at most eight, and leaves out one that does not fit", () => {
    const notes = Array.from({ length: VIEW_NOTES_MAX + 2 }, (_, i) => ({ at: AT, note: `Step ${String(i)}` }));
    const read = readViewDrawing({ at: AT, notes: [...notes, { at: AT, note: "a\nb" }] });
    expect(read?.notes).toHaveLength(VIEW_NOTES_MAX - 1);
    expect(read?.notes?.at(-1)?.note).toBe(`Step ${String(VIEW_NOTES_MAX + 1)}`);
    expect(readViewDrawing({ at: AT })?.notes).toBeUndefined();
  });
});
