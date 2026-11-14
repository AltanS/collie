import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { AuditLog } from "./audit.ts";
import {
  CONFIRM_BOUND_MS,
  CONFIRM_POLL_MS,
  LAUNCH_BUDGET_MS,
  MEMBER_DEADLINE_MS,
  knownBefore,
  lookForCreated,
  type CreateWanted,
  type KnownBefore,
} from "./create-confirm.ts";
import type { JsonObject } from "./json.ts";
import { isUnsettled, LAUNCH_NO_PROMPT_TEXT, LAUNCH_RECEIPTS_FILE, LAUNCH_UNKNOWN_TEXT, LaunchReceiptStore, memoryLaunchReceipts, type LaunchReceiptSurface } from "./launch-receipts.ts";
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
  type MuxSpace,
  type MuxTab,
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
//   5. The look's "before" is a fresh snapshot, a pane that reports no folder or carries another label is
//      not named, and a pane found by the look is typed into only when it reads as a shell.
//   6. The member holds its own deadline: past it the answer is unknown at once and the run goes on.
//   7. A throw, and a pane that could not be closed, never leave a receipt `pending` or forgotten.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const ID2 = "1c0f7b2d-4a3e-4d6f-9b8c-2e3f4a5b6c7d";
const CLAUDE: Launcher = { command: "claude", label: "Claude" };

function pane(over: Partial<MuxPane> & Pick<MuxPane, "paneId" | "spaceId" | "tabId">): MuxPane {
  // SAFETY: a snapshot row as the look reads it: only the fields below are read, the rest of `MuxPane` is not.
  return { spaceLabel: over.spaceId, spaceNumber: 1, cwd: "/home/op/app", focused: false, alive: true, agent: "shell", ...over } as MuxPane;
}

/** A snapshot of `panes`, with the space and tab labels the multiplexer would report when the test gives them. */
interface Labels {
  spaces?: Array<[string, string]>;
  tabs?: Array<[string, string]>;
}

function snap(panes: MuxPane[], labels: Labels = {}): MuxSnapshot {
  const spaces = (labels.spaces ?? []).map(([spaceId, label]) => ({ spaceId, label }));
  const tabs = (labels.tabs ?? []).map(([tabId, label]) => ({ tabId, label }));
  const rows: Pick<MuxSnapshot, "panes"> & { spaces: Partial<MuxSpace>[]; tabs: Partial<MuxTab>[] } = { panes, spaces, tabs };
  // SAFETY: the look reads `panes`, and the `spaceId`/`tabId` and `label` of the spaces and tabs listed here.
  return rows as MuxSnapshot;
}

/**
 * A clock that only moves when every step is waiting on it. `sleep` parks a timer; `run` lets all that can
 * run, run, then jumps to the earliest timer, until the promise it drives has answered. Nothing here waits in
 * real time, so a create that takes 15 virtual seconds costs a few milliseconds.
 */
function virtualClock() {
  let time = 0;
  const timers: Array<{ at: number; fire: () => void }> = [];
  // Lets everything that can run, run (a macrotask passes after every ready continuation), then jumps to the
  // earliest timer. `stop` is asked after the flush and before the jump, so the clock never moves past an answer.
  const next = async (stop: () => boolean): Promise<boolean> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (stop()) return false;
    timers.sort((x, y) => x.at - y.at);
    const due = timers.shift();
    if (due === undefined) return false;
    time = Math.max(time, due.at);
    due.fire();
    return true;
  };
  return {
    now: () => time,
    sleep: (by: number): Promise<void> =>
      new Promise<void>((resolve) => {
        timers.push({ at: time + by, fire: resolve });
      }),
    /** Drive the clock until `work` has answered. */
    async run<T>(work: Promise<T>): Promise<T> {
      let done = false;
      work.then(
        () => (done = true),
        () => (done = true),
      );
      for (let turns = 0; turns < 100_000; turns++) if (!(await next(() => done))) break;
      return work;
    },
    /** Let everything that is still running finish, however long it takes on this clock. */
    async drain(): Promise<void> {
      for (let turns = 0; turns < 100_000; turns++) if (!(await next(() => false))) return;
    },
  };
}

type VirtualClock = ReturnType<typeof virtualClock>;

const NONE = knownBefore(snap([pane({ paneId: "w1:p1", spaceId: "w1", tabId: "w1:t1" })]));

/** The look, run on a virtual clock: what it found and how long it took. */
async function runLook(
  mux: { snapshot: () => Promise<MuxSnapshot> },
  wanted: CreateWanted,
  known: KnownBefore = NONE,
): Promise<{ look: Awaited<ReturnType<typeof lookForCreated>>; elapsed: number }> {
  const vc = virtualClock();
  const look = await vc.run(lookForCreated(mux, known, wanted, vc));
  return { look, elapsed: vc.now() };
}

