import { describe, expect, test } from "bun:test";

import { declareCapabilities, MUX_CAPABILITIES, type MuxCapability, type MuxCapabilityDeclaration } from "./mux/capabilities.ts";
import { MUX_CONFORMANCE_FIXTURES } from "./mux/fixtures.ts";
import { muxAck, muxOk, type MuxAdapter, type MuxCreatedPane, type MuxRefusalOutcome } from "./mux/types.ts";
import { NO_GIT_NOTE, withWorktreeCapability, worktreeDeclaration } from "./worktree-capability.ts";

// `withWorktreeCapability` (M81 spec 02): `createWorktree` is lifted from `createSpace` plus git.
//
//   1. Lifted exactly when the adapter opens a space and git is found; never otherwise.
//   2. The adapter's declaration is copied, never mutated, and every other field is carried through.
//   3. An adapter that declares `createWorktree` itself is refused at construction.
//   4. Every method passes straight through.

const GIT = "/usr/bin/git";
const PANE: MuxCreatedPane = { paneId: "%1", spaceId: "s1", spaceLabel: "s1", tabId: "t1", cwd: "/tmp" };

function declaration(supports: readonly MuxCapability[], notes: Partial<Record<MuxCapability, string>> = {}): MuxCapabilityDeclaration {
  return declareCapabilities({
    supports,
    unsupportedKeys: ["PageUp"],
    notes,
    spaces: "many",
    topologyLatency: { kind: "push" },
  });
}

/** An adapter whose every method notes its name and arguments, and whose declaration a test may swap. */
function recordingAdapter(initial: MuxCapabilityDeclaration) {
  const calls: Array<[string, readonly unknown[]]> = [];
  let caps = initial;
  const note = (name: string, ...args: readonly unknown[]): void => {
    calls.push([name, args]);
  };
  const refusal: MuxRefusalOutcome = { ok: false, reason: "refused", detail: "stub" };
  const adapter: MuxAdapter = {
    mux: "stub",
    get capabilities() {
      return caps;
    },
    reachable: () => (note("reachable"), Promise.resolve(true)),
    snapshot: () => (note("snapshot"), Promise.resolve({ panes: [], spaces: [], tabs: [] })),
    refresh: () => (note("refresh"), Promise.resolve()),
    readGrid: (paneId, request) => (note("readGrid", paneId, request), Promise.resolve(refusal)),
    typeText: (paneId, text) => (note("typeText", paneId, text), Promise.resolve(muxAck())),
    writeKeys: (paneId, keys) => (note("writeKeys", paneId, keys), Promise.resolve(muxAck())),
    renamePane: (paneId, label) => (note("renamePane", paneId, label), Promise.resolve(muxAck())),
    closePane: (paneId) => (note("closePane", paneId), Promise.resolve(muxAck())),
    setFocus: (paneId) => (note("setFocus", paneId), Promise.resolve(muxAck())),
    createTab: (request) => (note("createTab", request), Promise.resolve(muxOk(PANE))),
    renameTab: (tabId, label) => (note("renameTab", tabId, label), Promise.resolve(muxAck())),
    closeTab: (tabId) => (note("closeTab", tabId), Promise.resolve(muxAck())),
    createSpace: (request) => (note("createSpace", request), Promise.resolve(muxOk(PANE))),
    listSessions: () => (note("listSessions"), Promise.resolve(muxOk([]))),
    watch: (options) => (note("watch", options), { close: () => {} }),
  };
  return {
    adapter,
    calls,
    swap: (next: MuxCapabilityDeclaration) => {
      caps = next;
    },
  };
}

describe("worktreeDeclaration", () => {
  test("createSpace and git: createWorktree is lifted, and the adapter's own worktree note goes", () => {
    const inner = declaration(["createSpace", "typeText"], { createWorktree: "Worktrees are not part of this adapter.", typeText: "kept" });
    const out = worktreeDeclaration(inner, GIT);
    expect(out.supports.createWorktree).toBe(true);
    expect(out.supports.createSpace).toBe(true);
    expect(out.supports.typeText).toBe(true);
    expect(out.notes).toEqual({ typeText: "kept" });
  });

  test("createSpace without git: not lifted, and the note says why", () => {
    const out = worktreeDeclaration(declaration(["createSpace"]), null);
    expect(out.supports.createWorktree).toBe(false);
    expect(out.notes.createWorktree).toBe(NO_GIT_NOTE);
  });

  test("no createSpace: never lifted, whatever git says, and the adapter's note stays", () => {
    const inner = declaration(["typeText"], { createWorktree: "one session only" });
    for (const git of [GIT, null]) {
      const out = worktreeDeclaration(inner, git);
      expect(out.supports.createWorktree).toBe(false);
      expect(out.notes.createWorktree).toBe("one session only");
    }
  });

  test("everything else is carried through, and the input is not mutated", () => {
    const inner = declaration(["createSpace", "sendKeys"], { createWorktree: "x" });
    const before = structuredClone(inner);
    const out = worktreeDeclaration({ ...inner, spaces: "one", topologyLatency: { kind: "bounded", ms: 500 } }, GIT);
    expect(inner).toEqual(before);
    expect(out.unsupportedKeys).toEqual(["PageUp"]);
    expect(out.spaces).toBe("one");
    expect(out.topologyLatency).toEqual({ kind: "bounded", ms: 500 });
    for (const capability of MUX_CAPABILITIES) {
      if (capability === "createWorktree") continue;
      expect({ capability, value: out.supports[capability] }).toEqual({ capability, value: inner.supports[capability] });
    }
  });
});

