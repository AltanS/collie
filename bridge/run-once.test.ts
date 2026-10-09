import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog, type AuditContent } from "./audit.ts";
import { apiPathFor, crewRouteFor, forwardAuditAction, forwardKind } from "./crew/forward.ts";
import { harnessLaunch } from "./harness-launch.ts";
import { memoryLaunchReceipts } from "./launch-receipts.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { readMerged, type LauncherSources } from "./launcher-adds.ts";
import { memoryAddedIo, memoryAddedLaunchers } from "./launchers-added.ts";
import { muxAck, muxOk, muxRefused, type MuxAck, type MuxAdapter, type MuxCreatedPane, type MuxGrid, type MuxOutcome, type MuxSpaceRequest } from "./mux/types.ts";
import { DEFAULT_SWITCHES, type LauncherSwitches } from "./operator-launchers.ts";
import {
  MAX_RECENT,
  RECENT_FILE,
  RecentRunStore,
  coerceRecentFile,
  formatRecentFile,
  looksSecret,
  memoryRecentRuns,
  recentRunFileIo,
  runProgram,
  type RecentRun,
} from "./recent-runs.ts";
import { createWorktreeAt, launch, launchersRoute, serveLaunchCheckRoute, serveRecentRunRoute, type LaunchDeps } from "./server.ts";
import type { SessionRuntime } from "./sessions.ts";
import type { StateEngine } from "./state-engine.ts";
import type { CreateResponse, LaunchCheckResponse, LaunchersResponse, RecentRunsResponse, WorktreeCreateResponse } from "./types.ts";
import { memoryWorktreeReceipts } from "./worktree-receipts.ts";

// A one-off run and its history (ADR 0095). The claims:
//
//   1. `run` is a fourth kind of launch, exclusive with `command`, `harness` and `shell`.
//   2. Before anything runs: a paired device, the operator's `[phone] run` switch, the character rule,
//      and the folder rules every launch meets. The line is typed exactly as a row's is.
//   3. The request id behaves as ADR 0091's: a replay answers the first pane and runs nothing.
//   4. A run that worked, and only that, joins the history: newest first, one per line, at most 12.
//   5. Each entry is checked again at read; a file of another version reads empty and refuses writes.
//   6. Remove and clear are writes through the caller's gate and resolver, forwarded on `?host=`.
//   7. The audit line names the command word and the length, never the line.
//   8. `POST /api/launch/check` tells a typed line's no-prompts answer and its character problem before
//      the first run: a read that runs nothing, stores nothing and is forwarded on `?host=`.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const ID2 = "1c0f7b2d-4a3e-4d6f-9b8c-2e3f4a5b6c7d";

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
  readonly keys: string[][] = [];
  readonly closes: string[] = [];
  failText = false;
  private n = 0;

  createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    this.n++;
    return Promise.resolve(
      muxOk({ paneId: `w${this.n}:p1`, spaceId: `w${this.n}`, spaceLabel: request.label ?? "shell", tabId: `w${this.n}:t1`, cwd: request.cwd ?? "/" }),
    );
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(this.failText ? muxRefused("pane is gone") : muxAck());
  }
  sendKeys(_paneId: string, keys: string[]): Promise<MuxAck> {
    this.keys.push(keys);
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
  // (on a failed send) and refresh: the six FakeMux implements.
  return fake as MuxAdapter;
}

function capture(content: AuditContent = "preview") {
  const raw: string[] = [];
  const audit = new AuditLog((line) => void raw.push(line), { content });
  // SAFETY: each line is one `formatAuditLine` JSON object.
  return { audit, raw, lines: () => raw.map((l) => JSON.parse(l) as JsonObject) };
}

/** A disk where every folder is a directory, or only `present` are. */
function dirs(present?: readonly string[]) {
  return { isDirectory: (path: string) => Promise.resolve(present === undefined || present.includes(path)) };
}

