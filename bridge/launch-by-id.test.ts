import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { realLinkDisk } from "./account-links.ts";
import { signInFolder } from "./account-folder.ts";
import { Accounts } from "./accounts-routes.ts";
import { accountTest } from "./accounts-skip.ts";
import { memoryAccountStore } from "./accounts-store.ts";
import { AuditLog } from "./audit.ts";
import { harnessLaunch } from "./harness-launch.ts";
import { LAUNCH_RECEIPTS_FILE, LaunchReceiptStore, coerceLaunchReceipt, isUnsettled, memoryLaunchReceipts } from "./launch-receipts.ts";
import type { JsonObject } from "./json.ts";
import { LEAD_ROW_HEADER, LEAD_ROW_MARK } from "./crew/launcher-rows.ts";
import { LaunchWindow } from "./launch-window.ts";
import { launch, launchersRoute, type LaunchDeps } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView, CreateResponse, Launcher, LaunchersResponse } from "./types.ts";
import {
  muxAck,
  muxOk,
  muxRefused,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxOutcome,
  type MuxSpaceRequest,
  type MuxTabRequest,
} from "./mux/types.ts";
import { declareCapabilities } from "./mux/capabilities.ts";

// `POST /api/launch` by id, with a request id and a receipt (ADR 0091). The claims:
//
//   1. `harness` names an id from the bridge's own list and the BRIDGE types its binary; an id it
//      does not start is a 400 before anything runs. The phone never sends a command line.
//   2. Exactly one of `command`, `harness` and `shell: true`; none or two is a 400.
//   3. `cwd` opens the pane there; a row's pinned `cwd` still wins; a relative one is under home.
//   4. A known `requestId` replays the first pane and the multiplexer is asked once in all; a second
//      request while the first runs is joined. A failed launch stores nothing.
//   5. `GET /api/launchers` carries the harness list when built with a probe, and not otherwise.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const HTOP: Launcher = { command: "htop", label: "htop", cwd: "/home/op/pinned" };

function engine(): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: `launch` reaches only `current()` (a beside-pane lookup, unused here) and `pokeNow()`.
  return stub as StateEngine;
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

class FakeMux {
  readonly spaces: MuxSpaceRequest[] = [];
  readonly texts: Array<[string, string]> = [];
  readonly closes: string[] = [];
  readonly tabRenames: Array<[string, string]> = [];
  // What a launch asks: a new space, and the tab rename that follows it (a fake with no `capabilities`
  // would throw in `supportsCapability`).
  capabilities = declareCapabilities({ supports: ["createSpace", "createTab", "renameTab"], topologyLatency: { kind: "push" } });
  failText = false;
  /** `renameTab` throws, as an adapter that fails mid-call would. */
  renameThrows = false;
  gate: Promise<void> | null = null;
  private n = 0;

  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    if (this.gate) await this.gate;
    this.n++;
    return muxOk({ paneId: `w${this.n}:p1`, spaceId: `w${this.n}`, spaceLabel: request.label ?? "shell", tabId: `w${this.n}:t1`, cwd: request.cwd ?? "/" });
  }
  renameTab(tabId: string, label: string): Promise<MuxAck> {
    this.tabRenames.push([tabId, label]);
    return this.renameThrows ? Promise.reject(new Error("rename failed")) : Promise.resolve(muxAck());
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(this.failText ? muxRefused("pane is gone") : muxAck());
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
  // SAFETY: a launch from the dashboard reaches createSpace, renameTab, readGrid, typeText, sendKeys,
  // closePane (on a failed send) and refresh, plus the `capabilities` declaration — what FakeMux implements.
  return fake as MuxAdapter;
}

