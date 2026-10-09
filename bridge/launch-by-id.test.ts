import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import { harnessLaunch } from "./harness-launch.ts";
import { LAUNCH_RECEIPTS_FILE, LaunchReceiptStore, coerceLaunchReceipt, memoryLaunchReceipts } from "./launch-receipts.ts";
import type { JsonObject } from "./json.ts";
import { launch, launchersRoute, type LaunchDeps } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { CreateResponse, Launcher, LaunchersResponse } from "./types.ts";
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
} from "./mux/types.ts";

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
  failText = false;
  gate: Promise<void> | null = null;
  private n = 0;

  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    if (this.gate) await this.gate;
    this.n++;
    return muxOk({ paneId: `w${this.n}:p1`, spaceId: `w${this.n}`, spaceLabel: request.label ?? "shell", tabId: `w${this.n}:t1`, cwd: request.cwd ?? "/" });
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(this.failText ? muxRefused("pane is gone") : muxAck());
  }
  sendKeys(): Promise<MuxAck> {
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
  // SAFETY: a launch from the dashboard reaches createSpace, readGrid, typeText, sendKeys, closePane
  // (on a failed send) and refresh — the six FakeMux implements.
  return fake as MuxAdapter;
}

const post = (body: JsonObject) =>
  new Request("http://x/api/launch", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

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
  test("a harness id opens a space and the bridge types that harness's binary", async () => {
    const mux = new FakeMux();
    const { status, body } = await run(mux, { harness: "claude", cwd: "/home/op/src/app" });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(mux.spaces).toEqual([{ cwd: "/home/op/src/app", label: "Claude Code" }]);
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

  test("a folder that worked joins Recent; a pinned one does not", async () => {
    const recorded: string[] = [];
    const folders = { recordRecent: (f: string) => Promise.resolve(void recorded.push(f)) };
    await run(new FakeMux(), { harness: "codex", cwd: "/home/op/src/app" }, { folders });
    await run(new FakeMux(), { command: "htop", cwd: "/home/op/x" }, { folders });
    expect(recorded).toEqual(["/home/op/src/app"]);
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
    expect(again.get(ID)?.paneId).toBe("w1:p1");
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