const post = (path: string, body: JsonValue) =>
  new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function fixture(over: { switches?: Partial<LauncherSwitches>; device?: string | null; history?: string | null; content?: AuditContent } = {}) {
  const mux = new FakeMux();
  let switches: LauncherSwitches = { ...DEFAULT_SWITCHES, ...over.switches };
  const io = memoryAddedIo(over.history ?? null);
  const recent = new RecentRunStore(io, () => {});
  const receipts = memoryLaunchReceipts();
  const log = capture(over.content);
  const run = async (body: JsonObject, deps: LaunchDeps = {}) => {
    const res = await launch(
      asMux(mux),
      engine(),
      post("/api/launch", body),
      log.audit,
      over.device === undefined ? "phone" : over.device,
      "default",
      () => Promise.resolve([{ command: "htop", label: "htop" }]),
      clock(),
      {
        harnesses: { launch: harnessLaunch },
        home: "/home/op",
        fs: dirs(),
        switches: () => Promise.resolve(switches),
        recentRuns: recent,
        receipts,
        ...deps,
      },
    );
    // SAFETY: `launch` answers a CreateResponse as JSON, or a plain-text 400 that parses to `null` here.
    const parsed = (await res.json().catch(() => null)) as CreateResponse | null;
    return { status: res.status, body: parsed };
  };
  return {
    mux,
    io,
    recent,
    log,
    run,
    setSwitches: (next: Partial<LauncherSwitches>) => {
      switches = { ...switches, ...next };
    },
  };
}

describe("POST /api/launch `{ run }`: the shape", () => {
  test("a run opens a shell in the folder and types the line plus Enter, as a row does", async () => {
    const f = fixture();
    const out = await f.run({ run: "make test", cwd: "~/src/app", requestId: ID });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, noPrompts: false, pane: { paneId: "w1:p1", cwd: join("/home/op", "src", "app") } });
    expect(f.mux.spaces).toEqual([{ cwd: join("/home/op", "src", "app"), label: "make" }]);
    expect(f.mux.texts).toEqual([["w1:p1", "make test"]]);
    expect(f.mux.keys).toEqual([["Enter"]]);
  });

  test("exclusive with command, harness and shell: two kinds, or none, is a 400 and nothing runs", async () => {
    const f = fixture();
    for (const body of [
      { run: "ls", command: "htop" },
      { run: "ls", harness: "claude" },
      { run: "ls", shell: true },
      { cwd: "/tmp" },
    ] satisfies JsonObject[]) {
      const out = await f.run(body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body).toBeNull();
    }
    expect(f.mux.spaces).toEqual([]);
    expect(await f.recent.list()).toEqual([]);
  });

  test("the character rule, before anything runs: launch.bad_line with the problem", async () => {
    const f = fixture();
    for (const [run, problem] of [
      ["ls\nrm -rf ~", "forbidden_character"],
      ["ls‮txt", "forbidden_character"],
      ["echo a b", "forbidden_character"],
      ["x".repeat(201), "too_long"],
      ["   ", "empty"],
      ["", "empty"],
      [42, "empty"],
    ] as const) {
      const out = await f.run({ run, requestId: ID });
      expect(out.status).toBe(400);
      expect(out.body).toMatchObject({ ok: false, code: "launch.bad_line", detail: { problem, max: 200 } });
    }
    expect(f.mux.spaces).toEqual([]);
    expect(await f.recent.list()).toEqual([]);
  });

  test("200 code points after NFC is still a line; it is trimmed before it is typed", async () => {
    const f = fixture();
    expect((await f.run({ run: `  ${"y".repeat(200)}  ` })).status).toBe(200);
    expect(f.mux.texts[0]?.[1]).toBe("y".repeat(200));
  });

  test("a request with no paired device is launch.no_device, and nothing runs", async () => {
    for (const device of [null, ""]) {
      const f = fixture({ device });
      const out = await f.run({ run: "ls", requestId: ID });
      expect(out.status).toBe(403);
      expect(out.body).toMatchObject({ ok: false, code: "launch.no_device" });
      expect(f.mux.spaces).toEqual([]);
    }
  });

  test("[phone] run = false refuses with launch.run_off; the default lets it run", async () => {
    const f = fixture({ switches: { run: false } });
    const off = await f.run({ run: "ls", requestId: ID });
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ ok: false, code: "launch.run_off" });
    expect(f.mux.spaces).toEqual([]);
    f.setSwitches({ run: true });
    expect((await f.run({ run: "ls", requestId: ID })).status).toBe(200);
    // No switches given at all: the defaults, and run is on.
    const bare = fixture();
    expect((await bare.run({ run: "ls" }, { switches: undefined })).status).toBe(200);
  });

  test("the folder rules every launch meets: bad_folder, folder_missing, and a bare name under home", async () => {
    const f = fixture();
    expect((await f.run({ run: "ls", cwd: "../etc" })).body).toMatchObject({ code: "launch.bad_folder" });
    expect((await f.run({ run: "ls", cwd: "~root" })).body).toMatchObject({ code: "launch.bad_folder" });
    const missing = await f.run({ run: "ls", cwd: "/nope" }, { fs: dirs(["/home/op/projects"]) });
    expect(missing.body).toMatchObject({ code: "launch.folder_missing", detail: { folder: "/nope" } });
    expect(f.mux.spaces).toEqual([]);
    expect((await f.run({ run: "ls", cwd: "projects" }, { fs: dirs([join("/home/op", "projects")]) })).status).toBe(200);
    expect(f.mux.spaces).toEqual([{ cwd: join("/home/op", "projects"), label: "ls" }]);
  });

  test("the answer says whether the line scans as no-prompts; the bridge does not ask for a confirm", async () => {
    const f = fixture();
    expect((await f.run({ run: "claude --dangerously-skip-permissions" })).body).toMatchObject({ ok: true, noPrompts: true });
    expect((await f.run({ run: "codex -a never" })).body).toMatchObject({ ok: true, noPrompts: true });
    expect((await f.run({ run: "claude --model opus" })).body).toMatchObject({ ok: true, noPrompts: false });
    expect((await f.recent.list()).map((e) => [e.line, e.noPrompts])).toEqual([
      ["claude --model opus", false],
      ["codex -a never", true],
      ["claude --dangerously-skip-permissions", true],
    ]);
  });

  test("a run never starts on a new branch: launch.run_no_branch, before any git or multiplexer", async () => {
    const res = await createWorktreeAt(
      asMux(new FakeMux()),
      engine(),
      post("/api/worktree", { cwd: "/home/op/src/app", branch: "feature", run: "make test" }),
      new AuditLog(() => {}),
      "phone",
      "default",
      () => Promise.resolve([]),
      {
        receipts: memoryWorktreeReceipts(),
        home: "/home/op",
        ask: () => {
          throw new Error("git must not be asked");
        },
      },
    );
    // SAFETY: createWorktreeAt wrote this body as a WorktreeCreateResponse.
    const body = (await res.json()) as WorktreeCreateResponse;
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.run_no_branch" });
  });
});