const post = (body: JsonObject, headers: Record<string, string> = {}) =>
  new Request("http://x/api/launch", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

/** A disk where every folder is a directory, or only `present` are (as absolute paths). */
function dirs(present?: readonly string[]) {
  return { isDirectory: (path: string) => Promise.resolve(present === undefined || present.includes(path)) };
}

async function run(fake: FakeMux, body: JsonObject, deps: LaunchDeps = {}) {
  const res = await launch(
    asMux(fake),
    engine(),
    post(body),
    new AuditLog(() => {}),
    null,
    "default",
    () => Promise.resolve([HTOP]),
    clock(),
    { harnesses: { launch: harnessLaunch }, home: "/home/op", fs: dirs(), ...deps },
  );
  // SAFETY: `launch` answers a CreateResponse as JSON, or a plain-text 400 that parses to `null` here.
  const parsed = (await res.json().catch(() => null)) as CreateResponse | null;
  return { status: res.status, body: parsed };
}

describe("POST /api/launch — by id", () => {
  test("a Kiro id launch types its program, kiro-cli, not the id", async () => {
    const mux = new FakeMux();
    const { status } = await run(mux, { harness: "kiro", cwd: "/home/op/src/app" });
    expect(status).toBe(200);
    expect(mux.texts).toEqual([["w1:p1", "kiro-cli"]]);
  });

  test("a harness id opens a space and the bridge types that harness's binary", async () => {
    const mux = new FakeMux();
    const { status, body } = await run(mux, { harness: "claude", cwd: "/home/op/src/app" });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    // The space takes the folder's name, the way Herdr names one opened by hand; the tab takes the harness's.
    expect(mux.spaces).toEqual([{ cwd: "/home/op/src/app", label: "app" }]);
    expect(mux.tabRenames).toEqual([["w1:t1", "Claude Code"]]);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
  });

  test("a harness launch marks its pane in the launch window once the line is typed; a shell, a row and a failed launch mark nothing", async () => {
    const window = new LaunchWindow();
    const mux = new FakeMux();
    const { body } = await run(mux, { harness: "omp", cwd: "/home/op/src/app" }, { launchWindow: window });
    expect(body?.ok).toBe(true);
    expect(window.expecting("default", "w1:p1")).toBe("omp");
    expect(window.expecting("other", "w1:p1")).toBeNull();

    const shell = new LaunchWindow();
    await run(new FakeMux(), { shell: true }, { launchWindow: shell });
    await run(new FakeMux(), { command: "htop" }, { launchWindow: shell });
    expect(shell.expecting("default", "w1:p1")).toBeNull();

    const failed = new LaunchWindow();
    const broken = new FakeMux();
    broken.failText = true;
    await run(broken, { harness: "omp" }, { launchWindow: failed });
    expect(failed.expecting("default", "w1:p1")).toBeNull();
  });

  test("an adapter that declares no renameTab still launches, and no rename is asked", async () => {
    const mux = new FakeMux();
    mux.capabilities = declareCapabilities({ supports: ["createSpace", "createTab"], topologyLatency: { kind: "push" } });
    const { status, body } = await run(mux, { harness: "claude", cwd: "/home/op/src/app" });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(mux.spaces).toEqual([{ cwd: "/home/op/src/app", label: "app" }]);
    expect(mux.tabRenames).toEqual([]);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
  });

  test("a tab rename that throws does not fail the launch", async () => {
    const mux = new FakeMux();
    mux.renameThrows = true;
    const { status, body } = await run(mux, { harness: "claude", cwd: "/home/op/src/app" });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(mux.tabRenames).toEqual([["w1:t1", "Claude Code"]]);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
  });

  test("an id the bridge does not start is refused before anything runs", async () => {
    const mux = new FakeMux();
    const { status, body } = await run(mux, { harness: "claude; rm -rf ~" });
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.unknown_harness" });
    expect(mux.spaces).toEqual([]);
  });

  test("a bridge built with no harness list starts no harness", async () => {
    const mux = new FakeMux();
    const { status } = await run(mux, { harness: "claude" }, { harnesses: undefined });
    expect(status).toBe(400);
    expect(mux.spaces).toEqual([]);
  });

  test("shell: true opens a space in the folder and types nothing", async () => {
    const mux = new FakeMux();
    const { body } = await run(mux, { shell: true, cwd: "~/src" });
    expect(body?.ok).toBe(true);
    expect(mux.spaces).toEqual([{ cwd: join("/home/op", "src"), label: undefined }]);
    expect(mux.texts).toEqual([]);
  });

  test("none, or two, of the three kinds is a plain 400", async () => {
    const mux = new FakeMux();
    expect((await run(mux, { cwd: "/home/op" })).status).toBe(400);
    expect((await run(mux, { harness: "claude", command: "htop" })).status).toBe(400);
    expect((await run(mux, { shell: true, harness: "claude" })).status).toBe(400);
    expect(mux.spaces).toEqual([]);
  });

  test("a row's pinned folder wins over the folder the sheet named", async () => {
    const mux = new FakeMux();
    await run(mux, { command: "htop", cwd: "/home/op/elsewhere" });
    expect(mux.spaces[0]?.cwd).toBe("/home/op/pinned");
    expect(mux.texts).toEqual([["w1:p1", "htop"]]);
  });

  test("a folder with a control character, a .. segment or ~name is refused", async () => {
    const mux = new FakeMux();
    for (const cwd of ["/home/op/a\nb", "src/../app", "/home/op/../etc", "~other/src", "..\\x"]) {
      expect((await run(mux, { shell: true, cwd })).body, cwd).toMatchObject({ code: "launch.bad_folder" });
    }
    expect(mux.spaces).toEqual([]);
  });

  test("a path with no leading / or ~ is a folder under home, as cd is in a fresh shell", async () => {
    const mux = new FakeMux();
    const { body } = await run(mux, { shell: true, cwd: "projects/app" });
    expect(body?.ok).toBe(true);
    expect(mux.spaces).toEqual([{ cwd: join("/home/op", "projects", "app"), label: undefined }]);
    await run(mux, { shell: true, cwd: "~" });
    expect(mux.spaces[1]?.cwd).toBe("/home/op");
  });

  test("a folder that is not there, or is not a directory, is refused before anything runs", async () => {
    const mux = new FakeMux();
    const answer = await run(mux, { harness: "claude", cwd: "projects" }, { fs: dirs(["/home/op"]) });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      ok: false,
      code: "launch.folder_missing",
      detail: { folder: join("/home/op", "projects") },
      error: `there is no folder ${join("/home/op", "projects")} on this machine`,
    });
    expect(mux.spaces).toEqual([]);
    expect(mux.texts).toEqual([]);
  });

  test("only the folder the person named is checked: not a pinned folder, the pane's, or home", async () => {
    const mux = new FakeMux();
    const none = dirs([]);
    expect((await run(mux, { command: "htop", cwd: "/home/op/typed" }, { fs: none })).body?.ok).toBe(true);
    expect((await run(mux, { shell: true }, { fs: none })).body?.ok).toBe(true);
  });

  test("a refused folder stores no receipt, so the same id can try again", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    await run(mux, { shell: true, cwd: "later", requestId: ID }, { receipts, fs: dirs([]) });
    const second = await run(mux, { shell: true, cwd: "later", requestId: ID }, { receipts, fs: dirs([join("/home/op", "later")]) });
    expect(second.body?.ok).toBe(true);
    expect(mux.spaces).toHaveLength(1);
  });

  test("with no folder named, a launch opens in the session's own folder, never over a named one", async () => {
    const mux = new FakeMux();
    const UNPINNED: Launcher = { command: "claude 1", label: "Claude" };
    const sessionFolder = "/home/op/projects/yt";
    const res = await launch(asMux(mux), engine(), post({ command: "claude 1" }), new AuditLog(() => {}), null, "project-yt",
      () => Promise.resolve([UNPINNED]), clock(), { home: "/home/op", fs: dirs(), sessionFolder });
    expect(res.status).toBe(200);
    await run(mux, { shell: true }, { sessionFolder });
    await run(mux, { shell: true, cwd: "/home/op/typed" }, { sessionFolder });
    await run(mux, { command: "htop" }, { sessionFolder });
    expect(mux.spaces.map((s) => s.cwd)).toEqual([sessionFolder, sessionFolder, "/home/op/typed", "/home/op/pinned"]);
  });

  test("from a pane, the pane's own folder wins over the session folder", async () => {
    const tabs: MuxTabRequest[] = [];
    const mux = new FakeMux();
    const createTab = (request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> => {
      tabs.push(request);
      return Promise.resolve(muxOk({ paneId: "w1:p2", spaceId: "w1", spaceLabel: "s", tabId: "w1:t2", cwd: request.cwd ?? "/" }));
    };
    // SAFETY: `launch` reads only `paneId`, `workspaceId` and `cwd` off the beside pane.
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/op/pane" } as AgentView;
    const withPane: Partial<StateEngine> = {
      pokeNow: () => {},
      current: () => ({ agents: [], shellPanes: [pane], workspaces: [], tabs: [], bridge: "connected" }),
    };
    // SAFETY: as engine() above, with one shell pane to launch beside.
    const res = await launch(asMux(Object.assign(mux, { createTab })), withPane as StateEngine, post({ shell: true, paneId: "w1:p1" }),
      new AuditLog(() => {}), null, "project-yt", () => Promise.resolve([]), clock(), { home: "/home/op", fs: dirs(), sessionFolder: "/srv/yt" });
    expect(res.status).toBe(200);
    expect(tabs.map((t) => t.cwd)).toEqual(["/home/op/pane"]);
  });

  test("a session folder is the operator's default, not the person's ask: it never joins Recent", async () => {
    const recorded: string[] = [];
    const folders = { recordRecent: (f: string) => Promise.resolve(void recorded.push(f)) };
    await run(new FakeMux(), { shell: true }, { folders, sessionFolder: "/home/op/projects/yt" });
    expect(recorded).toEqual([]);
  });

  test("a folder that worked joins Recent; a pinned one does not", async () => {
    const recorded: string[] = [];
    const folders = { recordRecent: (f: string) => Promise.resolve(void recorded.push(f)) };
    await run(new FakeMux(), { harness: "codex", cwd: "/home/op/src/app" }, { folders });
    await run(new FakeMux(), { command: "htop", cwd: "/home/op/x" }, { folders });
    expect(recorded).toEqual(["/home/op/src/app"]);
  });
});

