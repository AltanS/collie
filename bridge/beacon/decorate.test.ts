import { describe, expect, test } from "bun:test";

import { withAgentBeacons, type AgentBeaconDeps, type BeaconMatcher } from "./decorate.ts";
import { withAgentHints } from "./hint.ts";
import { fakeBeaconReader, FAKE_BEACON_NOW, type FakeBeacon } from "./fake.ts";
import { BEACON_SCHEMA_VERSION, type BeaconMarker, type BeaconStatus } from "./types.ts";
import { declareCapabilities, type MuxCapability } from "../mux/capabilities.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  type MuxAdapter,
  type MuxGridRequest,
  type MuxPane,
  type MuxSnapshot,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeScope,
} from "../mux/types.ts";

// THE DECORATOR'S OWN TESTS — the join, the two-way capability lift, and the pass-through.
//
// The pass-through is pinned method by method rather than by reading the source: a decorator that
// reimplements one verb is a fork of the adapter under it, and the failure would be invisible until
// the two drift.

const NAMESPACE = "fixture-mux";
const SCOPE = "/fixture/socket";

/** One pane, in the shape a blind adapter reports: a shell of unknown status, no session. */
function shellPane(paneId: string): MuxPane {
  return {
    paneId,
    spaceId: "space",
    spaceLabel: "space",
    spaceNumber: 1,
    tabId: "tab",
    cwd: "/tmp",
    focused: false,
    alive: true,
    agent: "shell",
    status: "unknown",
  };
}

/** One call the decorated adapter made, as the adapter underneath saw it. */
interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A blind adapter that records what reached it and answers something distinguishable. */
class StubAdapter implements MuxAdapter {
  readonly mux = "stub";
  /** The adapter's mark, when a case gives it one. Absent by default, like an adapter with none. */
  logo?: string;
  capabilities = declareCapabilities({
    supports: ["paneGrid", "typeText", "sendKeys"],
    notes: { agentDetection: "the adapter's own note", closePane: "untouched" },
    topologyLatency: { kind: "push" },
  });
  readonly calls: RecordedCall[] = [];
  panes: MuxPane[] = [shellPane("%1"), shellPane("%2")];
  readonly subscription: MuxSubscription = { close: () => undefined };