describe("POST /api/launch `{ run }`: request ids", () => {
  test("a replay answers the first pane, runs nothing, and records nothing again", async () => {
    const f = fixture();
    const first = await f.run({ run: "make test", requestId: ID });
    const before = await f.recent.list();
    const writes = f.io.writes;
    const again = await f.run({ run: "make test", requestId: ID });
    expect(again.body).toMatchObject({ ok: true, replayed: true, pane: first.body?.ok ? first.body.pane : {} });
    expect(f.mux.spaces).toHaveLength(1);
    expect(f.mux.texts).toHaveLength(1);
    expect(await f.recent.list()).toEqual(before);
    expect(f.io.writes).toBe(writes);
    // A replay answers even with another line and the switch now off: the id decides, as in ADR 0091.
    f.setSwitches({ run: false });
    expect((await f.run({ run: "rm -rf /", requestId: ID })).body).toMatchObject({ ok: true, replayed: true });
    expect(f.mux.texts).toHaveLength(1);
  });

  test("two requests with one id in flight start one pane and record one entry", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.run({ run: "make test", requestId: ID }), f.run({ run: "make test", requestId: ID })]);
    expect(f.mux.spaces).toHaveLength(1);
    expect([a.body, b.body].filter((r) => r?.ok === true && r.replayed === true)).toHaveLength(1);
    expect(await f.recent.list()).toHaveLength(1);
  });

  test("a failed send records nothing and closes the pane, so the same id may run again", async () => {
    const f = fixture();
    f.mux.failText = true;
    const out = await f.run({ run: "make test", requestId: ID });
    expect(out.body?.ok).toBe(false);
    expect(f.mux.closes).toEqual(["w1:p1"]);
    expect(await f.recent.list()).toEqual([]);
    f.mux.failText = false;
    expect((await f.run({ run: "make test", requestId: ID })).body).toMatchObject({ ok: true });
    expect(await f.recent.list()).toHaveLength(1);
  });
});

