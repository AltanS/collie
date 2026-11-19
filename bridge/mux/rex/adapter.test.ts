import { describe, expect, test } from "bun:test";

import { RexMux } from "./adapter.ts";
import type { MuxGridRequest } from "../types.ts";
import type { RexExec, RexRunResult, RexStreamClient, RexStreamHandlers } from "./exec.ts";
import { FakeRex } from "./fixture.ts";

/** The fake server, with every argv the adapter sent written down. */
class RecordingRex implements RexExec {
  readonly calls: string[][] = [];
  constructor(private readonly inner: FakeRex) {}
  run(args: readonly string[], stdin?: string): Promise<RexRunResult> {
    this.calls.push([...args]);
    return this.inner.run(args, stdin);
  }
  events(handlers: RexStreamHandlers): RexStreamClient {
    return this.inner.events(handlers);
  }
}

function world() {
  const rex = new RecordingRex(new FakeRex());
  return { adapter: new RexMux(rex), rex };
}

describe("a name that starts with a dash is a name, never a rex option", () => {
  // Probed on rex 0.0.1795116584 (API revision 19): `rex new --keep-open` made a session with a random
  // name and a block that stays open, and `rex new -h` printed help and exited 0.
  test("a new space keeps a label like --keep-open, and the create never carries it", async () => {
    const { adapter, rex } = world();
    const made = await adapter.createSpace({ label: "--keep-open", cwd: "/home/rex" });
    expect(made.ok).toBe(true);
    const snapshot = await adapter.snapshot();
    expect(snapshot.spaces.some((space) => space.label === "--keep-open")).toBe(true);
    const create = rex.calls.find((argv) => argv[0] === "new");
    expect(create).not.toContain("--keep-open");
    expect(rex.calls).toContainEqual(expect.arrayContaining(["session", "rename", "--", "--keep-open"]));
  });

  test("a new tab keeps a label like -h", async () => {
    const { adapter, rex } = world();
    const space = (await adapter.snapshot()).spaces[0]!;
    const made = await adapter.createTab({ spaceId: space.spaceId, label: "-h" });
    expect(made.ok).toBe(true);
    const snapshot = await adapter.snapshot();
    expect(snapshot.tabs.some((tab) => tab.label === "-h")).toBe(true);
    const create = rex.calls.find((argv) => argv[0] === "window" && argv[1] === "new");
    expect(create).not.toContain("-h");
  });

  test("a plain label still rides the create itself, with no rename after it", async () => {
    const { adapter, rex } = world();
    await adapter.createSpace({ label: "work two", cwd: "/home/rex" });
    expect(rex.calls.find((argv) => argv[0] === "new")).toContain("work two");
    expect(rex.calls.some((argv) => argv[0] === "session" && argv[1] === "rename")).toBe(false);
  });

  test("a rename, a close and a focus put `--` before the id and the label", async () => {
    const { adapter, rex } = world();
    const before = await adapter.snapshot();
    const tab = before.tabs[0]!;
    const pane = before.panes[0]!;
    expect((await adapter.renameTab(tab.tabId, "--help")).ok).toBe(true);
    expect((await adapter.snapshot()).tabs.find((t) => t.tabId === tab.tabId)?.label).toBe("--help");
    expect((await adapter.setFocus(pane.paneId)).ok).toBe(true);
    expect((await adapter.closePane(pane.paneId)).ok).toBe(true);
    const other = (await adapter.snapshot()).tabs.find((t) => t.tabId !== tab.tabId)!;
    expect((await adapter.closeTab(other.tabId)).ok).toBe(true);

    const positional = (argv: readonly string[], name: string): boolean => argv.indexOf("--") >= 0 && argv.indexOf("--") < argv.indexOf(name);
    expect(rex.calls.filter((argv) => argv[0] === "window" && argv[1] === "rename").every((argv) => positional(argv, tab.tabId))).toBe(true);
    expect(rex.calls.filter((argv) => argv[0] === "focus").every((argv) => positional(argv, pane.paneId))).toBe(true);
    expect(rex.calls.filter((argv) => argv[0] === "block" && argv[1] === "close").every((argv) => positional(argv, pane.paneId))).toBe(true);
    expect(rex.calls.filter((argv) => argv[0] === "window" && argv[1] === "close").every((argv) => positional(argv, other.tabId))).toBe(true);
  });
});

