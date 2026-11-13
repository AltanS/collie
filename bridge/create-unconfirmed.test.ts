import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import { CONFIRM_BOUND_MS, CONFIRM_POLL_MS, LAUNCH_BUDGET_MS, knownBefore, lookForCreated } from "./create-confirm.ts";
import type { JsonObject } from "./json.ts";
import { isUnsettled, LAUNCH_RECEIPTS_FILE, LaunchReceiptStore, memoryLaunchReceipts, type LaunchReceiptSurface } from "./launch-receipts.ts";
import { createTab, createWorkspace, launch } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { Launcher } from "./types.ts";
import { declareCapabilities } from "./mux/capabilities.ts";
import {
  muxAck,
  muxOk,
  muxRefused,
  muxUnconfirmed,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxOutcome,
  type MuxPane,
  type MuxSnapshot,
  type MuxSpaceRequest,
  type MuxTabRequest,
} from "./mux/types.ts";

// A create that timed out is not a create that failed, and a request id guards every create (M100 spec 04).
//
//   1. `lookForCreated` finds the one new space or tab in the snapshot, and says `none` only after it read
//      one, `unread` when it could not, and refuses to pick between two.
//   2. A launch, a tab and a space create with a request id write a `pending` receipt BEFORE the
//      multiplexer is asked, and settle it after.
//   3. A create that is `unconfirmed` and shows up in the snapshot is a success with a receipt; one that
//      does not is the plain failure and the id may run again; one nobody can look up is `unknown`, a 504
//      the phone reads as the lead's own, and the same id then starts nothing.
//   4. On start a pending receipt older than the launch budget reads `unknown`.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const ID2 = "1c0f7b2d-4a3e-4d6f-9b8c-2e3f4a5b6c7d";
const CLAUDE: Launcher = { command: "claude", label: "Claude" };

function pane(over: Partial<MuxPane> & Pick<MuxPane, "paneId" | "spaceId" | "tabId">): MuxPane {
  // SAFETY: a snapshot row as the look reads it: only the fields below are read, the rest of `MuxPane` is not.
  return { spaceLabel: over.spaceId, spaceNumber: 1, cwd: "/home/op/app", focused: false, alive: true, agent: "shell", ...over } as MuxPane;
}