describe("the history: recorded by a run that worked", () => {
  test("newest first, the folder it ran in (null for home), and a re-run moves the line to the top", async () => {
    const f = fixture();
    await f.run({ run: "make test", cwd: "/srv/app" });
    await f.run({ run: "htop" });
    await f.run({ run: "make test", cwd: "/srv/other" });
    const list = await f.recent.list();
    expect(list.map((e) => [e.line, e.cwd])).toEqual([
      ["make test", "/srv/other"],
      ["htop", null],
    ]);
  });

  test("no record on any refusal", async () => {
    const f = fixture({ switches: { run: false } });
    await f.run({ run: "ls" });
    f.setSwitches({ run: true });
    await f.run({ run: "ls\nx" });
    await f.run({ run: "ls", cwd: "/gone" }, { fs: dirs([]) });
    await f.run({ run: "ls", command: "htop" });
    expect(await f.recent.list()).toEqual([]);
    expect(f.io.writes).toBe(0);
  });

  test("a line that seems to carry a secret runs, and is not kept", async () => {
    const f = fixture();
    for (const run of ["TOKEN=abc deploy", "export GH_PAT=x; gh pr list", "curl https://me:hunter2@example.com", "op read --api-key k", "make FOO=1"]) {
      const out = await f.run({ run });
      expect(out.status).toBe(200);
    }
    expect(f.mux.texts).toHaveLength(5);
    expect(await f.recent.list()).toEqual([]);
  });

  test("looksSecret keeps ordinary lines, flags included", () => {
    for (const line of ["make test", "git log --format=%h -n 5", "htop", "claude --dangerously-skip-permissions", "ls -la ~/projects", "curl https://example.com/a?b"]) {
      expect(looksSecret(line)).toBe(false);
    }
    for (const line of ["A=1 make", "x && KEY=v y", "psql postgres://u:p@db/x", "echo $SECRET", "vault login -method=token", "Authorization: x"]) {
      expect(looksSecret(line)).toBe(true);
    }
  });

  test("a history that cannot be written does not undo a run that happened", async () => {
    const f = fixture({ history: JSON.stringify({ version: 2, entries: [] }) });
    const out = await f.run({ run: "make test" });
    expect(out.status).toBe(200);
    expect(f.mux.texts).toHaveLength(1);
    expect(f.io.text).toBe(JSON.stringify({ version: 2, entries: [] }));
  });

  test("the store dedupes by exact line and keeps at most twelve", async () => {
    const recent = memoryRecentRuns();
    for (let i = 0; i < MAX_RECENT + 3; i++) await recent.record({ line: `job ${i}`, cwd: null, at: i, noPrompts: false });
    await recent.record({ line: "job 5", cwd: "/srv", at: 99, noPrompts: false });
    const list = await recent.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toEqual({ line: "job 5", cwd: "/srv", at: 99, noPrompts: false });
    expect(list.filter((e) => e.line === "job 5")).toHaveLength(1);
    expect(list.map((e) => e.line)).not.toContain("job 0");
    // Moving `job 5` up drops nothing: it was already one of the twelve, so `job 3` is still the last.
    expect(list.at(-1)?.line).toBe("job 3");
  });
});