  private note(method: string, ...args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  reachable(): Promise<boolean> {
    this.note("reachable");
    return Promise.resolve(true);
  }

  refresh(): Promise<void> {
    this.note("refresh");
    return Promise.resolve();
  }

  snapshot(): Promise<MuxSnapshot> {
    this.note("snapshot");
    return Promise.resolve({ panes: this.panes, spaces: [], tabs: [] });
  }

  readGrid(paneId: string, request: MuxGridRequest) {
    this.note("readGrid", paneId, request);
    return Promise.resolve(muxOk({ paneId, text: "grid", truncated: false, revision: 7 }));
  }

  typeText(paneId: string, text: string) {
    this.note("typeText", paneId, text);
    return Promise.resolve(muxAck());
  }

  sendKeys(paneId: string, keys: readonly string[]) {
    this.note("sendKeys", paneId, keys);
    return Promise.resolve(muxAck());
  }

  renamePane(paneId: string, label: string | null) {
    this.note("renamePane", paneId, label);
    return Promise.resolve(muxAck());
  }

  closePane(paneId: string) {
    this.note("closePane", paneId);
    return Promise.resolve(muxGone("gone"));
  }

  setFocus(paneId: string) {
    this.note("setFocus", paneId);
    return Promise.resolve(muxAck());
  }

  createTab(request: MuxTabRequest) {
    this.note("createTab", request);
    return Promise.resolve(muxOk({ paneId: "%9", spaceId: "space", spaceLabel: "space", tabId: "tab", cwd: "/tmp" }));
  }

  renameTab(tabId: string, label: string) {
    this.note("renameTab", tabId, label);
    return Promise.resolve(muxAck());
  }

  closeTab(tabId: string) {
    this.note("closeTab", tabId);
    return Promise.resolve(muxAck());
  }

  createSpace(request: MuxSpaceRequest) {
    this.note("createSpace", request);
    return Promise.resolve(muxOk({ paneId: "%9", spaceId: "space", spaceLabel: "space", tabId: "tab", cwd: "/tmp" }));
  }

  listWorktrees(scope: MuxWorktreeScope) {
    this.note("listWorktrees", scope);
    return Promise.resolve(muxOk<readonly MuxWorktree[]>([]));
  }

  createWorktree(request: MuxWorktreeCreateRequest) {
    this.note("createWorktree", request);
    return Promise.resolve(muxOk({ paneId: "%9", spaceId: "space", spaceLabel: "space", tabId: "tab", cwd: "/tmp" }));
  }

  openWorktree(request: MuxWorktreeOpenRequest) {
    this.note("openWorktree", request);
    return Promise.resolve(muxOk({ pane: { paneId: "%9", spaceId: "space", spaceLabel: "space", tabId: "tab", cwd: "/tmp" }, alreadyOpen: false }));
  }


  watch(options: MuxWatchOptions): MuxSubscription {
    this.note("watch", options);
    return this.subscription;
  }
}

/** The matcher a fixture multiplexer would contribute: pane id equality inside one scope. */
function stubMatcher(scope: string | null = SCOPE): BeaconMatcher {
  return {
    namespace: NAMESPACE,
    scope: () => Promise.resolve(scope),
    matches: (pane, entry, resolved) => entry.scope === resolved && entry.pane === pane.paneId,
    notesWithoutHooks: {
      agentDetection: "install the hooks and a pane names itself",
      agentSessionRef: "install the hooks and the agent supplies its session",
    },
  };
}

function beacon(markers: readonly BeaconMarker[], status: BeaconStatus, pid: number, alive = true): FakeBeacon {
  return {
    record: {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: "claude",
      session: { kind: "id", value: `session-${String(pid)}` },
      status,
      pid,
      pidStartTime: 11,
      markers,
      heartbeatMs: FAKE_BEACON_NOW,
    },
    alive,
  };
}

function marker(pane: string, scope = SCOPE): BeaconMarker {
  return { namespace: NAMESPACE, scope, pane };
}

function deps(hooksInstalled: boolean, matcher: BeaconMatcher = stubMatcher()): AgentBeaconDeps {
  return { matcher, hooksInstalled: () => hooksInstalled };
}

/** The decorated adapter over one seeded beacon directory. */
function decorate(adapter: MuxAdapter, beacons: readonly FakeBeacon[], hooks = true, matcher = stubMatcher()): MuxAdapter {
  return withAgentBeacons(adapter, fakeBeaconReader(beacons), deps(hooks, matcher));
}

async function paneOf(adapter: MuxAdapter, paneId: string): Promise<MuxPane> {
  const found = (await adapter.snapshot()).panes.find((pane) => pane.paneId === paneId);
  if (found === undefined) throw new Error(`no pane ${paneId} in the snapshot`);
  return found;
}

describe("withAgentBeacons refuses an adapter that already sees", () => {
  test("an adapter declaring agentDetection is refused at construction", () => {
    const adapter = new StubAdapter();
    adapter.capabilities = declareCapabilities({ supports: ["agentDetection"], topologyLatency: { kind: "push" } });
    expect(() => decorate(adapter, [])).toThrow(/already declares agentDetection/u);
  });

  test("an adapter declaring agentSessionRef is refused at construction", () => {
    const adapter = new StubAdapter();
    adapter.capabilities = declareCapabilities({ supports: ["agentSessionRef"], topologyLatency: { kind: "push" } });
    expect(() => decorate(adapter, [])).toThrow(/already declares agentSessionRef/u);
  });
});

// THE FIELD THAT WENT MISSING, and the tripwire for the next one.
//
// `logo` was added to MuxAdapter and to all three adapters, and no live instance ever published it:
// index.ts wraps every adapter in a decorator, each decorator rebuilds the adapter as a literal
// naming every field, and an unnamed field simply ceases to exist. Nothing caught it, because every
// test in the tree that read a logo read it off a RAW adapter.
//
// So the data fields are gathered by one helper (bridge/mux/types.ts § muxDataFields) and the
// surface is asserted here, for BOTH decorators — `withAgentHints` included, even though it lives in
// hint.ts, because the failure is the shape they share and a guard in only one of them is half a
// guard.
describe("a decorator preserves the adapter's whole surface", () => {
  /**
   * Every field of the contract, at runtime.
   *
   * `satisfies Record<keyof Required<MuxAdapter>, true>` is the half that has teeth: adding a field
   * to {@link MuxAdapter} stops this FILE compiling until the field is named here, and naming it
   * here then fails the assertions below until both decorators carry it. `Required<…>` so an
   * OPTIONAL field is covered too — which is the only kind that has ever gone missing.
   */
  const MUX_ADAPTER_FIELDS = {
    mux: true,
    capabilities: true,
    logo: true,
    reachable: true,
    snapshot: true,
    refresh: true,
    readGrid: true,
    typeText: true,
    sendKeys: true,
    renamePane: true,
    closePane: true,
    setFocus: true,
    createTab: true,
    renameTab: true,
    closeTab: true,
    createSpace: true,
    listWorktrees: true,
    createWorktree: true,
    openWorktree: true,
    watch: true,
  } satisfies Record<keyof Required<MuxAdapter>, true>;

  const CONTRACT = Object.keys(MUX_ADAPTER_FIELDS).toSorted();

  /**
   * Which contract fields this object actually has.
   *
   * `in`, not `Object.keys`: a raw adapter is a class, so its methods live on the prototype and its
   * private state (`#client`, a revision map) is own state that no decorator should be expected to
   * reproduce. Asking the contract's own questions compares the two shapes on the only terms that
   * mean anything.
   */
  function surfaceOf(adapter: MuxAdapter): string[] {
    return CONTRACT.filter((field) => field in adapter);
  }

  /** A raw adapter carrying EVERY field, so a decorator dropping any one of them is visible. */
  function fullAdapter(): MuxAdapter {
    const stub = new StubAdapter();
    stub.logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>`;
    return stub;
  }

  test("the fixture itself is complete — otherwise the assertions below prove nothing", () => {
    // This is the test that fails FIRST when a field is added to the contract: name it above, and
    // this one demands the fixture carry it before anything gets to claim a decorator preserves it.
    expect(surfaceOf(fullAdapter())).toEqual(CONTRACT);
  });

  test("the beacon decorator hands on every field it was given", () => {
    expect(surfaceOf(decorate(fullAdapter(), []))).toEqual(CONTRACT);
  });

  test("the hint decorator hands on every field it was given", () => {
    expect(surfaceOf(withAgentHints(fullAdapter(), { hooksInstalled: () => false }))).toEqual(CONTRACT);
  });

  test("both decorators, stacked exactly as the bridge stacks them, still preserve it", () => {
    // index.ts wraps beacons first and hints outside them — the real chain, not one link of it.
    const raw = fullAdapter();
    const wrapped = withAgentHints(decorate(raw, []), { hooksInstalled: () => false });
    expect(surfaceOf(wrapped)).toEqual(CONTRACT);
    expect(wrapped.logo).toBe(raw.logo);
  });

  test("an adapter with no mark comes out with the KEY absent, through either decorator", () => {
    // Absent, not present-and-undefined: `"logo" in adapter` is the question `muxDataFields` keeps
    // answerable, and a decorator that assigned `logo: undefined` would answer it wrongly.
    expect("logo" in decorate(new StubAdapter(), [])).toBe(false);
    expect("logo" in withAgentHints(new StubAdapter(), { hooksInstalled: () => false })).toBe(false);
  });
});

describe("everything but capabilities and snapshot is a pass-through", () => {
  const request: MuxGridRequest = { scope: "viewport", lines: 20, styling: "strip" };
  const watchOptions: MuxWatchOptions = {
    panes: ["%1"],
    onTopologyChange: () => undefined,
    onPaneChange: () => undefined,
    onUp: () => undefined,
    onDown: () => undefined,
  };

  test("every method reaches the wrapped adapter with the arguments it was given", async () => {
    const adapter = new StubAdapter();
    const decorated = decorate(adapter, []);
    expect(decorated.mux).toBe(adapter.mux);
    expect(await decorated.reachable()).toBe(true);
    expect(await decorated.readGrid("%1", request)).toEqual(await adapter.readGrid("%1", request));
    await decorated.typeText("%1", "hello");
    await decorated.sendKeys("%1", ["ctrl+c"]);
    await decorated.renamePane("%1", null);
    await decorated.closePane("%1");
    await decorated.setFocus("%1");
    await decorated.createTab({ spaceId: "space" });
    await decorated.renameTab("tab", "label");
    await decorated.closeTab("tab");
    await decorated.createSpace({ cwd: "/tmp" });
    expect(decorated.watch(watchOptions)).toBe(adapter.subscription);

    const seen = adapter.calls.filter((call) => call.method !== "snapshot" && call.method !== "readGrid");
    expect(seen).toEqual([
      { method: "reachable", args: [] },
      { method: "typeText", args: ["%1", "hello"] },
      { method: "sendKeys", args: ["%1", ["ctrl+c"]] },
      { method: "renamePane", args: ["%1", null] },
      { method: "closePane", args: ["%1"] },
      { method: "setFocus", args: ["%1"] },
      { method: "createTab", args: [{ spaceId: "space" }] },
      { method: "renameTab", args: ["tab", "label"] },
      { method: "closeTab", args: ["tab"] },
      { method: "createSpace", args: [{ cwd: "/tmp" }] },
      { method: "watch", args: [watchOptions] },
    ]);
  });

  test("a beacon changing synthesises no event — watch is the wrapped adapter's, untouched", () => {
    const adapter = new StubAdapter();
    const decorated = decorate(adapter, [beacon([marker("%1")], "working", 1)]);
    expect(decorated.watch(watchOptions)).toBe(adapter.subscription);
    expect(decorated.capabilities.supports.pushPaneEvents).toBe(adapter.capabilities.supports.pushPaneEvents);
  });
});

describe("the capability lift is gated on the hooks, not on a beacon", () => {
  test("hooks installed lifts both capabilities and keeps every other answer", () => {
    const adapter = new StubAdapter();
    // No beacon at all: the declaration must not flicker with what happens to be on disk.
    const decorated = decorate(adapter, [], true);
    expect(decorated.capabilities.supports.agentDetection).toBe(true);
    expect(decorated.capabilities.supports.agentSessionRef).toBe(true);
    const inherited: readonly MuxCapability[] = ["paneGrid", "typeText", "sendKeys", "closePane", "createTab"];
    for (const capability of inherited) {
      expect(decorated.capabilities.supports[capability]).toBe(adapter.capabilities.supports[capability]);
    }
  });

  test("hooks absent leaves both absent and replaces the note with how to enable them", () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "working", 1)], false);
    expect(decorated.capabilities.supports.agentDetection).toBe(false);
    expect(decorated.capabilities.supports.agentSessionRef).toBe(false);
    expect(decorated.capabilities.notes.agentDetection).toBe("install the hooks and a pane names itself");
    expect(decorated.capabilities.notes.agentSessionRef).toBe("install the hooks and the agent supplies its session");
    // A note that has nothing to do with this decorator travels through untouched.
    expect(decorated.capabilities.notes.closePane).toBe("untouched");
  });

  test("hooks absent leaves the panes exactly as the blind adapter reported them", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "working", 1)], false);
    const pane = await paneOf(decorated, "%1");
    expect(pane.agent).toBe("shell");
    expect(pane.status).toBe("unknown");
    expect(pane.agentSession).toBeUndefined();
  });

  test("the declaration follows the seam, so installing the hooks needs no restart", () => {
    let installed = false;
    const decorated = withAgentBeacons(new StubAdapter(), fakeBeaconReader([]), {
      matcher: stubMatcher(),
      hooksInstalled: () => installed,
    });
    expect(decorated.capabilities.supports.agentDetection).toBe(false);
    installed = true;
    expect(decorated.capabilities.supports.agentDetection).toBe(true);
  });
});

describe("the beacon status map", () => {
  test("working reads as working", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "working", 1)]);
    expect((await paneOf(decorated, "%1")).status).toBe("working");
  });

  test("idle reads as idle", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "idle", 1)]);
    expect((await paneOf(decorated, "%1")).status).toBe("idle");
  });

  test("waiting reads as blocked — the top of triage", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "waiting", 1)]);
    expect((await paneOf(decorated, "%1")).status).toBe("blocked");
  });

  test("a live beacon names the agent and carries its session", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "working", 1)]);
    const pane = await paneOf(decorated, "%1");
    expect(pane.agent).toBe("claude");
    expect(pane.agentSession).toEqual({ kind: "id", value: "session-1" });
  });

  test("an expired beacon keeps its session but reads unknown — it can claim nothing since it died", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "working", 1, false)]);
    const pane = await paneOf(decorated, "%1");
    expect(pane.status).toBe("unknown");
    expect(pane.agent).toBe("claude");
    expect(pane.agentSession).toEqual({ kind: "id", value: "session-1" });
  });

  test("an absent beacon reads unknown and never idle", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%2")], "idle", 2)]);
    const pane = await paneOf(decorated, "%1");
    expect(pane.status).toBe("unknown");
    expect(pane.status).not.toBe("idle");
    expect(pane.agent).toBe("shell");
    expect(pane.agentSession).toBeUndefined();
  });

  test("an empty beacon directory leaves every pane unknown", async () => {
    const decorated = decorate(new StubAdapter(), []);
    for (const pane of (await decorated.snapshot()).panes) {
      expect(pane.status).toBe("unknown");
      expect(pane.agent).toBe("shell");
    }
  });
});

describe("no pane takes an identity it cannot prove", () => {
  test("a beacon from another scope is not this pane's, however well the id matches", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1", "/somebody/else")], "working", 1)]);
    expect((await paneOf(decorated, "%1")).agent).toBe("shell");
  });

  test("a beacon from another namespace is not read at all", async () => {
    const foreign: BeaconMarker = { namespace: "another-mux", scope: SCOPE, pane: "%1" };
    const decorated = decorate(new StubAdapter(), [beacon([foreign], "working", 1)]);
    expect((await paneOf(decorated, "%1")).agent).toBe("shell");
  });

  test("a nested emitter's own namespace still joins on the entry that is ours", async () => {
    const markers: BeaconMarker[] = [{ namespace: "another-mux", scope: "outer", pane: "0" }, marker("%1")];
    const decorated = decorate(new StubAdapter(), [beacon(markers, "working", 1)]);
    expect((await paneOf(decorated, "%1")).agent).toBe("claude");
  });

  test("two beacons claiming one pane are two answers to a one-answer question — neither is taken", async () => {
    const decorated = decorate(new StubAdapter(), [
      beacon([marker("%1")], "working", 1),
      beacon([marker("%1"), marker("%2")], "idle", 2),
    ]);
    expect((await paneOf(decorated, "%1")).agent).toBe("shell");
  });

  test("an unresolvable scope joins nothing rather than joining on the pane id alone", async () => {
    const decorated = decorate(new StubAdapter(), [beacon([marker("%1")], "working", 1)], true, stubMatcher(null));
    expect((await paneOf(decorated, "%1")).agent).toBe("shell");
  });

  test("a harness name that no registry could match is not put on a pane", async () => {
    const shouty = beacon([marker("%1")], "working", 1);
    const decorated = decorate(new StubAdapter(), [
      { ...shouty, record: { ...shouty.record, harness: "a name with spaces and a ../ in it" } },
    ]);
    expect((await paneOf(decorated, "%1")).agent).toBe("shell");
  });
});