describe("an id rex did not hand out is gone before any rex call", () => {
  // Rex reads a target as a full id, then a label, then a one-based position, then an id suffix, so
  // `shell` or `1` would name whichever block carries that label or sits in that place.
  const VIEWPORT: MuxGridRequest = { scope: "viewport", lines: 50, styling: "preserve" };
  const paneIds = ["shell", "1", "bdbcf4", "window:01a1f140-f804-7d10-b29f-000000000101", "block:not-a-uuid"];

  test.each(paneIds)("a pane id %p", async (id) => {
    const { adapter, rex } = world();
    const answers = [
      await adapter.readGrid(id, VIEWPORT),
      await adapter.readLogicalText(id, 50),
      await adapter.typeText(id, "hi"),
      await adapter.writeKeys(id, ["Enter"]),
      await adapter.closePane(id),
      await adapter.setFocus(id),
    ];
    for (const answer of answers) expect(answer).toMatchObject({ ok: false, reason: "gone" });
    expect(rex.calls).toEqual([]);
  });

  test.each(["1", "work", "block:01a1f140-f804-7d10-b29f-000000000101"])("a tab id %p", async (id) => {
    const { adapter, rex } = world();
    expect(await adapter.renameTab(id, "new name")).toMatchObject({ ok: false, reason: "gone" });
    expect(await adapter.closeTab(id)).toMatchObject({ ok: false, reason: "gone" });
    expect(rex.calls).toEqual([]);
  });

  test.each(["1", "work"])("a space id %p for a new tab", async (id) => {
    const { adapter, rex } = world();
    expect(await adapter.createTab({ spaceId: id })).toMatchObject({ ok: false, reason: "gone" });
    expect(rex.calls).toEqual([]);
  });

  test("an id rex handed out still reaches rex", async () => {
    const { adapter, rex } = world();
    const pane = (await adapter.snapshot()).panes[0]!;
    const before = rex.calls.length;
    expect((await adapter.readGrid(pane.paneId, VIEWPORT)).ok).toBe(true);
    expect(rex.calls.length).toBeGreaterThan(before);
  });
});

describe("Focus in rex with no Rex app on the session", () => {
  test("is refused with the reason, and rex is never asked to focus", async () => {
    const { adapter, rex } = world();
    const snapshot = await adapter.snapshot();
    const notes = snapshot.spaces.find((space) => space.label === "notes")!;
    const pane = snapshot.panes.find((p) => p.spaceId === notes.spaceId)!;
    const answer = await adapter.setFocus(pane.paneId);
    expect(answer).toEqual({ ok: false, reason: "refused", detail: "no Rex app shows this session, so there is no screen to move" });
    expect(rex.calls.some((argv) => argv[0] === "focus")).toBe(false);
  });

  test("moves the screen where an app shows the session", async () => {
    const { adapter, rex } = world();
    const snapshot = await adapter.snapshot();
    const work = snapshot.spaces.find((space) => space.label === "work")!;
    const pane = snapshot.panes.find((p) => p.spaceId === work.spaceId && !p.focused)!;
    expect((await adapter.setFocus(pane.paneId)).ok).toBe(true);
    expect(rex.calls).toContainEqual(["focus", "--", pane.paneId]);
    expect((await adapter.snapshot()).panes.find((p) => p.paneId === pane.paneId)?.focused).toBe(true);
  });

  test("a pane rex no longer lists is gone", async () => {
    const { adapter } = world();
    expect(await adapter.setFocus("block:01a1f140-f804-7d10-b29f-00000000ffff")).toMatchObject({ ok: false, reason: "gone" });
  });
});