describe("the history file: checked again at read, and guarded by its version", () => {
  const good: RecentRun = { line: "make test", cwd: "/srv/app", at: 1, noPrompts: false };

  test("an entry that fails the rule is dropped alone", () => {
    const file = {
      version: 1,
      entries: [
        { line: "make test", cwd: "/srv/app", at: 1, noPrompts: false },
        { line: "ls\nrm -rf ~", cwd: null, at: 2, noPrompts: false },
        { line: "ls ‮txt", cwd: null, at: 3, noPrompts: false },
        { line: "x".repeat(201), cwd: null, at: 4, noPrompts: false },
        { line: "pwd", cwd: "relative/path", at: 5, noPrompts: false },
        { line: "pwd", cwd: "/a\u0007b", at: 6, noPrompts: false },
        { line: " padded ", cwd: null, at: 7, noPrompts: false },
        { line: "htop", cwd: null, at: "now", noPrompts: false },
        { line: "make test", cwd: null, at: 8, noPrompts: false },
        { line: "uptime", cwd: null, at: 9 },
      ],
    };
    expect(coerceRecentFile(file)).toEqual([good, { line: "uptime", cwd: null, at: 9, noPrompts: false }]);
  });

  test("a visible no-prompts flag reads as no-prompts, whatever the file says", () => {
    expect(coerceRecentFile({ version: 1, entries: [{ line: "codex --yolo", cwd: null, at: 1, noPrompts: false }] })).toEqual([
      { line: "codex --yolo", cwd: null, at: 1, noPrompts: true },
    ]);
  });

  test("a file that is not version 1 reads as empty and refuses every write, untouched", async () => {
    for (const text of [JSON.stringify({ version: 2, entries: [good] }), "{ not json", "[]"]) {
      const io = memoryAddedIo(text);
      const recent = new RecentRunStore(io, () => {});
      expect(await recent.list()).toEqual([]);
      expect(await recent.record(good)).toBe("unwritable");
      expect(await recent.remove("make test")).toBe("unwritable");
      expect(await recent.clear()).toBe("unwritable");
      expect(io.text).toBe(text);
      expect(io.writes).toBe(0);
    }
  });

  describe("on disk", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "collie-recent-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("owner-only, version 1, renamed into place with no temp file left", async () => {
      const recent = new RecentRunStore(recentRunFileIo(dir), () => {});
      expect(await recent.list()).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
      await recent.record(good);
      expect(await readdir(dir)).toEqual([RECENT_FILE]);
      if (process.platform !== "win32") expect((await stat(join(dir, RECENT_FILE))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(dir, RECENT_FILE), "utf8")).toBe(formatRecentFile([good]));
      expect(JSON.parse(await readFile(join(dir, RECENT_FILE), "utf8"))).toMatchObject({ version: 1 });
    });
  });
});

// ── Remove and clear, through the caller's gate ─────────────────────────────────────────────────

type RecentCaller = Parameters<typeof serveRecentRunRoute>[2];

function caller(over: Partial<RecentCaller> = {}): RecentCaller {
  return {
    gate: () => null,
    // SAFETY: the history routes read only `name` off the runtime.
    resolve: () => Promise.resolve({ name: "default" } as SessionRuntime),
    device: () => "phone",
    audit: new AuditLog(() => {}),
    ...over,
  };
}

async function seeded(): Promise<RecentRunStore> {
  const recent = memoryRecentRuns();
  await recent.record({ line: "htop", cwd: null, at: 1, noPrompts: false });
  await recent.record({ line: "TOKEN=hunter2 make deploy", cwd: "/srv/app", at: 2, noPrompts: false });
  return recent;
}

async function answer(res: Response | null): Promise<{ status: number; body: RecentRunsResponse }> {
  if (res === null) throw new Error("the route did not answer");
  // SAFETY: the history routes answer a RecentRunsResponse as JSON.
  return { status: res.status, body: (await res.json()) as RecentRunsResponse };
}

