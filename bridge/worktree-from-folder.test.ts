import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { harnessLaunch } from "./harness-launch.ts";
import { createWorktreeAt, planWorktree } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { WorktreeCreateResponse, WorktreePlanResponse } from "./types.ts";
import {
  muxAck,
  muxOk,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxOutcome,
  type MuxWorktreeCreateRequest,
} from "./mux/types.ts";
import { CHOICES_FILE, WorktreeChoiceStore, coerceChoice, memoryWorktreeChoices } from "./worktree-choices.ts";
import { memoryWorktreeReceipts } from "./worktree-receipts.ts";

// The New sheet's branch from a FOLDER (M48, ADR 0093), against a real git repo in a temporary home:
//
//   1. The plan finds the repo from any folder in it, a linked worktree included, and answers the
//      default and current branch, Herdr's default folder and the folder rule's verdict on a parent.
//   2. The create runs the folder rule again at use time and sends `path` only for "Other folder".
//   3. A refusal reaches no multiplexer; a create that worked is remembered per repo, never before.
//   4. A known request id replays; a harness id types the bridge's own binary.

const ID = "4f1c2b3a-9d8e-4c7b-a6f5-0e1d2c3b4a59";

let root: string;
let home: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home },
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "collie-wt-from-folder-")));
  home = join(root, "home", "op");
  repo = join(home, "src", "app");
  await mkdir(join(repo, "sub"), { recursive: true });
  await mkdir(join(home, "trees"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  await git(repo, "branch", "fix-tabs-base");
  await git(repo, "worktree", "add", "-q", "-b", "side", join(home, "trees", "side"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const deps = () => ({ home, readHerdrConfig: () => Promise.resolve(null) });

async function plan(query: Record<string, string>, choices = memoryWorktreeChoices()) {
  const url = new URL("http://x/api/worktree/plan");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await planWorktree(new Request(url), choices, deps());
  // SAFETY: planWorktree wrote this body and typed it as WorktreePlanResponse itself.
  return (await res.json()) as WorktreePlanResponse;
}

function engine(): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: the create reaches `current()` (a replay's label) and `pokeNow()` and nothing else.
  return stub as StateEngine;
}

class FakeMux {
  readonly creates: MuxWorktreeCreateRequest[] = [];
  readonly texts: Array<[string, string]> = [];
  async createWorktree(request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.creates.push(request);
    await Promise.resolve();
    return muxOk({ paneId: "w7:p1", spaceId: "w7", spaceLabel: "app-fix", tabId: "w7:t1", cwd: request.path ?? "/x" });
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(muxAck());
  }
  sendKeys(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  closePane(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}

function asMux(fake: Partial<MuxAdapter>): MuxAdapter {
  // SAFETY: a create from a folder reaches createWorktree, then readGrid, typeText and sendKeys for
  // a launcher, and refresh: the members FakeMux implements.
  return fake as MuxAdapter;
}

const clock = () => {
  let ms = 0;
  return {
    now: () => ms,
    sleep: (by: number) => {
      ms += by;
      return Promise.resolve();
    },
  };
};

async function create(mux: FakeMux, body: JsonObject, extra: { choices?: ReturnType<typeof memoryWorktreeChoices>; receipts?: ReturnType<typeof memoryWorktreeReceipts> } = {}) {
  const res = await createWorktreeAt(
    asMux(mux),
    engine(),
    new Request("http://x/api/worktree", { method: "POST", body: JSON.stringify(body) }),
    new AuditLog(() => {}),
    null,
    "default",
    () => Promise.resolve([]),
    {
      ...deps(),
      receipts: extra.receipts ?? memoryWorktreeReceipts(),
      choices: extra.choices,
      harnesses: { launch: harnessLaunch },
      wait: clock(),
    },
  );
  // SAFETY: createWorktreeAt wrote this body as a WorktreeCreateResponse.
  return { status: res.status, body: (await res.json()) as WorktreeCreateResponse };
}

describe("GET /api/worktree/plan", () => {
  test("from a folder deep in the repo: its root, default and current branch", async () => {
    expect(await plan({ cwd: join(repo, "sub") })).toEqual({ ok: true, repoRoot: repo, defaultBranch: "main", currentBranch: "main" });
  });

  test("from a linked worktree: the MAIN checkout, and the worktree's own branch", async () => {
    expect(await plan({ cwd: join(home, "trees", "side") })).toMatchObject({ ok: true, repoRoot: repo, currentBranch: "side" });
  });

  test("a folder in no repo is not_a_repo, a name with no leading / or ~ is under home, one with .. is folder_invalid", async () => {
    expect(await plan({ cwd: join(home, "trees") })).toMatchObject({ ok: false, code: "worktree.not_a_repo" });
    expect(await plan({ cwd: "src/app" })).toMatchObject({ ok: true, repoRoot: repo });
    expect(await plan({ cwd: "src/../app" })).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
  });

  test("with a branch: Herdr's default folder; with a parent: the rule's verdict", async () => {
    const answer = await plan({ cwd: repo, branch: "Fix/Tabs", parent: "~/trees" });
    expect(answer).toMatchObject({
      ok: true,
      branchValid: true,
      defaultTarget: { path: join(home, ".herdr", "worktrees", "app", "fix-tabs"), exists: false },
      parentTarget: { ok: true, path: join(home, "trees", "fix-tabs") },
    });
    expect(await plan({ cwd: repo, branch: "x", parent: repo })).toMatchObject({ parentTarget: { ok: false, code: "worktree.folder_in_repo" } });
  });

  test("a branch git refuses is branchValid false, and no folder is worked out", async () => {
    const answer = await plan({ cwd: repo, branch: "a..b", parent: "~/trees" });
    expect(answer).toMatchObject({ ok: true, branchValid: false });
    expect(answer).not.toHaveProperty("parentTarget");
  });

  test("the plan hands back what this repo remembers", async () => {
    const choices = memoryWorktreeChoices();
    await choices.record(repo, { base: "current", folder: "parent", parent: join(home, "trees"), at: 1 });
    expect(await plan({ cwd: join(repo, "sub") }, choices)).toMatchObject({
      remembered: { base: "current", folder: "parent", parent: join(home, "trees") },
    });
  });
});

describe("POST /api/worktree", () => {
  test("Herdr's default sends no path, and the repo root, branch and base reach Herdr", async () => {
    const mux = new FakeMux();
    const { body } = await create(mux, { cwd: join(repo, "sub"), branch: "fix-tabs", base: { kind: "default" } });
    expect(body.ok).toBe(true);
    expect(mux.creates).toEqual([{ repoRoot: repo, branch: "fix-tabs", base: "main" }]);
  });

  test("Other folder sends the checked child of the parent", async () => {
    const mux = new FakeMux();
    await create(mux, { cwd: repo, branch: "feat/x", folder: { kind: "parent", parent: "~/trees" } });
    expect(mux.creates[0]?.path).toBe(join(home, "trees", "feat-x"));
  });

  test("the rule runs at use time: a parent that broke since the plan reaches no Herdr", async () => {
    const mux = new FakeMux();
    await symlink(join(home, "trees"), join(home, "via"));
    const cases: Array<[JsonValue, string]> = [
      [{ kind: "parent", parent: join(home, "via") }, "worktree.folder_link"],
      [{ kind: "parent", parent: root }, "worktree.folder_outside_home"],
      [{ kind: "parent", parent: `${home}/trees/../trees` }, "worktree.folder_invalid"],
      [{ kind: "parent", parent: join(repo, ".git") }, "worktree.folder_hidden"],
      [{ kind: "parent", parent: join(repo, "sub") }, "worktree.folder_in_repo"],
      [{ kind: "parent", parent: join(home, "trees") }, "worktree.target_exists"],
      [{ kind: "elsewhere" }, "worktree.folder_invalid"],
    ];
    for (const [folder, code] of cases) {
      const { body } = await create(mux, { cwd: repo, branch: "side", folder });
      expect({ folder, body }).toMatchObject({ folder, body: { ok: false, code } });
    }
    expect(mux.creates).toEqual([]);
  });

  test("a branch that reads as a flag, or one git refuses, reaches no Herdr", async () => {
    const mux = new FakeMux();
    expect((await create(mux, { cwd: repo, branch: "-D" })).body).toMatchObject({ code: "worktree.invalid_branch" });
    expect((await create(mux, { cwd: repo, branch: "a..b" })).body).toMatchObject({ code: "worktree.invalid_branch" });
    expect((await create(mux, { cwd: repo, branch: "ok", base: { kind: "ref", ref: "--orphan" } })).body).toMatchObject({
      code: "worktree.invalid_base",
    });
    expect(mux.creates).toEqual([]);
  });

  test("a harness id types the bridge's own binary in the new folder", async () => {
    const mux = new FakeMux();
    const { body } = await create(mux, { cwd: repo, branch: "fix-tabs", harness: "codex" });
    expect(body).toMatchObject({ ok: true, launcherStarted: true });
    expect(mux.texts).toEqual([["w7:p1", "codex"]]);
    expect((await create(mux, { cwd: repo, branch: "x2", harness: "rm -rf" })).body).toMatchObject({
      code: "launch.unknown_harness",
    });
  });

  test("a create that worked is remembered for the repo; a refusal is not", async () => {
    const choices = memoryWorktreeChoices();
    await create(new FakeMux(), { cwd: repo, branch: "side", folder: { kind: "parent", parent: "~/trees" } }, { choices });
    expect(choices.get(repo)).toBeUndefined();
    await create(new FakeMux(), { cwd: repo, branch: "fix", base: { kind: "ref", ref: "side" }, folder: { kind: "parent", parent: "~/trees" } }, { choices });
    expect(choices.get(repo)).toMatchObject({ base: "current", folder: "parent", parent: join(home, "trees") });
  });

  test("a known request id replays and Herdr is asked once", async () => {
    const mux = new FakeMux();
    const receipts = memoryWorktreeReceipts();
    await create(mux, { cwd: repo, branch: "fix-tabs", requestId: ID }, { receipts });
    const again = await create(mux, { cwd: repo, branch: "fix-tabs", requestId: ID }, { receipts });
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(mux.creates).toHaveLength(1);
  });
});

describe("WorktreeChoiceStore — the file", () => {
  test("loading writes nothing; a record writes one owner-only file a restart reads back", async () => {
    const dir = join(root, "state");
    await mkdir(dir);
    const store = new WorktreeChoiceStore(dir, () => {});
    await store.load();
    expect(await readdir(dir)).toEqual([]);
    await store.record(repo, { base: "default", folder: "parent", parent: "/p", at: 1 });
    await store.record(repo, { base: "current", folder: "default", at: 2 });
    expect(await readdir(dir)).toEqual([CHOICES_FILE]);
    const again = new WorktreeChoiceStore(dir, () => {});
    await again.load();
    // The default kind keeps the last parent, so switching back to Other folder still offers it.
    expect(again.get(repo)).toEqual({ base: "current", folder: "default", parent: "/p", at: 2 });
    expect((await Bun.file(join(dir, CHOICES_FILE)).stat()).mode & 0o777).toBe(0o600);
  });

  test("an entry that is not a choice is dropped", () => {
    expect(coerceChoice({ base: "sideways", folder: "default", at: 1 })).toBeNull();
    expect(coerceChoice({ base: "default", folder: "parent", parent: 3, at: 1 })).toBeNull();
  });
});
