import { describe, expect, test } from "bun:test";
import { HerdrCoreMux, RAW_KEY_GAP_MS } from "./adapter.ts";
import { HcError, type RunShellRequest } from "./client.ts";
import { FakeHcCore, ManualClock } from "./fake-core.ts";
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

  test("omp sends no report, so its foreground process names the agent; a shell stays a shell; a report wins", async () => {
    const { fake, adapter } = build();
    const omp = fake.add({ status: null, foreground: { name: "omp", cwd: "/home/dev" } });
    const shell = fake.add({ status: null, foreground: { name: "zsh", cwd: "/home/dev" } });
    const reported = fake.add({ status: { state: "working", app: "claude-code", kind: "" }, foreground: { name: "omp", cwd: "/home/dev" } });
    const snapshot = await adapter.snapshot();
    const agentOf = (id: string) => snapshot.panes.find((p) => p.paneId === id)?.agent;
    expect(agentOf(omp)).toBe("omp");
    expect(agentOf(shell)).toBe("shell");
    expect(agentOf(reported)).toBe("claude");
  });

  test("a pane's cwd is absolute: the foreground's cwd when reported, else the terminal's, ~ as the bridge's home", async () => {
    // The core shortens the home folder to `~` (HC_API.md); a journal keyed on the folder needs it whole.
    const { fake, adapter } = build();
    const inForeground = fake.add({ status: null, cwd: "~", foreground: { name: "pi", cwd: "~/x" } });
    const startFolder = fake.add({ status: null, cwd: "~/start", foreground: { name: "bash", cwd: "" } });
    const home = fake.add({ status: null, cwd: "/srv", foreground: { name: "omp", cwd: "~" } });
    const absolute = fake.add({ status: null, cwd: "~", foreground: { name: "bash", cwd: "/tmp/lab" } });
    const unknown = fake.add({ status: null, cwd: "", foreground: { name: "bash", cwd: "" } });
    const relative = fake.add({ status: null, cwd: "", foreground: { name: "bash", cwd: "~other/x" } });
    const snapshot = await adapter.snapshot();
    const cwdOf = (id: string) => snapshot.panes.find((p) => p.paneId === id)?.cwd;
    expect(cwdOf(inForeground)).toBe("/home/dev/x");
    expect(cwdOf(startFolder)).toBe("/home/dev/start");
    expect(cwdOf(home)).toBe("/home/dev");
    expect(cwdOf(absolute)).toBe("/tmp/lab");
    expect(cwdOf(unknown)).toBe("");
    expect(cwdOf(relative)).toBe("");
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
    const sent = await adapter.writeKeys("t2", ["Up", "$", "Enter", "PageUp"]);
    expect(sent.ok).toBe(true);
    expect(fake.writes().map((w) => [w.kind, w.payload])).toEqual([
      ["keys", ["up"]],
      ["text", ["$"]],
      ["text", ["\r"]],
      ["keys", ["pageup"]],
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

  /** Record what `terminal.run` is asked for, and let the fake core answer as before. */
  function recordShells(fake: FakeHcCore): RunShellRequest[] {
    const asked: RunShellRequest[] = [];
    const run = fake.runShell.bind(fake);
    fake.runShell = (request) => {
      asked.push(request);
      return run(request);
    };
    return asked;
  }

  test("a new space starts one shell with fresh space and tab labels, and the next snapshot shows it", async () => {
    const { fake, adapter } = build();
    const asked = recordShells(fake);
    const before = await adapter.snapshot();
    const created = await adapter.createSpace({ cwd: "/home/dev/lab", label: "ignored" });
    if (!created.ok) throw new Error(created.detail);
    expect(asked).toHaveLength(1);
    const labels = asked[0]?.labels ?? {};
    const spaceLabel = labels["herdr.space"] ?? "";
    const tabLabel = labels["herdr.tab"] ?? "";
    expect(Object.keys(labels).toSorted()).toEqual(["herdr.space", "herdr.tab"]);
    expect(spaceLabel).toMatch(/^sp[0-9a-f]{32}$/u);
    expect(tabLabel).toMatch(/^tb[0-9a-f]{32}$/u);
    expect(before.spaces.map((space) => space.spaceId)).not.toContain(spaceLabel);
    expect(before.tabs.map((tab) => tab.tabId)).not.toContain(tabLabel);
    expect(asked[0]?.cwd).toBe("/home/dev/lab");
    expect(created.value.spaceId).toBe(spaceLabel);
    expect(created.value.tabId).toBe(tabLabel);
    expect(created.value.cwd).toBe("/home/dev/lab");

    const after = await adapter.snapshot();
    const space = after.spaces.find((candidate) => candidate.spaceId === created.value.spaceId);
    expect(space).toBeDefined();
    expect(space?.label).toBe(created.value.spaceLabel);
    expect(created.value.spaceLabel).toBe("lab");
    expect(after.spaces).toHaveLength(before.spaces.length + 1);
    const tabs = after.tabs.filter((tab) => tab.spaceId === created.value.spaceId);
    expect(tabs.map((tab) => tab.tabId)).toEqual([created.value.tabId]);
    const panes = after.panes.filter((pane) => pane.spaceId === created.value.spaceId);
    expect(panes.map((pane) => pane.paneId)).toEqual([created.value.paneId]);
  });

  test("two new spaces get different ids, and a blank cwd sends no cwd to the core", async () => {
    const { fake, adapter } = build();
    const asked = recordShells(fake);
    const first = await adapter.createSpace({ cwd: "" });
    const second = await adapter.createSpace({ cwd: "" });
    if (!first.ok || !second.ok) throw new Error("a create failed");
    expect(asked).toHaveLength(2);
    expect(asked.every((request) => request.cwd === undefined)).toBe(true);
    expect(first.value.spaceId).not.toBe(second.value.spaceId);
    expect(first.value.tabId).not.toBe(second.value.tabId);
  });

  test("a new space in the home folder is labelled as the snapshot labels it", async () => {
    const { adapter } = build();
    const created = await adapter.createSpace({ cwd: "/home/dev" });
    if (!created.ok) throw new Error(created.detail);
    const after = await adapter.snapshot();
    expect(after.spaces.find((space) => space.spaceId === created.value.spaceId)?.label).toBe(created.value.spaceLabel);
    expect(created.value.spaceLabel).toBe("~");
  });

  test("a core error on a new space is a refusal", async () => {
    const { fake, adapter } = build();
    fake.runShell = () => Promise.reject(new HcError("not_found", "herdr-core terminal.run: not_found: no such folder"));
    const gone = await adapter.createSpace({ cwd: "/nowhere" });
    expect(gone.ok ? "ok" : gone.reason).toBe("gone");
    fake.runShell = () => Promise.reject(new HcError("invalid_params", "herdr-core terminal.run: invalid_params: bad cwd"));
    const refused = await adapter.createSpace({ cwd: "/nowhere" });
    expect(refused.ok ? "ok" : refused.reason).toBe("refused");
  });

  test("screen reads honour preserve and strip without changing the pane", async () => {
    const { fake, adapter } = build();
    fake.setScreen("t1", ["\u001b[31mRed\u001b[0m"]);
    const styled = await adapter.readGrid("t1", { scope: "viewport", lines: 40, styling: "preserve" });
    const plain = await adapter.readGrid("t1", { scope: "recent", lines: 40, styling: "strip" });
    if (!styled.ok || !plain.ok) throw new Error("screen read failed");
    expect(styled.value.text).toContain("\u001b[31mRed\u001b[0m");
    expect(plain.value.text).toBe("Red\n\n\n\n\n");
    expect(fake.writes()).toEqual([]);
  });

  test("style-only changes advance once, while plain, styled and history reads share a revision", async () => {
    const { fake, adapter } = build();
    const read = async (styling: "preserve" | "strip", older = false) => {
      const result = await adapter.readGrid("t1", { scope: "recent", lines: 80, styling, purpose: older ? "older" : "poll" });
      if (!result.ok) throw new Error("screen read failed");
      return result.value.revision;
    };
    fake.setScreen("t1", ["\u001b[31mSame\u001b[0m"]);
    const initial = await read("preserve");
    expect(await read("strip")).toBe(initial);
    fake.setScreen("t1", ["\u001b[34mSame\u001b[0m"]);
    expect(await read("strip")).toBe(initial); // No style fact was observed yet.
    expect(await read("preserve")).toBe(initial + 1);
    expect(await read("strip")).toBe(initial + 1);
    expect(await read("preserve", true)).toBe(initial + 1);
    expect(await read("preserve")).toBe(initial + 1);
    fake.setScreen("t1", ["Same"]); // Removing the highlight is a style change too.
    expect(await read("preserve")).toBe(initial + 2);
    expect(await read("strip")).toBe(initial + 2);
    fake.setScreen("t1", ["Changed"]);
    expect(await read("strip")).toBe(initial + 3);
    expect(await read("preserve")).toBe(initial + 3);
  });

  test("the derived revision moves with one view's text and not across views", async () => {
    const { fake, adapter } = build();
    const viewport = () => adapter.readGrid("t1", { scope: "viewport", lines: 40, styling: "preserve" });
    const recent = () => adapter.readGrid("t1", { scope: "recent", lines: 200, styling: "preserve", purpose: "older" });
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

  test("one screen change gives every view the same revision: two line counts, a viewport read and a history read", async () => {
    const { fake, adapter } = build();
    const reads = async () => {
      const outcomes = await Promise.all([
        adapter.readGrid("t1", { scope: "recent", lines: 40, styling: "preserve" }),
        adapter.readGrid("t1", { scope: "recent", lines: 80, styling: "preserve" }),
        adapter.readGrid("t1", { scope: "viewport", lines: 40, styling: "preserve" }),
        adapter.readGrid("t1", { scope: "recent", lines: 600, styling: "preserve", purpose: "older" }),
      ]);
      return outcomes.map((outcome) => {
        if (!outcome.ok) throw new Error("a read failed");
        return outcome.value.revision;
      });
    };
    const first = await reads();
    const base = first[0] ?? 0;
    expect(first).toEqual([base, base, base, base]);
    expect(await reads()).toEqual([base, base, base, base]);
    fake.setScreen("t1", ["[✔] Apple", "[ ] Cherry"]);
    const after = await reads();
    expect(after).toEqual([base + 1, base + 1, base + 1, base + 1]);
  });

  test("each further screen change bumps the revision exactly once, whichever view reads first", async () => {
    const { fake, adapter } = build();
    const read = async (scope: "recent" | "viewport", lines: number) => {
      const outcome = await adapter.readGrid("t1", { scope, lines, styling: "preserve" });
      if (!outcome.ok) throw new Error("a read failed");
      return outcome.value.revision;
    };
    const start = await read("recent", 40);
    fake.setScreen("t1", ["one"]);
    expect(await read("recent", 80)).toBe(start + 1);
    expect(await read("recent", 40)).toBe(start + 1);
    fake.setScreen("t1", ["two"]);
    expect(await read("viewport", 40)).toBe(start + 2);
    expect(await read("recent", 80)).toBe(start + 2);
    expect(await read("recent", 40)).toBe(start + 2);
    expect(await read("viewport", 40)).toBe(start + 2);
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

describe("the raw key gap (RAW_KEY_GAP_MS)", () => {
  /** The adapter on a manual clock: a wait moves the clock and costs no real time. */
  function paced() {
    const fake = new FakeHcCore();
    const clock = new ManualClock();
    const waits: number[] = [];
    const adapter = new HerdrCoreMux(fake, "/home/dev", {
      clock: { now: () => clock.now(), wait: (ms) => (waits.push(ms), clock.wait(ms)) },
    });
    return { fake, adapter, clock, waits };
  }

  test("a raw Enter right after a text write waits until the floor has passed", async () => {
    const { adapter, clock, waits } = paced();
    clock.ms = 1000;
    await adapter.typeText("t2", "hello");
    const sent = await adapter.writeKeys("t2", ["Enter"]);
    expect(sent.ok).toBe(true);
    expect(waits).toEqual([RAW_KEY_GAP_MS]);
    expect(clock.now()).toBe(1000 + RAW_KEY_GAP_MS);
  });

  test("a raw Enter after the floor is not delayed, and a gap already partly spent waits only the rest", async () => {
    const { adapter, clock, waits } = paced();
    clock.ms = 1000;
    await adapter.typeText("t2", "hello");
    clock.ms += 200;
    await adapter.writeKeys("t2", ["Enter"]);
    expect(waits).toEqual([]);
    await adapter.typeText("t2", "x");
    clock.ms += 100;
    await adapter.writeKeys("t2", ["Backspace"]);
    expect(waits).toEqual([RAW_KEY_GAP_MS - 100]);
  });

  test("a run of ten raw Backspaces after one text write waits once, not ten times", async () => {
    const { fake, adapter, clock, waits } = paced();
    clock.ms = 1000;
    await adapter.typeText("t2", "beltdraft");
    const sent = await adapter.writeKeys("t2", Array.from({ length: 10 }, () => "Backspace"));
    expect(sent.ok).toBe(true);
    expect(waits).toEqual([RAW_KEY_GAP_MS]);
    expect(clock.now()).toBe(1000 + RAW_KEY_GAP_MS);
    expect(fake.writes().filter((w) => w.kind === "text" && w.payload[0] === "\x7f")).toHaveLength(10);
  });

  test("a raw key right after another raw key goes at once, and text after them arms the gap again", async () => {
    const { adapter, waits } = paced();
    await adapter.typeText("t2", "x");
    await adapter.writeKeys("t2", ["Backspace"]);
    await adapter.writeKeys("t2", ["Enter"]);
    await adapter.writeKeys("t2", ["Tab"]);
    expect(waits).toEqual([RAW_KEY_GAP_MS]);
    await adapter.typeText("t2", "y");
    await adapter.writeKeys("t2", ["Enter"]);
    expect(waits).toEqual([RAW_KEY_GAP_MS, RAW_KEY_GAP_MS]);
  });

  test("a pane that was never written to, and another pane's write, add no wait", async () => {
    const { adapter, waits } = paced();
    await adapter.writeKeys("t2", ["Enter"]);
    await adapter.typeText("t3", "x");
    expect(waits).toEqual([]);
    await adapter.writeKeys("t3", ["Enter"]);
    expect(waits).toEqual([RAW_KEY_GAP_MS]);
  });

  test("text and a raw key never share one write, and the order holds", async () => {
    const { fake, adapter } = paced();
    await adapter.typeText("t2", "hello");
    await adapter.writeKeys("t2", ["$", "Enter", "Backspace", "Tab"]);
    expect(fake.writes().map((w) => [w.kind, w.payload])).toEqual([
      ["text", ["hello"]],
      ["text", ["$"]],
      ["text", ["\r"]],
      ["text", ["\x7f"]],
      ["text", ["\t"]],
    ]);
  });

  test("a modified key goes by name and is not delayed", async () => {
    const { fake, adapter, waits } = paced();
    await adapter.typeText("t2", "hello");
    const sent = await adapter.writeKeys("t2", ["ctrl+c", "shift+Tab"]);
    expect(sent.ok).toBe(true);
    expect(waits).toEqual([]);
    expect(fake.writes().map((w) => [w.kind, w.payload])).toEqual([
      ["text", ["hello"]],
      ["keys", ["ctrl+c", "shift+tab"]],
    ]);
  });
});
