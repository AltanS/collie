import { describe, expect, test } from "bun:test";

import { MORPH_NOTES_MAX, morphBlocksOf, parseMorphView, readMorphView } from "../../web/src/lib/morph/wire.ts";
import { draftOf, keptBlocks, placed, readKeepFields, readPendingFields, readSetFields, removed, shownBlocks } from "./blocks.ts";
import { MorphService, singleNode } from "./service.ts";
import { MorphStore } from "./store.ts";

// Morph's blocks: the pure edits, the socket's fields, and the service's block verbs end to end.

const S = "local/%1#aaaa";
const para = (text: string) => ({ kind: "para", text });

interface Rig {
  readonly morph: MorphService;
  readonly at: (ms: number) => string;
  readonly advance: (ms: number) => void;
}

function rig(): Rig {
  let clock = Date.parse("2026-11-10T10:00:00.000Z");
  const morph = new MorphService({
    store: new MorphStore(null, () => clock),
    place: (address) => ({ address }),
    sessionsKnown: () => true,
    crewMode: () => "solo",
    binary: "/home/op/apps/collie/bin/collie",
    now: () => clock,
  });
  return { morph, at: (ms) => new Date(ms).toISOString(), advance: (ms) => void (clock += ms) };
}

function ids(r: Rig): string[] {
  return (r.morph.status(S).view?.blocks ?? []).map((block) => block.id);
}

