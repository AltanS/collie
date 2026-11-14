import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog, type AuditEntry } from "./audit.ts";
import { forwardAuditAction, forwardKind } from "./crew/forward.ts";
import { harnessLaunch } from "./harness-launch.ts";
import type { JsonObject } from "./json.ts";
import { muxAck, muxOk, type MuxAdapter, type MuxCreatedPane, type MuxGrid, type MuxOutcome, type MuxSpaceRequest } from "./mux/types.ts";
import { createWorktreeAt, planWorktree, serveWorktreeFolderRoute, type FolderRouteCaller } from "./server.ts";
import type { SessionRuntime } from "./sessions.ts";
import type { StateEngine } from "./state-engine.ts";
import type { WorktreeCreateResponse, WorktreeFolderSettingResponse, WorktreePlanResponse } from "./types.ts";
import { memoryWorktreeChoices } from "./worktree-choices.ts";
import {
  FOLDER_SETTING_FILE,
  WorktreeFolderSettingStore,
  coerceFolderSetting,
  memoryWorktreeFolderSetting,
} from "./worktree-folder-setting.ts";
import { resolveSetFolderTarget } from "./worktree-folder.ts";
import { memoryWorktreeReceipts } from "./worktree-receipts.ts";

// The "Worktree folder" setting (ADR 0093, note of 2026-11-13), against a real git repo in a temporary
// home:
//
//   1. The store keeps one string in the state dir, reads it back, clears it, and reads anything
//      broken as unset.
//   2. The rule: the setting's directory passes rules 1 to 5, and the target is
//      `<dir>/<repo folder name>/<slug>`, with the repo's folder and the child checked.
//   3. The order at the sheet: unset is Herdr's rule (its config, else `~/.herdr/worktrees`); set wins
//      over Herdr's config; an explicit parent pick wins over both and is what the sheet remembers.
//   4. The rule runs on every use: a setting that broke since it was saved is refused at plan and create.
//   5. The routes: gated, forwarded by `?host=`, one audit line with the act and no path.

