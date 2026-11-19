import { describe, expect, test } from "bun:test";

import { RexMux } from "./adapter.ts";
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
