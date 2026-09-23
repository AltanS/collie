import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commonAncestor, rootOfWorkspace, withinBound, workspaceRoot, type RootSnapshot } from "./changes-root.ts";
import { gitEnv } from "./changes.ts";
import { paneChanges, workspaceChanges } from "./server.ts";
import type { AgentView, WorkspaceView } from "./types.ts";

const HOME = "/home/dev";

describe("workspaceRoot — which folder a workspace's Changes list reads", () => {
  test("the mux's own folder wins (herdr worktree checkout, tmux session_path)", () => {
    expect(
      workspaceRoot({
        folder: "/home/dev/projects/collie-workspace",
        cwds: ["/home/dev/projects/collie-workspace/experiments/session-stream"],
        home: HOME,
      }),
    ).toBe("/home/dev/projects/collie-workspace");
  });

  test("without one, the deepest common ancestor of the panes' cwds", () => {
    expect(
      workspaceRoot({
        cwds: [
          "/home/dev/projects/collie-workspace",
          "/home/dev/projects/collie-workspace/experiments/session-stream",
          "/home/dev/projects/collie-workspace/collie/web",
        ],
        home: HOME,
      }),
    ).toBe("/home/dev/projects/collie-workspace");
    // A shared name prefix is not a shared folder.
    expect(workspaceRoot({ cwds: ["/home/dev/projects/ab/x", "/home/dev/projects/abc/y"], home: HOME })).toBe(
      "/home/dev/projects",
    );
    // One pane: its own folder.
    expect(workspaceRoot({ cwds: ["/home/dev/projects/one/"], home: HOME })).toBe("/home/dev/projects/one");
  });

  test("blank and relative cwds are ignored", () => {
    expect(workspaceRoot({ cwds: ["", "  ", "relative/x", "/home/dev/p/a"], home: HOME })).toBe("/home/dev/p/a");
    expect(workspaceRoot({ cwds: ["", "  "], home: HOME })).toBeNull();
    expect(workspaceRoot({ folder: "", cwds: [], home: HOME })).toBeNull();
  });

  test("never `/`, never home itself, never above home", () => {
    expect(workspaceRoot({ cwds: ["/home/dev/a", "/srv/b"], home: HOME })).toBeNull();
    expect(workspaceRoot({ cwds: ["/home/dev/a", "/home/dev/b"], home: HOME })).toBeNull();
    expect(workspaceRoot({ cwds: ["/home/dev/a", "/home/other"], home: HOME })).toBeNull();
    expect(workspaceRoot({ cwds: ["/home/dev"], home: `${HOME}/` })).toBeNull();
  });

  test("a mux folder out of bounds (a tmux session started in ~) falls through to the panes", () => {
    expect(workspaceRoot({ folder: HOME, cwds: ["/home/dev/p/a", "/home/dev/p/b"], home: HOME })).toBe("/home/dev/p");
    expect(workspaceRoot({ folder: "/", cwds: [], home: HOME })).toBeNull();
  });

  test("a folder outside home is fine", () => {
    expect(workspaceRoot({ cwds: ["/srv/app/a", "/srv/app/b"], home: HOME })).toBe("/srv/app");
    expect(withinBound("/tmp/x", HOME)).toBe(true);
  });

  test("commonAncestor", () => {
    expect(commonAncestor([])).toBeNull();
    expect(commonAncestor(["/a/b/c", "/a/b"])).toBe("/a/b");
    expect(commonAncestor(["/a", "/b"])).toBe("/");
  });
});

// ── The two routes, over a fake snapshot and real git ───────────────────────────────────────────

function pane(paneId: string, workspaceId: string, cwd: string): AgentView {
  // SAFETY: the Changes routes read `paneId`, `workspaceId` and `cwd` off a view and nothing else.
  return { paneId, workspaceId, cwd } as AgentView;
}