const hangs = (): Promise<MuxSnapshot> => new Promise<MuxSnapshot>(() => {});

describe("lookForCreated", () => {
  test("a space: the new space's first pane, in the folder asked for", async () => {
    const mux = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w1:p1", spaceId: "w1", tabId: "w1:t1" }), pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", spaceLabel: "app" })])) };
    const { look } = await runLook(mux, { kind: "space", cwd: "/home/op/app" });
    expect(look).toEqual({ kind: "found", agent: "shell", pane: { paneId: "w2:p1", spaceId: "w2", spaceLabel: "app", tabId: "w2:t1", cwd: "/home/op/app" } });
  });

  test("a new space in another folder is not the one asked for", async () => {
    const mux = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", cwd: "/elsewhere" })])) };
    expect((await runLook(mux, { kind: "space", cwd: "/home/op/app" })).look.kind).toBe("none");
  });

  test("a tab: a new pane in the space asked for, not one in another space", async () => {
    const mux = {
      snapshot: () =>
        Promise.resolve(snap([pane({ paneId: "w9:p1", spaceId: "w9", tabId: "w9:t1" }), pane({ paneId: "w1:p2", spaceId: "w1", tabId: "w1:t2" })])),
    };
    expect((await runLook(mux, { kind: "tab", spaceId: "w1", cwd: "/home/op/app" })).look).toMatchObject({ kind: "found", pane: { paneId: "w1:p2", tabId: "w1:t2" } });
  });

  test("two new spaces: it cannot tell which, so it proves nothing", async () => {
    const mux = {
      snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" }), pane({ paneId: "w3:p1", spaceId: "w3", tabId: "w3:t1" })])),
    };
    expect((await runLook(mux, { kind: "space", cwd: "/home/op/app" })).look.kind).toBe("unread");
  });

  test("a snapshot that shows it on the third look is found; one that never does is none after the bound", async () => {
    let looks = 0;
    const late = {
      snapshot: () => {
        looks += 1;
        return Promise.resolve(snap(looks < 3 ? [] : [pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" })]));
      },
    };
    expect((await runLook(late, { kind: "space", cwd: "/home/op/app" })).look.kind).toBe("found");
    expect(looks).toBe(3);
    let tries = 0;
    const empty = {
      snapshot: () => {
        tries += 1;
        return Promise.resolve(snap([]));
      },
    };
    const never = await runLook(empty, { kind: "space" });
    expect(never.look.kind).toBe("none");
    expect(never.elapsed).toBeGreaterThanOrEqual(CONFIRM_BOUND_MS);
    expect(tries).toBe(Math.floor(CONFIRM_BOUND_MS / CONFIRM_POLL_MS) + 1);
  });

  test("a snapshot that cannot be read is unread, never none", async () => {
    const broken = { snapshot: () => Promise.reject(new Error("socket closed")) };
    expect((await runLook(broken, { kind: "space" })).look.kind).toBe("unread");
  });

  test("a snapshot that hangs does not stretch the look: unread at the bound", async () => {
    const stuck = await runLook({ snapshot: hangs }, { kind: "space" });
    expect(stuck.look.kind).toBe("unread");
    expect(stuck.elapsed).toBe(CONFIRM_BOUND_MS);
    // One hung read in the middle costs the time left, and a later read cannot start past the bound.
    let reads = 0;
    const slowThenGone = { snapshot: () => (++reads === 1 ? Promise.resolve(snap([])) : hangs()) };
    const mixed = await runLook(slowThenGone, { kind: "space" });
    expect(mixed.look.kind).toBe("unread");
    expect(mixed.elapsed).toBe(CONFIRM_BOUND_MS);
  });

  test("a new pane that reports no folder is not a match yet: the look goes on, and never says none", async () => {
    const blank = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", cwd: "" })])) };
    const stuck = await runLook(blank, { kind: "space", cwd: "/home/op/app" });
    expect(stuck.look.kind).toBe("unread");
    expect(stuck.elapsed).toBeGreaterThanOrEqual(CONFIRM_BOUND_MS);
    // The next look reads the folder: now it is a match.
    let reads = 0;
    const settles = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", cwd: ++reads < 3 ? "" : "/home/op/app" })])) };
    expect((await runLook(settles, { kind: "space", cwd: "/home/op/app" })).look.kind).toBe("found");
    expect(reads).toBe(3);
    // A create that named no folder has no folder to compare; its label (the space's own, "w2") is the property it names.
    expect((await runLook(blank, { kind: "space", label: "w2" })).look.kind).toBe("found");
  });

  test("a label the request gave must be the label the snapshot shows", async () => {
    const wrong = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" })], { spaces: [["w2", "somebody's"]] })) };
    // Not named as ours, and not "nothing was made" either: it may be ours under a name the multiplexer changed.
    const mismatch = await runLook(wrong, { kind: "space", label: "app" });
    expect(mismatch.look.kind).toBe("unread");
    const right = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" })], { spaces: [["w2", "app"]] })) };
    expect((await runLook(right, { kind: "space", label: "app" })).look.kind).toBe("found");
    // A snapshot that carries no label (an empty one) shows nothing against the request, and nothing for it: the label named
    // no positive property, so with no folder asked either the pane is only "new", which is not enough (see the next test).
    const silent = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", spaceLabel: "" })])) };
    expect((await runLook(silent, { kind: "space", label: "app" })).look.kind).toBe("unread");
    expect((await runLook(silent, { kind: "space", label: "app", cwd: "/home/op/app" })).look.kind).toBe("found");
    // A tab reads the tab's own label.
    const tabs = (label: string) => ({ snapshot: () => Promise.resolve(snap([pane({ paneId: "w1:p2", spaceId: "w1", tabId: "w1:t2" })], { tabs: [["w1:t2", label]] })) });
    expect((await runLook(tabs("other"), { kind: "tab", spaceId: "w1", label: "Claude" })).look.kind).toBe("unread");
    expect((await runLook(tabs("Claude"), { kind: "tab", spaceId: "w1", label: "Claude" })).look.kind).toBe("found");
  });

  test("a bare create, one that named no folder and no label, adopts nothing: a lone new tab or space is doubtful", async () => {
    const tabs = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w1:p2", spaceId: "w1", tabId: "w1:t2" })], { tabs: [["w1:t2", "2"]] })) };
    const bareTab = await runLook(tabs, { kind: "tab", spaceId: "w1" });
    expect(bareTab.look.kind).toBe("unread");
    expect(bareTab.elapsed).toBeGreaterThanOrEqual(CONFIRM_BOUND_MS);
    const spaces = { snapshot: () => Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" })])) };
    expect((await runLook(spaces, { kind: "space" })).look.kind).toBe("unread");
    // One property named is enough, and it must hold: the folder.
    expect((await runLook(tabs, { kind: "tab", spaceId: "w1", cwd: "/home/op/app" })).look.kind).toBe("found");
    expect((await runLook(tabs, { kind: "tab", spaceId: "w1", cwd: "/elsewhere" })).look.kind).toBe("none");
    // Or the label, when the snapshot carries it.
    expect((await runLook(tabs, { kind: "tab", spaceId: "w1", label: "2" })).look.kind).toBe("found");
  });

  test("a doubtful pane beside a matching one is two candidates, so it proves nothing", async () => {
    const both = {
      snapshot: () =>
        Promise.resolve(snap([pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1" }), pane({ paneId: "w3:p1", spaceId: "w3", tabId: "w3:t1", cwd: "" })])),
    };
    expect((await runLook(both, { kind: "space", cwd: "/home/op/app" })).look.kind).toBe("unread");
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
  /** The panes the snapshot shows before any create was asked. */
  before: MuxPane[] = [];
  /** The panes the snapshot shows once a create was asked. `null`: the snapshot cannot be read at all. */
  shown: MuxPane[] | null = [];
  /** The space and tab labels the snapshot reports once a create was asked. */
  labels: Labels = {};
  /** What the multiplexer's screen reads for a pane: constant text is a settled shell. */
  screen: (read: number) => string = () => "$ ";
  /** Virtual time each step takes, on the clock the test drives. All zero: instant. */
  slow = { create: 0, snapshot: 0, type: 0 };
  /** Set by a test to make a step wait on its clock. */
  pause: (ms: number) => Promise<void> = () => Promise.resolve();
  /** What closing a pane answers. */
  closeAnswer: "ok" | "refused" = "ok";
  /** What typing the line answers. */
  typeAnswer: "ok" | "refused" = "ok";
  /** A create that throws instead of answering. */
  throwOnCreate = false;
  private asked = false;
  private reads = 0;
  /** Called as each create begins, to see what was on disk by then. */
  onCreate: (() => void) | null = null;
  private n = 0;

  private created(cwd: string | undefined, label: string | undefined, spaceId?: string): MuxOutcome<MuxCreatedPane> {
    this.onCreate?.();
    this.asked = true;
    if (this.throwOnCreate) throw new Error("adapter fell over");
    if (this.answer === "unconfirmed") return muxUnconfirmed("herdr workspace.create: timed out after 5000ms");
    if (this.answer === "refused") return muxRefused("no such directory");
    this.n++;
    const id = spaceId ?? `w${this.n}`;
    return muxOk({ paneId: `${id}:p${this.n}`, spaceId: id, spaceLabel: label ?? "shell", tabId: `${id}:t${this.n}`, cwd: cwd ?? "/" });
  }
  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    await this.pause(this.slow.create);
    return this.created(request.cwd, request.label);
  }
  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.tabs.push(request);
    await this.pause(this.slow.create);
    return this.created(request.cwd, request.label, request.spaceId);
  }
  async snapshot(): Promise<MuxSnapshot> {
    await this.pause(this.slow.snapshot);
    if (this.shown === null) throw new Error("socket closed");
    return this.asked ? snap(this.shown, this.labels) : snap(this.before);
  }
  renameTab(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: this.screen(this.reads++), truncated: false, revision: 1 }));
  }
  async typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    await this.pause(this.slow.type);
    return this.typeAnswer === "ok" ? muxAck() : muxRefused("pane is gone");
  }
  writeKeys(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  closePane(paneId: string): Promise<MuxAck> {
    this.closes.push(paneId);
    return Promise.resolve(this.closeAnswer === "ok" ? muxAck() : muxRefused("cannot close"));
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

// A test sets it to make the step after a create throw (the engine is poked once the pane exists).
let pokeThrows = false;

const engine = (): StateEngine => {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {
      if (pokeThrows) throw new Error("engine fell over");
    },
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: a create reads `current()` (the panes it knew) and `pokeNow()`; nothing else.
  return stub as StateEngine;
};

const post = (path: string, body: JsonObject) =>
  new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

// One clock per test: the routes wait on it, and `run` is what moves it.
let vc: VirtualClock = virtualClock();
beforeEach(() => {
  vc = virtualClock();
  pokeThrows = false;
});

const launchRaw = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject, audit: AuditLog = new AuditLog(() => {})) =>
  launch(asMux(mux), engine(), post("/api/launch", body), audit, null, "default", () => Promise.resolve([CLAUDE]), vc, {
    receipts,
    deadline: vc,
    home: "/home/op",
    fs: { isDirectory: () => Promise.resolve(true) },
  });

async function launchOnce(mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject, audit?: AuditLog) {
  const res = await vc.run(launchRaw(mux, receipts, body, audit));
  // SAFETY: `launch` answers JSON for every route this file takes.
  return { status: res.status, body: (await res.json()) as JsonObject };
}

const tabRaw = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject, audit: AuditLog = new AuditLog(() => {})) =>
  createTab(asMux(mux), engine(), post("/api/tab", body), audit, null, "default", { receipts, wait: vc, deadline: vc });
const tab = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject, audit?: AuditLog) => vc.run(tabRaw(mux, receipts, body, audit));

const spaceRaw = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject, audit: AuditLog = new AuditLog(() => {})) =>
  createWorkspace(asMux(mux), engine(), post("/api/workspace", body), audit, null, "default", undefined, undefined, { receipts, wait: vc, deadline: vc });
const space = (mux: FakeMux, receipts: LaunchReceiptSurface, body: JsonObject, audit?: AuditLog) => vc.run(spaceRaw(mux, receipts, body, audit));

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
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: basename(homedir()), cwd: homedir() })];
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

  test("a launch whose pane is not in the snapshot after the bound is unknown, not a failure, and the receipt stays", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    const receipts = memoryLaunchReceipts();
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    // "No pane seen in 4 s" is a time-out, not a fact.
    expect(status).toBe(504);
    expect(body).toMatchObject({ ok: false, code: "write_outcome_unknown" });
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    expect(mux.texts).toEqual([]);
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
    const res = await tab(mux, receipts, { workspaceId: "w1", cwd: "/home/op/app", requestId: ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pane: { paneId: "w1:p5", tabId: "w1:t5" } });
    const again = await tab(mux, receipts, { workspaceId: "w1", cwd: "/home/op/app", requestId: ID });
    expect(await again.json()).toMatchObject({ ok: true, replayed: true, pane: { paneId: "w1:p5" } });
    expect(mux.tabs).toHaveLength(1);
  });

  test("a space create: nothing new after the bound is unknown, and the receipt stays", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    const receipts = memoryLaunchReceipts();
    const res = await space(mux, receipts, { cwd: "/home/op/app", requestId: ID });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ ok: false, code: "write_outcome_unknown" });
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
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
    const one = tabRaw(mux, receipts, { workspaceId: "w1", requestId: ID });
    const two = tabRaw(mux, receipts, { workspaceId: "w1", requestId: ID });
    release();
    const [a, b] = await vc.run(Promise.all([one, two]));
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

  test("an unknown receipt keeps its own sentence across a start; a sentence this build does not know is not read back", async () => {
    const first = new LaunchReceiptStore(dir, () => {});
    await first.record({ requestId: ID, at: 1, state: "unknown", text: LAUNCH_NO_PROMPT_TEXT });
    const second = new LaunchReceiptStore(dir, () => {});
    await second.load();
    expect(second.get(ID)).toEqual({ requestId: ID, at: 1, state: "unknown", text: LAUNCH_NO_PROMPT_TEXT });
    await Bun.write(join(dir, LAUNCH_RECEIPTS_FILE), JSON.stringify({ receipts: [{ requestId: ID2, at: 2, state: "unknown", text: "anything a file says" }] }));
    const third = new LaunchReceiptStore(dir, () => {});
    await third.load();
    expect(third.get(ID2)).toEqual({ requestId: ID2, at: 2, state: "unknown" });
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

describe("the look's before is a fresh snapshot, and its answer is checked", () => {
  const HOME_NAME = basename(homedir());

  test("a pane that was there before the call is not the one the call made, whatever the engine remembers", async () => {
    // The state engine's stub knows no pane at all; the multiplexer already had this one.
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    const old = pane({ paneId: "w2:p1", spaceId: "w2", tabId: "w2:t1", spaceLabel: HOME_NAME, cwd: homedir() });
    mux.before = [old];
    mux.shown = [old];
    const receipts = memoryLaunchReceipts();
    const { body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    // Not named as ours; and "nothing new in 4 s" is not "nothing made", so the answer is unknown.
    expect(body).toMatchObject({ ok: false, code: "write_outcome_unknown" });
    expect(mux.texts).toEqual([]);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a snapshot that cannot be read before the call means no look: unknown, never a guess", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = null;
    const receipts = memoryLaunchReceipts();
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(504);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a new pane that reports no folder is not named: unknown, and nothing is typed", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: "" })];
    const receipts = memoryLaunchReceipts();
    const { status } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(504);
    expect(mux.texts).toEqual([]);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a new pane under another label than the launch gave is not named", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: "somebody's", cwd: homedir() })];
    const { status } = await launchOnce(mux, memoryLaunchReceipts(), { command: "claude", requestId: ID });
    expect(status).toBe(504);
    expect(mux.texts).toEqual([]);
  });

  test("a tab create that named a label finds only a tab with that label", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w1:p5", spaceId: "w1", tabId: "w1:t5" })];
    mux.labels = { tabs: [["w1:t5", "other"]] };
    expect((await tab(mux, memoryLaunchReceipts(), { workspaceId: "w1", label: "build", requestId: ID })).status).toBe(504);
    const right = new FakeMux();
    right.answer = "unconfirmed";
    right.shown = [pane({ paneId: "w1:p5", spaceId: "w1", tabId: "w1:t5" })];
    right.labels = { tabs: [["w1:t5", "build"]] };
    const res = await tab(right, memoryLaunchReceipts(), { workspaceId: "w1", label: "build", requestId: ID2 });
    expect(await res.json()).toMatchObject({ ok: true, pane: { paneId: "w1:p5" } });
  });

  test("a pane the look found that holds an agent gets nothing typed: unknown", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: homedir(), agent: "claude" })];
    const receipts = memoryLaunchReceipts();
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(504);
    expect(body.code).toBe("write_outcome_unknown");
    expect(mux.texts).toEqual([]);
    expect(mux.closes).toEqual([]);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a pane the look found whose screen never settles gets nothing typed: unknown", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: homedir() })];
    mux.screen = (read) => `output ${read}`;
    const receipts = memoryLaunchReceipts();
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(504);
    expect(mux.texts).toEqual([]);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("the pane the create answered with is typed into as before, with no extra read of the shell", async () => {
    const mux = new FakeMux();
    mux.screen = (read) => (read < 3 ? "" : "$ ");
    const { status } = await launchOnce(mux, memoryLaunchReceipts(), { command: "claude", requestId: ID });
    expect(status).toBe(200);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
  });
});

