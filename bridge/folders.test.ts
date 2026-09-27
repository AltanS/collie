import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  coerceFolderLists,
  FolderStore,
  MAX_FAVOURITES,
  MAX_FOLDER_CHARS,
  MAX_RECENT,
  usableFolder,
  withRecent,
  withStar,
  type FolderLists,
} from "./folders.ts";

// The new-space sheet's folder list (#289, M40/02): what the store keeps, what it refuses, and when
// it writes. The routes that read and star it are pinned in server.test.ts.

const HOME = "/home/op";
const EMPTY: FolderLists = { recent: [], favourites: [] };

/** `n` distinct folders under /srv, oldest first. */
const folders = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `/srv/${prefix}${i}`);

async function withStateDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "collie-folders-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("usableFolder — what may be an entry", () => {
  test("a folder string is kept, one trailing slash dropped", () => {
    expect(usableFolder("/srv/app", HOME)).toBe("/srv/app");
    expect(usableFolder("/srv/app/", HOME)).toBe("/srv/app");
    // The root keeps its only slash.
    expect(usableFolder("/", HOME)).toBe("/");
  });

  test("home is never an entry, however it is spelled", () => {
    expect(usableFolder(HOME, HOME)).toBeNull();
    expect(usableFolder(`${HOME}/`, HOME)).toBeNull();
    expect(usableFolder(HOME, `${HOME}/`)).toBeNull();
    // A folder UNDER home is an ordinary entry.
    expect(usableFolder(`${HOME}/proj`, HOME)).toBe(`${HOME}/proj`);
  });

  test("not a string, empty, or longer than the bound: refused", () => {
    expect(usableFolder(undefined, HOME)).toBeNull();
    expect(usableFolder(42, HOME)).toBeNull();
    expect(usableFolder(null, HOME)).toBeNull();
    expect(usableFolder(["/srv/app"], HOME)).toBeNull();
    expect(usableFolder("", HOME)).toBeNull();
    expect(usableFolder(`/${"a".repeat(MAX_FOLDER_CHARS)}`, HOME)).toBeNull();
    expect(usableFolder(`/${"a".repeat(MAX_FOLDER_CHARS - 1)}`, HOME)).not.toBeNull();
  });
});

describe("withRecent — a successful create with a folder", () => {
  test("newest first, no duplicates", () => {
    let lists: FolderLists = EMPTY;
    for (const f of ["/srv/a", "/srv/b", "/srv/c"]) lists = withRecent(lists, f, HOME) ?? lists;
    expect(lists.recent).toEqual(["/srv/c", "/srv/b", "/srv/a"]);
    // Opening an older one again moves it to the top rather than listing it twice.
    lists = withRecent(lists, "/srv/a", HOME) ?? lists;
    expect(lists.recent).toEqual(["/srv/a", "/srv/c", "/srv/b"]);
    // And `/srv/a/` is the same folder.
    expect(withRecent(lists, "/srv/a/", HOME)).toBeNull();
  });

  test("bounded at eight: the oldest ages out", () => {
    let lists: FolderLists = EMPTY;
    for (const f of folders(MAX_RECENT + 3)) lists = withRecent(lists, f, HOME) ?? lists;
    expect(lists.recent).toHaveLength(MAX_RECENT);
    expect(lists.recent[0]).toBe(`/srv/p${MAX_RECENT + 2}`);
    expect(lists.recent).not.toContain("/srv/p0");
  });

  test("home, an empty report and an over-long one change nothing", () => {
    expect(withRecent(EMPTY, HOME, HOME)).toBeNull();
    expect(withRecent(EMPTY, "", HOME)).toBeNull();
    expect(withRecent(EMPTY, `/${"a".repeat(MAX_FOLDER_CHARS + 1)}`, HOME)).toBeNull();
  });

  test("a favourite is never listed again under Recent", () => {
    const lists: FolderLists = { recent: ["/srv/b"], favourites: ["/srv/a"] };
    expect(withRecent(lists, "/srv/a", HOME)).toBeNull();
  });

  test("the folder already at the top changes nothing, so nothing is written", () => {
    expect(withRecent({ recent: ["/srv/a", "/srv/b"], favourites: [] }, "/srv/a", HOME)).toBeNull();
  });
});

