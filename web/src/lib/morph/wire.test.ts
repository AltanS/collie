import { describe, expect, it } from "vitest";

import { MORPH_HINT_MAX, MORPH_NOTE_MAX, MORPH_TITLE_MAX, parseMorphView, readMorphAnswer, readMorphSession, readMorphSwitchBody, readMorphView } from "./wire";

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