let root: string;
let home: string;
let repo: string;
let state: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "collie-wt-setting-")));
  home = join(root, "home", "op");
  repo = join(home, "src", "app");
  state = join(root, "state");
  await mkdir(repo, { recursive: true });
  await mkdir(join(home, "trees"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const noConfig = () => Promise.resolve(null);
const deps = () => ({ home, readHerdrConfig: noConfig });

describe("the store", () => {
  test("a fresh state dir is unset and writes nothing", async () => {
    const store = new WorktreeFolderSettingStore(state);
    await store.load();
    expect(store.get()).toBeUndefined();
    await expect(stat(join(state, FOLDER_SETTING_FILE))).rejects.toThrow();
  });

  test("a saved value is read back by a new store, in an owner-only file", async () => {
    const store = new WorktreeFolderSettingStore(state);
    expect(await store.set("  ~/trees  ")).toBe(true);
    expect(store.get()).toBe("~/trees");
    const again = new WorktreeFolderSettingStore(state);
    await again.load();
    expect(again.get()).toBe("~/trees");
    expect(JSON.parse(await readFile(join(state, FOLDER_SETTING_FILE), "utf8"))).toEqual({ version: 1, dir: "~/trees" });
    // Windows has no POSIX mode bits, so only the mode expectation waits for another platform.
    if (process.platform !== "win32") expect((await stat(join(state, FOLDER_SETTING_FILE))).mode & 0o777).toBe(0o600);
  });

  test("null clears it, and the file goes", async () => {
    const store = new WorktreeFolderSettingStore(state);
    await store.set("~/trees");
    expect(await store.set(null)).toBe(true);
    expect(store.get()).toBeUndefined();
    await expect(stat(join(state, FOLDER_SETTING_FILE))).rejects.toThrow();
  });

  test("a broken file, a foreign version and a control character all read as unset", () => {
    expect(coerceFolderSetting({ version: 1, dir: "~/trees" })).toBe("~/trees");
    expect(coerceFolderSetting({ version: 2, dir: "~/trees" })).toBeUndefined();
    expect(coerceFolderSetting({ version: 1, dir: "" })).toBeUndefined();
    expect(coerceFolderSetting({ version: 1, dir: "~/a\nb" })).toBeUndefined();
    expect(coerceFolderSetting({ version: 1, dir: 7 })).toBeUndefined();
    expect(coerceFolderSetting([1])).toBeUndefined();
  });

  test("a write that fails leaves the value as it was and says so", async () => {
    const warnings: string[] = [];
    // The state dir is a file, so the write cannot make it.
    await writeFile(state, "x");
    const store = new WorktreeFolderSettingStore(state, (line) => warnings.push(line));
    expect(await store.set("~/trees")).toBe(false);
    expect(store.get()).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe("the rule: <dir>/<repo folder name>/<slug>", () => {
  const resolve = (dir: string, branch = "feat/x") => resolveSetFolderTarget({ dir, branch, repoRoot: repo, home });

  test("a directory under home gives Herdr's shape, and the repo's folder need not exist yet", async () => {
    expect(await resolve("~/trees")).toEqual({ ok: true, path: join(home, "trees", "app", "feat-x") });
    expect(await resolve(join(home, "trees"), "Fix/Tabs")).toEqual({ ok: true, path: join(home, "trees", "app", "fix-tabs") });
  });

  test("two repos with different folder names never share a folder", async () => {
    const other = join(home, "src", "other");
    await mkdir(other, { recursive: true });
    const a = await resolve("~/trees");
    const b = await resolveSetFolderTarget({ dir: "~/trees", branch: "feat/x", repoRoot: other, home });
    expect(a.ok && b.ok && a.path !== b.path).toBe(true);
  });

  test("rules 1 to 5 refuse what ADR 0093 refuses", async () => {
    await mkdir(join(home, ".hidden"), { recursive: true });
    await symlink(join(home, "trees"), join(home, "link"));
    const outside = join(root, "outside");
    await mkdir(outside);
    const code = async (dir: string) => {
      const out = await resolve(dir);
      return out.ok ? "ok" : out.code;
    };
    expect(await code("")).toBe("worktree.folder_invalid");
    expect(await code("trees")).toBe("worktree.folder_invalid");
    expect(await code("~/../etc")).toBe("worktree.folder_invalid");
    expect(await code("~/a\u0007b")).toBe("worktree.folder_invalid");
    expect(await code("~/nowhere")).toBe("worktree.folder_missing");
    expect(await code("~/link")).toBe("worktree.folder_link");
    expect(await code(outside)).toBe("worktree.folder_outside_home");
    expect(await code("~/.hidden")).toBe("worktree.folder_hidden");
    expect(await code("~/src/app")).toBe("worktree.folder_in_repo");
  });

  test("a repo folder that is a link, or a file, is refused; a child that exists is target_exists", async () => {
    await symlink(join(home, "src"), join(home, "trees", "app"));
    expect(await resolve("~/trees")).toMatchObject({ ok: false, code: "worktree.folder_link" });
    await rm(join(home, "trees", "app"));
    await mkdir(join(home, "trees", "app", "feat-x"), { recursive: true });
    expect(await resolve("~/trees")).toMatchObject({ ok: false, code: "worktree.target_exists" });
  });
});

// ── The sheet's plan and the create ──────────────────────────────────────────────────────────────

async function plan(query: Record<string, string>, setting: string | undefined, config: () => Promise<string | null> = noConfig) {
  const url = new URL("http://x/api/worktree/plan");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await planWorktree(new Request(url), memoryWorktreeChoices(), {
    home,
    readHerdrConfig: config,
    folderSetting: memoryWorktreeFolderSetting(setting),
  });
  // SAFETY: planWorktree wrote this body and typed it as WorktreePlanResponse itself.
  return (await res.json()) as WorktreePlanResponse;
}

class FakeMux {
  readonly spaces: MuxSpaceRequest[] = [];
  createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    return Promise.resolve(muxOk({ paneId: "w7:p1", spaceId: "w7", spaceLabel: "x", tabId: "w7:t1", cwd: request.cwd }));
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText = () => Promise.resolve(muxAck());
  writeKeys = () => Promise.resolve(muxAck());
  closePane = () => Promise.resolve(muxAck());
  refresh = () => Promise.resolve();
}

function engine(): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: a create reaches `current()` and `pokeNow()` and nothing else.
  return stub as StateEngine;
}

function asMux(fake: Partial<MuxAdapter>): MuxAdapter {
  // SAFETY: a create reaches createSpace, readGrid, typeText, writeKeys and refresh: what FakeMux implements.
  return fake as MuxAdapter;
}

async function create(mux: FakeMux, body: JsonObject, setting: string | undefined, config: () => Promise<string | null> = noConfig) {
  const choices = memoryWorktreeChoices();
  const res = await createWorktreeAt(
    asMux(mux),
    engine(),
    new Request("http://x/api/worktree", { method: "POST", body: JSON.stringify({ cwd: repo, ...body }) }),
    new AuditLog(() => {}),
    null,
    "default",
    () => Promise.resolve([]),
    {
      home,
      readHerdrConfig: config,
      receipts: memoryWorktreeReceipts(),
      choices,
      harnesses: { launch: harnessLaunch },
      wait: { now: () => 0, sleep: () => Promise.resolve() },
      folderSetting: memoryWorktreeFolderSetting(setting),
    },
  );
  // SAFETY: createWorktreeAt wrote this body as a WorktreeCreateResponse.
  return { body: (await res.json()) as WorktreeCreateResponse, choices };
}

const HERDR_CONFIG = (dir: string) => () => Promise.resolve(`[worktrees]\ndirectory = "${dir}"\n`);

describe("the order of the default: the setting, then Herdr's config, then ~/.herdr/worktrees", () => {
  test("unset is Herdr's rule: its config directory, else ~/.herdr/worktrees", async () => {
    const bare = await plan({ cwd: repo, branch: "feat/x" }, undefined);
    expect(bare).toMatchObject({ defaultSource: "rule", defaultTarget: { path: join(home, ".herdr", "worktrees", "app", "feat-x"), exists: false } });
    const configured = await plan({ cwd: repo, branch: "feat/x" }, undefined, HERDR_CONFIG("~/from-herdr"));
    expect(configured).toMatchObject({ defaultSource: "rule", defaultTarget: { path: join(home, "from-herdr", "app", "feat-x") } });
  });

  test("set wins over Herdr's config, in Herdr's shape", async () => {
    const answer = await plan({ cwd: repo, branch: "feat/x" }, "~/trees", HERDR_CONFIG("~/from-herdr"));
    expect(answer).toMatchObject({ defaultSource: "setting", defaultTarget: { path: join(home, "trees", "app", "feat-x"), exists: false } });
  });

  test("a parent pick is still answered on its own, and the plan needs a branch for any target", async () => {
    await mkdir(join(home, "picked"));
    const answer = await plan({ cwd: repo, branch: "feat/x", parent: "~/picked" }, "~/trees");
    expect(answer).toMatchObject({ parentTarget: { ok: true, path: join(home, "picked", "feat-x") }, defaultSource: "setting" });
    const none = await plan({ cwd: repo }, "~/trees");
    expect(none.ok && none.defaultTarget).toBeUndefined();
  });

  test("a setting that breaks after it was saved is refused at plan, with no promised folder", async () => {
    const answer = await plan({ cwd: repo, branch: "feat/x" }, "~/gone");
    expect(answer).toMatchObject({ ok: true, defaultSource: "setting", defaultRefusal: { code: "worktree.folder_missing" } });
    expect(answer.ok && answer.defaultTarget).toBeUndefined();
  });

  test("a create with the default folder and a set value makes the checkout there, and remembers no parent", async () => {
    const mux = new FakeMux();
    const { body, choices } = await create(mux, { branch: "feat/x" }, "~/trees", HERDR_CONFIG("~/from-herdr"));
    const folder = join(home, "trees", "app", "feat-x");
    expect(body).toMatchObject({ ok: true, pane: { cwd: folder } });
    expect(await git(folder, "symbolic-ref", "--short", "HEAD")).toBe("feat/x");
    expect(mux.spaces[0]).toMatchObject({ cwd: folder, worktree: { repoRoot: repo } });
    expect(choices.get(repo)).toMatchObject({ folder: "default" });
    expect(choices.get(repo)?.parent).toBeUndefined();
  });

  test("a create with unset goes where Herdr's rule says, as before", async () => {
    const { body } = await create(new FakeMux(), { branch: "feat/y" }, undefined);
    expect(body).toMatchObject({ ok: true, pane: { cwd: join(home, ".herdr", "worktrees", "app", "feat-y") } });
  });

  test("an explicit parent pick wins over the setting, and is what the sheet remembers", async () => {
    await mkdir(join(home, "picked"));
    const { body, choices } = await create(new FakeMux(), { branch: "feat/z", folder: { kind: "parent", parent: "~/picked" } }, "~/trees");
    expect(body).toMatchObject({ ok: true, pane: { cwd: join(home, "picked", "feat-z") } });
    expect(choices.get(repo)).toMatchObject({ folder: "parent", parent: join(home, "picked") });
  });

  test("the rule runs again at create: a setting that broke is refused and nothing reaches the multiplexer or git", async () => {
    const mux = new FakeMux();
    const { body } = await create(mux, { branch: "feat/q" }, "~/gone");
    expect(body).toMatchObject({ ok: false, code: "worktree.folder_missing" });
    expect(mux.spaces).toEqual([]);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("feat-q");
  });
});

// ── The routes ───────────────────────────────────────────────────────────────────────────────────

// SAFETY: the setting's routes only test `rt instanceof Response` and read `rt.name` for the audit line.
const localRuntime = { name: "default" } as SessionRuntime;

function caller(opts: { denyAt?: "read" | "write"; resolve?: Response } = {}) {
  const asked: string[] = [];
  const entries: Array<AuditEntry & { ts: string }> = [];
  const audit = new AuditLog((line) => {
    // SAFETY: the appender is handed formatAuditLine's own output, so the parse round-trips it.
    entries.push(JSON.parse(line) as AuditEntry & { ts: string });
  });
  const c: FolderRouteCaller & { device(): string | null; audit: AuditLog } = {
    gate: (level) => {
      asked.push(`gate:${level}`);
      return opts.denyAt === level ? new Response("denied", { status: 403 }) : null;
    },
    resolve: () => {
      asked.push("resolve");
      return Promise.resolve(opts.resolve ?? localRuntime);
    },
    device: () => "phone",
    audit,
  };
  return { c, asked, entries };
}

const get = () => new Request("http://x/api/worktree/folder");
const setRaw = (body: string) => new Request("http://x/api/worktree/folder/set", { method: "POST", body });
const set = (body: JsonObject) => setRaw(JSON.stringify(body));

async function serve(req: Request, c: ReturnType<typeof caller>, store = memoryWorktreeFolderSetting()) {
  const res = await serveWorktreeFolderRoute(req, new URL(req.url).pathname, c.c, store, deps());
  return { res, store };
}

describe("GET and POST /api/worktree/folder", () => {
  test("the read answers unset with the fallback folder Herdr uses", async () => {
    const { res } = await serve(get(), caller());
    expect(await res?.json()).toEqual({ ok: true, dir: null, fallback: join(home, ".herdr", "worktrees") });
  });

  test("a set saves the string, answers its real path, and writes one audit line with the act and no path", async () => {
    const c = caller();
    const { res, store } = await serve(set({ dir: "~/trees" }), c);
    expect(await res?.json()).toMatchObject({ ok: true, dir: "~/trees", path: join(home, "trees") });
    expect(store.get()).toBe("~/trees");
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ action: "worktree.folder", detail: { act: "set" } });
    expect(JSON.stringify(c.entries[0])).not.toContain("trees");
  });

  test("a folder that fails the rule is refused, nothing is stored and nothing is audited", async () => {
    const c = caller();
    const { res, store } = await serve(set({ dir: "~/nowhere" }), c);
    expect(await res?.json()).toMatchObject({ ok: false, code: "worktree.folder_missing" });
    expect(store.get()).toBeUndefined();
    expect(c.entries).toEqual([]);
  });

  test("null clears it", async () => {
    const store = memoryWorktreeFolderSetting("~/trees");
    const c = caller();
    const { res } = await serve(set({ dir: null }), c, store);
    expect(await res?.json()).toMatchObject({ ok: true, dir: null });
    expect(store.get()).toBeUndefined();
    expect(c.entries[0]).toMatchObject({ detail: { act: "clear" } });
  });

  test("a stored value that broke shows its problem on the read, and the value stays", async () => {
    const { res } = await serve(get(), caller(), memoryWorktreeFolderSetting("~/gone"));
    // SAFETY: the route wrote this body as a WorktreeFolderSettingResponse.
    const answer = (await res?.json()) as WorktreeFolderSettingResponse;
    expect(answer).toMatchObject({ ok: true, dir: "~/gone", problem: { code: "worktree.folder_missing" } });
    expect(answer.path).toBeUndefined();
  });

  test("a bad body is a 400, and a body that is not a string or null is too", async () => {
    expect((await serve(setRaw("{"), caller())).res?.status).toBe(400);
    expect((await serve(set({ dir: 5 }), caller())).res?.status).toBe(400);
    expect((await serve(set({}), caller())).res?.status).toBe(400);
  });

  test("the write is gated first, then the resolver, and a read-only device cannot write", async () => {
    const c = caller({ denyAt: "write" });
    const { res, store } = await serve(set({ dir: "~/trees" }), c);
    expect(res?.status).toBe(403);
    expect(c.asked).toEqual(["gate:write"]);
    expect(store.get()).toBeUndefined();
    const reader = caller({ denyAt: "write" });
    expect((await serve(get(), reader)).res?.status).toBe(200);
    expect(reader.asked).toEqual(["gate:read", "resolve"]);
  });

  test("a call addressed at a member is that member's answer, untouched, and this store is not read or written", async () => {
    const member = new Response("the member's own", { status: 200 });
    const store = memoryWorktreeFolderSetting("~/trees");
    const readC = caller({ resolve: member });
    expect((await serve(get(), readC, store)).res).toBe(member);
    const writeC = caller({ resolve: member });
    expect((await serve(set({ dir: null }), writeC, store)).res).toBe(member);
    expect(store.get()).toBe("~/trees");
    expect(writeC.entries).toEqual([]);
  });

  test("another path or method is none of this route's", async () => {
    const c = caller();
    expect(await serveWorktreeFolderRoute(new Request("http://x/api/worktree/folder", { method: "POST" }), "/api/worktree/folder", c.c, memoryWorktreeFolderSetting(), deps())).toBeNull();
    expect(await serveWorktreeFolderRoute(get(), "/api/worktree/plan", c.c, memoryWorktreeFolderSetting(), deps())).toBeNull();
  });
});

describe("in a crew each machine has its own value", () => {
  test("the read crosses the link as a read and the write as a write, audited like the member's own line", () => {
    expect(forwardKind("worktree/folder", "GET")).toBe("read");
    expect(forwardKind("worktree/folder/set", "POST")).toBe("write");
    expect(forwardAuditAction("worktree/folder", "GET")).toBeNull();
    expect(forwardAuditAction("worktree/folder/set", "POST")).toBe("worktree.folder");
  });
});