describe("POST /api/launch/recent/remove and /clear", () => {
  test("not one of its paths, or not a POST: null", async () => {
    const recent = await seeded();
    expect(await serveRecentRunRoute(post("/api/launch", {}), "/api/launch", caller(), recent)).toBeNull();
    expect(await serveRecentRunRoute(new Request("http://x/api/launch/recent/clear"), "/api/launch/recent/clear", caller(), recent)).toBeNull();
  });

  test("remove takes one exact line, and answers launch.recent_unknown for a line not there", async () => {
    const recent = await seeded();
    const gone = await answer(await serveRecentRunRoute(post("/api/launch/recent/remove", { line: "htop" }), "/api/launch/recent/remove", caller(), recent));
    expect(gone).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect((await recent.list()).map((e) => e.line)).toEqual(["TOKEN=hunter2 make deploy"]);
    const missing = await answer(await serveRecentRunRoute(post("/api/launch/recent/remove", { line: "htop" }), "/api/launch/recent/remove", caller(), recent));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, code: "launch.recent_unknown" });
    const bad = await answer(await serveRecentRunRoute(post("/api/launch/recent/remove", { line: 3 }), "/api/launch/recent/remove", caller(), recent));
    expect(bad.status).toBe(400);
  });

  test("clear removes every line and says how many", async () => {
    const recent = await seeded();
    const out = await answer(await serveRecentRunRoute(post("/api/launch/recent/clear", {}), "/api/launch/recent/clear", caller(), recent));
    expect(out).toEqual({ status: 200, body: { ok: true, removed: 2 } });
    expect(await recent.list()).toEqual([]);
  });

  test("a file of another version: launch.recent_unreadable, and the file stays", async () => {
    const text = JSON.stringify({ version: 2, entries: [] });
    const recent = memoryRecentRuns(text);
    for (const [path, body] of [
      ["/api/launch/recent/remove", { line: "htop" }],
      ["/api/launch/recent/clear", {}],
    ] as const) {
      const out = await answer(await serveRecentRunRoute(post(path, body), path, caller(), recent));
      expect(out.status).toBe(503);
      expect(out.body).toMatchObject({ ok: false, code: "launch.recent_unreadable" });
    }
  });

  test("the write gate first: a read-only device changes nothing", async () => {
    const recent = await seeded();
    let asked = "";
    const res = await serveRecentRunRoute(
      post("/api/launch/recent/clear", {}),
      "/api/launch/recent/clear",
      caller({
        gate: (level) => {
          asked = level;
          return new Response("device not authorised", { status: 403 });
        },
      }),
      recent,
    );
    expect(asked).toBe("write");
    expect(res?.status).toBe(403);
    expect(await recent.list()).toHaveLength(2);
  });

  test("a `?host=` call is the member's: its answer comes back untouched, and this history is not touched", async () => {
    const recent = await seeded();
    const member = new Response(JSON.stringify({ ok: true, removed: 7 }), { status: 200 });
    const res = await serveRecentRunRoute(
      post("/api/launch/recent/clear?host=laptop", {}),
      "/api/launch/recent/clear",
      caller({ resolve: () => Promise.resolve(member) }),
      recent,
    );
    expect(res).toBe(member);
    expect(await recent.list()).toHaveLength(2);
  });
});

describe("the crew link carries the history writes, and the run rides `launch`", () => {
  test("remove and clear are forwardable writes, audited under the member's own names", () => {
    for (const [route, action] of [
      ["launch/recent/remove", "launch.recent.remove"],
      ["launch/recent/clear", "launch.recent.clear"],
    ] as const) {
      expect(crewRouteFor(`/api/${route}`)).toBe(route);
      expect(apiPathFor(route)).toBe(`/api/${route}`);
      expect(forwardKind(route)).toBe("write");
      expect(forwardAuditAction(route)).toBe(action);
    }
    expect(crewRouteFor("/api/launch/recent")).toBeNull();
    expect(crewRouteFor("/api/launch/recent/list")).toBeNull();
    expect(crewRouteFor("/api/launch")).toBe("launch");
  });
});

// ── The audit line ──────────────────────────────────────────────────────────────────────────────