describe("withWorktreeCapability", () => {
  test("an adapter that declares createWorktree itself is refused", () => {
    const { adapter } = recordingAdapter(declaration(["createSpace", "createWorktree"]));
    expect(() => withWorktreeCapability(adapter, { git: GIT })).toThrow(/already declares createWorktree/);
  });

  test("the declaration follows the wrapped one when it changes, and is stable while it does not", () => {
    const { adapter, swap } = recordingAdapter(declaration(["typeText"]));
    const wrapped = withWorktreeCapability(adapter, { git: GIT });
    expect(wrapped.capabilities.supports.createWorktree).toBe(false);
    swap(declaration(["typeText", "createSpace"]));
    const lifted = wrapped.capabilities;
    expect(lifted.supports.createWorktree).toBe(true);
    expect(wrapped.capabilities).toBe(lifted);
    // The adapter's own declaration still says nothing about worktrees.
    expect(adapter.capabilities.supports.createWorktree).toBe(false);
  });

  test("every method passes through, with its arguments", async () => {
    const { adapter, calls } = recordingAdapter(declaration(["createSpace"]));
    const wrapped = withWorktreeCapability(adapter, { git: GIT });
    expect(wrapped.mux).toBe("stub");
    await wrapped.reachable();
    await wrapped.snapshot();
    await wrapped.refresh();
    await wrapped.readGrid("%1", { scope: "viewport", lines: 10, styling: "strip" });
    await wrapped.typeText("%1", "hi");
    await wrapped.writeKeys("%1", ["Enter"]);
    await wrapped.renamePane("%1", "p");
    await wrapped.closePane("%1");
    await wrapped.setFocus("%1");
    await wrapped.createTab({ spaceId: "s1" });
    await wrapped.renameTab("t1", "t");
    await wrapped.closeTab("t1");
    expect(await wrapped.createSpace({ cwd: "/w", label: "w" })).toEqual(muxOk(PANE));
    await wrapped.listSessions();
    wrapped.watch({ panes: [], onTopologyChange: () => {}, onPaneChange: () => {}, onUp: () => {}, onDown: () => {} });
    expect(calls.map(([name]) => name)).toEqual([
      "reachable",
      "snapshot",
      "refresh",
      "readGrid",
      "typeText",
      "writeKeys",
      "renamePane",
      "closePane",
      "setFocus",
      "createTab",
      "renameTab",
      "closeTab",
      "createSpace",
      "listSessions",
      "watch",
    ]);
    expect(calls.find(([name]) => name === "createSpace")?.[1]).toEqual([{ cwd: "/w", label: "w" }]);
  });

  test("an optional method the adapter lacks stays absent", () => {
    const { adapter } = recordingAdapter(declaration(["createSpace"]));
    const wrapped = withWorktreeCapability(adapter, { git: GIT });
    expect("readLogicalText" in wrapped).toBe(false);
    expect("logo" in wrapped).toBe(false);
  });
});

describe("every registered adapter, wrapped", () => {
  for (const fixture of MUX_CONFORMANCE_FIXTURES) {
    const name = fixture.variant === undefined ? fixture.mux : `${fixture.mux} (${fixture.variant})`;
    test(`${name}: declares no createWorktree itself, and gains createWorktree exactly when it opens a space`, async () => {
      const world = await fixture.create();
      const own = world.adapter.capabilities.supports;
      expect({ name, createWorktree: own.createWorktree }).toEqual({ name, createWorktree: false });
      const wrapped = withWorktreeCapability(world.adapter, { git: GIT });
      expect({ name, lifted: wrapped.capabilities.supports.createWorktree }).toEqual({ name, lifted: own.createSpace });
    });
  }
});