// A sign-in start (M101) runs in a folder the bridge owns, `sign-in` under its state folder: an agent
// started only to log in must not ask about, or get trust for, home or a neighbouring pane's folder.
describe("POST /api/launch — a sign-in start's folder", () => {
  let state = "";
  beforeEach(async () => {
    state = await mkdtemp(join(tmpdir(), "collie-sign-in-"));
  });
  afterEach(async () => {
    await rm(state, { recursive: true, force: true });
  });

  /** One shell pane the launch can open beside, and a multiplexer that records the tab's folder. */
  async function beside(body: JsonObject, deps: LaunchDeps) {
    const tabs: MuxTabRequest[] = [];
    const mux = new FakeMux();
    const createTab = (request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> => {
      tabs.push(request);
      return Promise.resolve(muxOk({ paneId: "w1:p2", spaceId: "w1", spaceLabel: "s", tabId: "w1:t2", cwd: request.cwd ?? "/" }));
    };
    // SAFETY: `launch` reads only `paneId`, `workspaceId` and `cwd` off the beside pane.
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/op/pane" } as AgentView;
    const withPane: Partial<StateEngine> = {
      pokeNow: () => {},
      current: () => ({ agents: [], shellPanes: [pane], workspaces: [], tabs: [], bridge: "connected" }),
    };
    // SAFETY: as engine() above, with one shell pane to launch beside.
    const res = await launch(asMux(Object.assign(mux, { createTab })), withPane as StateEngine, post({ paneId: "w1:p1", ...body }),
      new AuditLog(() => {}), null, "default", () => Promise.resolve([]), clock(), { harnesses: { launch: harnessLaunch }, home: "/home/op", ...deps });
    return { status: res.status, tabs, mux };
  }

  test("with no folder named, it opens in <state>/sign-in, which the bridge made private and left empty", async () => {
    const mux = new FakeMux();
    const { status, body } = await run(mux, { harness: "claude", signIn: true }, { stateDir: state, fs: undefined, sessionFolder: "/home/op/projects/yt" });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    const folder = join(state, "sign-in");
    expect(signInFolder(state)).toBe(folder);
    expect(mux.spaces.map((s) => s.cwd)).toEqual([folder]);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
    const made = await stat(folder);
    expect(made.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(made.mode & 0o777).toBe(0o700);
    expect(await readdir(folder)).toEqual([]);
    // Started again with the folder there: no error, nothing written.
    expect((await run(new FakeMux(), { harness: "claude", signIn: true }, { stateDir: state, fs: undefined })).status).toBe(200);
    expect(await readdir(folder)).toEqual([]);
  });

  test("a folder the body names still wins, and nothing is made", async () => {
    const mux = new FakeMux();
    const { status } = await run(mux, { harness: "claude", signIn: true, cwd: "/home/op/src/app" }, { stateDir: state });
    expect(status).toBe(200);
    expect(mux.spaces.map((s) => s.cwd)).toEqual(["/home/op/src/app"]);
    expect(await readdir(state)).toEqual([]);
  });

  test("beside a pane it does not take the pane's folder", async () => {
    const out = await beside({ harness: "claude", signIn: true }, { stateDir: state, fs: undefined });
    expect(out.status).toBe(200);
    expect(out.tabs.map((t) => t.cwd)).toEqual([join(state, "sign-in")]);
    // Any other start beside the same pane keeps the pane's folder.
    const plain = await beside({ harness: "claude" }, { stateDir: state, fs: undefined });
    expect(plain.tabs.map((t) => t.cwd)).toEqual(["/home/op/pane"]);
  });

  test("a start that is not a sign-in is as it was: session folder, then home", async () => {
    const mux = new FakeMux();
    await run(mux, { harness: "claude" }, { stateDir: state, sessionFolder: "/home/op/projects/yt" });
    await run(mux, { harness: "claude", signIn: false }, { stateDir: state });
    expect(mux.spaces.map((s) => s.cwd)).toEqual(["/home/op/projects/yt", homedir()]);
    expect(await readdir(state)).toEqual([]);
  });

  test("with no state folder given, a sign-in start is as any other start", async () => {
    const mux = new FakeMux();
    await run(mux, { harness: "claude", signIn: true }, { sessionFolder: "/home/op/projects/yt" });
    expect(mux.spaces.map((s) => s.cwd)).toEqual(["/home/op/projects/yt"]);
  });

  test("a folder that cannot be made is refused as launch.folder_missing, with nothing launched", async () => {
    const folder = join(state, "sign-in");
    await writeFile(folder, "in the way");
    const mux = new FakeMux();
    const out = await run(mux, { harness: "claude", signIn: true }, { stateDir: state, fs: undefined, sessionFolder: "/home/op/projects/yt" });
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, code: "launch.folder_missing", detail: { folder } });
    expect(mux.spaces).toEqual([]);
    expect(mux.texts).toEqual([]);
  });

  test("the folder never joins Recent", async () => {
    const recorded: string[] = [];
    const folders = { recordRecent: (f: string) => Promise.resolve(void recorded.push(f)) };
    const { body } = await run(new FakeMux(), { harness: "claude", signIn: true }, { stateDir: state, fs: undefined, folders });
    expect(body?.ok).toBe(true);
    expect(recorded).toEqual([]);
  });
});