describe("the pure edits", () => {
  const draft = { nodes: [para("a"), para("b")], blocks: [{ id: "a", at: "t0" }, { id: "b", at: "t0" }] };

  test("a block with a held id is replaced where it stands; a new one goes at the end, first, or after another", () => {
    expect(placed(draft, { node: para("A"), block: { id: "a", at: "t1" }, place: { kind: "end" } })).toEqual({ nodes: [para("A"), para("b")], blocks: [{ id: "a", at: "t1" }, { id: "b", at: "t0" }] });
    expect(placed(draft, { node: para("c"), block: { id: "c", at: "t1" }, place: { kind: "end" } })).toMatchObject({ blocks: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(placed(draft, { node: para("c"), block: { id: "c", at: "t1" }, place: { kind: "first" } })).toMatchObject({ blocks: [{ id: "c" }, { id: "a" }, { id: "b" }] });
    expect(placed(draft, { node: para("c"), block: { id: "c", at: "t1" }, place: { kind: "after", id: "a" } })).toMatchObject({ blocks: [{ id: "a" }, { id: "c" }, { id: "b" }] });
    // A held block given a place moves there.
    expect(placed(draft, { node: para("B"), block: { id: "b", at: "t1" }, place: { kind: "first" } })).toMatchObject({ nodes: [para("B"), para("a")], blocks: [{ id: "b" }, { id: "a" }] });
  });

  test("after a block that is not there, or after itself, is refused", () => {
    expect(placed(draft, { node: para("c"), block: { id: "c", at: "t1" }, place: { kind: "after", id: "zz" } })).toHaveProperty("error");
    expect(placed(draft, { node: para("a"), block: { id: "a", at: "t1" }, place: { kind: "after", id: "a" } })).toHaveProperty("error");
  });

  test("remove takes one block and never the last; keep re-stamps the named blocks or all of them", () => {
    expect(removed(draft, "a")).toEqual({ nodes: [para("b")], blocks: [{ id: "b", at: "t0" }] });
    expect(removed(draft, "zz")).toHaveProperty("error");
    expect(removed({ nodes: [para("a")], blocks: [{ id: "a", at: "t0" }] }, "a")).toHaveProperty("error");
    expect(keptBlocks(draft, { ids: ["b"], at: "t2" })).toMatchObject({ blocks: [{ at: "t0" }, { at: "t2" }] });
    expect(keptBlocks(draft, { ids: "all", at: "t2" })).toMatchObject({ blocks: [{ at: "t2" }, { at: "t2" }] });
    expect(keptBlocks(draft, { ids: ["choice"], at: "t2" })).toMatchObject({ blocks: [{ at: "t0" }, { at: "t0" }] });
    expect(keptBlocks(draft, { ids: ["zz"], at: "t2" })).toHaveProperty("error");
  });

  test("a show names its blocks by their ids and mints b1, b2 for the rest, skipping a taken one", () => {
    expect(shownBlocks(["intro", null, null], "t")).toEqual([{ id: "intro", at: "t" }, { id: "b1", at: "t" }, { id: "b2", at: "t" }]);
    expect(shownBlocks([null, "b1"], "t").map((block) => block.id)).toEqual(["b2", "b1"]);
  });

  test("a screen stored before blocks reads as b1, b2 at the screen's time", () => {
    const old = readMorphView({ rev: 1, at: "2026-11-01T00:00:00.000Z", view: [para("a"), para("b")] });
    expect(old === null ? [] : morphBlocksOf(old)).toEqual([
      { id: "b1", at: "2026-11-01T00:00:00.000Z" },
      { id: "b2", at: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(draftOf(undefined)).toEqual({ nodes: [], blocks: [] });
  });

  test("a set node may name its own id, never another", () => {
    expect(singleNode({ id: "a", ...para("x") }, "a")).toEqual({ node: para("x") });
    expect(singleNode([para("x")], "a")).toEqual({ node: para("x") });
    expect(singleNode({ id: "b", ...para("x") }, "a")).toHaveProperty("error");
    expect(singleNode([para("x"), para("y")], "a")).toHaveProperty("error");
  });
});

describe("the socket's fields", () => {
  test("an id is the pattern and never `choice`; --first and --after exclude each other", () => {
    expect(readSetFields({ id: "a-1", node: para("x") })).toMatchObject({ id: "a-1", place: { kind: "end" }, images: [] });
    expect(readSetFields({ id: "A", node: para("x") })).toMatchObject({ code: "bad_block" });
    expect(readSetFields({ id: "choice", node: para("x") })).toMatchObject({ code: "bad_block" });
    expect(readSetFields({ id: "a", node: para("x"), first: true, after: "b" })).toMatchObject({ code: "bad_block" });
    expect(readSetFields({ id: "a" })).toMatchObject({ code: "bad_view" });
    expect(readPendingFields({ id: "a", label: "Running\nthe tests" })).toMatchObject({ code: "bad_block" });
    expect(readPendingFields({ id: "a", label: "Running the tests", after: "b" })).toEqual({ id: "a", label: "Running the tests", place: { kind: "after", id: "b" } });
    expect(readKeepFields({ ids: ["a", "choice"] })).toEqual({ ids: ["a", "choice"] });
    expect(readKeepFields({ all: true })).toEqual({ ids: "all" });
    expect(readKeepFields({})).toMatchObject({ code: "bad_block" });
  });
});

describe("a show's blocks", () => {
  test("ids on top-level nodes are taken off the view and kept as the blocks, stamped with the show's time", () => {
    const r = rig();
    const answer = r.morph.show(S, { view: [{ id: "intro", ...para("Hi") }, para("Body")], title: null });
    expect(answer.ok).toBe(true);
    const view = r.morph.status(S).view;
    expect(JSON.parse(JSON.stringify(view?.view))).toEqual([para("Hi"), para("Body")]);
    const at = view?.at ?? "";
    expect(view?.blocks).toEqual([{ id: "intro", at }, { id: "b1", at }]);
  });

  test("a bad or doubled id refuses the show with its path", () => {
    const r = rig();
    expect(r.morph.show(S, { view: [{ id: "Bad", ...para("x") }], title: null })).toMatchObject({ ok: false, code: "bad_view" });
    const doubled = r.morph.show(S, { view: [{ id: "a", ...para("x") }, { id: "a", ...para("y") }], title: null });
    expect(!doubled.ok && doubled.refusals?.[0]).toMatchObject({ path: "/view/1/id" });
    expect(r.morph.status(S).view).toBeUndefined();
  });

  test("a show with a choice stamps choiceAt", () => {
    const r = rig();
    r.morph.show(S, { view: [para("x")], title: null, choice: { options: [{ label: "Yes" }] } });
    expect(r.morph.status(S).view?.choiceAt).toBe(r.morph.status(S).view?.at);
  });
});

describe("the block verbs", () => {
  test("set fills, inserts and moves blocks; each edit is a new rev and keeps the title and the drawing", () => {
    const r = rig();
    r.morph.show(S, { view: [{ id: "intro", ...para("Hi") }], title: "Screen" });
    r.morph.start(S, { note: "Filling in" });
    r.advance(1000);
    const answer = r.morph.set(S, { id: "tests", node: para("All pass"), place: { kind: "end" }, images: [] });
    expect(answer.ok && answer.session.view?.rev).toBe(2);
    expect(ids(r)).toEqual(["intro", "tests"]);
    const view = r.morph.status(S).view;
    expect(view?.title).toBe("Screen");
    expect(view?.blocks?.[1]?.at).toBe(view?.at);
    expect(view?.blocks?.[0]?.at).not.toBe(view?.at);
    expect(r.morph.status(S).drawing?.note).toBe("Filling in");
    r.morph.set(S, { id: "top", node: para("Top"), place: { kind: "first" } , images: [] });
    expect(ids(r)).toEqual(["top", "intro", "tests"]);
  });

  test("set with no screen starts one", () => {
    const r = rig();
    expect(r.morph.set(S, { id: "a", node: para("x"), place: { kind: "end" }, images: [] })).toMatchObject({ ok: true });
    expect(ids(r)).toEqual(["a"]);
  });

  test("a set that would break the screen is refused, and the screen stays as it was", () => {
    const r = rig();
    r.morph.show(S, { view: [para("x")], title: null });
    const before = r.morph.status(S).view;
    expect(r.morph.set(S, { id: "b1", node: { kind: "button", attrs: { label: "Go" } }, place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "bad_view" });
    expect(r.morph.set(S, { id: "zz", node: para("y"), place: { kind: "after", id: "nope" }, images: [] })).toMatchObject({ ok: false, code: "bad_block" });
    expect(r.morph.set(S, { id: "b1", node: { id: "other", ...para("y") }, place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "bad_view" });
    expect(r.morph.status(S).view).toEqual(before);
  });

  test("pending holds a spacer and the label; set fills it in place", () => {
    const r = rig();
    r.morph.show(S, { view: [{ id: "intro", ...para("Hi") }], title: null });
    r.morph.pending(S, { id: "tests", label: "Running the tests", place: { kind: "end" } });
    const held = r.morph.status(S).view;
    expect(held?.view[1]).toEqual({ kind: "spacer" });
    expect(held?.blocks?.[1]).toMatchObject({ id: "tests", pending: "Running the tests" });
    r.morph.set(S, { id: "tests", node: para("All pass"), place: { kind: "end" }, images: [] });
    expect(r.morph.status(S).view?.blocks?.[1]?.pending).toBeUndefined();
    expect(JSON.parse(JSON.stringify(r.morph.status(S).view?.view[1]))).toEqual(para("All pass"));
  });

  test("remove takes one block; the last one and a missing one are refused; with no screen, no_screen", () => {
    const r = rig();
    expect(r.morph.remove(S, "a")).toMatchObject({ ok: false, code: "no_screen" });
    r.morph.show(S, { view: [{ id: "a", ...para("x") }, { id: "b", ...para("y") }], title: null });
    expect(r.morph.remove(S, "a")).toMatchObject({ ok: true });
    expect(ids(r)).toEqual(["b"]);
    expect(r.morph.remove(S, "b")).toMatchObject({ ok: false, code: "bad_block" });
    expect(r.morph.remove(S, "zz")).toMatchObject({ ok: false, code: "bad_block" });
  });

  test("keep re-stamps the named blocks and, by `choice`, the decision block; a missing id or choice is refused", () => {
    const r = rig();
    r.morph.show(S, { view: [{ id: "a", ...para("x") }, { id: "b", ...para("y") }], title: null, choice: { options: [{ label: "Yes" }] } });
    const shownAt = r.morph.status(S).view?.at;
    r.advance(5000);
    expect(r.morph.keep(S, ["b"])).toMatchObject({ ok: true });
    const kept = r.morph.status(S).view;
    expect(kept?.blocks?.map((block) => block.at)).toEqual([shownAt ?? "", kept?.at ?? ""]);
    expect(kept?.choiceAt).toBe(shownAt);
    r.advance(5000);
    r.morph.keep(S, ["choice"]);
    expect(r.morph.status(S).view?.choiceAt).toBe(r.morph.status(S).view?.at);
    r.advance(5000);
    r.morph.keep(S, "all");
    const all = r.morph.status(S).view;
    expect(all?.blocks?.every((block) => block.at === all.at)).toBe(true);
    expect(r.morph.keep(S, ["zz"])).toMatchObject({ ok: false, code: "bad_block" });
    r.morph.setChoice(S, null);
    expect(r.morph.keep(S, ["choice"])).toMatchObject({ ok: false, code: "bad_block" });
  });

  test("choice sets the decision block alone, with picked; --clear drops it; a bad one leaves the screen", () => {
    const r = rig();
    expect(r.morph.setChoice(S, { options: [{ label: "Yes" }] })).toMatchObject({ ok: false, code: "no_screen" });
    r.morph.show(S, { view: [para("x")], title: null });
    r.advance(1000);
    expect(r.morph.setChoice(S, { question: "Go on?", options: [{ label: "Yes" }, { label: "No" }], picked: 1 })).toMatchObject({ ok: true });
    const view = r.morph.status(S).view;
    expect(view?.choice?.picked).toBe(1);
    expect(view?.choiceAt).toBe(view?.at);
    expect(r.morph.setChoice(S, { options: [] })).toMatchObject({ ok: false, code: "bad_choice" });
    expect(r.morph.status(S).view?.choice?.picked).toBe(1);
    r.morph.setChoice(S, null);
    expect(r.morph.status(S).view?.choice).toBeUndefined();
    expect(r.morph.status(S).view?.choiceAt).toBeUndefined();
  });

  test("a crew member refuses every block verb", () => {
    const r = rig();
    const peer = new MorphService({ store: new MorphStore(null, Date.now), place: (address) => ({ address }), sessionsKnown: () => true, crewMode: () => "peer", binary: "/x" });
    expect(peer.set(S, { id: "a", node: para("x"), place: { kind: "end" }, images: [] })).toMatchObject({ code: "not_on_lead" });
    expect(peer.pending(S, { id: "a", label: "x", place: { kind: "end" } })).toMatchObject({ code: "not_on_lead" });
    expect(peer.remove(S, "a")).toMatchObject({ code: "not_on_lead" });
    expect(peer.keep(S, "all")).toMatchObject({ code: "not_on_lead" });
    expect(peer.setChoice(S, null)).toMatchObject({ code: "not_on_lead" });
    expect(r.morph.status(S).view).toBeUndefined();
  });

  test("the stored screen still passes the phone's reader, blocks and all", () => {
    const r = rig();
    r.morph.show(S, { view: [{ id: "a", ...para("x") }], title: null });
    r.morph.pending(S, { id: "p", label: "Later", place: { kind: "first" } });
    const stored = JSON.parse(JSON.stringify(r.morph.status(S).view));
    const read = readMorphView(stored);
    expect(read?.blocks).toEqual(stored.blocks);
    expect(parseMorphView(JSON.parse(JSON.stringify(read?.view))).refusals).toEqual([]);
  });
});

describe("the notes of a drawing run", () => {
  test("each start adds its note with its time; a show ends the run; the list holds the newest eight", () => {
    const r = rig();
    r.morph.start(S, { note: "Reading" });
    r.advance(1000);
    r.morph.start(S, { note: "Testing" });
    r.advance(1000);
    r.morph.start(S, { note: null });
    const drawing = r.morph.status(S).drawing;
    expect(drawing?.notes?.map((n) => n.note)).toEqual(["Reading", "Testing"]);
    expect(drawing?.note).toBeUndefined();
    for (let i = 0; i < MORPH_NOTES_MAX + 2; i += 1) r.morph.start(S, { note: `Step ${String(i)}` });
    expect(r.morph.status(S).drawing?.notes).toHaveLength(MORPH_NOTES_MAX);
    expect(r.morph.status(S).drawing?.notes?.at(-1)?.note).toBe(`Step ${String(MORPH_NOTES_MAX + 1)}`);
    r.morph.show(S, { view: [para("x")], title: null });
    r.morph.start(S, { note: "Again" });
    expect(r.morph.status(S).drawing?.notes?.map((n) => n.note)).toEqual(["Again"]);
  });
});
