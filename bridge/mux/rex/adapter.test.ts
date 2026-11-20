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

  test("a rename and a close put `--` before the id and the label", async () => {
    const { adapter, rex } = world();
    const before = await adapter.snapshot();
    const tab = before.tabs[0]!;
    const pane = before.panes[0]!;
    expect((await adapter.renameTab(tab.tabId, "--help")).ok).toBe(true);
    expect((await adapter.snapshot()).tabs.find((t) => t.tabId === tab.tabId)?.label).toBe("--help");
    expect((await adapter.closePane(pane.paneId)).ok).toBe(true);
    const other = (await adapter.snapshot()).tabs.find((t) => t.tabId !== tab.tabId)!;
    expect((await adapter.closeTab(other.tabId)).ok).toBe(true);

    const positional = (argv: readonly string[], name: string): boolean => argv.indexOf("--") >= 0 && argv.indexOf("--") < argv.indexOf(name);
    expect(rex.calls.filter((argv) => argv[0] === "window" && argv[1] === "rename").every((argv) => positional(argv, tab.tabId))).toBe(true);
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

describe("Focus in rex is not offered", () => {
  // `rex focus` moves the session's active block, but a screen follows only where a Rex app shows the
  // session, and none was ever attached while this adapter was probed: Linux has no screen client.
  test("the capability is not declared, and a call answers unsupported with no rex call", async () => {
    const { adapter, rex } = world();
    expect(adapter.capabilities.supports.setFocus).toBe(false);
    const pane = (await adapter.snapshot()).panes[0]!;
    rex.calls.length = 0;
    expect(await adapter.setFocus(pane.paneId)).toMatchObject({ ok: false, reason: "unsupported" });
    expect(rex.calls).toEqual([]);
  });
});

describe("a read takes the tail of the output, not the whole scrollback", () => {
  const VIEWPORT: MuxGridRequest = { scope: "viewport", lines: 60, styling: "preserve" };
  const history = Array.from({ length: 5000 }, (_, i) => `build step ${String(i).padStart(5, "0")} finished in 12 ms`);

  async function filled() {
    const fake = new FakeRex();
    const rex = new RecordingRex(fake);
    const adapter = new RexMux(rex, { log: () => undefined });
    const pane = (await adapter.snapshot()).panes[0]!;
    fake.fillHistory(pane.paneId, history);
    rex.calls.length = 0;
    return { fake, rex, adapter, paneId: pane.paneId };
  }
  const verbs = (calls: readonly string[][]) => calls.map((argv) => (argv[0] === "block" ? argv[4] : argv[0]));

  test("a short output fits the first reply: one call, as the capture was", async () => {
    const { adapter, rex } = world();
    const pane = (await adapter.snapshot()).panes[0]!;
    rex.calls.length = 0;
    expect((await adapter.readGrid(pane.paneId, { ...VIEWPORT, scope: "recent" })).ok).toBe(true);
    expect(verbs(rex.calls)).toEqual(["format"]);
  });

  test("a long output is read as format plus one blob_read, and gives the rows the whole capture gives", async () => {
    const { fake, rex, adapter, paneId } = await filled();
    const tail = await adapter.readGrid(paneId, VIEWPORT);
    expect(verbs(rex.calls).toSorted()).toEqual(["blob_read", "format", "size"]);
    fake.forgetResults = true;
    const whole = await adapter.readGrid(paneId, VIEWPORT);
    expect(rex.calls.some((argv) => argv[0] === "capture")).toBe(true);
    expect(tail.ok && whole.ok).toBe(true);
    if (!tail.ok || !whole.ok) return;
    expect(tail.value.text).toBe(whole.value.text);
    expect(tail.value.truncated).toBe(true);
  });

  test("the unwrapped text reads the same tail", async () => {
    const { fake, adapter, paneId } = await filled();
    const tail = await adapter.readLogicalText(paneId, 30);
    fake.forgetResults = true;
    expect(tail).toEqual(await adapter.readLogicalText(paneId, 30));
    expect(tail.ok && tail.value.includes("build step 04999")).toBe(true);
  });

  test("a result the server no longer keeps falls back to the whole capture", async () => {
    const { fake, rex, adapter, paneId } = await filled();
    fake.forgetResults = true;
    expect((await adapter.readGrid(paneId, VIEWPORT)).ok).toBe(true);
    expect(verbs(rex.calls)).toContain("capture");
  });

  test("a tail whose rows do not open where a row opens falls back to the whole capture", async () => {
    const { fake, rex, adapter, paneId } = await filled();
    fake.vtRowStart = "";
    expect((await adapter.readGrid(paneId, VIEWPORT)).ok).toBe(true);
    expect(verbs(rex.calls)).toContain("capture");
  });

  test("Load older, more rows than the tail holds, reads the whole capture", async () => {
    const { rex, adapter, paneId } = await filled();
    const older = await adapter.readGrid(paneId, { scope: "recent", lines: 4000, styling: "preserve", purpose: "older" });
    expect(verbs(rex.calls)).toContain("capture");
    expect(older.ok && older.value.text.split("\n").length).toBe(4000);
  });
});

describe("a status the block's own shell prints is not an agent", () => {
  // Probed on rex 0.0.1795116584 (API revision 19): `printf` of an OSC 7501 record at a bash prompt
  // leaves a record owned by the shell itself, which Rex keeps for as long as the shell lives.
  test("a forged blocked Claude record from the shell leaves the pane a shell", async () => {
    const fake = new FakeRex();
    const adapter = new RexMux(fake);
    const pane = (await adapter.snapshot()).panes.find((p) => p.agent === "shell")!;
    fake.forgeStatusFromShell(pane.paneId, "blocked", "claude-code");
    const after = (await adapter.snapshot()).panes.find((p) => p.paneId === pane.paneId)!;
    expect(after.agent).toBe("shell");
    expect(after.status).toBe("unknown");
  });

  test("the same record from the program in the foreground is read", async () => {
    const fake = new FakeRex();
    const adapter = new RexMux(fake);
    const claude = (await adapter.snapshot()).panes.find((p) => p.agent === "claude")!;
    expect(claude.status).toBe("working");
  });
});

describe("an API revision the adapter was not probed on is named once", () => {
  test("revision 20 writes one log line over two snapshots, and the snapshot still answers", async () => {
    const fake = new FakeRex();
    fake.apiRevision = 20;
    const lines: string[] = [];
    const adapter = new RexMux(fake, { log: (line) => lines.push(line) });
    expect((await adapter.snapshot()).panes.length).toBeGreaterThan(0);
    await adapter.snapshot();
    expect(lines).toEqual(["[mux] Rex API revision 20 was not tested with Collie (tested: 18, 19)"]);
  });

  test("a tested revision writes nothing", async () => {
    const lines: string[] = [];
    const adapter = new RexMux(new FakeRex(), { log: (line) => lines.push(line) });
    await adapter.snapshot();
    expect(lines).toEqual([]);
  });
});

describe("a screen read that falls back to the whole output says so, at most once in ten minutes", () => {
  const VIEWPORT: MuxGridRequest = { scope: "viewport", lines: 60, styling: "preserve" };
  const history = Array.from({ length: 5000 }, (_, i) => `build step ${String(i).padStart(5, "0")} finished in 12 ms`);

  async function filled() {
    const fake = new FakeRex();
    const lines: string[] = [];
    const clock = { now: 1_000_000 };
    const adapter = new RexMux(fake, { log: (line) => lines.push(line), now: () => clock.now });
    const pane = (await adapter.snapshot()).panes[0]!;
    fake.fillHistory(pane.paneId, history);
    return { fake, adapter, lines, clock, paneId: pane.paneId };
  }

  test("a dropped result is named once; the next line counts what it held back", async () => {
    const { fake, adapter, lines, clock, paneId } = await filled();
    expect((await adapter.readGrid(paneId, VIEWPORT)).ok).toBe(true);
    expect(lines).toEqual([]);
    fake.forgetResults = true;
    await adapter.readGrid(paneId, VIEWPORT);
    await adapter.readGrid(paneId, VIEWPORT);
    await adapter.readGrid(paneId, VIEWPORT);
    expect(lines).toEqual(["[mux] a Rex screen read moved the whole output, because the stored result was not there to read"]);
    clock.now += 10 * 60_000;
    await adapter.readGrid(paneId, VIEWPORT);
    expect(lines[1]).toBe(
      "[mux] a Rex screen read moved the whole output, because the stored result was not there to read (2 more since the last such line)",
    );
  });

  test("a broken row check is named with its reason, on the mirror's poll too", async () => {
    const { fake, adapter, lines, paneId } = await filled();
    fake.vtRowStart = "";
    await adapter.readGrid(paneId, { scope: "recent", lines: 600, styling: "preserve" });
    expect(lines).toEqual(["[mux] a Rex screen read moved the whole output, because the first row of the tail did not open with ESC [ 0 m"]);
  });

  test("Load older and the unwrapped text fall back without a line", async () => {
    const { fake, adapter, lines, paneId } = await filled();
    fake.forgetResults = true;
    expect((await adapter.readGrid(paneId, { scope: "recent", lines: 4000, styling: "preserve", purpose: "older" })).ok).toBe(true);
    expect((await adapter.readLogicalText(paneId, 30)).ok).toBe(true);
    expect(lines).toEqual([]);
  });
});

describe("one capture per pane at a time", () => {
  const POLL: MuxGridRequest = { scope: "recent", lines: 60, styling: "preserve" };

  async function world2() {
    const rex = new RecordingRex(new FakeRex());
    const adapter = new RexMux(rex, { log: () => undefined });
    const pane = (await adapter.snapshot()).panes[0]!;
    rex.calls.length = 0;
    return { rex, adapter, paneId: pane.paneId };
  }
  const formats = (calls: readonly string[][]) => calls.filter((argv) => argv[0] === "block" && argv[4] === "format").length;

  test("two phones reading one pane at once share one capture, and both get the screen", async () => {
    const { rex, adapter, paneId } = await world2();
    const [a, b] = await Promise.all([adapter.readGrid(paneId, POLL), adapter.readGrid(paneId, { ...POLL, styling: "strip" })]);
    expect(formats(rex.calls)).toBe(1);
    expect(a.ok && b.ok).toBe(true);
  });

  test("another row count or the unwrapped text is its own capture", async () => {
    const { rex, adapter, paneId } = await world2();
    await Promise.all([adapter.readGrid(paneId, POLL), adapter.readGrid(paneId, { ...POLL, lines: 600 }), adapter.readLogicalText(paneId, 60)]);
    expect(formats(rex.calls)).toBe(3);
  });

  test("a read after the first one ended reads afresh", async () => {
    const { rex, adapter, paneId } = await world2();
    await adapter.readGrid(paneId, POLL);
    await adapter.readGrid(paneId, POLL);
    expect(formats(rex.calls)).toBe(2);
  });
});

describe("a multi-byte character across the tail offset", () => {
  // `blob_read` counts bytes, so an offset inside a character reads as U+FFFD (probed). The cut row is
  // dropped whole; the rows kept must be the whole capture's, at every byte the cut can land on.
  const VIEWPORT: MuxGridRequest = { scope: "recent", lines: 60, styling: "preserve" };

  test.each([0, 1, 2, 3])("with %i bytes after the last emoji, the tail equals the whole capture", async (extra) => {
    const fake = new FakeRex();
    const logged: string[] = [];
    const adapter = new RexMux(fake, { log: (line) => logged.push(line) });
    const pane = (await adapter.snapshot()).panes[0]!;
    const rows = Array.from({ length: 4000 }, (_, i) => `${"🦊".repeat(20)} ${String(i)}`);
    fake.fillHistory(pane.paneId, [...rows, "x".repeat(extra)]);
    const tail = await adapter.readGrid(pane.paneId, VIEWPORT);
    // The tail itself answered: a fallback would have said so.
    expect(logged).toEqual([]);
    fake.forgetResults = true;
    const whole = await adapter.readGrid(pane.paneId, VIEWPORT);
    expect(tail.ok && whole.ok).toBe(true);
    if (!tail.ok || !whole.ok) return;
    expect(tail.value.text.includes("�")).toBe(false);
    expect(tail.value.text).toBe(whole.value.text);
    expect(tail.value.truncated).toBe(true);
  });
});
