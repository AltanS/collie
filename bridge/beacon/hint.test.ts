import { describe, expect, test } from "bun:test";

import { AGENT_HINT, paneHint, withAgentHints, withPaneHint } from "./hint.ts";
import { declareCapabilities } from "../mux/capabilities.ts";
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
} from "../mux/types.ts";

// THE HINT'S OWN TESTS — the three suppression rules, and the promise that a hint changes nothing
// else about the pane it sits on.
//
// The last group is the load-bearing one: a hint that quietly set an agent name would pick a wrong
// harness grammar and a wrong journal adapter (bridge/mux/types.ts § MuxPane.agent), and the failure
// would show up as a pane that types into the wrong dialog rather than as a wrong sentence.

/** One pane as a blind adapter reports it: a shell of unknown standing. */
function shellPane(over: Partial<MuxPane> = {}): MuxPane {
  return {
    paneId: "%1",
    spaceId: "space",
    spaceLabel: "space",
    spaceNumber: 1,
    tabId: "tab",
    cwd: "/tmp",
    focused: false,
    alive: true,
    agent: "shell",
    status: "unknown",
    ...over,
  };
}

/** The world in which a hint is the right answer: a blind adapter on a host with no emitter. */
const BLIND = { agentDetection: false, hooksInstalled: false } as const;

describe("paneHint — when a pane earns a sentence", () => {
  test("a foreground command naming a harness this build knows gets the sentence", () => {
    expect(paneHint(shellPane({ foregroundCommand: "claude" }), BLIND)).toBe(AGENT_HINT);
  });

  test("a full argv is matched on its base name, case-insensitively", () => {
    expect(paneHint(shellPane({ foregroundCommand: "/usr/local/bin/Codex --resume" }), BLIND)).toBe(AGENT_HINT);
  });

  test("an ordinary shell earns nothing", () => {
    expect(paneHint(shellPane({ foregroundCommand: "bash" }), BLIND)).toBeNull();
    expect(paneHint(shellPane({ foregroundCommand: "nvim" }), BLIND)).toBeNull();
  });

  test("a pane whose multiplexer reports no foreground command at all earns nothing", () => {
    expect(paneHint(shellPane(), BLIND)).toBeNull();
    expect(paneHint(shellPane({ foregroundCommand: "   " }), BLIND)).toBeNull();
  });

  test("the sentence names no harness and no multiplexer", () => {
    for (const name of ["claude", "codex", "pi", "opencode", "omp", "herdr", "tmux", "zellij"]) {
      expect(AGENT_HINT.toLowerCase()).not.toContain(name);
    }
  });
});

describe("paneHint — the three suppressions", () => {
  test("suppressed when the adapter reports agents from its own wire (Herdr never hints)", () => {
    const ctx = { agentDetection: true, hooksInstalled: false };
    expect(paneHint(shellPane({ foregroundCommand: "claude" }), ctx)).toBeNull();
  });

  test("suppressed when the emitter's hooks are already installed — the remedy is done", () => {
    const ctx = { agentDetection: false, hooksInstalled: true };
    expect(paneHint(shellPane({ foregroundCommand: "claude" }), ctx)).toBeNull();
  });

  test("suppressed when the pane already has an identity", () => {
    // What a joined pane looks like: the port named the agent, so a guess about it is noise.
    const identified = shellPane({ foregroundCommand: "claude", agent: "claude", status: "working" });
    expect(paneHint(identified, BLIND)).toBeNull();
  });
});

describe("withPaneHint — what it may touch", () => {
  test("attaches the sentence and changes nothing else", () => {
    const pane = shellPane({ foregroundCommand: "claude" });
    const hinted = withPaneHint(pane, BLIND);
    expect(hinted.hint).toBe(AGENT_HINT);
    // Identity, standing and the session ref are untouched — the pane still reads as a bare shell.
    expect(hinted.agent).toBe("shell");
    expect(hinted.status).toBe("unknown");
    expect(hinted.agentSession).toBeUndefined();
    expect({ ...hinted, hint: undefined }).toEqual({ ...pane, hint: undefined });
  });

  test("a pane with no sentence keeps the field ABSENT rather than empty", () => {
    const pane = shellPane({ foregroundCommand: "bash" });
    const same = withPaneHint(pane, BLIND);
    expect(same).toBe(pane);
    expect("hint" in same).toBe(false);
  });
});

// ── The wrapper ──────────────────────────────────────────────────────────────