function snap(panes: MuxPane[]): MuxSnapshot {
  // SAFETY: the look reads `panes` and nothing else of a snapshot.
  return { panes, spaces: [], tabs: [] } as MuxSnapshot;
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

const NONE = knownBefore({ agents: [], shellPanes: [{ paneId: "w1:p1", workspaceId: "w1" }], workspaces: [{ workspaceId: "w1" }] });

describe("lookForCreated", () => {
  test("a space: the new space's first pane, in the folder asked for", async () => {
    const mux = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w1:p1", spaceId: "w1", tabId: "w1:t1" }), pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", spaceLabel: "app" })])) };
    const look = await lookForCreated(mux, NONE, { kind: "space", cwd: "/home/op/app" }, clock());
    expect(look).toEqual({ kind: "found", pane: { paneId: "w2:p1", spaceId: "w2", spaceLabel: "app", tabId: "w2:t1", cwd: "/home/op/app" } });
  });

  test("a new space in another folder is not the one asked for", async () => {
    const mux = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", cwd: "/elsewhere" })])) };
    const look = await lookForCreated(mux, NONE, { kind: "space", cwd: "/home/op/app" }, clock());
    expect(look.kind).toBe("none");
  });

  test("a tab: a new pane in the space asked for, not one in another space", async () => {
    const mux = {
      snapshot: () =>
        Promise.resolve(snap([pane({ paneId: "w9:p1", spaceId: "w9", tabId: "w9:t1" }), pane({ paneId: "w1:p2", spaceId: "w1", tabId: "w1:t2" })])),
    };
    const look = await lookForCreated(mux, NONE, { kind: "tab", spaceId: "w1" }, clock());
    expect(look).toMatchObject({ kind: "found", pane: { paneId: "w1:p2", tabId: "w1:t2" } });
  });

  test("two new spaces: it cannot tell which, so it proves nothing", async () => {
    const mux = {
      snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" }), pane({ paneId: "w3:p1", spaceId: "w3", tabId: "w3:t1" })])),
    };
    expect((await lookForCreated(mux, NONE, { kind: "space", cwd: "/home/op/app" }, clock())).kind).toBe("unread");
  });

  test("a snapshot that shows it on the third look is found; one that never does is none after the bound", async () => {
    const c = clock();
    let looks = 0;
    const late = {
      snapshot: () => {
        looks += 1;
        return Promise.resolve(snap(looks < 3 ? [] : [pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" })]));
      },
    };
    expect((await lookForCreated(late, NONE, { kind: "space" }, c)).kind).toBe("found");
    expect(looks).toBe(3);
    const never = clock();
    let tries = 0;
    const empty = {
      snapshot: () => {
        tries += 1;
        return Promise.resolve(snap([]));
      },
    };
    expect((await lookForCreated(empty, NONE, { kind: "space" }, never)).kind).toBe("none");
    expect(never.now()).toBeGreaterThanOrEqual(CONFIRM_BOUND_MS);
    expect(tries).toBe(Math.floor(CONFIRM_BOUND_MS / CONFIRM_POLL_MS) + 1);
  });

  test("a snapshot that cannot be read is unread, never none", async () => {
    const broken = { snapshot: () => Promise.reject(new Error("socket closed")) };
    expect((await lookForCreated(broken, NONE, { kind: "space" }, clock())).kind).toBe("unread");
  });

  test("the lead's budget for a create is longer than the member's own waits put together", () => {
    // The adapter's wait for the create (5 s) + the look + the wait for the new shell (5 s).
    expect(LAUNCH_BUDGET_MS).toBeGreaterThan(5000 + CONFIRM_BOUND_MS + 5000);
  });
});

/** A multiplexer whose creates answer as told, and whose snapshot shows what `shown` holds. */
class FakeMux {
  readonly spaces: MuxSpaceRequest[] = [];
  readonly tabs: MuxTabRequest[] = [];
  readonly texts: Array<[string, string]> = [];
  readonly closes: string[] = [];
  capabilities = declareCapabilities({ supports: ["createSpace", "createTab", "renameTab"], topologyLatency: { kind: "push" } });
  /** What a create answers: the default makes the pane. */
  answer: "ok" | "unconfirmed" | "refused" = "ok";
  /** The panes the snapshot shows after a create that timed out. `null`: the snapshot cannot be read. */
  shown: MuxPane[] | null = [];
  /** Called as each create begins, to see what was on disk by then. */
  onCreate: (() => void) | null = null;
  private n = 0;

  private created(cwd: string | undefined, label: string | undefined, spaceId?: string): MuxOutcome<MuxCreatedPane> {
    this.onCreate?.();
    if (this.answer === "unconfirmed") return muxUnconfirmed("herdr workspace.create: timed out after 5000ms");
    if (this.answer === "refused") return muxRefused("no such directory");
    this.n++;
    const id = spaceId ?? `w${this.n}`;
    return muxOk({ paneId: `${id}:p${this.n}`, spaceId: id, spaceLabel: label ?? "shell", tabId: `${id}:t${this.n}`, cwd: cwd ?? "/" });
  }
  createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    return Promise.resolve(this.created(request.cwd, request.label));
  }
  createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.tabs.push(request);
    return Promise.resolve(this.created(request.cwd, request.label, request.spaceId));
  }
  snapshot(): Promise<MuxSnapshot> {
    return this.shown === null ? Promise.reject(new Error("socket closed")) : Promise.resolve(snap(this.shown));
  }
  renameTab(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
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
  closePane(paneId: string): Promise<MuxAck> {
    this.closes.push(paneId);
    return Promise.resolve(muxAck());
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}

function asMux(fake: Partial<MuxAdapter>): MuxAdapter {
  // SAFETY: a launch or a create reaches the create calls, the snapshot, renameTab, readGrid, typeText,
  // writeKeys, closePane and refresh, plus the `capabilities` declaration: what FakeMux implements.
  return fake as MuxAdapter;
}

const engine = (): StateEngine => {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: a create reads `current()` (the panes it knew) and `pokeNow()`; nothing else.
  return stub as StateEngine;
};

const post = (path: string, body: JsonObject) =>
  new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function launchOnce(mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject) {
  const res = await launch(asMux(mux), engine(), post("/api/launch", body), new AuditLog(() => {}), null, "default", () => Promise.resolve([CLAUDE]), clock(), {
    receipts,
    home: "/home/op",
    fs: { isDirectory: () => Promise.resolve(true) },
  });
  // SAFETY: `launch` answers JSON for every route this file takes.
  return { status: res.status, body: (await res.json()) as JsonObject };
}

const tab = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject) =>
  createTab(asMux(mux), engine(), post("/api/tab", body), new AuditLog(() => {}), null, "default", { receipts, wait: clock() });