describe("withStar — star and unstar", () => {
  const lists: FolderLists = { recent: ["/srv/a", "/srv/b", "/srv/c"], favourites: ["/srv/f"] };

  test("a star moves a Recent folder to the end of Favourites", () => {
    const out = withStar(lists, "/srv/b", true);
    expect(out).toEqual({
      ok: true,
      changed: true,
      lists: { recent: ["/srv/a", "/srv/c"], favourites: ["/srv/f", "/srv/b"] },
    });
  });

  test("an unstar puts the folder back at the top of Recent", () => {
    const out = withStar(lists, "/srv/f", false);
    expect(out).toEqual({
      ok: true,
      changed: true,
      lists: { recent: ["/srv/f", "/srv/a", "/srv/b", "/srv/c"], favourites: [] },
    });
  });

  test("an unstar into a full Recent pushes the oldest out", () => {
    const full: FolderLists = { recent: folders(MAX_RECENT), favourites: ["/srv/f"] };
    const out = withStar(full, "/srv/f", false);
    expect(out.ok && out.lists.recent).toHaveLength(MAX_RECENT);
    expect(out.ok && out.lists.recent[0]).toBe("/srv/f");
  });

  test("a folder in neither list cannot be starred", () => {
    expect(withStar(lists, "/etc", true)).toEqual({ ok: false, code: "folders.unknown" });
  });

  test("a folder a pane uses right now can be starred, and joins the end of Favourites", () => {
    const out = withStar(lists, "/srv/open/", true, ["/srv/other", "/srv/open"]);
    expect(out).toEqual({
      ok: true,
      changed: true,
      lists: { recent: ["/srv/a", "/srv/b", "/srv/c"], favourites: ["/srv/f", "/srv/open"] },
    });
    // Open somewhere else is not open here: the list names the folder exactly or not at all.
    expect(withStar(lists, "/srv/ope", true, ["/srv/open"])).toEqual({ ok: false, code: "folders.unknown" });
  });

  test("an open folder is still bound by the twelve", () => {
    const full: FolderLists = { recent: [], favourites: folders(MAX_FAVOURITES, "f") };
    expect(withStar(full, "/srv/open", true, ["/srv/open"])).toEqual({ ok: false, code: "folders.favourites_full" });
  });

  test("a thirteenth favourite is refused, never dropping one the operator chose", () => {
    const full: FolderLists = { recent: ["/srv/a"], favourites: folders(MAX_FAVOURITES, "f") };
    expect(withStar(full, "/srv/a", true)).toEqual({ ok: false, code: "folders.favourites_full" });
  });

  test("starring a favourite, or unstarring a non-favourite, is an answer, not a change", () => {
    expect(withStar(lists, "/srv/f", true)).toEqual({ ok: true, lists, changed: false });
    expect(withStar(lists, "/srv/a", false)).toEqual({ ok: true, lists, changed: false });
    expect(withStar(lists, "/etc", false)).toEqual({ ok: true, lists, changed: false });
  });
});

describe("coerceFolderLists — a file the bridge did not write, or wrote long ago", () => {
  test("anything but an object is an empty list", () => {
    for (const raw of [undefined, null, 3, "x", [], [["/srv/a"]]]) {
      expect(coerceFolderLists(raw, HOME)).toEqual(EMPTY);
    }
  });

  test("a wrong-typed field costs that field; a bad entry costs that entry", () => {
    expect(coerceFolderLists({ recent: "/srv/a", favourites: { a: 1 } }, HOME)).toEqual(EMPTY);
    expect(
      coerceFolderLists({ recent: ["/srv/a", 7, null, "", HOME, "/srv/a/", "/srv/b"], favourites: [] }, HOME),
    ).toEqual({ recent: ["/srv/a", "/srv/b"], favourites: [] });
  });

  test("bounds apply on the way in, and a favourite is dropped from Recent", () => {
    const out = coerceFolderLists(
      { recent: ["/srv/f0", ...folders(MAX_RECENT + 4)], favourites: folders(MAX_FAVOURITES + 3, "f") },
      HOME,
    );
    expect(out.favourites).toHaveLength(MAX_FAVOURITES);
    expect(out.recent).toHaveLength(MAX_RECENT);
    expect(out.recent).not.toContain("/srv/f0");
    expect(out.recent[0]).toBe("/srv/p0");
  });
});