/** A blind adapter, written as a CLASS so the wrapper is proved not to lose prototype methods. */
class StubAdapter implements MuxAdapter {
  readonly mux = "stub";
  capabilities = declareCapabilities({ supports: ["paneGrid", "typeText"] });
  panes: MuxPane[] = [shellPane({ paneId: "%1", foregroundCommand: "claude" }), shellPane({ paneId: "%2" })];
  readonly calls: string[] = [];
  readonly subscription: MuxSubscription = { close: () => undefined };

  reachable(): Promise<boolean> {
    this.calls.push("reachable");
    return Promise.resolve(true);
  }

  snapshot(): Promise<MuxSnapshot> {
    this.calls.push("snapshot");
    return Promise.resolve({ panes: this.panes, spaces: [], tabs: [] });
  }

  readGrid(paneId: string, _request: MuxGridRequest) {
    this.calls.push("readGrid");
    return Promise.resolve(muxOk({ paneId, text: "grid", truncated: false, revision: 1 }));
  }

  typeText(_paneId: string, _text: string) {
    this.calls.push("typeText");
    return Promise.resolve(muxAck());
  }

  sendKeys(_paneId: string, _keys: readonly string[]) {
    this.calls.push("sendKeys");
    return Promise.resolve(muxAck());
  }

  renamePane(_paneId: string, _label: string | null) {
    this.calls.push("renamePane");
    return Promise.resolve(muxAck());
  }

  closePane(_paneId: string) {
    this.calls.push("closePane");
    return Promise.resolve(muxGone("gone"));
  }

  createTab(_request: MuxTabRequest) {
    this.calls.push("createTab");
    return Promise.resolve(muxOk({ paneId: "%9", spaceId: "space", spaceLabel: "space", tabId: "tab", cwd: "/tmp" }));
  }

  renameTab(_tabId: string, _label: string) {
    this.calls.push("renameTab");
    return Promise.resolve(muxAck());
  }

  closeTab(_tabId: string) {
    this.calls.push("closeTab");
    return Promise.resolve(muxAck());
  }

  createSpace(_request: MuxSpaceRequest) {
    this.calls.push("createSpace");
    return Promise.resolve(muxOk({ paneId: "%9", spaceId: "space", spaceLabel: "space", tabId: "tab", cwd: "/tmp" }));
  }

  watch(_options: MuxWatchOptions): MuxSubscription {
    this.calls.push("watch");
    return this.subscription;
  }
}

describe("withAgentHints", () => {
  test("hints only the pane that looks like an agent", async () => {
    const stub = new StubAdapter();
    const snapshot = await withAgentHints(stub, { hooksInstalled: () => false }).snapshot();
    expect(snapshot.panes.map((pane) => pane.hint)).toEqual([AGENT_HINT, undefined]);
  });

  test("declares exactly what the wrapped adapter declares — a sentence is never a capability", () => {
    const stub = new StubAdapter();
    const wrapped = withAgentHints(stub, { hooksInstalled: () => false });
    expect(wrapped.capabilities).toEqual(stub.capabilities);
    expect(wrapped.mux).toBe(stub.mux);
  });

  test("re-reads the install per snapshot, so an install reaches a running bridge", async () => {
    const stub = new StubAdapter();
    let installed = false;
    const wrapped = withAgentHints(stub, { hooksInstalled: () => installed });
    expect((await wrapped.snapshot()).panes[0]?.hint).toBe(AGENT_HINT);
    installed = true;
    expect((await wrapped.snapshot()).panes[0]?.hint).toBeUndefined();
  });

  test("every other verb reaches the adapter underneath", async () => {
    const stub = new StubAdapter();
    const wrapped = withAgentHints(stub, { hooksInstalled: () => false });
    await wrapped.reachable();
    await wrapped.readGrid("%1", { scope: "viewport", lines: 10, styling: "strip" });
    await wrapped.typeText("%1", "hi");
    await wrapped.sendKeys("%1", ["Enter"]);
    await wrapped.renamePane("%1", "label");
    await wrapped.closePane("%1");
    await wrapped.createTab({ spaceId: "space" });
    await wrapped.renameTab("tab", "label");
    await wrapped.closeTab("tab");
    await wrapped.createSpace({ cwd: "/tmp" });
    wrapped.watch({ panes: [], onTopologyChange: () => {}, onPaneChange: () => {}, onUp: () => {}, onDown: () => {} });
    expect(stub.calls).toEqual([
      "reachable",
      "readGrid",
      "typeText",
      "sendKeys",
      "renamePane",
      "closePane",
      "createTab",
      "renameTab",
      "closeTab",
      "createSpace",
      "watch",
    ]);
  });
});