/** A launch whose audit lines are kept, parsed. */
async function audited(fake: FakeMux, body: JsonObject, deps: LaunchDeps = {}, headers: Record<string, string> = {}) {
  const lines: string[] = [];
  const res = await launch(
    asMux(fake),
    engine(),
    post(body, headers),
    new AuditLog((line) => void lines.push(line)),
    null,
    "default",
    () => Promise.resolve([HTOP]),
    clock(),
    { harnesses: { launch: harnessLaunch }, home: "/home/member", fs: dirs(), ...deps },
  );
  // SAFETY: `launch` answers a CreateResponse as JSON, or a plain-text 400 that parses to `null` here.
  const parsed = (await res.json().catch(() => null)) as CreateResponse | null;
  // SAFETY: each line is one JSON audit entry (audit.ts `formatAuditLine`); only `action` and `detail` are read.
  const entries = lines.map((line) => JSON.parse(line) as { action: string; detail?: JsonObject });
  return { status: res.status, body: parsed, entries };
}

describe("POST /api/launch — a lead row carried over the crew link (ADR 0127 point 3)", () => {
  const ROW = { command: "claude --resume", label: "Claude resume", cwd: "~/src/app", harness: "claude", noPrompts: false };
  /** The call came over the crew link, which on a member means its lead. */
  const CREW: LaunchDeps = { viaCrew: true };
  /** The lead's own mark, which it adds only on a forward where it set `row` itself. */
  const MARK = { [LEAD_ROW_HEADER]: LEAD_ROW_MARK };

  test("a lead row forwarded to a member runs there, its `cwd` under the member's home, audited `source: lead`", async () => {
    const mux = new FakeMux();
    // `~/src/app` expands with `join`, this machine's own separators: `\home\member\src\app` on Windows.
    const cwd = join("/home/member", "src", "app");
    const { status, body, entries } = await audited(mux, { command: "claude --resume", row: ROW }, CREW, MARK);
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(mux.spaces).toEqual([{ cwd, label: "app" }]);
    expect(mux.tabRenames).toEqual([["w1:t1", "Claude resume"]]);
    expect(mux.texts).toEqual([["w1:p1", "claude --resume"]]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("workspace.launch");
    expect(entries[0]!.detail).toMatchObject({ command: "claude --resume", cwd, source: "lead" });
  });

  test("a lead row with no pinned folder opens where an own row would: the folder the sheet named", async () => {
    const mux = new FakeMux();
    const { command, label, noPrompts } = ROW;
    const { status } = await audited(mux, { command, cwd: "/home/member/elsewhere", row: { command, label, noPrompts } }, CREW, MARK);
    expect(status).toBe(200);
    expect(mux.spaces).toEqual([{ cwd: "/home/member/elsewhere", label: "elsewhere" }]);
  });

  test("a phone-direct body with `row` is refused with `launch.row_not_from_lead`, and nothing runs", async () => {
    const mux = new FakeMux();
    const { status, body, entries } = await audited(mux, { command: "claude --resume", row: ROW });
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("an old lead's shape, a body `row` over the crew link with no mark, is refused, and nothing runs", async () => {
    // A lead before 0127 forwards a phone's launch body unchanged, `row` and all, and never adds the mark.
    const mux = new FakeMux();
    const { status, body, entries } = await audited(mux, { command: "claude --resume", row: ROW }, CREW);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
    expect(mux.texts).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("the mark on a call that did not come over the crew link is no mark: refused, and nothing runs", async () => {
    const mux = new FakeMux();
    const { status, body, entries } = await audited(mux, { command: "claude --resume", row: ROW }, {}, MARK);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("a mark with another value is no mark", async () => {
    const mux = new FakeMux();
    const { status, body } = await audited(mux, { command: "claude --resume", row: ROW }, CREW, { [LEAD_ROW_HEADER]: "true" });
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
  });

  test("this machine's own row wins over a carried row with the same command, and `row` is not read", async () => {
    const mux = new FakeMux();
    const carried = { command: "htop", label: "Lead htop", cwd: "/srv/elsewhere", noPrompts: false };
    const { status, entries } = await audited(mux, { command: "htop", row: carried }, CREW, MARK);
    expect(status).toBe(200);
    // HTOP's own pinned folder and label, not the carried row's.
    expect(mux.spaces).toEqual([{ cwd: "/home/op/pinned", label: "pinned" }]);
    expect(mux.tabRenames).toEqual([["w1:t1", "htop"]]);
    expect(entries[0]!.detail).not.toHaveProperty("source");
    // The same holds for a phone: its own row runs, and the `row` it sent is simply not read.
    const phone = await audited(new FakeMux(), { command: "htop", row: carried });
    expect(phone.status).toBe(200);
  });

  test("a command this host does not hold, with no `row`, is still `launch.not_allowlisted` (an old member's answer too)", async () => {
    const { status, body } = await audited(new FakeMux(), { command: "claude --resume" }, CREW);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.not_allowlisted" });
  });

  test("a carried row that is not one is a plain 400 from the lead, and nothing runs", async () => {
    const mux = new FakeMux();
    const bad = [
      { ...ROW, command: "rm -rf ~" },
      { ...ROW, label: "" },
      { command: ROW.command, label: ROW.label },
      { ...ROW, cwd: "relative/path" },
      { ...ROW, cwd: "~other/src" },
      "claude --resume",
    ];
    for (const row of bad) {
      const { status, body } = await audited(mux, { command: "claude --resume", row }, CREW, MARK);
      expect(status).toBe(400);
      expect(body).toBeNull();
    }
    expect(mux.spaces).toEqual([]);
  });
});

describe("POST /api/launch — request ids", () => {
  test("a repeat with a known id replays the first pane and runs nothing", async () => {
    const mux = new FakeMux();
    const receipts = memoryLaunchReceipts();
    const first = await run(mux, { harness: "claude", requestId: ID }, { receipts });
    const again = await run(mux, { harness: "claude", requestId: ID }, { receipts });
    expect(mux.spaces).toHaveLength(1);
    expect(mux.texts).toHaveLength(1);
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(again.body?.ok && first.body?.ok && again.body.pane.paneId === first.body.pane.paneId).toBe(true);
  });

  test("a repeat while the first is still running joins it", async () => {
    const mux = new FakeMux();
    let open!: () => void;
    mux.gate = new Promise((r) => (open = r));
    const receipts = memoryLaunchReceipts();
    const a = run(mux, { shell: true, requestId: ID }, { receipts });
    const b = run(mux, { shell: true, requestId: ID }, { receipts });
    await Bun.sleep(0);
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(mux.spaces).toHaveLength(1);
    expect(ra.body?.ok).toBe(true);
    expect(rb.body).toMatchObject({ ok: true, replayed: true });
  });

  test("a failed launch stores nothing, so the same id may run again", async () => {
    const mux = new FakeMux();
    mux.failText = true;
    const receipts = memoryLaunchReceipts();
    const first = await run(mux, { harness: "claude", requestId: ID }, { receipts });
    expect(first.body?.ok).toBe(false);
    expect(mux.closes).toEqual(["w1:p1"]);
    mux.failText = false;
    const again = await run(mux, { harness: "claude", requestId: ID }, { receipts });
    expect(again.body).toMatchObject({ ok: true });
    expect(again.body).not.toHaveProperty("replayed");
    expect(mux.spaces).toHaveLength(2);
  });

  test("an id that is not a UUID is a 400", async () => {
    expect((await run(new FakeMux(), { shell: true, requestId: "retry-1" })).status).toBe(400);
  });
});

describe("LaunchReceiptStore — the file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "collie-launch-receipts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loading writes nothing; a launch with an id writes one owner-only file a restart reads back", async () => {
    const store = new LaunchReceiptStore(dir, () => {});
    await store.load();
    expect(await readdir(dir)).toEqual([]);
    await store.record({ requestId: ID, at: 1, workspaceId: "w1", workspaceLabel: "app", paneId: "w1:p1", tabId: "w1:t1", cwd: "/x" });
    expect(await readdir(dir)).toEqual([LAUNCH_RECEIPTS_FILE]);
    const again = new LaunchReceiptStore(dir, () => {});
    await again.load();
    const got = again.get(ID);
    expect(got !== undefined && !isUnsettled(got) ? got.paneId : null).toBe("w1:p1");
    const mode = (await Bun.file(join(dir, LAUNCH_RECEIPTS_FILE)).stat()).mode & 0o777;
    // NTFS has no 0600 mode bits; on Windows the state folder's access list keeps the file private.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  test("an entry that is not a receipt is dropped", () => {
    expect(coerceLaunchReceipt({ requestId: "x", at: 1 })).toBeNull();
    expect(coerceLaunchReceipt([])).toBeNull();
  });
});

describe("GET /api/launchers — the harness list rides along", () => {
  test("with a probe: rows, home and harnesses", async () => {
    const res = await launchersRoute(() => Promise.resolve([HTOP]), null, {
      list: () => Promise.resolve([{ id: "claude", label: "Claude Code", found: true }]),
    });
    // SAFETY: `launchersRoute` wrote this body two lines up, satisfying `LaunchersResponse` itself.
    const body = (await res.json()) as LaunchersResponse;
    expect(body).toEqual({ launchers: [HTOP], home: homedir(), harnesses: [{ id: "claude", label: "Claude Code", found: true }] });
  });

  test("without one: the body an older bridge sends, which is how the phone tells it apart", async () => {
    const res = await launchersRoute(() => Promise.resolve([]), null);
    expect(await res.json()).toEqual({ launchers: [], home: homedir() });
  });
});

// ── An account on a launch (M101, ADR 0141) ─────────────────────────────────────────────────────
//
//   1. With no `account` and no `signIn`, the typed line is the line it always was, byte for byte.
//   2. An added account types `NAME='<folder>' <binary>`; its pane is noted for the tag.
//   3. An unknown id, or one of another agent, is refused before anything is created.
//   4. A shell, a one-off run and a hand-written row never take an account; a recipe row does.

describe("POST /api/launch — with an account", () => {
  const ACCOUNT = "6f1c2a4e-3b5d-4c7e-9f00-112233445566";

  async function accountsWith(rows: { harness: string; kind: "own" | "shared"; dir: string; id?: string }[] = []) {
    const store = memoryAccountStore();
    for (const r of rows) await store.add({ id: r.id ?? ACCOUNT, harness: r.harness, label: "Work", kind: r.kind, dir: r.dir, addedAt: 1, device: "pixel" });
    return new Accounts({
      store,
      harnesses: { list: () => Promise.resolve([]), launch: harnessLaunch },
      home: "/home/op",
      env: {},
      platform: "linux",
      disk: realLinkDisk,
    });
  }

  test("no account and no sign-in: the typed line is unchanged, with or without the service", async () => {
    for (const accounts of [undefined, await accountsWith()]) {
      const mux = new FakeMux();
      expect((await run(mux, { harness: "claude", cwd: "/home/op/src/app" }, { accounts })).status).toBe(200);
      expect(mux.texts).toEqual([["w1:p1", "claude"]]);
    }
  });

  accountTest("an own account types the quoted folder before the binary, and the pane carries the account", async () => {
    const accounts = await accountsWith([{ harness: "codex", kind: "own", dir: "/home/op/.codex-work" }]);
    const mux = new FakeMux();
    const { status } = await run(mux, { harness: "codex", account: ACCOUNT, cwd: "/home/op/src/app" }, { accounts });
    expect(status).toBe(200);
    expect(mux.texts).toEqual([["w1:p1", "CODEX_HOME='/home/op/.codex-work' codex"]]);
    const started: AgentView = { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "app", workspaceNumber: 1, tabId: "w1:t1", agent: "codex", status: "idle", cwd: "/home/op/src/app", focused: false };
    expect(accounts.paneAccount("default", started)).toEqual({ id: ACCOUNT, label: "Work" });
    // Over the crew link (M101 spec 06, decision 5): the member types ITS OWN folder for its own id, and a
    // folder the forwarded body names is never read.
    const crewMux = new FakeMux();
    const forwarded = { harness: "codex", account: ACCOUNT, cwd: "/home/op/src/app", path: "/tmp/elsewhere", dir: "/tmp/elsewhere", folder: "/tmp/elsewhere" };
    expect((await run(crewMux, forwarded, { accounts, viaCrew: true })).status).toBe(200);
    expect(crewMux.texts).toEqual([["w1:p1", "CODEX_HOME='/home/op/.codex-work' codex"]]);
  });

  test("an unknown id, another agent's id, no service, and Windows are refused before anything runs", async () => {
    const accounts = await accountsWith([{ harness: "codex", kind: "own", dir: "/home/op/.codex-work" }]);
    const cases: [JsonObject, LaunchDeps, number, "accounts.unknown" | "accounts.unavailable"][] = [
      [{ harness: "codex", account: "6f1c2a4e-3b5d-4c7e-9f00-000000000000" }, { accounts }, 400, "accounts.unknown"],
      [{ harness: "claude", account: ACCOUNT }, { accounts }, 400, "accounts.unknown"],
      [{ harness: "codex", account: ACCOUNT }, {}, 404, "accounts.unavailable"],
    ];
    for (const [body, deps, status, code] of cases) {
      const mux = new FakeMux();
      const out = await run(mux, body, deps);
      expect([out.status, out.body?.ok === false ? out.body.code : undefined]).toEqual([status, code]);
      expect(mux.spaces).toEqual([]);
    }
    const windows = new Accounts({ store: memoryAccountStore(), harnesses: { list: () => Promise.resolve([]), launch: harnessLaunch }, home: "/home/op", env: {}, platform: "win32", disk: realLinkDisk });
    const mux = new FakeMux();
    expect((await run(mux, { harness: "codex", account: ACCOUNT }, { accounts: windows })).status).toBe(404);
    expect(mux.spaces).toEqual([]);
  });

  test("an account never rides a shell, a one-off run or a hand-written row", async () => {
    const accounts = await accountsWith([{ harness: "codex", kind: "own", dir: "/home/op/.codex-work" }]);
    for (const body of [{ shell: true, account: ACCOUNT }, { run: "ls", account: ACCOUNT }, { command: "htop", account: ACCOUNT }, { account: ACCOUNT }, { harness: "codex", account: 7 }]) {
      const mux = new FakeMux();
      expect((await run(mux, body, { accounts })).status).toBe(400);
      expect(mux.spaces).toEqual([]);
    }
  });

  accountTest("a recipe row a phone added takes the account in front of its own line", async () => {
    const accounts = await accountsWith([{ harness: "codex", kind: "own", dir: "/home/op/.codex-work" }]);
    const recipe: Launcher = { command: "codex --search", label: "Codex search", source: "added", addedAs: "recipe", harness: "codex", kind: "agent", id: "r1" };
    const mux = new FakeMux();
    const res = await launch(asMux(mux), engine(), post({ command: "codex --search", account: ACCOUNT }), new AuditLog(() => {}), null, "default", () => Promise.resolve([recipe]), clock(), {
      harnesses: { launch: harnessLaunch },
      home: "/home/op",
      fs: dirs(),
      accounts,
    });
    expect(res.status).toBe(200);
    expect(mux.texts).toEqual([["w1:p1", "CODEX_HOME='/home/op/.codex-work' codex --search"]]);
  });

  test("signIn with the harness alone types the Default start", async () => {
    const mux = new FakeMux();
    expect((await run(mux, { harness: "claude", signIn: true }, { accounts: await accountsWith() })).status).toBe(200);
    expect(mux.texts).toEqual([["w1:p1", "claude"]]);
  });
  accountTest("Change login: on an account that reads signed in, the launch types the agent's own login menu, as Sign in again does", async () => {
    const home = await mkdtemp(join(tmpdir(), "collie-change-login-"));
    try {
      // Claude Code has run in both folders: its state file is there (existence only).
      await writeFile(join(home, ".claude.json"), "{}");
      const work = join(home, ".claude-work");
      await mkdir(work, { recursive: true });
      await writeFile(join(work, ".claude.json"), "{}");
      const store = memoryAccountStore();
      await store.add({ id: ACCOUNT, harness: "claude", label: "Work", kind: "own", dir: work, addedAt: 1, device: "pixel" });
      const signedIn = { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "work@example.com", subscriptionType: "max" }), stderr: "" };
      const accounts = new Accounts({
        store,
        status: () => Promise.resolve(signedIn),
        harnesses: { list: () => Promise.resolve([{ id: "claude", label: "Claude Code", found: true }]), launch: harnessLaunch },
        home,
        env: {},
        platform: "linux",
        disk: realLinkDisk,
      });
      // The page read the list first, so the bridge holds "signed in".
      await accounts.body();
      for (const [body, line] of [
        [{ harness: "claude", signIn: true }, "claude /login"],
        [{ harness: "claude", account: ACCOUNT, signIn: true }, `CLAUDE_CONFIG_DIR='${work}' claude /login`],
      ] as const) {
        const mux = new FakeMux();
        expect((await run(mux, body, { accounts })).status).toBe(200);
        expect(mux.texts).toEqual([["w1:p1", line]]);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// ── A start on a crew member with an account (M101 spec 06, decisions 1 and 5) ──────────────────
//
// The lead forwards the phone's launch body unchanged (bridge/crew/forward.ts), `account` with it. The
// member resolves that id against ITS OWN accounts, never against a folder in the request, and refuses
// an id it does not hold with the existing sentence. A sign-in start does not cross the link.

describe("POST /api/launch — over the crew link, with an account", () => {
  const ACCOUNT = "6f1c2a4e-3b5d-4c7e-9f00-112233445566";
  const LEADS = "6f1c2a4e-3b5d-4c7e-9f00-998877665544";

  async function memberAccounts() {
    const store = memoryAccountStore();
    await store.add({ id: ACCOUNT, harness: "codex", label: "Work", kind: "own", dir: "/home/op/.codex-work", addedAt: 1, device: "pixel" });
    return new Accounts({ store, harnesses: { list: () => Promise.resolve([]), launch: harnessLaunch }, home: "/home/op", env: {}, platform: "linux", disk: realLinkDisk });
  }

  test("an id the member does not hold (the lead's own, or a folder) is refused with the existing sentence, nothing runs", async () => {
    const accounts = await memberAccounts();
    for (const account of [LEADS, "/home/op/.codex-work", "~/.codex-work"]) {
      const mux = new FakeMux();
      const out = await run(mux, { harness: "codex", account }, { accounts, viaCrew: true });
      expect([out.status, out.body?.ok === false ? out.body.code : undefined]).toEqual([400, "accounts.unknown"]);
      expect(mux.spaces).toEqual([]);
    }
  });

  test("a sign-in start over the crew link is refused before anything runs; locally it still starts", async () => {
    const accounts = await memberAccounts();
    for (const body of [{ harness: "claude", signIn: true }, { harness: "codex", account: ACCOUNT, signIn: true }]) {
      const mux = new FakeMux();
      expect((await run(mux, body, { accounts, viaCrew: true })).status).toBe(400);
      expect(mux.spaces).toEqual([]);
      expect(mux.texts).toEqual([]);
    }
    const mux = new FakeMux();
    expect((await run(mux, { harness: "claude", signIn: true }, { accounts })).status).toBe(200);
  });
});
