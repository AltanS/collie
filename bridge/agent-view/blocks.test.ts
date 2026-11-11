import { describe, expect, test } from "bun:test";

import { VIEW_NOTES_MAX, viewBlocksOf, parseAgentView, readViewScreen } from "../../web/src/lib/agent-view/wire.ts";
import { draftOf, keptBlocks, placed, readKeepFields, readPendingFields, readSetFields, removed, shownBlocks } from "./blocks.ts";
import { AgentViewService, singleNode, type AgentViewServiceDeps, type ViewGate } from "./service.ts";
import { AgentViewStore } from "./store.ts";

// Agent views' blocks: the pure edits, the socket's fields, and the service's block verbs end to end.

const T = "morph";
const S = "local/%1#aaaa";
const para = (text: string) => ({ kind: "para", text });

/** A gate that lets one trick through with its rules text. */
const openGate = (rules = "Draw one screen.\n") => ({
  check: (): ViewGate => ({ ok: true, name: "Morph", rules }),
  fresh: async (): Promise<ViewGate> => ({ ok: true, name: "Morph", rules }),
});

const BASE: Omit<AgentViewServiceDeps, "store" | "crewMode"> = {
  place: (address) => ({ address }),
  sessionsKnown: () => true,
  binary: "/home/op/apps/collie/bin/collie",
  gate: openGate(),
  rulesIdOf: (trick) => `rid-${trick}`,
  helpOf: () => ["help"],
};

interface Rig {
  readonly service: AgentViewService;
  readonly at: (ms: number) => string;
  readonly advance: (ms: number) => void;
}

/** A service with the person's switch for the one session already on, as the phone leaves it. */
async function rig(): Promise<Rig> {
  let clock = Date.parse("2026-11-10T10:00:00.000Z");
  const service = new AgentViewService({ ...BASE, store: new AgentViewStore(null, () => clock), crewMode: () => "solo", now: () => clock });
  const switched = await service.switch({ trick: T, session: S, on: true }, null);
  if (!switched.ok) throw new Error(`switch refused: ${switched.error}`);
  return { service, at: (ms) => new Date(ms).toISOString(), advance: (ms) => void (clock += ms) };
}

