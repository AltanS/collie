// pi-source.ts over the fake World (M66 spec 03): panes from the open runs, items from the mapper over the reader's
// entries plus the live partial, the state, the turn rule and the pane rev.
import { describe, expect, test } from "bun:test";
import { busyOf, itemsOf, paneIdOfRun, piSource, runOfPaneId, turnIdOf } from "../../../packages/durable-sdk/src/durable-harness/pi-source.ts";
import { assistantEntry, FakeWorld, livePartial, task, toolResultEntry, userEntry } from "./fake-world.ts";

describe("the pane id", () => {
  test("conv-<run id>, and back", () => {
    expect(paneIdOfRun("wrun_01ABC")).toBe("conv-wrun_01ABC");
    expect(runOfPaneId("conv-wrun_01ABC")).toBe("wrun_01ABC");
    expect(runOfPaneId("conv-12")).toBeUndefined();
    expect(runOfPaneId("p1")).toBeUndefined();
  });
});

describe("items", () => {
  test("the mapper's items over the entries: the user's text, the reply, the tool call with its result", () => {
    const entries = [userEntry(1, "refund order 5521"), assistantEntry(3, "I will refund it.", { id: "call-1", name: "refund", args: { order: "5521" } }), toolResultEntry(5, "call-1", "refund", "refunded")];
    const items = itemsOf({ sessionId: "s", eventCount: 6, unfinished: false, entries, live: {}, tasks: [] }, true);
    expect(items.map((i) => [i.kind, "text" in i ? i.text : i.kind === "tool" ? `${i.tool.name}:${i.status}` : ""])).toEqual([
      ["user", "refund order 5521"],
      ["reply", "I will refund it."],
      ["tool", "refund:done"],
    ]);
  });

  test("the live partial is the growing reply, with partial: true and the id its finished entry will have", () => {
    const live = livePartial("Half a rep");
    const view = { sessionId: "s", eventCount: 3, unfinished: true, entries: [userEntry(1, "hi")], live, tasks: [task("t1", 2)] };
    const items = itemsOf(view, true);
    expect(items.at(-1)).toMatchObject({ kind: "reply", text: "Half a rep", partial: true });
    const finished = itemsOf({ ...view, live: {}, entries: [...view.entries, { ...assistantEntry(3, "Half a reply."), model: [{ ...live.generation.message, content: [{ type: "text", text: "Half a reply." }], stopReason: "stop" }] }] }, true);
    expect(finished.at(-1)).toMatchObject({ id: items.at(-1)!.id, kind: "reply", text: "Half a reply." });
    expect(finished.at(-1)).not.toHaveProperty("partial");
    expect(itemsOf(view, false).some((i) => i.kind === "reply")).toBe(false);
  });
});

describe("state and turn", () => {
  const base = { sessionId: "wrun_01X", eventCount: 9, entries: [userEntry(1, "one"), assistantEntry(3, "r1"), userEntry(5, "two")], tasks: [task("t1", 2, "terminal"), task("t2", 6)] };

  test("working while a task is not terminal or a run is live; idle otherwise", () => {
    expect(busyOf({ ...base, unfinished: true, live: {} })).toBe(true);
    expect(busyOf({ ...base, unfinished: false, live: { run: {} } })).toBe(true);
    expect(busyOf({ ...base, unfinished: false, live: {} })).toBe(false);
  });

  test("the turn is the user entry before the oldest live task; idle, the newest user entry; the same on every read", () => {
    const busy = turnIdOf({ ...base, unfinished: true, live: { run: {} } });
    const idle = turnIdOf({ ...base, unfinished: false, live: {}, tasks: [task("t1", 2, "terminal"), task("t2", 6, "terminal")] });
    expect(busy).toBe(idle); // both name slot 5
    const followUp = { ...base, entries: [...base.entries, userEntry(8, "three")], unfinished: true, live: { run: {} } };
    expect(turnIdOf(followUp)).toBe(busy); // a follow-up queued during task t2 is not the running turn
    expect(turnIdOf({ ...followUp, unfinished: false, live: {}, tasks: [] })).not.toBe(busy);
    expect(turnIdOf({ ...base, sessionId: "wrun_01Y", unfinished: false, live: {} })).not.toBe(idle);
  });
});

describe("the source", () => {
  test("layout: one workspace, one tab, a pane per open run, titled by its first message; the run count in rev", async () => {
    const w = new FakeWorld();
    const open = w.addRun({ session: { eventCount: 4, entries: [userEntry(1, "refund 5521"), assistantEntry(3, "ok")] } });
    w.addRun({ status: "completed", session: { eventCount: 2, entries: [userEntry(1, "old")] } });
    const empty = w.addRun({ session: { eventCount: 0 } });
    const layout = await piSource({ port: w.port() }).layout();
    expect(layout.workspaces).toEqual([{ id: "pi-durable", title: "pi-durable" }]);
    expect(layout.panes.map((p) => [p.id, p.title, p.state, p.rev])).toEqual([
      [paneIdOfRun(open), "refund 5521", "idle", 4],
      [paneIdOfRun(empty), `Session ${empty.slice(-6)}`, "idle", 0],
    ]);
    expect(layout.rev).toBe(2 ** 32 + 3); // one finished run, three runs
  });

  test("pane: an open run of this program; a closed run, another program's run or another id is no pane", async () => {
    const w = new FakeWorld();
    const open = w.addRun({ session: { eventCount: 2, entries: [userEntry(1, "hi")] } });
    const done = w.addRun({ status: "completed" });
    const other = w.addRun({ name: "other" });
    const source = piSource({ port: w.port() });
    expect((await source.pane(paneIdOfRun(open), true))?.items?.map((i) => i.kind)).toEqual(["user"]);
    expect(await source.pane(paneIdOfRun(done), true)).toBeUndefined();
    expect(await source.pane(paneIdOfRun(other), true)).toBeUndefined();
    expect(await source.pane("p1", true)).toBeUndefined();
  });

  test("history: every run newest first, open and closed, paged; items of one, paged", async () => {
    const w = new FakeWorld();
    const a = w.addRun({ status: "completed", session: { entries: [userEntry(1, "a"), assistantEntry(3, "ra")] } });
    const b = w.addRun({ session: { entries: [userEntry(1, "b")] } });
    const history = piSource({ port: w.port() }).history!;
    const first = await history.list(undefined, 1);
    expect(first.items.map((r) => [r.id, r.title, r.state, r.items])).toEqual([[paneIdOfRun(b), "b", "open", 1]]);
    const second = await history.list(first.next, 1);
    expect(second.items.map((r) => [r.id, r.state])).toEqual([[paneIdOfRun(a), "closed"]]);
    expect(second.next).toBeUndefined();
    const items = await history.items(paneIdOfRun(a), undefined, 1);
    expect(items?.items.map((i) => i.kind)).toEqual(["user"]);
    expect((await history.items(paneIdOfRun(a), items?.next, 10))?.items.map((i) => i.kind)).toEqual(["reply"]);
    expect(await history.items("conv-wrun_01NONE", undefined, 10)).toBeUndefined();
  });
});