describe("the member holds its own deadline", () => {
  const HOME_NAME = basename(homedir());
  /** A create that took the adapter's whole 5 s, a pane in the snapshot, and a send that takes 10 s: the run ends past the deadline. */
  function slowMux(): FakeMux {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: homedir() })];
    mux.pause = (ms) => (ms === 0 ? Promise.resolve() : vc.sleep(ms));
    mux.slow = { create: 5000, snapshot: 0, type: 10_000 };
    return mux;
  }

  test("the answer is unknown at the deadline, below the lead's budget, and the run goes on to a receipt", async () => {
    expect(MEMBER_DEADLINE_MS).toBeLessThan(LAUNCH_BUDGET_MS);
    const mux = slowMux();
    const receipts = memoryLaunchReceipts();
    const first = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(vc.now()).toBe(MEMBER_DEADLINE_MS);
    expect(first.status).toBe(504);
    expect(first.body.code).toBe("write_outcome_unknown");
    // The run is still going: its receipt is pending and the line is not through yet.
    expect(receipts.get(ID)).toMatchObject({ state: "pending" });
    await vc.drain();
    const settled = receipts.get(ID);
    expect(settled !== undefined && !isUnsettled(settled) ? settled.paneId : null).toBe("w7:p1");
    // The retap replays the pane the run made. Nothing is created twice.
    const again = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(again.body).toMatchObject({ ok: true, replayed: true, pane: { paneId: "w7:p1" } });
    expect(mux.spaces).toHaveLength(1);
    expect(mux.texts).toHaveLength(1);
  });

  test("a retap while the run still goes joins it, on its own deadline", async () => {
    const mux = slowMux();
    const receipts = memoryLaunchReceipts();
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(504);
    const startedAt = vc.now();
    const joined = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(joined.body).toMatchObject({ ok: true, replayed: true, pane: { paneId: "w7:p1" } });
    expect(vc.now() - startedAt).toBeLessThan(MEMBER_DEADLINE_MS);
    expect(mux.spaces).toHaveLength(1);
  });

  test("a retap that joins a run that will not end is answered at its own deadline", async () => {
    const mux = slowMux();
    mux.slow = { create: 5000, snapshot: 0, type: 100 * MEMBER_DEADLINE_MS };
    const receipts = memoryLaunchReceipts();
    await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    const startedAt = vc.now();
    const joined = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(joined.status).toBe(504);
    expect(vc.now() - startedAt).toBe(MEMBER_DEADLINE_MS);
  });

  test("a run that ends past the deadline as unknown settles its receipt as unknown", async () => {
    const mux = slowMux();
    mux.typeAnswer = "refused";
    mux.closeAnswer = "refused";
    const receipts = memoryLaunchReceipts();
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(504);
    await vc.drain();
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(504);
    expect(mux.spaces).toHaveLength(1);
  });

  test("a snapshot that hangs for ever ends the run unknown at the sum of its own bounds, not at the deadline", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [];
    mux.pause = (ms) => (ms === 0 ? Promise.resolve() : vc.sleep(ms));
    mux.slow = { create: 5000, snapshot: 0, type: 0 };
    mux.snapshot = hangs;
    const receipts = memoryLaunchReceipts();
    const { status } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(504);
    // The "before" read gave up at 4 s, the create took 5 s, and no look can start without a "before".
    expect(vc.now()).toBe(CONFIRM_BOUND_MS + 5000);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a tab and a space create hold the same deadline", async () => {
    const mux = new FakeMux();
    mux.pause = (ms) => (ms === 0 ? Promise.resolve() : vc.sleep(ms));
    mux.slow = { create: 100 * MEMBER_DEADLINE_MS, snapshot: 0, type: 0 };
    expect((await tab(mux, memoryLaunchReceipts(), { workspaceId: "w1", requestId: ID })).status).toBe(504);
    expect(vc.now()).toBe(MEMBER_DEADLINE_MS);
    const before = vc.now();
    expect((await space(mux, memoryLaunchReceipts(), { requestId: ID2 })).status).toBe(504);
    expect(vc.now() - before).toBe(MEMBER_DEADLINE_MS);
  });

  test("the member's worst case without the deadline is longer than the lead's budget, so the deadline is what holds", () => {
    // create 5 s + look 4 s + shell wait 5 s + a send on the core 6.4 s.
    expect(5000 + CONFIRM_BOUND_MS + 5000 + 6400).toBeGreaterThan(LAUNCH_BUDGET_MS);
    expect(MEMBER_DEADLINE_MS).toBeLessThan(LAUNCH_BUDGET_MS);
  });
});

