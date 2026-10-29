import { describe, expect, test } from "bun:test";
import { HerdrCoreMux } from "./adapter.ts";
import { FakeHcCore } from "./fake-core.ts";
import { IMPLICIT_SPACE_ID } from "./layout.ts";

/** One fake core and the adapter over it. */
interface Built {
  readonly fake: FakeHcCore;
  readonly adapter: HerdrCoreMux;
}

function build(): Built {
  const fake = new FakeHcCore();
  return { fake, adapter: new HerdrCoreMux(fake, "/home/dev") };
}

describe("HerdrCoreMux over a fake core", () => {
  test("the seeded snapshot: herdr-app's spaces, the implicit space, no remote pane", async () => {
    const { adapter } = build();
    const snapshot = await adapter.snapshot();
    expect(snapshot.panes.map((p) => [p.paneId, p.spaceLabel, p.agent, p.status])).toEqual([
      ["t1", "collie", "claude", "blocked"],
      ["t2", "collie", "shell", "unknown"],
      ["t3", "scratch", "shell", "unknown"],
      ["t4", IMPLICIT_SPACE_ID, "shell", "unknown"],
    ]);
  });

  test("a core at another generation is unreachable, and the snapshot says what to update", async () => {
    const { fake, adapter } = build();
    fake.generation = 2;
    expect(await adapter.reachable()).toBe(false);
    expect(adapter.snapshot()).rejects.toThrow(/generation 1/u);
  });

  test("every pane write to another machine's terminal answers gone and reaches nothing", async () => {
    const { fake, adapter } = build();
    for (const outcome of [
      await adapter.typeText("box/t1", "hi"),
      await adapter.writeKeys("box/t1", ["Enter"]),
      await adapter.closePane("box/t1"),
      await adapter.readGrid("box/t1", { scope: "viewport", lines: 10, styling: "preserve" }),
    ]) {
      expect(outcome.ok ? "ok" : outcome.reason).toBe("gone");
    }
    expect(fake.writes()).toHaveLength(0);
  });

  test("a key batch keeps its order across raw characters and key names", async () => {
    const { fake, adapter } = build();
    const sent = await adapter.writeKeys("t2", ["Up", "$", "Enter", "Enter"]);
    expect(sent.ok).toBe(true);
    expect(fake.writes().map((w) => [w.kind, w.payload])).toEqual([
      ["keys", ["up"]],
      ["text", ["$"]],
      ["keys", ["enter", "enter"]],
    ]);
  });

  test("a batch with one key the core cannot express sends nothing", async () => {
    const { fake, adapter } = build();
    const sent = await adapter.writeKeys("t2", ["Up", "ctrl+$"]);
    expect(sent.ok ? "ok" : sent.reason).toBe("refused");
    expect(fake.writes()).toHaveLength(0);
  });

  test("closing a pane that already ended answers gone", async () => {
    const { adapter } = build();
    expect((await adapter.closePane("t2")).ok).toBe(true);
    const again = await adapter.closePane("t2");
    expect(again.ok ? "ok" : again.reason).toBe("gone");
  });

  test("a new tab in a herdr-app space carries that space and a fresh tab id", async () => {
    const { adapter } = build();
    const created = await adapter.createTab({ spaceId: "spcollie" });
    if (!created.ok) throw new Error(created.detail);
    expect(created.value.tabId).toMatch(/^tb[0-9a-f]{32}$/u);
    const after = await adapter.snapshot();
    const pane = after.panes.find((p) => p.paneId === created.value.paneId);
    expect(pane?.spaceId).toBe("spcollie");
    expect(pane?.tabId).toBe(created.value.tabId);
  });

  test("a new tab in the implicit space joins its one tab, and an unknown space is gone", async () => {
    const { adapter } = build();
    const created = await adapter.createTab({ spaceId: IMPLICIT_SPACE_ID, cwd: "/tmp" });
    if (!created.ok) throw new Error(created.detail);
    expect(created.value.spaceId).toBe(IMPLICIT_SPACE_ID);
    expect(created.value.cwd).toBe("/tmp");
    const missing = await adapter.createTab({ spaceId: "spnothere" });
    expect(missing.ok ? "ok" : missing.reason).toBe("gone");
  });

  test("the derived revision moves with one view's text and not across views", async () => {
    const { fake, adapter } = build();
    const viewport = () => adapter.readGrid("t1", { scope: "viewport", lines: 40, styling: "preserve" });
    const recent = () => adapter.readGrid("t1", { scope: "recent", lines: 200, styling: "preserve" });
    const first = await viewport();
    const history = await recent();
    const second = await viewport();
    if (!first.ok || !history.ok || !second.ok) throw new Error("a read failed");
    expect(history.value.revision).toBe(first.value.revision);
    expect(second.value.revision).toBe(first.value.revision);
    expect(history.value.text.split("\n").length).toBeGreaterThan(first.value.text.split("\n").length);
    expect(first.value.text.includes("\u001b")).toBe(false);
    await fake.changePane("t1");
    const moved = await viewport();
    if (!moved.ok) throw new Error("a read failed");
    expect(moved.value.revision).toBe(first.value.revision + 1);
  });

  test("`missed` re-reads everything, and a status on a watched pane is a pane change", async () => {
    const { fake, adapter } = build();
    let topology = 0;
    const panes: string[] = [];
    let up = 0;
    const watch = adapter.watch({
      panes: ["t1"],
      onTopologyChange: () => (topology += 1),
      onPaneChange: (paneId) => panes.push(paneId),
      onUp: () => (up += 1),
      onDown: () => {},
    });
    await Promise.resolve();
    expect(up).toBe(1);
    fake.pokeMissed();
    expect(topology).toBe(1);
    fake.setStatus("t1", { state: "working", app: "claude-code", kind: "" });
    expect(panes).toEqual(["t1"]);
    fake.setStatus("t3", { state: "working", app: "codex", kind: "" });
    expect(topology).toBe(2);
    watch.close();
  });
});
