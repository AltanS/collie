import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browseFolders, MAX_BROWSE_FOLDERS, type FolderBrowseContext } from "./folder-browse.ts";
import { UNKNOWN_PATH } from "./files-view.ts";
import { type FolderRouteCaller, serveFolderRoute } from "./server.ts";
import type { SessionRuntime } from "./sessions.ts";
import type { FolderBrowseResponse } from "./types.ts";

// The New page's folder browser (#467) reads the disk under home with the Files view's bound
// (ADR 0083), so most of this file is that view's checklist run against a real home on disk: the
// text forms the New page accepts, the walk up, a link out, the deny list, the cap. Every refusal must
// be the same `unknown-path`.

let base: string;
let home: string;
let outside: string;
let ctx: FolderBrowseContext;

beforeAll(() => {
  // realpath: macOS's tmpdir is itself a link, and home's real path is what containment compares.
  base = realpathSync(mkdtempSync(join(tmpdir(), "collie-browse-")));
  home = join(base, "home");
  outside = join(base, "outside");
  mkdirSync(join(outside, "secret-project"), { recursive: true });
  for (const dir of ["src/plektra-api", "src/Plektra-web", "src/other", "src/plektra-api/missing-not", "docs", ".hidden", ".config/tool", ".config/collie", ".local/state/collie", "paired-devices.json"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  // A repository (a `.git` folder) and a worktree (a `.git` file) both carry the marker.
  mkdirSync(join(home, "src/plektra-api/.git"), { recursive: true });
  writeFileSync(join(home, "src/other/.git"), "gitdir: /elsewhere\n");
  writeFileSync(join(home, "notes.txt"), "not a folder");
  writeFileSync(join(home, "src/README.md"), "not a folder");
  mkdirSync(join(home, "many"));
  for (let i = 0; i < MAX_BROWSE_FOLDERS + 5; i++) mkdirSync(join(home, "many", `d${String(i).padStart(3, "0")}`));
  mkdirSync(join(home, "many", "zz-last"));
  // Every link is to a folder. Windows makes it a junction, which needs no privilege, so the three
  // link tests below run there too; POSIX ignores the type.
  symlinkSync(outside, join(home, "out"), "junction");
  symlinkSync(join(home, "src"), join(home, "code"), "junction");
  symlinkSync(join(home, "nowhere"), join(home, "dangling"), "junction");
  ctx = { home, privateFolders: [join(home, ".local/state/collie"), join(home, ".config/collie")] };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

// SAFETY: the folder routes only test `rt instanceof Response` and never read a member of the runtime.
const localRuntime = { name: "default" } as SessionRuntime;

function caller(opts: { denyAt?: "read" | "device-read" | "write"; resolve?: Response } = {}) {
  const asked: string[] = [];
  const c: FolderRouteCaller = {
    gate: (level) => {
      asked.push(`gate:${level}`);
      return level === opts.denyAt ? new Response("device not authorised", { status: 403 }) : null;
    },
    resolve: () => {
      asked.push("resolve");
      return Promise.resolve(opts.resolve ?? localRuntime);
    },
  };
  return { c, asked };
}

function browseReq(text?: string): Request {
  const q = text === undefined ? "" : `?${new URLSearchParams({ path: text }).toString()}`;
  return new Request(`http://localhost/api/folders/browse${q}`);
}

async function browse(text?: string): Promise<Response> {
  const res = await serveFolderRoute(browseReq(text), "/api/folders/browse", caller().c, undefined, ctx);
  expect(res).not.toBeNull();
  return res!;
}

async function ok(text?: string): Promise<FolderBrowseResponse> {
  const res = await browse(text);
  expect(res.status).toBe(200);
  // SAFETY: a 200 from the browse route is `browseFolders`' answer, typed `FolderBrowseResponse`.
  return (await res.json()) as FolderBrowseResponse;
}

async function refused(text: string): Promise<void> {
  const res = await browse(text);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "unknown-path" });
}

const names = (r: FolderBrowseResponse): string[] => r.folders.map((f) => f.name);

describe("the text, read the way the New page reads a folder", () => {
  test("empty is home: its sub-folders by name, no files, no dot-folders, and no parent above the bound", async () => {
    for (const text of [undefined, "", "   ", "~", "~/"]) {
      const r = await ok(text);
      expect(r.path).toBe(home);
      expect(r.parent).toBeNull();
      expect(r.filter).toBe("");
      expect(r.truncated).toBe(false);
      expect(names(r)).not.toContain("notes.txt");
      expect(names(r)).not.toContain(".hidden");
      expect(names(r)).not.toContain(".config");
      expect(names(r)).toEqual(["code", "docs", "many", "src"]);
    }
  });

  test("`~/src`, `src` (under home) and the absolute path are one folder", async () => {
    for (const text of ["~/src", "src", "src/", join(home, "src"), `${join(home, "src")}/`]) {
      const r = await ok(text);
      expect(r.path).toBe(join(home, "src"));
      expect(r.parent).toBe(home);
      expect(r.filter).toBe("");
      // Sorted by name case-insensitive; README.md is a file.
      expect(names(r)).toEqual(["other", "plektra-api", "Plektra-web"]);
    }
  });

  test("a folder holding a `.git` entry carries the marker, a folder or a worktree's file alike", async () => {
    const r = await ok("~/src");
    expect(r.folders).toEqual([
      { name: "other", git: true },
      { name: "plektra-api", git: true },
      { name: "Plektra-web", git: false },
    ]);
  });

  test("a partial name opens the folder above it, filtered by that name, case-insensitive", async () => {
    const r = await ok("~/src/plektra-");
    expect(r.path).toBe(join(home, "src"));
    expect(r.parent).toBe(home);
    expect(r.filter).toBe("plektra-");
    expect(names(r)).toEqual(["plektra-api", "Plektra-web"]);
    expect(names(await ok("~/src/PLEKTRA-W"))).toEqual(["Plektra-web"]);
    expect(names(await ok("~/src/zzz"))).toEqual([]);
  });

  test("a missing deeper folder walks up to the nearest one that exists, and keeps the rest as the filter", async () => {
    const r = await ok("~/src/plektra-api/missing/deeper");
    expect(r.path).toBe(join(home, "src", "plektra-api"));
    expect(r.parent).toBe(join(home, "src"));
    expect(r.filter).toBe("missing/deeper");
    expect(names(r)).toEqual([]);
    // A file in the text is not a folder: the walk passes it and its name joins the filter.
    const f = await ok("~/notes.txt");
    expect(f.path).toBe(home);
    expect(f.filter).toBe("notes.txt");
    expect(names(f)).toEqual([]);
  });

  test("outside home is refused: an absolute path, a `..`, a `~name`, a control character", async () => {
    await refused(outside);
    await refused("/");
    await refused(base);
    await refused("~/../outside");
    await refused("src/../../outside");
    await refused("~root/x");
    await refused("~/src\u0007");
  });
});

describe("the Files view's bound, with home as the root", () => {
  test("a symlink that leads out of home is never followed, listed or walked past", async () => {
    await refused("~/out");
    await refused("~/out/secret-project");
    await refused("~/out/secret-");
    expect(names(await ok(""))).not.toContain("out");
    expect(names(await ok("~/ou"))).toEqual([]);
  });

  test("a symlink to a folder inside home is listed and browsed under its own name", async () => {
    const r = await ok("~/code");
    expect(r.path).toBe(join(home, "code"));
    expect(names(r)).toEqual(["other", "plektra-api", "Plektra-web"]);
    expect(r.folders.find((f) => f.name === "plektra-api")?.git).toBe(true);
  });

  test("a dangling link is refused, not walked past", async () => {
    await refused("~/dangling");
    expect(names(await ok(""))).not.toContain("dangling");
  });

  test("`.git` is never listed, and a text naming it is refused", async () => {
    expect(names(await ok("~/src/plektra-api"))).toEqual(["missing-not"]);
    expect(names(await ok("~/src/plektra-api/."))).toEqual(["missing-not"]);
    await refused("~/src/plektra-api/.git");
    await refused("~/src/plektra-api/.GIT/objects");
    expect(names(await ok("~/src/plektra-api/.g"))).toEqual([]);
  });

  test("the bridge's state and config folders and a state secret's name are never listed, and refused by name", async () => {
    // A dot filter shows dot-folders: the person typed the dot.
    expect(names(await ok("~/.c"))).toEqual([".config"]);
    expect(names(await ok("~/.config"))).toEqual(["tool"]);
    expect(names(await ok("~/.local/state"))).toEqual([]);
    await refused("~/.config/collie");
    await refused("~/.local/state/collie/x");
    expect(names(await ok("~/paired"))).toEqual([]);
    await refused("~/paired-devices.json");
  });

  test("at most 200 rows, sorted by name, and `truncated` when more matched; typing narrows it", async () => {
    const r = await ok("~/many");
    expect(r.folders).toHaveLength(MAX_BROWSE_FOLDERS);
    expect(r.truncated).toBe(true);
    expect(r.folders[0]!.name).toBe("d000");
    expect(r.folders.at(-1)!.name).toBe("d199");
    expect(names(r)).not.toContain("zz-last");
    const narrowed = await ok("~/many/d20");
    expect(names(narrowed)).toEqual(["d200", "d201", "d202", "d203", "d204"]);
    expect(narrowed.truncated).toBe(false);
  });

  test("a home that is the whole disk, or not there, browses nothing", async () => {
    expect(await browseFolders({ home: "/", privateFolders: [] }, "/etc")).toBe(UNKNOWN_PATH);
    expect(await browseFolders({ home: join(base, "gone"), privateFolders: [] }, join(base, "gone"))).toBe(UNKNOWN_PATH);
  });
});

describe("the route: GET /api/folders/browse", () => {
  test("gated at the Files view's level (`device-read`), then resolved, then read", async () => {
    const { c, asked } = caller();
    const res = await serveFolderRoute(browseReq("~/src"), "/api/folders/browse", c, undefined, ctx);
    expect(res!.status).toBe(200);
    expect(asked).toEqual(["gate:device-read", "resolve"]);
  });

  test("a device the gate refuses is refused before the resolver, and nothing is read", async () => {
    const { c, asked } = caller({ denyAt: "device-read" });
    const res = await serveFolderRoute(browseReq("~/src"), "/api/folders/browse", c, undefined, ctx);
    expect(res!.status).toBe(403);
    expect(asked).toEqual(["gate:device-read"]);
  });

  test("a `?host=` call the resolver forwarded comes back as the member answered it", async () => {
    const member = new Response(`{"error":"unknown-path"}`, { status: 404 });
    const { c } = caller({ resolve: member });
    expect(await serveFolderRoute(browseReq("~/x"), "/api/folders/browse", c, undefined, ctx)).toBe(member);
  });

  test("a bridge built without the browser answers 404, and a POST is not this route", async () => {
    const res = await serveFolderRoute(browseReq("~/src"), "/api/folders/browse", caller().c, undefined, undefined);
    expect(res!.status).toBe(404);
    expect(await res!.text()).toBe("not found");
    const post = new Request("http://localhost/api/folders/browse", { method: "POST" });
    expect(await serveFolderRoute(post, "/api/folders/browse", caller().c, undefined, ctx)).toBeNull();
  });

  test("an over-long text is the one refusal", async () => {
    await refused(`~/${"a".repeat(5000)}`);
  });
});
