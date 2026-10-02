import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  commonAncestor,
  isAbsoluteFolder,
  rootOfWorkspace,
  withinBound,
  workspaceRoot,
  type RootSnapshot,
  type WorkspaceRootInput,
} from "./changes-root.ts";
import { gitEnv } from "./changes.ts";
import { hostFor, isInside } from "./host.ts";
import { paneChanges, workspaceChanges } from "./server.ts";
import type { AgentView, WorkspaceView } from "./types.ts";

const HOME = "/home/dev";

// The rules as they stood before the Windows work, copied here so the rewrite is proven to answer a
// POSIX path the way the string version did, not only to pass the cases written after it.
const legacyNormalize = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return null;
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
};
const legacyCommonAncestor = (paths: readonly string[]): string | null => {
  if (paths.length === 0) return null;
  let parts = paths[0]!.split("/").filter(Boolean);
  for (const path of paths.slice(1)) {
    const other = path.split("/").filter(Boolean);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return `/${parts.join("/")}`;
};
const legacyWithinBound = (path: string, home: string): boolean => {
  if (path === "/") return false;
  const h = legacyNormalize(home);
  if (h === null || h === "/") return true;
  return path !== h && !h.startsWith(`${path}/`);
};
const legacyWorkspaceRoot = (input: Omit<WorkspaceRootInput, "host">): string | null => {
  const folder = legacyNormalize(input.folder);
  if (folder !== null && legacyWithinBound(folder, input.home)) return folder;
  const cwds = input.cwds.map(legacyNormalize).filter((c): c is string => c !== null);
  const common = legacyCommonAncestor(cwds);
  if (common !== null && legacyWithinBound(common, input.home)) return common;
  return null;
};

describe("the POSIX answers are the ones the string rules gave", () => {
  const folders = [
    "/", "/home", "/home/dev", "/home/dev/", "/home/dev/a", "/home/dev/a/b", "/home/devx", "/home/dev/ab",
    "/srv/app", "/srv/app/", "/tmp/x", "/opt", "/Home/Dev", "relative/dir", "", "   ", "./here",
  ];
  const homes = ["/home/dev", "/home/dev/", "/", "", "/root", "relative"];

  test("withinBound agrees on every folder against every home", () => {
    for (const home of homes) {
      for (const f of folders) {
        const path = legacyNormalize(f);
        if (path === null) continue;
        expect(withinBound(path, home, hostFor("linux"))).toBe(legacyWithinBound(path, home));
      }
    }
  });

  test("commonAncestor agrees on every pair and triple of folders", () => {
    const clean = folders.map(legacyNormalize).filter((f): f is string => f !== null);
    for (const a of clean) {
      for (const b of clean) {
        expect(commonAncestor([a, b], hostFor("linux"))).toBe(legacyCommonAncestor([a, b]));
        expect(commonAncestor([a, b, "/home/dev/a"], hostFor("linux"))).toBe(legacyCommonAncestor([a, b, "/home/dev/a"]));
      }
    }
    expect(commonAncestor([], hostFor("linux"))).toBeNull();
  });

  test("workspaceRoot agrees on every mux folder and pane set against every home", () => {
    const cwdSets = [[], ["/home/dev/a"], ["/home/dev/a", "/home/dev/b"], ["/srv/app", "/srv/other"], ["/home/dev/a/", "rel"]];
    for (const home of homes) {
      for (const folder of [undefined, ...folders]) {
        for (const cwds of cwdSets) {
          const input = { folder, cwds, home };
          expect(posixRoot(input)).toBe(legacyWorkspaceRoot(input));
        }
      }
    }
  });
});

// These rules mean POSIX paths, so they pin a POSIX host: the default is the machine's own flavour, which
// on Windows reads `/home/dev/...` as a drive-relative path.
const posixRoot = (input: Omit<WorkspaceRootInput, "host">): string | null =>
  workspaceRoot({ ...input, host: hostFor("linux") });

describe("workspaceRoot — which folder a workspace's Changes list reads", () => {
  test("the mux's own folder wins (herdr worktree checkout, tmux session_path)", () => {
    expect(
      posixRoot({
        folder: "/home/dev/projects/collie-workspace",
        cwds: ["/home/dev/projects/collie-workspace/experiments/session-stream"],
        home: HOME,
      }),
    ).toBe("/home/dev/projects/collie-workspace");
  });

  test("without one, the deepest common ancestor of the panes' cwds", () => {
    expect(
      posixRoot({
        cwds: [
          "/home/dev/projects/collie-workspace",
          "/home/dev/projects/collie-workspace/experiments/session-stream",
          "/home/dev/projects/collie-workspace/collie/web",
        ],
        home: HOME,
      }),
    ).toBe("/home/dev/projects/collie-workspace");
    // A shared name prefix is not a shared folder.
    expect(posixRoot({ cwds: ["/home/dev/projects/ab/x", "/home/dev/projects/abc/y"], home: HOME })).toBe(
      "/home/dev/projects",
    );
    // One pane: its own folder.
    expect(posixRoot({ cwds: ["/home/dev/projects/one/"], home: HOME })).toBe("/home/dev/projects/one");
  });

  test("blank and relative cwds are ignored", () => {
    expect(posixRoot({ cwds: ["", "  ", "relative/x", "/home/dev/p/a"], home: HOME })).toBe("/home/dev/p/a");
    expect(posixRoot({ cwds: ["", "  "], home: HOME })).toBeNull();
    expect(posixRoot({ folder: "", cwds: [], home: HOME })).toBeNull();
  });

  test("never `/`, never home itself, never above home", () => {
    expect(posixRoot({ cwds: ["/home/dev/a", "/srv/b"], home: HOME })).toBeNull();
    expect(posixRoot({ cwds: ["/home/dev/a", "/home/dev/b"], home: HOME })).toBeNull();
    expect(posixRoot({ cwds: ["/home/dev/a", "/home/other"], home: HOME })).toBeNull();
    expect(posixRoot({ cwds: ["/home/dev"], home: `${HOME}/` })).toBeNull();
  });

  test("a mux folder out of bounds (a tmux session started in ~) falls through to the panes", () => {
    expect(posixRoot({ folder: HOME, cwds: ["/home/dev/p/a", "/home/dev/p/b"], home: HOME })).toBe("/home/dev/p");
    expect(posixRoot({ folder: "/", cwds: [], home: HOME })).toBeNull();
  });

  test("a folder outside home is fine", () => {
    expect(posixRoot({ cwds: ["/srv/app/a", "/srv/app/b"], home: HOME })).toBe("/srv/app");
    expect(withinBound("/tmp/x", HOME, hostFor("linux"))).toBe(true);
  });

  test("commonAncestor", () => {
    expect(commonAncestor([], hostFor("linux"))).toBeNull();
    expect(commonAncestor(["/a/b/c", "/a/b"], hostFor("linux"))).toBe("/a/b");
    expect(commonAncestor(["/a", "/b"], hostFor("linux"))).toBe("/");
  });
});

// ── The same rules on Windows paths, pinned with path.win32 so Linux CI runs them ───────────────

describe("the root rules on Windows paths (path.win32)", () => {
  const host = hostFor("win32");
  const WIN_HOME = "C:\\Users\\pat";

  test("a drive-letter or UNC path is absolute; a relative or blank one is not", () => {
    expect(isAbsoluteFolder("C:\\Users\\pat\\repo", host)).toBe(true);
    expect(isAbsoluteFolder("c:/Users/pat", host)).toBe(true);
    expect(isAbsoluteFolder("\\\\srv\\share\\x", host)).toBe(true);
    expect(isAbsoluteFolder("repo\\sub", host)).toBe(false);
    expect(isAbsoluteFolder("C:repo", host)).toBe(false);
    expect(isAbsoluteFolder("  ", host)).toBe(false);
  });

  test("isInside: the folder itself and below, never a sibling that shares a name prefix", () => {
    const inside = (folder: string, parent: string) => isInside(host, folder, parent);
    expect(inside("C:\\Users\\pat\\repo", "C:\\Users\\pat\\repo")).toBe(true);
    expect(inside("C:\\Users\\pat\\repo\\sub\\deep", "C:\\Users\\pat\\repo")).toBe(true);
    expect(inside("C:\\Users\\pat\\repo2", "C:\\Users\\pat\\repo")).toBe(false);
    expect(inside("C:\\Users\\pat", "C:\\Users\\pat\\repo")).toBe(false);
    // Case, slash direction and the `\\?\` prefix are spellings, not places.
    expect(inside("c:/users/PAT/Repo/sub", "C:\\Users\\pat\\repo")).toBe(true);
    expect(inside("\\\\?\\C:\\Users\\pat\\repo\\sub", "C:\\Users\\pat\\repo")).toBe(true);
    expect(inside("\\\\?\\UNC\\srv\\share\\a\\b", "\\\\srv\\share\\a")).toBe(true);
    // Another drive or another share is never inside, even with the same folder names.
    expect(inside("D:\\Users\\pat\\repo", "C:\\Users\\pat\\repo")).toBe(false);
    expect(inside("\\\\srv\\other\\a", "\\\\srv\\share\\a")).toBe(false);
  });

  test("a folder inside home, outside home, or on another drive is within the bound", () => {
    expect(withinBound("C:\\Users\\pat\\repo", WIN_HOME, host)).toBe(true);
    expect(withinBound("D:\\work\\repo", WIN_HOME, host)).toBe(true);
    expect(withinBound("C:\\srv\\app", WIN_HOME, host)).toBe(true);
    expect(withinBound("\\\\srv\\share\\repo", WIN_HOME, host)).toBe(true);
  });

  test("a drive root, home itself and every folder above home are not, whatever the case", () => {
    expect(withinBound("C:\\", WIN_HOME, host)).toBe(false);
    expect(withinBound("D:\\", WIN_HOME, host)).toBe(false);
    expect(withinBound("\\\\srv\\share\\", WIN_HOME, host)).toBe(false);
    expect(withinBound("C:\\Users", WIN_HOME, host)).toBe(false);
    expect(withinBound("C:\\Users\\pat", WIN_HOME, host)).toBe(false);
    expect(withinBound("c:\\users\\PAT", WIN_HOME, host)).toBe(false);
    expect(withinBound("C:\\Users\\pat", "c:/users/pat/", host)).toBe(false);
    expect(withinBound("\\\\?\\C:\\Users\\pat", WIN_HOME, host)).toBe(false);
    // A home that is a drive root bounds nothing.
    expect(withinBound("D:\\work", "C:\\", host)).toBe(true);
  });

  test("commonAncestor keeps the first spelling, folds case, and finds nothing across drives", () => {
    expect(commonAncestor(["C:\\Users\\pat\\repo", "C:\\Users\\pat\\repo\\sub"], host)).toBe("C:\\Users\\pat\\repo");
    // A shared name prefix is not a shared folder.
    expect(commonAncestor(["C:\\Users\\pat\\repo", "C:\\Users\\pat\\repo2"], host)).toBe("C:\\Users\\pat");
    expect(commonAncestor(["C:\\Users\\pat\\Repo", "c:/users/pat/repo/sub"], host)).toBe("C:\\Users\\pat\\Repo");
    expect(commonAncestor(["C:\\a", "C:\\b"], host)).toBe("C:\\");
    expect(commonAncestor(["C:\\Users\\pat\\repo", "D:\\Users\\pat\\repo"], host)).toBeNull();
    expect(commonAncestor(["C:\\Users\\pat\\repo", "\\\\srv\\share\\repo"], host)).toBeNull();
    expect(commonAncestor([], host)).toBeNull();
  });

  test("workspaceRoot: the mux folder, else the panes' common folder, bounded by home", () => {
    const root = (input: { folder?: string; cwds: string[] }) => workspaceRoot({ ...input, home: WIN_HOME, host });
    expect(root({ folder: "C:\\Users\\pat\\ws\\", cwds: ["C:\\Users\\pat\\ws\\one"] })).toBe("C:\\Users\\pat\\ws");
    expect(root({ cwds: ["C:\\Users\\pat\\ws\\one", "C:\\Users\\pat\\ws\\two\\src"] })).toBe("C:\\Users\\pat\\ws");
    expect(root({ cwds: ["", "relative\\x", "D:\\work\\a"] })).toBe("D:\\work\\a");
    // Out of bounds: home itself (any case), a drive root, panes that only share the drive.
    expect(root({ folder: "c:\\users\\pat", cwds: ["C:\\Users\\pat\\p\\a", "C:\\Users\\pat\\p\\b"] })).toBe(
      "C:\\Users\\pat\\p",
    );
    expect(root({ cwds: ["C:\\Users\\pat\\a", "C:\\Users\\pat\\b"] })).toBeNull();
    expect(root({ cwds: ["C:\\Users\\pat\\a", "C:\\other"] })).toBeNull();
    expect(root({ cwds: ["C:\\work\\a", "D:\\work\\a"] })).toBeNull();
    expect(root({ folder: "C:\\", cwds: [] })).toBeNull();
  });

  test("workspaceRoot returns one spelling of a folder, the host's own, whichever the input used", () => {
    const root = (input: { folder?: string; cwds: string[] }) => workspaceRoot({ ...input, home: WIN_HOME, host });
    expect(root({ folder: "C:/Users/pat/ws" , cwds: [] })).toBe("C:\\Users\\pat\\ws");
    expect(root({ folder: "C:\\Users\\pat\\ws", cwds: [] })).toBe("C:\\Users\\pat\\ws");
    expect(root({ folder: "\\\\?\\C:\\Users\\pat\\ws", cwds: [] })).toBe("C:\\Users\\pat\\ws");
    expect(root({ folder: "//srv/share/ws/", cwds: [] })).toBe("\\\\srv\\share\\ws");
    // The pane folders, mixed spellings of one place, meet at one native folder.
    expect(root({ cwds: ["C:/Users/pat/ws/one", "C:\\Users\\pat\\ws\\two"] })).toBe("C:\\Users\\pat\\ws");
    expect(root({ cwds: ["D:/work/a"] })).toBe("D:\\work\\a");
  });

  test("path.posix pinned on any host keeps the POSIX answers", () => {
    const pinned = { host: hostFor("linux") };
    expect(workspaceRoot({ cwds: ["/srv/app/a", "/srv/app/b"], home: HOME, ...pinned })).toBe("/srv/app");
    expect(workspaceRoot({ cwds: ["C:\\x"], home: HOME, ...pinned })).toBeNull();
    expect(isInside(pinned.host, "/a/B", "/a/b")).toBe(false);
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
    expect(basename(res.root)).toBe("two");
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