describe("a pane that could not be closed, and a throw, never leave the receipt wrong", () => {
  test("a failed line whose pane closes forgets the id, so it may run again", async () => {
    const mux = new FakeMux();
    mux.typeAnswer = "refused";
    const receipts = memoryLaunchReceipts();
    const { body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(body.ok).toBe(false);
    expect(mux.closes).toEqual(["w1:p1"]);
    expect(receipts.get(ID)).toBeUndefined();
  });

  test("a failed line whose pane stays open keeps the receipt, as unknown, and the id starts nothing new", async () => {
    const mux = new FakeMux();
    mux.typeAnswer = "refused";
    mux.closeAnswer = "refused";
    const receipts = memoryLaunchReceipts();
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).body.ok).toBe(false);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    mux.typeAnswer = "ok";
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(504);
    expect(mux.spaces).toHaveLength(1);
  });

  test("a close that throws is the same: the receipt stays, as unknown", async () => {
    const mux = new FakeMux();
    mux.typeAnswer = "refused";
    mux.closePane = () => Promise.reject(new Error("socket closed"));
    const receipts = memoryLaunchReceipts();
    await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a create call that throws leaves unknown behind, on a launch, a tab and a space", async () => {
    for (const run of [
      (mux: FakeMux, receipts: LaunchReceiptSurface) => launchRaw(mux, receipts, { command: "claude", requestId: ID }),
      (mux: FakeMux, receipts: LaunchReceiptSurface) => tabRaw(mux, receipts, { workspaceId: "w1", requestId: ID }),
      (mux: FakeMux, receipts: LaunchReceiptSurface) => spaceRaw(mux, receipts, { requestId: ID }),
    ]) {
      const mux = new FakeMux();
      mux.throwOnCreate = true;
      const receipts = memoryLaunchReceipts();
      let thrown = false;
      await vc.run(run(mux, receipts)).catch(() => {
        thrown = true;
      });
      expect(thrown).toBe(true);
      expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    }
  });

  test("a step after the create that throws leaves unknown behind too, on a launch, a tab and a space", async () => {
    pokeThrows = true;
    for (const run of [
      (mux: FakeMux, receipts: LaunchReceiptSurface) => launchRaw(mux, receipts, { command: "claude", requestId: ID }),
      (mux: FakeMux, receipts: LaunchReceiptSurface) => tabRaw(mux, receipts, { workspaceId: "w1", requestId: ID }),
      (mux: FakeMux, receipts: LaunchReceiptSurface) => spaceRaw(mux, receipts, { requestId: ID }),
    ]) {
      const mux = new FakeMux();
      const receipts = memoryLaunchReceipts();
      let thrown = false;
      await vc.run(run(mux, receipts)).catch(() => {
        thrown = true;
      });
      expect(thrown).toBe(true);
      expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
      // The pane exists, so the same id must not make another.
      expect(mux.spaces.length + mux.tabs.length).toBe(1);
    }
  });
});