const space = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject) =>
  createWorkspace(asMux(mux), engine(), post("/api/workspace", body), new AuditLog(() => {}), null, "default", undefined, undefined, { receipts, wait: clock() });

describe("a launch writes its receipt pending before the create, and settles it", () => {
  test("pending while the multiplexer is asked, the pane's receipt after", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    let during = "not asked";
    mux.onCreate = () => {
      const held = receipts.get(ID);
      during = held === undefined ? "none" : isUnsettled(held) ? held.state : "pane";
    };
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(during).toBe("pending");
    const settled = receipts.get(ID);
    expect(settled !== undefined && !isUnsettled(settled) ? settled.paneId : null).toBe("w1:p1");
  });

  test("a create that fails stores nothing, so the id may run again", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    mux.answer = "refused";
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).body.ok).toBe(false);
    expect(receipts.get(ID)).toBeUndefined();
    mux.answer = "ok";
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).body.ok).toBe(true);
  });

  test("a bridge that stopped with the receipt pending starts nothing for that id on a retry", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    await receipts.record({ requestId: ID, at: 1, state: "unknown" });
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(504);
    expect(body.code).toBe("write_outcome_unknown");
    expect(mux.spaces).toHaveLength(0);
  });
});

describe("a create that timed out is looked up, not failed", () => {
  test("a launch whose space shows up in the snapshot succeeds, with a receipt, and types its line once", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: "app", cwd: homedir() })];
    const receipts = memoryLaunchReceipts();
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, pane: { paneId: "w7:p1", workspaceId: "w7" } });
    expect(mux.texts).toEqual([["w7:p1", "claude"]]);
    const settled = receipts.get(ID);
    expect(settled !== undefined && !isUnsettled(settled) ? settled.paneId : null).toBe("w7:p1");
    // The retry after a lost answer replays that pane and makes nothing.
    const again = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(again.body).toMatchObject({ ok: true, replayed: true, pane: { paneId: "w7:p1" } });
    expect(mux.spaces).toHaveLength(1);
  });

  test("a launch whose pane is not in the snapshot after the bound is the plain failure, and the id may run again", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    const receipts = memoryLaunchReceipts();
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, code: "workspace.create_failed" });
    expect(receipts.get(ID)).toBeUndefined();
  });

  test("a launch whose snapshot cannot be read is unknown: a 504, the receipt says unknown, and the same id starts nothing", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = null;
    const receipts = memoryLaunchReceipts();
    const first = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(first.status).toBe(504);
    expect(first.body).toMatchObject({ ok: false, code: "write_outcome_unknown" });
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    mux.answer = "ok";
    const second = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(second.status).toBe(504);
    expect(mux.spaces).toHaveLength(1);
  });

  test("a tab create: a new pane in that space is the tab, and the same id replays it", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w1:p5", spaceId: "w1", tabId: "w1:t5" })];
    const receipts = memoryLaunchReceipts();
    const res = await tab(mux, receipts, { workspaceId: "w1", requestId: ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pane: { paneId: "w1:p5", tabId: "w1:t5" } });
    const again = await tab(mux, receipts, { workspaceId: "w1", requestId: ID });
    expect(await again.json()).toMatchObject({ ok: true, replayed: true, pane: { paneId: "w1:p5" } });
    expect(mux.tabs).toHaveLength(1);
  });

  test("a space create: nothing new after the bound is the plain failure", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    const receipts = memoryLaunchReceipts();
    const res = await space(mux, receipts, { cwd: "/home/op/app", requestId: ID });
    expect(await res.json()).toMatchObject({ ok: false, code: "workspace.create_failed" });
    expect(receipts.get(ID)).toBeUndefined();
  });
});