function space(workspaceId: string, label: string, folder?: string): WorkspaceView {
  const view: WorkspaceView = {
    workspaceId,
    number: 1,
    label,
    focused: false,
    activeTabId: "",
    tabCount: 1,
    paneCount: 1,
  };
  if (folder !== undefined) view.folder = folder;
  return view;
}

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args],
    { cwd, env: gitEnv(process.env), stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

describe("GET /api/pane/:id/changes and /api/workspace/:id/changes", () => {
  let home: string;
  let ws: string;
  let snap: RootSnapshot;
  const engine = { current: () => snap };
  const req = new Request("http://x/");
  const at = (q = "") => new URL(`http://x/api/x/changes${q}`);

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "collie-changes-root-"));
    // A workspace folder holding two repos; one pane sits deep in a subfolder of the first.
    ws = join(home, "projects", "ws");
    for (const name of ["one", "two"]) {
      const dir = join(ws, name);
      mkdirSync(join(dir, "deep", "er"), { recursive: true });
      git(dir, "init", "-q");
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "init");
      writeFileSync(join(dir, "a.txt"), `${name} change\n`);
    }
    snap = {
      agents: [pane("w1:p1", "w1", join(ws, "one", "deep", "er"))],
      shellPanes: [pane("w1:p2", "w1", join(ws, "two")), pane("w2:p1", "w2", home)],
      workspaces: [space("w1", "ws"), space("w2", "home")],
    };
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test("a pane in a subfolder shows the whole workspace, and every pane the same list", async () => {
    const a = await (await paneChanges(engine, "w1:p1", at(), req, home)).json();
    const b = await (await paneChanges(engine, "w1:p2", at(), req, home)).json();
    expect(a).toMatchObject({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "ws", available: true });
    expect(a.repos.map((r: { relPath: string }) => r.relPath).toSorted()).toEqual(["one", "two"]);
    // The list is the same; only the mark of the asking pane's own repo differs.
    expect(a.paneRepo).toBe("one");
    expect(b.paneRepo).toBe("two");
    expect({ ...b, paneId: "w1:p1", paneRepo: "one" }).toEqual(a);
  });

  test("the workspace route answers the same list, and its diff form", async () => {
    const byPane = await (await paneChanges(engine, "w1:p1", at(), req, home)).json();
    const byWs = await (await workspaceChanges(engine, "w1", at(), req, home)).json();
    const { paneId: _paneId, paneRepo: _paneRepo, ...rest } = byPane;
    expect(byWs).toEqual(rest);
    const diff = await (await workspaceChanges(engine, "w1", at("?repo=two&path=a.txt"), req, home)).json();
    expect(diff).toMatchObject({ workspaceId: "w1", workspaceLabel: "ws", available: true, repo: "two" });
    expect(diff.diff).toContain("+two change");
  });

  test("both routes answer the commit view with ?view=commit", async () => {
    const byWs = await (await workspaceChanges(engine, "w1", at("?view=commit&repo=two"), req, home)).json();
    expect(byWs).toMatchObject({ workspaceId: "w1", workspaceLabel: "ws", available: true, repo: "two" });
    expect(byWs.commit.subject).toBe("init");
    expect(byWs.files.map((f: { path: string }) => f.path)).toEqual(["a.txt"]);
    const byPane = await (await paneChanges(engine, "w1:p1", at("?view=commit&repo=two&path=a.txt"), req, home)).json();
    expect(byPane).toMatchObject({ paneId: "w1:p1", available: true, repo: "two", path: "a.txt", hash: byWs.commit.hash });
    const unlisted = await (await paneChanges(engine, "w1:p1", at("?view=commit&repo=two&path=b.txt"), req, home)).json();
    expect(unlisted).toMatchObject({ available: false, reason: "unknown-path" });
  });

  test("the mux folder is preferred over the panes' common folder", async () => {
    const saved = snap;
    snap = { ...snap, workspaces: [space("w1", "ws", join(ws, "two")), space("w2", "home")] };
    const res = await (await workspaceChanges(engine, "w1", at(), req, home)).json();
    snap = saved;
    expect(res.repos.map((r: { relPath: string }) => r.relPath)).toEqual(["."]);
    expect(res.root.endsWith("/two")).toBe(true);
  });

  test("at home: the pane route falls back to the pane's folder, the workspace route says no-folder", async () => {
    const byWs = await (await workspaceChanges(engine, "w2", at(), req, home)).json();
    expect(byWs).toEqual({ workspaceId: "w2", workspaceLabel: "home", available: false, reason: "no-folder" });
    expect(rootOfWorkspace(snap, "w2", home)?.root).toBeNull();
    const byPane = await (await paneChanges(engine, "w2:p1", at(), req, home)).json();
    expect(byPane).toMatchObject({ paneId: "w2:p1", workspaceId: "w2", available: true });
  });

  test("an unknown id is an ordinary answer", async () => {
    expect(await (await paneChanges(engine, "nope", at(), req, home)).json()).toEqual({
      paneId: "nope",
      available: false,
      reason: "no-pane",
    });
    expect(await (await workspaceChanges(engine, "nope", at("?repo=.&path=a"), req, home)).json()).toEqual({
      workspaceId: "nope",
      available: false,
      reason: "no-workspace",
    });
  });
});
