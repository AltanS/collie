import { describe, expect, test } from "bun:test";

import { AuditLog } from "./audit.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { memoryLaunchReceipts } from "./launch-receipts.ts";
import { declareCapabilities, type MuxCapability } from "./mux/capabilities.ts";
import {
  muxAck,
  muxOk,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxOutcome,
  type MuxSplitRequest,
  type MuxTabRequest,
} from "./mux/types.ts";
import { DEFAULT_SWITCHES } from "./operator-launchers.ts";
import { launch } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView, CreateResponse } from "./types.ts";

// A run asked to open in the pane's own tab (`split: true`, a chat's Run in shell). The claims:
//
//   1. Where the multiplexer declares `splitPane`, the shell is a new pane in the agent's tab, the line
//      is typed into it, and the audit line names a pane.
//   2. Where it does not, or the body does not ask, the run opens a tab beside the pane as before.
//   3. A split that lands in another tab is closed before anything is typed, and the run is refused.
//   4. The name the phone sends goes on the new pane, or on the new tab where there is no split.

const AGENT: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "app",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/op/app",
  focused: false,
  kind: "agent",
};

function engine(): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [AGENT], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: `launch` reaches only `current()` (the beside-pane lookup) and `pokeNow()`.
  return stub as StateEngine;
}

const BASE: readonly MuxCapability[] = ["typeText", "sendKeys", "createTab", "closePane", "renamePane"];

class FakeMux {
  readonly splits: MuxSplitRequest[] = [];
  readonly tabs: MuxTabRequest[] = [];
  readonly texts: Array<[string, string]> = [];
  readonly closes: string[] = [];
  readonly renames: Array<[string, string | null]> = [];
  readonly capabilities;
  splitLandsIn = "w1:t1";

  constructor(splitDeclared: boolean) {
    this.capabilities = declareCapabilities({
      supports: splitDeclared ? [...BASE, "splitPane"] : BASE,
      topologyLatency: { kind: "push" },
    });
  }
  splitPane(request: MuxSplitRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.splits.push(request);
    return Promise.resolve(muxOk({ paneId: "w1:p2", spaceId: "w1", spaceLabel: "w1", tabId: this.splitLandsIn, cwd: request.cwd ?? "/" }));
  }
  createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.tabs.push(request);
    return Promise.resolve(muxOk({ paneId: "w1:p3", spaceId: "w1", spaceLabel: "w1", tabId: "w1:t2", cwd: request.cwd ?? "/" }));
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(muxAck());
  }
  writeKeys(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  renamePane(paneId: string, label: string | null): Promise<MuxAck> {
    this.renames.push([paneId, label]);
    return Promise.resolve(muxAck());
  }
  closePane(paneId: string): Promise<MuxAck> {
    this.closes.push(paneId);
    return Promise.resolve(muxAck());
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}

function asMux(fake: Partial<MuxAdapter>): MuxAdapter {
  // SAFETY: a run beside a pane reaches splitPane or createTab, readGrid, typeText, writeKeys,
  // closePane and refresh, and reads `capabilities`: the ones FakeMux implements.
  return fake as MuxAdapter;
}

function clock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: (by: number): Promise<void> => {
      ms += by;
      return Promise.resolve();
    },
  };
}

async function run(mux: FakeMux, body: JsonObject) {
  const raw: string[] = [];
  const audit = new AuditLog((line) => void raw.push(line), { content: "preview" });
  const res = await launch(
    asMux(mux),
    engine(),
    new Request("http://x/api/launch", { method: "POST", body: JSON.stringify(body satisfies JsonValue) }),
    audit,
    "phone",
    "default",
    () => Promise.resolve([]),
    clock(),
    { home: "/home/op", switches: () => Promise.resolve({ ...DEFAULT_SWITCHES }), receipts: memoryLaunchReceipts() },
  );
  // SAFETY: `launch` answers a CreateResponse as JSON here; every case sends a well-formed body.
  const answer = (await res.json()) as CreateResponse;
  // SAFETY: each audit line is one `formatAuditLine` JSON object.
  return { answer, audit: raw.map((line) => JSON.parse(line) as JsonObject) };
}

describe("POST /api/launch `{ run, split }`", () => {
  test("opens a pane in the agent's tab where the multiplexer can split, and types the line there", async () => {
    const mux = new FakeMux(true);
    const { answer, audit } = await run(mux, { run: "sudo ls", paneId: "w1:p1", split: true });
    expect(answer).toMatchObject({ ok: true, pane: { paneId: "w1:p2", tabId: "w1:t1" } });
    expect(mux.splits).toEqual([{ paneId: "w1:p1", cwd: "/home/op/app" }]);
    expect(mux.tabs).toEqual([]);
    expect(mux.texts).toEqual([["w1:p2", "sudo ls"]]);
    expect(audit.at(-1)).toMatchObject({ action: "pane.run", paneId: "w1:p2" });
  });

  test("opens a tab beside the pane where the multiplexer cannot split, or nobody asked", async () => {
    const undeclared = new FakeMux(false);
    expect((await run(undeclared, { run: "sudo ls", paneId: "w1:p1", split: true })).answer).toMatchObject({ ok: true, pane: { tabId: "w1:t2" } });
    expect(undeclared.splits).toEqual([]);
    const unasked = new FakeMux(true);
    expect((await run(unasked, { run: "sudo ls", paneId: "w1:p1" })).answer).toMatchObject({ ok: true, pane: { tabId: "w1:t2" } });
    expect(unasked.splits).toEqual([]);
  });

  test("names the new pane, or the new tab where the run cannot split, with the phone's words", async () => {
    const split = new FakeMux(true);
    await run(split, { run: "sudo ls", paneId: "w1:p1", split: true, label: "Run in shell" });
    expect(split.renames).toEqual([["w1:p2", "Run in shell"]]);
    const tab = new FakeMux(false);
    await run(tab, { run: "sudo ls", paneId: "w1:p1", split: true, label: "Run in shell" });
    expect(tab.tabs[0]?.label).toBe("Run in shell");
    expect(tab.renames).toEqual([]);
    const unnamed = new FakeMux(true);
    await run(unnamed, { run: "sudo ls", paneId: "w1:p1", split: true, label: "bad\u0007name" });
    expect(unnamed.renames).toEqual([]);
  });

  test("closes a split that landed in another tab, types nothing, and refuses", async () => {
    const mux = new FakeMux(true);
    mux.splitLandsIn = "w7:t1";
    const { answer } = await run(mux, { run: "sudo ls", paneId: "w1:p1", split: true });
    expect(answer).toMatchObject({ ok: false, code: "workspace.create_failed" });
    expect(mux.closes).toEqual(["w1:p2"]);
    expect(mux.texts).toEqual([]);
  });
});