describe("a tab and a space create carry the request id like a launch", () => {
  test("a space create with an id asks the multiplexer once, however often it is sent", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    const first = await (await space(mux, receipts, { cwd: "/home/op/app", requestId: ID })).json();
    const again = await (await space(mux, receipts, { cwd: "/home/op/app", requestId: ID })).json();
    expect(first).toMatchObject({ ok: true });
    expect(again).toMatchObject({ ok: true, replayed: true, pane: { paneId: "w1:p1" } });
    expect(mux.spaces).toHaveLength(1);
    // Another intent is another space.
    await space(mux, receipts, { cwd: "/home/op/app", requestId: ID2 });
    expect(mux.spaces).toHaveLength(2);
  });

  test("a tab create with an id asks the multiplexer once, and a second request while it runs joins it", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = mux.createTab.bind(mux);
    mux.createTab = async (request) => {
      await gate;
      return real(request);
    };
    const one = tab(mux, receipts, { workspaceId: "w1", requestId: ID });
    const two = tab(mux, receipts, { workspaceId: "w1", requestId: ID });
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(mux.tabs).toHaveLength(1);
    expect(await a.json()).toMatchObject({ ok: true });
    expect(await b.json()).toMatchObject({ ok: true, replayed: true });
  });

  test("an id that is not a UUID is a 400 on both", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    expect((await tab(mux, receipts, { workspaceId: "w1", requestId: "nope" })).status).toBe(400);
    expect((await space(mux, receipts, { requestId: "nope" })).status).toBe(400);
  });

  test("a create with no id works as it always did and writes no receipt", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    expect(await (await space(mux, receipts, { cwd: "/home/op/app" })).json()).toMatchObject({ ok: true });
    expect(await (await tab(mux, receipts, { workspaceId: "w1" })).json()).toMatchObject({ ok: true });
    expect(receipts.get(ID)).toBeUndefined();
  });
});

describe("the receipt file across a start", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "collie-launch-pending-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a pending receipt older than the launch budget reads unknown after a start; a younger one stays pending", async () => {
    const first = new LaunchReceiptStore(dir, () => {});
    await first.record({ requestId: ID, at: 1000, state: "pending" });
    await first.record({ requestId: ID2, at: 1000 + LAUNCH_BUDGET_MS, state: "pending" });
    const second = new LaunchReceiptStore(dir, () => {});
    await second.load();
    expect(await second.expirePending(1000 + LAUNCH_BUDGET_MS + 1)).toBe(1);
    expect(second.get(ID)).toMatchObject({ state: "unknown" });
    expect(second.get(ID2)).toMatchObject({ state: "pending" });
    // It reached the disk, and a second start has nothing more to change.
    const third = new LaunchReceiptStore(dir, () => {});
    await third.load();
    expect(third.get(ID)).toMatchObject({ state: "unknown" });
    expect(await third.expirePending(1000 + LAUNCH_BUDGET_MS + 1)).toBe(0);
    expect(await third.expirePending(1000 + 2 * LAUNCH_BUDGET_MS + 2)).toBe(1);
    expect(await third.expirePending(1000 + 3 * LAUNCH_BUDGET_MS)).toBe(0);
  });

  test("a start with nothing pending writes no file", async () => {
    const store = new LaunchReceiptStore(dir, () => {});
    await store.load();
    expect(await store.expirePending()).toBe(0);
    expect(await Bun.file(join(dir, LAUNCH_RECEIPTS_FILE)).exists()).toBe(false);
  });

  test("a pane's receipt written before this change still reads", async () => {
    await Bun.write(
      join(dir, LAUNCH_RECEIPTS_FILE),
      JSON.stringify({ receipts: [{ requestId: ID, at: 5, workspaceId: "w1", workspaceLabel: "app", paneId: "w1:p1", tabId: "w1:t1", cwd: "/x" }] }),
    );
    const store = new LaunchReceiptStore(dir, () => {});
    await store.load();
    const old = store.get(ID);
    expect(old !== undefined && !isUnsettled(old) ? old.paneId : null).toBe("w1:p1");
    expect(await store.expirePending(1e12)).toBe(0);
  });
});