describe("a look that found nothing is a time-out, not a fact (M100 spec 04, review point 5)", () => {
  const HOME_NAME = basename(homedir());
  /** A create the adapter gave up on at 5 s: the pane lands after the look's bound, so the look sees nothing. */
  function lateMux(): FakeMux {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [];
    return mux;
  }
  const landed = (mux: FakeMux, over: Partial<MuxPane> = {}) => {
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: homedir(), ...over })];
  };

  test("a launch: the pane appears after the bound, the same id creates nothing and answers unknown", async () => {
    const mux = lateMux();
    const receipts = memoryLaunchReceipts();
    const first = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(first.status).toBe(504);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    landed(mux);
    const retap = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(retap.status).toBe(504);
    expect(retap.body).toMatchObject({ ok: false, code: "write_outcome_unknown", error: LAUNCH_UNKNOWN_TEXT });
    expect(mux.spaces).toHaveLength(1);
    expect(mux.texts).toEqual([]);
  });

  test("the receipt outlasts the phone's 30 s window by a wide margin: it is kept until the store's own cap pushes it out", async () => {
    const mux = lateMux();
    const receipts = memoryLaunchReceipts();
    await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    await vc.run(vc.sleep(10 * 60_000));
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
  });

  test("a tab create: the same", async () => {
    const mux = lateMux();
    const receipts = memoryLaunchReceipts();
    expect((await tab(mux, receipts, { workspaceId: "w1", cwd: "/home/op/app", requestId: ID })).status).toBe(504);
    mux.shown = [pane({ paneId: "w1:p5", spaceId: "w1", tabId: "w1:t5" })];
    const retap = await tab(mux, receipts, { workspaceId: "w1", cwd: "/home/op/app", requestId: ID });
    expect(retap.status).toBe(504);
    expect(await retap.json()).toMatchObject({ code: "write_outcome_unknown", error: LAUNCH_UNKNOWN_TEXT });
    expect(mux.tabs).toHaveLength(1);
  });

  test("a space create: the same", async () => {
    const mux = lateMux();
    const receipts = memoryLaunchReceipts();
    expect((await space(mux, receipts, { cwd: "/home/op/app", requestId: ID })).status).toBe(504);
    landed(mux, { cwd: "/home/op/app" });
    const retap = await space(mux, receipts, { cwd: "/home/op/app", requestId: ID });
    expect(retap.status).toBe(504);
    expect(mux.spaces).toHaveLength(1);
  });

  test("a create with no request id answers unknown too: nothing to guard, but nothing was proven either", async () => {
    const mux = lateMux();
    const res = await space(mux, memoryLaunchReceipts(), { cwd: "/home/op/app" });
    expect(res.status).toBe(504);
  });

  test("a create the multiplexer REFUSED forgets the id: a retap creates", async () => {
    const mux = new FakeMux();
    mux.answer = "refused";
    const receipts = memoryLaunchReceipts();
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).body).toMatchObject({ ok: false, code: "workspace.create_failed" });
    expect(receipts.get(ID)).toBeUndefined();
    mux.answer = "ok";
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).status).toBe(200);
    expect(mux.spaces).toHaveLength(2);
  });

  test("a bare tab create (no folder, no label) whose tab shows up is not adopted: unknown, nothing typed, receipt unknown", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w1:p5", spaceId: "w1", tabId: "w1:t5" })];
    const receipts = memoryLaunchReceipts();
    const res = await tab(mux, receipts, { workspaceId: "w1", requestId: ID });
    expect(res.status).toBe(504);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown" });
    expect((await tab(mux, receipts, { workspaceId: "w1", requestId: ID })).status).toBe(504);
    expect(mux.tabs).toHaveLength(1);
  });
});