describe("FolderStore — the file", () => {
  test("load of a missing file, then reads, write nothing at all", async () => {
    await withStateDir(async (dir) => {
      const store = new FolderStore({ stateDir: dir }, HOME);
      await store.load();
      expect(store.current()).toEqual(EMPTY);
      // A blank create's home and an empty report are not entries, so they are not writes either.
      await store.recordRecent(HOME);
      await store.recordRecent("");
      // Unstarring what is not starred is an answer, not a change.
      expect(await store.star("/srv/a", false)).toMatchObject({ ok: true, changed: false });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test("a malformed file is survived: the lists read empty, and the next write replaces it", async () => {
    await withStateDir(async (dir) => {
      const file = join(dir, "folders.json");
      await writeFile(file, "{ not json");
      const store = new FolderStore({ stateDir: dir }, HOME);
      await store.load();
      expect(store.current()).toEqual(EMPTY);
      await store.recordRecent("/srv/a");
      expect(await Bun.file(file).json()).toEqual({ recent: ["/srv/a"], favourites: [] });
    });
  });

  test("a write is atomic and owner-only: no temp file left, mode 0600", async () => {
    await withStateDir(async (dir) => {
      const store = new FolderStore({ stateDir: dir }, HOME);
      await store.recordRecent("/srv/a");
      expect(await readdir(dir)).toEqual(["folders.json"]);
      expect((await stat(join(dir, "folders.json"))).mode & 0o777).toBe(0o600);
    });
  });

  test("the state dir is created when it is missing", async () => {
    await withStateDir(async (root) => {
      const dir = join(root, "nested", "state");
      const store = new FolderStore({ stateDir: dir }, HOME);
      await store.recordRecent("/srv/a");
      expect(await Bun.file(join(dir, "folders.json")).json()).toEqual({ recent: ["/srv/a"], favourites: [] });
    });
  });

  test("what one bridge writes, the next one reads", async () => {
    await withStateDir(async (dir) => {
      const first = new FolderStore({ stateDir: dir }, HOME);
      await first.recordRecent("/srv/a");
      await first.recordRecent("/srv/b");
      await first.star("/srv/a", true);
      const second = new FolderStore({ stateDir: dir }, HOME);
      await second.load();
      expect(second.current()).toEqual({ recent: ["/srv/b"], favourites: ["/srv/a"] });
    });
  });

  test("taps in quick succession all land, in order, with no temp-file race", async () => {
    await withStateDir(async (dir) => {
      const store = new FolderStore({ stateDir: dir }, HOME);
      for (const f of ["/srv/a", "/srv/b", "/srv/c"]) await store.recordRecent(f);
      // Not awaited one by one: three writes queued at once.
      await Promise.all([store.star("/srv/a", true), store.star("/srv/b", true), store.star("/srv/c", true)]);
      expect(await Bun.file(join(dir, "folders.json")).json()).toEqual({
        recent: [],
        favourites: ["/srv/a", "/srv/b", "/srv/c"],
      });
      expect(await readdir(dir)).toEqual(["folders.json"]);
    });
  });

  test("current() is a copy: a caller cannot change the store", async () => {
    await withStateDir(async (dir) => {
      const store = new FolderStore({ stateDir: dir }, HOME);
      await store.recordRecent("/srv/a");
      store.current().recent.push("/etc");
      expect(store.current().recent).toEqual(["/srv/a"]);
    });
  });

  test("a create whose list cannot be saved still resolves, and says so", async () => {
    await withStateDir(async (root) => {
      // A FILE where the state dir should be: mkdir fails, so the save does.
      const blocked = join(root, "state");
      await writeFile(blocked, "");
      const warnings: string[] = [];
      const store = new FolderStore({ stateDir: blocked }, HOME, (m) => warnings.push(m));
      await store.recordRecent("/srv/a");
      expect(warnings).toHaveLength(1);
      // Kept in memory, so the next write that succeeds carries it.
      expect(store.current().recent).toEqual(["/srv/a"]);
    });
  });

  test("a star may name a folder a pane uses now; never home, an empty report or another folder", async () => {
    await withStateDir(async (dir) => {
      const store = new FolderStore({ stateDir: dir }, HOME);
      const openNow = ["", HOME, `${HOME}/`, "/srv/open/"];
      expect(await store.star(HOME, true, openNow)).toEqual({ ok: false, code: "folders.unknown" });
      expect(await store.star(`${HOME}/`, true, openNow)).toEqual({ ok: false, code: "folders.unknown" });
      expect(await store.star("/srv/elsewhere", true, openNow)).toEqual({ ok: false, code: "folders.unknown" });
      expect(await readdir(dir)).toEqual([]);
      // Either spelling of the open folder reaches the one entry, stored without its slash.
      expect(await store.star("/srv/open", true, openNow)).toMatchObject({ ok: true, changed: true });
      expect(await Bun.file(join(dir, "folders.json")).json()).toEqual({ recent: [], favourites: ["/srv/open"] });
    });
  });

  test("a star the disk refused is not a star: the lists are put back and the error rises", async () => {
    await withStateDir(async (root) => {
      const blocked = join(root, "state");
      await writeFile(blocked, "");
      const store = new FolderStore({ stateDir: blocked }, HOME, () => {});
      await store.recordRecent("/srv/a");
      await expect(store.star("/srv/a", true)).rejects.toThrow();
      expect(store.current()).toEqual({ recent: ["/srv/a"], favourites: [] });
    });
  });
});