describe("the audit line names the command word and the length, never the line", () => {
  test("a run: `workspace.run`, the command word after any assignment, and the length", async () => {
    const f = fixture();
    await f.run({ run: "TOKEN=hunter2 make deploy", cwd: "/srv/app", requestId: ID });
    const [line] = f.log.lines();
    expect(line).toMatchObject({
      action: "workspace.run",
      paneId: "w1:p1",
      device: "phone",
      detail: { program: "make", length: 25, cwd: "/srv/app", requestId: ID },
    });
    expect(f.log.raw.join("\n")).not.toContain("hunter2");
    expect(f.log.raw.join("\n")).not.toContain("deploy");
    // The space is named after the command word too, never after the assignment.
    expect(f.mux.spaces[0]?.label).toBe("make");
  });

  test("under `content = none` the word redacts, the length stays a number", async () => {
    const f = fixture({ content: "none" });
    await f.run({ run: "make deploy", requestId: ID2 });
    expect(f.log.lines()[0]).toMatchObject({ action: "workspace.run", detail: { program: "⟨redacted⟩", length: 11, requestId: ID2 } });
  });

  test("a shell that never settles: the service log gives the length, never the line", async () => {
    const f = fixture();
    f.mux.readGrid = (paneId: string) => Promise.resolve(muxOk({ paneId, text: "", truncated: false, revision: 1 }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.run({ run: "TOKEN=hunter2 make deploy" });
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[run] pane w1:p1 did not settle");
      expect(logged).toContain("a 25-character line");
      expect(logged).not.toContain("hunter2");
    } finally {
      warn.mockRestore();
    }
    expect(f.mux.texts).toEqual([["w1:p1", "TOKEN=hunter2 make deploy"]]);
  });

  test("remove and clear: the word and the length, or the count", async () => {
    const recent = await seeded();
    const log = capture();
    const c = caller({ audit: log.audit });
    await serveRecentRunRoute(post("/api/launch/recent/remove", { line: "TOKEN=hunter2 make deploy" }), "/api/launch/recent/remove", c, recent);
    await serveRecentRunRoute(post("/api/launch/recent/clear", {}), "/api/launch/recent/clear", c, recent);
    expect(log.lines().map((l) => [l.action, l.detail])).toEqual([
      ["launch.recent.remove", { program: "make", length: 25 }],
      ["launch.recent.clear", { removed: 1 }],
    ]);
    expect(log.raw.join("\n")).not.toContain("hunter2");
  });

  test("runProgram: assignments skipped, a label's length at most", () => {
    expect(runProgram("make test")).toBe("make");
    expect(runProgram("A=1 B=two ./run.sh --fast")).toBe("./run.sh");
    expect(runProgram("A=1")).toBe("shell");
    expect([...runProgram("z".repeat(80))]).toHaveLength(60);
  });
});

// ── GET /api/launchers ──────────────────────────────────────────────────────────────────────────

describe("GET /api/launchers carries the history and the switch", () => {
  async function read(switches: Partial<LauncherSwitches>) {
    const recent = await seeded();
    await recent.record({ line: "claude --dangerously-skip-permissions", cwd: null, at: 3, noPrompts: true });
    const sources: LauncherSources = {
      operator: () => Promise.resolve([]),
      added: memoryAddedLaunchers(),
      switches: () => Promise.resolve({ ...DEFAULT_SWITCHES, ...switches }),
    };
    const res = await launchersRoute(
      async () => (await readMerged(sources)).rows,
      null,
      undefined,
      { merged: () => readMerged(sources), file: "/x/launchers.toml", recent: () => recent.list() },
    );
    // SAFETY: the route answers a LaunchersResponse as JSON.
    return (await res.json()) as LaunchersResponse;
  }

  test("on: every entry, newest first, available, with its no-prompts flag", async () => {
    const body = await read({});
    expect(body.adding?.run).toBe(true);
    expect(body.recentRuns).toEqual([
      { line: "claude --dangerously-skip-permissions", cwd: null, at: 3, noPrompts: true, available: true },
      { line: "TOKEN=hunter2 make deploy", cwd: "/srv/app", at: 2, noPrompts: false, available: true },
      { line: "htop", cwd: null, at: 1, noPrompts: false, available: true },
    ]);
  });

  test("off: still listed, each unavailable with run_off", async () => {
    const body = await read({ run: false });
    expect(body.adding?.run).toBe(false);
    expect(body.recentRuns?.map((e) => [e.available, e.reason])).toEqual([
      [false, "run_off"],
      [false, "run_off"],
      [false, "run_off"],
    ]);
  });
});

// ── POST /api/launch/check ──────────────────────────────────────────────────────────────────────

describe("POST /api/launch/check: a typed line, checked before it runs", () => {
  async function check(body: JsonValue, over: Partial<RecentCaller> = {}, path = "/api/launch/check") {
    const res = await serveLaunchCheckRoute(post(path, body), path, caller(over));
    if (res === null) throw new Error("the route did not answer");
    // SAFETY: the check answers a LaunchCheckResponse as JSON (or plain text on a bad body, read by status).
    return { status: res.status, body: (await res.json().catch(() => null)) as LaunchCheckResponse | null };
  }

  test("not its path, or not a POST: null", async () => {
    expect(await serveLaunchCheckRoute(post("/api/launch", {}), "/api/launch", caller())).toBeNull();
    expect(await serveLaunchCheckRoute(new Request("http://x/api/launch/check"), "/api/launch/check", caller())).toBeNull();
  });

  test("a plain line: ok, no problem, no prompts skipped", async () => {
    expect(await check({ run: "make test" })).toEqual({ status: 200, body: { ok: true, noPrompts: false } });
  });

  test("a line with a known flag reads as no-prompts, as the run would", async () => {
    for (const run of ["claude --dangerously-skip-permissions", "  codex --yolo  ", "opencode --auto", "FOO=1 claude --permission-mode bypassPermissions"]) {
      expect((await check({ run })).body).toEqual({ ok: true, noPrompts: true });
    }
  });

  test("a line the character rule refuses names the problem, and is never no-prompts", async () => {
    expect((await check({ run: "" })).body).toEqual({ ok: true, noPrompts: false, problem: "empty" });
    expect((await check({ run: "   " })).body).toEqual({ ok: true, noPrompts: false, problem: "empty" });
    expect((await check({})).body).toEqual({ ok: true, noPrompts: false, problem: "empty" });
    expect((await check({ run: 7 })).body).toEqual({ ok: true, noPrompts: false, problem: "empty" });
    expect((await check({ run: "ls\nrm -rf x --yolo" })).body).toEqual({ ok: true, noPrompts: false, problem: "forbidden_character" });
    expect((await check({ run: "echo \u202e --yolo" })).body).toEqual({ ok: true, noPrompts: false, problem: "forbidden_character" });
    expect((await check({ run: "x".repeat(201) })).body).toEqual({ ok: true, noPrompts: false, problem: "too_long" });
    expect((await check({ run: "x".repeat(200) })).body).toEqual({ ok: true, noPrompts: false });
  });

  test("it agrees with the run: the same line gets the same noPrompts from launch", async () => {
    const f = fixture();
    const line = "codex --dangerously-bypass-approvals-and-sandbox";
    const ran = await f.run({ run: line, requestId: ID });
    expect(ran.body).toMatchObject({ ok: true, noPrompts: true });
    expect((await check({ run: line })).body?.noPrompts).toBe(true);
  });

  test("a body that is not an object is a 400", async () => {
    expect((await check("make test")).status).toBe(400);
    expect((await check(null)).status).toBe(400);
    const res = await serveLaunchCheckRoute(
      new Request("http://x/api/launch/check", { method: "POST", body: "{nope" }),
      "/api/launch/check",
      caller(),
    );
    expect(res?.status).toBe(400);
  });

  test("it stands on the READ gate, and a refusal there answers before anything else", async () => {
    const gates: string[] = [];
    const refused = new Response("no", { status: 401 });
    const res = await serveLaunchCheckRoute(
      post("/api/launch/check", { run: "ls" }),
      "/api/launch/check",
      caller({
        gate: (kind) => {
          gates.push(kind);
          return refused;
        },
        resolve: () => Promise.reject(new Error("the resolver must not run behind a refused gate")),
      }),
    );
    expect(res).toBe(refused);
    expect(gates).toEqual(["read"]);
  });

  test("a read-only device may check: no paired device and no [phone] run switch is asked", async () => {
    const res = await check({ run: "ls" }, { device: () => null });
    expect(res.status).toBe(200);
  });

  test("a `?host=` call is the member's: its answer comes back untouched", async () => {
    const member = new Response(JSON.stringify({ ok: true, noPrompts: true }), { status: 200 });
    const res = await serveLaunchCheckRoute(
      post("/api/launch/check?host=laptop", { run: "ls" }),
      "/api/launch/check",
      caller({ resolve: () => Promise.resolve(member) }),
    );
    expect(res).toBe(member);
  });

  test("it stores nothing and writes no audit line", async () => {
    const recent = memoryRecentRuns();
    const log = capture();
    await check({ run: "make deploy --yolo" }, { audit: log.audit });
    expect(await recent.list()).toEqual([]);
    expect(log.raw).toEqual([]);
  });

  test("the crew link carries it as a forwardable READ, audited on neither side", () => {
    expect(crewRouteFor("/api/launch/check")).toBe("launch/check");
    expect(apiPathFor("launch/check")).toBe("/api/launch/check");
    expect(forwardKind("launch/check")).toBe("read");
    expect(forwardAuditAction("launch/check")).toBeNull();
  });
});