describe("a pane the look found is typed into only at a real shell prompt", () => {
  const HOME_NAME = basename(homedir());
  function found(screen: (read: number) => string): FakeMux {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: homedir() })];
    mux.screen = screen;
    return mux;
  }

  test("a screen that holds still but ends in output, not a prompt: nothing is typed, the pane's own sentence, and a retap says the same words", async () => {
    const mux = found(() => "Last login: today\nbuilding project...");
    const receipts = memoryLaunchReceipts();
    const { status, body } = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(status).toBe(504);
    expect(body).toMatchObject({ code: "write_outcome_unknown", error: LAUNCH_NO_PROMPT_TEXT });
    expect(mux.texts).toEqual([]);
    expect(mux.closes).toEqual([]);
    expect(receipts.get(ID)).toMatchObject({ state: "unknown", text: LAUNCH_NO_PROMPT_TEXT });
    // The retap cannot know which case it was; the receipt kept the words.
    const retap = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(retap.status).toBe(504);
    expect(retap.body).toMatchObject({ error: LAUNCH_NO_PROMPT_TEXT });
    expect(mux.spaces).toHaveLength(1);
    expect(mux.texts).toEqual([]);
  });

  test("a pane that holds an agent already gets the same sentence", async () => {
    const mux = found(() => "$ ");
    mux.shown = [pane({ paneId: "w7:p1", spaceId: "w7", tabId: "w7:t1", spaceLabel: HOME_NAME, cwd: homedir(), agent: "claude" })];
    const { body } = await launchOnce(mux, memoryLaunchReceipts(), { command: "claude", requestId: ID });
    expect(body).toMatchObject({ error: LAUNCH_NO_PROMPT_TEXT });
    expect(mux.texts).toEqual([]);
  });

  test("nothing seen keeps the general sentence, on the first answer and on the retap", async () => {
    const mux = new FakeMux();
    mux.answer = "unconfirmed";
    const receipts = memoryLaunchReceipts();
    const first = await launchOnce(mux, receipts, { command: "claude", requestId: ID });
    expect(first.body).toMatchObject({ ok: false, code: "write_outcome_unknown" });
    expect(first.body.error).not.toBe(LAUNCH_NO_PROMPT_TEXT);
    expect(receipts.get(ID)).toEqual({ requestId: ID, at: expect.any(Number), state: "unknown" });
    expect((await launchOnce(mux, receipts, { command: "claude", requestId: ID })).body.error).toBe(LAUNCH_UNKNOWN_TEXT);
  });

  test("a launch with no line to type (a plain shell) adopts the found pane and types nothing: no sentence is needed", async () => {
    const mux = found(() => "building project...");
    const { status, body } = await launchOnce(mux, memoryLaunchReceipts(), { shell: true, requestId: ID });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, pane: { paneId: "w7:p1" } });
    expect(mux.texts).toEqual([]);
  });

  test("a tab and a space create type nothing, so a found pane is adopted with no prompt read", async () => {
    const tabMux = new FakeMux();
    tabMux.answer = "unconfirmed";
    tabMux.shown = [pane({ paneId: "w1:p5", spaceId: "w1", tabId: "w1:t5" })];
    tabMux.screen = () => "output";
    expect((await tab(tabMux, memoryLaunchReceipts(), { workspaceId: "w1", cwd: "/home/op/app", requestId: ID })).status).toBe(200);
    const spaceMux = found(() => "output");
    expect((await space(spaceMux, memoryLaunchReceipts(), { cwd: homedir(), requestId: ID2 })).status).toBe(200);
  });

  test("a prompt on the last non-blank row, with blank rows under it, is typed into", async () => {
    const mux = found(() => "Last login: today\nuser@host:~/work$ \n\n\n");
    const { status } = await launchOnce(mux, memoryLaunchReceipts(), { command: "claude", requestId: ID });
    expect(status).toBe(200);
    expect(mux.texts).toEqual([["w7:p1", "claude"]]);
  });

  test("a prompt that is drawn late is waited for inside the bound", async () => {
    const mux = found((read) => (read < 6 ? "starting shell..." : "~/work $"));
    expect((await launchOnce(mux, memoryLaunchReceipts(), { command: "claude", requestId: ID })).status).toBe(200);
    expect(mux.texts).toHaveLength(1);
  });

  test("a pane the create call confirmed keeps today's path: no prompt is asked for", async () => {
    const mux = new FakeMux();
    mux.screen = () => "welcome to a shell that draws no recognisable prompt";
    const { status } = await launchOnce(mux, memoryLaunchReceipts(), { command: "claude", requestId: ID });
    expect(status).toBe(200);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
  });
});