function ids(r: Rig): string[] {
  return (r.service.status(T, S).view?.blocks ?? []).map((block) => block.id);
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
    const old = readViewScreen({ rev: 1, at: "2026-11-01T00:00:00.000Z", view: [para("a"), para("b")] });
    expect(old === null ? [] : viewBlocksOf(old)).toEqual([
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
  test("ids on top-level nodes are taken off the view and kept as the blocks, stamped with the show's time", async () => {
    const r = await rig();
    const answer = await r.service.show(T, S, { view: [{ id: "intro", ...para("Hi") }, para("Body")], title: null });
    expect(answer.ok).toBe(true);
    const view = r.service.status(T, S).view;
    expect(JSON.parse(JSON.stringify(view?.view))).toEqual([para("Hi"), para("Body")]);
    const at = view?.at ?? "";
    expect(view?.blocks).toEqual([{ id: "intro", at }, { id: "b1", at }]);
  });

  test("a bad or doubled id refuses the show with its path", async () => {
    const r = await rig();
    expect(await r.service.show(T, S, { view: [{ id: "Bad", ...para("x") }], title: null })).toMatchObject({ ok: false, code: "bad_view" });
    const doubled = await r.service.show(T, S, { view: [{ id: "a", ...para("x") }, { id: "a", ...para("y") }], title: null });
    expect(!doubled.ok && doubled.refusals?.[0]).toMatchObject({ path: "/view/1/id" });
    expect(r.service.status(T, S).view).toBeUndefined();
  });

  test("a show with a choice stamps choiceAt", async () => {
    const r = await rig();
    await r.service.show(T, S, { view: [para("x")], title: null, choice: { options: [{ label: "Yes" }] } });
    expect(r.service.status(T, S).view?.choiceAt).toBe(r.service.status(T, S).view?.at);
  });
});

describe("the block verbs", () => {
  test("set fills, inserts and moves blocks; each edit is a new rev and keeps the title and the drawing", async () => {
    const r = await rig();
    await r.service.show(T, S, { view: [{ id: "intro", ...para("Hi") }], title: "Screen" });
    await r.service.start(T, S, { note: "Filling in" });
    r.advance(1000);
    const answer = await r.service.set(T, S, { id: "tests", node: para("All pass"), place: { kind: "end" }, images: [] });
    expect(answer.ok && answer.session.view?.rev).toBe(2);
    expect(ids(r)).toEqual(["intro", "tests"]);
    const view = r.service.status(T, S).view;
    expect(view?.title).toBe("Screen");
    expect(view?.blocks?.[1]?.at).toBe(view?.at);
    expect(view?.blocks?.[0]?.at).not.toBe(view?.at);
    expect(r.service.status(T, S).drawing?.note).toBe("Filling in");
    await r.service.set(T, S, { id: "top", node: para("Top"), place: { kind: "first" } , images: [] });
    expect(ids(r)).toEqual(["top", "intro", "tests"]);
  });

  test("set with no screen starts one", async () => {
    const r = await rig();
    expect(await r.service.set(T, S, { id: "a", node: para("x"), place: { kind: "end" }, images: [] })).toMatchObject({ ok: true });
    expect(ids(r)).toEqual(["a"]);
  });

  test("a set that would break the screen is refused, and the screen stays as it was", async () => {
    const r = await rig();
    await r.service.show(T, S, { view: [para("x")], title: null });
    const before = r.service.status(T, S).view;
    expect(await r.service.set(T, S, { id: "b1", node: { kind: "button", attrs: { label: "Go" } }, place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "bad_view" });
    expect(await r.service.set(T, S, { id: "zz", node: para("y"), place: { kind: "after", id: "nope" }, images: [] })).toMatchObject({ ok: false, code: "bad_block" });
    expect(await r.service.set(T, S, { id: "b1", node: { id: "other", ...para("y") }, place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "bad_view" });
    expect(r.service.status(T, S).view).toEqual(before);
  });

  test("pending holds a spacer and the label; set fills it in place", async () => {
    const r = await rig();
    await r.service.show(T, S, { view: [{ id: "intro", ...para("Hi") }], title: null });
    await r.service.pending(T, S, { id: "tests", label: "Running the tests", place: { kind: "end" } });
    const held = r.service.status(T, S).view;
    expect(held?.view[1]).toEqual({ kind: "spacer" });
    expect(held?.blocks?.[1]).toMatchObject({ id: "tests", pending: "Running the tests" });
    await r.service.set(T, S, { id: "tests", node: para("All pass"), place: { kind: "end" }, images: [] });
    expect(r.service.status(T, S).view?.blocks?.[1]?.pending).toBeUndefined();
    expect(JSON.parse(JSON.stringify(r.service.status(T, S).view?.view[1]))).toEqual(para("All pass"));
  });

  test("remove takes one block; the last one and a missing one are refused; with no screen, no_screen", async () => {
    const r = await rig();
    expect(await r.service.remove(T, S, "a")).toMatchObject({ ok: false, code: "no_screen" });
    await r.service.show(T, S, { view: [{ id: "a", ...para("x") }, { id: "b", ...para("y") }], title: null });
    expect(await r.service.remove(T, S, "a")).toMatchObject({ ok: true });
    expect(ids(r)).toEqual(["b"]);
    expect(await r.service.remove(T, S, "b")).toMatchObject({ ok: false, code: "bad_block" });
    expect(await r.service.remove(T, S, "zz")).toMatchObject({ ok: false, code: "bad_block" });
  });

  test("keep re-stamps the named blocks and, by `choice`, the decision block; a missing id or choice is refused", async () => {
    const r = await rig();
    await r.service.show(T, S, { view: [{ id: "a", ...para("x") }, { id: "b", ...para("y") }], title: null, choice: { options: [{ label: "Yes" }] } });
    const shownAt = r.service.status(T, S).view?.at;
    r.advance(5000);
    expect(await r.service.keep(T, S, ["b"])).toMatchObject({ ok: true });
    const kept = r.service.status(T, S).view;
    expect(kept?.blocks?.map((block) => block.at)).toEqual([shownAt ?? "", kept?.at ?? ""]);
    expect(kept?.choiceAt).toBe(shownAt);
    r.advance(5000);
    await r.service.keep(T, S, ["choice"]);
    expect(r.service.status(T, S).view?.choiceAt).toBe(r.service.status(T, S).view?.at);
    r.advance(5000);
    await r.service.keep(T, S, "all");
    const all = r.service.status(T, S).view;
    expect(all?.blocks?.every((block) => block.at === all.at)).toBe(true);
    expect(await r.service.keep(T, S, ["zz"])).toMatchObject({ ok: false, code: "bad_block" });
    await r.service.setChoice(T, S, null);
    expect(await r.service.keep(T, S, ["choice"])).toMatchObject({ ok: false, code: "bad_block" });
  });

  test("choice sets the decision block alone, with picked; --clear drops it; a bad one leaves the screen", async () => {
    const r = await rig();
    expect(await r.service.setChoice(T, S, { options: [{ label: "Yes" }] })).toMatchObject({ ok: false, code: "no_screen" });
    await r.service.show(T, S, { view: [para("x")], title: null });
    r.advance(1000);
    expect(await r.service.setChoice(T, S, { question: "Go on?", options: [{ label: "Yes" }, { label: "No" }], picked: 1 })).toMatchObject({ ok: true });
    const view = r.service.status(T, S).view;
    expect(view?.choice?.picked).toBe(1);
    expect(view?.choiceAt).toBe(view?.at);
    expect(await r.service.setChoice(T, S, { options: [] })).toMatchObject({ ok: false, code: "bad_choice" });
    expect(r.service.status(T, S).view?.choice?.picked).toBe(1);
    await r.service.setChoice(T, S, null);
    expect(r.service.status(T, S).view?.choice).toBeUndefined();
    expect(r.service.status(T, S).view?.choiceAt).toBeUndefined();
  });

  test("every block verb is refused view_off while the person's switch is off, and nothing is stored", async () => {
    const store = new AgentViewStore(null, Date.now);
    const off = new AgentViewService({ ...BASE, store, crewMode: () => "solo" });
    expect(await off.set(T, S, { id: "a", node: para("x"), place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "view_off" });
    expect(await off.pending(T, S, { id: "a", label: "x", place: { kind: "end" } })).toMatchObject({ ok: false, code: "view_off" });
    expect(await off.remove(T, S, "a")).toMatchObject({ ok: false, code: "view_off" });
    expect(await off.keep(T, S, "all")).toMatchObject({ ok: false, code: "view_off" });
    expect(await off.setChoice(T, S, null)).toMatchObject({ ok: false, code: "view_off" });
    expect(store.all()).toEqual([]);
  });

  test("every block verb is refused with the gate's code while the trick is shut", async () => {
    const shut = new AgentViewService({
      ...BASE,
      store: new AgentViewStore(null, Date.now),
      crewMode: () => "solo",
      gate: { check: () => ({ ok: false, code: "trick_off", error: "off" }), fresh: async () => ({ ok: false, code: "trick_off", error: "off" }) },
    });
    expect(await shut.set(T, S, { id: "a", node: para("x"), place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "trick_off" });
    expect(await shut.keep(T, S, "all")).toMatchObject({ ok: false, code: "trick_off" });
  });

  test("a crew member refuses every block verb", async () => {
    const r = await rig();
    const peer = new AgentViewService({ ...BASE, store: new AgentViewStore(null, Date.now), crewMode: () => "peer", binary: "/x" });
    expect(await peer.set(T, S, { id: "a", node: para("x"), place: { kind: "end" }, images: [] })).toMatchObject({ code: "not_on_lead" });
    expect(await peer.pending(T, S, { id: "a", label: "x", place: { kind: "end" } })).toMatchObject({ code: "not_on_lead" });
    expect(await peer.remove(T, S, "a")).toMatchObject({ code: "not_on_lead" });
    expect(await peer.keep(T, S, "all")).toMatchObject({ code: "not_on_lead" });
    expect(await peer.setChoice(T, S, null)).toMatchObject({ code: "not_on_lead" });
    expect(r.service.status(T, S).view).toBeUndefined();
  });

  test("the stored screen still passes the phone's reader, blocks and all", async () => {
    const r = await rig();
    await r.service.show(T, S, { view: [{ id: "a", ...para("x") }], title: null });
    await r.service.pending(T, S, { id: "p", label: "Later", place: { kind: "first" } });
    const stored = JSON.parse(JSON.stringify(r.service.status(T, S).view));
    const read = readViewScreen(stored);
    expect(read?.blocks).toEqual(stored.blocks);
    expect(parseAgentView(JSON.parse(JSON.stringify(read?.view))).refusals).toEqual([]);
  });
});

describe("the notes of a drawing run", () => {
  test("each start adds its note with its time; a show ends the run; the list holds the newest eight", async () => {
    const r = await rig();
    await r.service.start(T, S, { note: "Reading" });
    r.advance(1000);
    await r.service.start(T, S, { note: "Testing" });
    r.advance(1000);
    await r.service.start(T, S, { note: null });
    const drawing = r.service.status(T, S).drawing;
    expect(drawing?.notes?.map((n) => n.note)).toEqual(["Reading", "Testing"]);
    expect(drawing?.note).toBeUndefined();
    for (let i = 0; i < VIEW_NOTES_MAX + 2; i += 1) await r.service.start(T, S, { note: `Step ${String(i)}` });
    expect(r.service.status(T, S).drawing?.notes).toHaveLength(VIEW_NOTES_MAX);
    expect(r.service.status(T, S).drawing?.notes?.at(-1)?.note).toBe(`Step ${String(VIEW_NOTES_MAX + 1)}`);
    await r.service.show(T, S, { view: [para("x")], title: null });
    await r.service.start(T, S, { note: "Again" });
    expect(r.service.status(T, S).drawing?.notes?.map((n) => n.note)).toEqual(["Again"]);
  });
});
