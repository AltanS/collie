import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { pictureHeader, pictureHeaderFits, PROJECT_PICTURE_BYTES_MAX } from "../web/src/lib/project-picture-wire.ts";
import { hillImageMime, hillImageSize } from "./hill/media.ts";
import { forwardedPictureRoute, HILL_MEDIA_HEADERS, HILL_MEDIA_MISSING, PROJECT_PICTURE_ROUTE, projectPictureRoute } from "./server.ts";
import { checkIconPath, cleanName, descriptorIs, ENCLOSING_MAX, isControlCode, locateProjectFile, NEVER_TABLES, parseProjectFile, PROJECT_FILE_BYTES_MAX, PROJECT_KEYS, readProjectFile, readSmallFile } from "./project-file.ts";
import { checkProjectPicture, iconTarget, pictureVersion, pngAnimated, ProjectPictures, readCappedBody, readProjectPicture, READS_MAX, STAMP_TTL_MS, LOCATE_TTL_MS, webpAnimated, type PictureReader } from "./project-picture.ts";

/** A FIFO is a file on disk on Linux and macOS; Windows has none (its named pipes live under `\\.\pipe\`). */
const NAMED_PIPES_ON_DISK = process.platform !== "win32";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh real folder, spelled as the OS's own real path: the one `locateProjectFile` and the readers
 * resolve to (`fs/promises` `realpath`). Plain `realpathSync` keeps an 8.3 short name, and the Windows
 * runner's `tmpdir()` is one (`C:\Users\RUNNER~1\...`), so an expectation built from it named a
 * path the product rightly never answers (Windows CI, 2026-11-21).
 */
function folder(prefix = "collie-project-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

function chunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}

/** A PNG with its IHDR, an optional acTL, one IDAT and IEND. The CRCs are zero: nothing here checks them. */
function png(width = 128, height = 128, opts: { animated?: boolean; pad?: number } = {}): Uint8Array<ArrayBuffer> {
  const parts = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk("IHDR", [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...(opts.animated === true ? [chunk("acTL", [...be32(2), ...be32(0)])] : []),
    chunk("IDAT", Array.from({ length: opts.pad ?? 16 }, () => 0)),
    chunk("IEND", []),
  ];
  return new Uint8Array(parts.flat());
}

function jpeg(width = 200, height = 100): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

/** A VP8X WebP, its animation flag set or not, with an optional ANIM chunk after it. */
function webp(width = 256, height = 256, opts: { flag?: boolean; anim?: boolean } = {}): Uint8Array {
  const vp8x = [...ascii("VP8X"), ...le32(10), opts.flag === true ? 0x02 : 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const anim = opts.anim === true ? [...ascii("ANIM"), ...le32(6), 0, 0, 0, 0, 0, 0] : [];
  const body = [...ascii("WEBP"), ...vp8x, ...anim];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

/** `git init` without git: a `.git` folder with a HEAD and an objects folder. */
function repo(root: string): string {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

function write(path: string, content: string | Uint8Array): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("the project file's reader", () => {
  test("[project] icon is read; unknown tables and keys are ignored and listed, never an error", () => {
    const read = parseProjectFile(`
[project]
icon = "assets/logo.png"
name = "later"

[commands]
deploy = "rm -rf /"

[hooks]
pre = "curl evil"

top = 1
`);
    expect(read.settings).toEqual({ icon: "assets/logo.png" });
    expect(read.refused).toEqual([]);
    expect(read.ignored).toEqual(expect.arrayContaining(["project.name", "commands", "hooks"]));
    expect(read.parseError).toBe(false);
  });

  test("a wrong type is refused by name; a file that is not TOML answers nothing", () => {
    expect(parseProjectFile("[project]\nicon = 5\n")).toMatchObject({ settings: {}, refused: ["project.icon is not a text"] });
    expect(parseProjectFile("[project]\nicon = 1979-05-27\n").settings).toEqual({});
    expect(parseProjectFile("project = \"flat\"\n")).toMatchObject({ settings: {}, ignored: ["project"] });
    expect(parseProjectFile("[project\nicon=")).toMatchObject({ settings: {}, parseError: true });
  });

  test("a table named like a prototype member is only an unknown table", () => {
    const read = parseProjectFile('[constructor]\nicon = "x.png"\n[toString]\na = 1\n');
    expect(read.settings).toEqual({});
    expect(read.ignored).toEqual(["constructor", "toString"]);
  });

  test("an ignored name is printed without its control characters and at a bounded length", () => {
    const read = parseProjectFile(`["a\\u001b[31mred\\u202e"]\nx = 1\n["${"n".repeat(200)}"]\ny = 2\n`);
    expect(read.ignored[0]).toBe("a[31mred");
    expect(read.ignored[1]!.length).toBe(64);
  });

  test("the fixed list never holds a table that could act", () => {
    for (const name of NEVER_TABLES) expect(Object.hasOwn(PROJECT_KEYS, name)).toBe(false);
    expect(Object.keys(PROJECT_KEYS)).toEqual(["project"]);
    expect(Object.keys(PROJECT_KEYS.project)).toEqual(["icon"]);
  });

  test("the icon path: relative, / only, no . or .. step, not under .git, a bounded text", () => {
    expect(checkIconPath("assets/logo.png")).toEqual({ ok: true, value: "assets/logo.png" });
    for (const bad of ["/etc/passwd", "~/x.png", "C:/x.png", "../x.png", "a/../../x.png", "./x.png", "a//x.png", "a\\x.png", ".git/x.png", "a/.GIT/x.png", "", "x".repeat(257), "a\u0000.png", "a\u202e.png"]) {
      expect(checkIconPath(bad).ok).toBe(false);
    }
  });
});

describe("which file speaks for a folder", () => {
  test("the nearest file wins, from the session's folder up to the repository root", async () => {
    const root = repo(folder());
    write(join(root, "collie.toml"), "[project]\n");
    write(join(root, "web", "collie.toml"), "[project]\n");
    mkdirSync(join(root, "web", "src", "deep"), { recursive: true });
    expect(await locateProjectFile(join(root, "web", "src", "deep"))).toEqual({ file: join(root, "web", "collie.toml"), root });
    mkdirSync(join(root, "docs"));
    expect(await locateProjectFile(join(root, "docs"))).toEqual({ file: join(root, "collie.toml"), root });
  });

  test("never above the repository root", async () => {
    const outer = folder();
    write(join(outer, "collie.toml"), "[project]\n");
    const root = repo(join(outer, "checkout"));
    mkdirSync(join(root, "src"), { recursive: true });
    expect(await locateProjectFile(join(root, "src"))).toBeNull();
  });

  test("outside any repository: only a file in the folder itself", async () => {
    const outer = folder();
    write(join(outer, "collie.toml"), "[project]\n");
    mkdirSync(join(outer, "sub"));
    expect(await locateProjectFile(outer)).toEqual({ file: join(outer, "collie.toml"), root: outer });
    expect(await locateProjectFile(join(outer, "sub"))).toBeNull();
  });

  test("a linked worktree: its own tree first, then the main checkout from the same folder", async () => {
    const main = repo(folder());
    write(join(main, "collie.toml"), "[project]\n");
    const wtGit = join(main, ".git", "worktrees", "feat");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = folder();
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    // Git's back link, which a real `git worktree add` writes (R4).
    writeFileSync(join(wtGit, "gitdir"), `${join(wt, ".git")}\n`);
    mkdirSync(join(wt, "src"));
    expect(await locateProjectFile(join(wt, "src"))).toEqual({ file: join(main, "collie.toml"), root: main });
    write(join(wt, "collie.toml"), "[project]\n");
    expect(await locateProjectFile(join(wt, "src"))).toEqual({ file: join(wt, "collie.toml"), root: wt });
  });

  test("a submodule is a tree of its own, and the outer repository speaks for it only as an enclosing one (R8)", async () => {
    const outer = repo(folder());
    write(join(outer, "collie.toml"), "[project]\n");
    const sub = join(outer, "vendor", "lib");
    mkdirSync(join(outer, ".git", "modules", "lib"), { recursive: true });
    write(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    // No main checkout for a submodule: the outer file comes in as the enclosing repository's.
    expect(await locateProjectFile(sub)).toEqual({ file: join(outer, "collie.toml"), root: outer, enclosing: outer });
    // Its own file wins.
    write(join(sub, "collie.toml"), "[project]\n");
    expect(await locateProjectFile(sub)).toEqual({ file: join(sub, "collie.toml"), root: sub });
  });

  test("a folder reached through a symlink walks its real tree", async () => {
    const root = repo(folder());
    write(join(root, "collie.toml"), "[project]\n");
    mkdirSync(join(root, "src"));
    const elsewhere = folder();
    symlinkSync(join(root, "src"), join(elsewhere, "link"));
    expect(await locateProjectFile(join(elsewhere, "link"))).toEqual({ file: join(root, "collie.toml"), root });
  });
});

describe("reading the file off disk", () => {
  test("a regular file at most 16 KB is read", async () => {
    const dir = folder();
    const path = write(join(dir, "collie.toml"), '[project]\nicon = "a.png"\n');
    expect(await readProjectFile(path)).toMatchObject({ settings: { icon: "a.png" }, problem: null });
  });

  test("a file larger than the cap, a folder, a FIFO, a symlink and bytes that are not UTF-8 are refused", async () => {
    const dir = folder();
    const big = write(join(dir, "big.toml"), `# ${"x".repeat(PROJECT_FILE_BYTES_MAX)}\n`);
    expect((await readProjectFile(big)).problem).toContain("larger than 16 KB");
    mkdirSync(join(dir, "dir.toml"));
    expect((await readProjectFile(join(dir, "dir.toml"))).problem).toBe("is not a regular file");
    // Windows has no FIFO in its file system and no `mkfifo`: only that step is left out there.
    if (NAMED_PIPES_ON_DISK) {
      execFileSync("mkfifo", [join(dir, "fifo.toml")]);
      expect((await readProjectFile(join(dir, "fifo.toml"))).problem).toBe("is not a regular file");
    }
    symlinkSync(big, join(dir, "link.toml"));
    expect((await readProjectFile(join(dir, "link.toml"))).problem).toBe("is a symlink");
    const latin = write(join(dir, "latin.toml"), new Uint8Array([0x23, 0xff, 0xfe, 0x0a]));
    expect((await readProjectFile(latin)).problem).toBe("is not UTF-8 text");
  });

  test("a refused nearest file stops the walk: no reach to a file further up", async () => {
    const root = repo(folder());
    write(join(root, "collie.toml"), '[project]\nicon = "a.png"\n');
    mkdirSync(join(root, "web", "collie.toml"), { recursive: true });
    expect(await locateProjectFile(join(root, "web"))).toEqual({ file: join(root, "web", "collie.toml"), root });
  });
});

describe("the picture's rules", () => {
  test("PNG, JPEG and WebP inside the limits pass; the version is the sha256's first 24 hex", async () => {
    const dir = folder();
    for (const [name, bytes] of [["a.png", png()], ["b.jpg", jpeg()], ["c.webp", webp()]] as const) {
      const read = await readProjectPicture(write(join(dir, name), bytes), []);
      expect(read).toMatchObject({ ok: true, version: pictureVersion(bytes) });
    }
    expect(pictureVersion(png())).toMatch(/^[0-9a-f]{24}$/);
  });

  test("SVG, GIF and HTML are refused by their first bytes, whatever the name", async () => {
    const dir = folder();
    for (const [name, text] of [["a.png", '<svg xmlns="http://www.w3.org/2000/svg"/>'], ["b.png", "GIF89a\u0001\u0000\u0001\u0000"], ["c.png", "<!doctype html><script></script>"]] as const) {
      expect((await readProjectPicture(write(join(dir, name), text), [])).ok).toBe(false);
    }
  });

  test("an animated PNG and an animated WebP are refused", () => {
    expect(pngAnimated(png(128, 128, { animated: true }))).toBe(true);
    expect(checkProjectPicture(png(128, 128, { animated: true }), "image/png")).toContain("animated");
    expect(webpAnimated(webp(256, 256, { flag: true }))).toBe(true);
    expect(webpAnimated(webp(256, 256, { anim: true }))).toBe(true);
    expect(checkProjectPicture(webp(256, 256, { anim: true }), "image/webp")).toContain("animated");
    expect(checkProjectPicture(png(), "image/png")).toBeNull();
    expect(checkProjectPicture(webp(), "image/webp")).toBeNull();
  });

  test("a PNG whose chunks cannot be walked to its image data is refused", () => {
    const cut = png().subarray(0, 40);
    expect(pngAnimated(cut)).toBeNull();
    expect(checkProjectPicture(cut, "image/png")).not.toBeNull();
  });

  test("each side is 64 to 1024 px, read from the header", () => {
    expect(checkProjectPicture(png(64, 1024), "image/png")).toBeNull();
    expect(checkProjectPicture(png(63, 128), "image/png")).toContain("63 x 128");
    expect(checkProjectPicture(png(128, 1025), "image/png")).toContain("each side");
    expect(checkProjectPicture(jpeg(2000, 100), "image/jpeg")).toContain("each side");
    expect(checkProjectPicture(webp(32, 32), "image/webp")).toContain("each side");
  });

  test("at most 256 KB, refused on lstat before any read", async () => {
    const dir = folder();
    const big = write(join(dir, "big.png"), png(128, 128, { pad: PROJECT_PICTURE_BYTES_MAX }));
    expect(await readProjectPicture(big, [])).toMatchObject({ ok: false, why: "is larger than 256 KB" });
  });

  test("a symlink, a symlinked folder on the way, a FIFO and a path under a denied folder are refused", async () => {
    const dir = folder();
    const real = write(join(dir, "real", "a.png"), png());
    symlinkSync(real, join(dir, "link.png"));
    expect((await readProjectPicture(join(dir, "link.png"), [])).ok).toBe(false);
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    expect((await readProjectPicture(join(dir, "linked", "a.png"), [])).ok).toBe(false);
    if (NAMED_PIPES_ON_DISK) {
      execFileSync("mkfifo", [join(dir, "fifo.png")]);
      expect((await readProjectPicture(join(dir, "fifo.png"), [])).ok).toBe(false);
    }
    expect((await readProjectPicture(real, [join(dir, "real")])).ok).toBe(false);
  });

  test("the joined path must stay strictly below the repository root", () => {
    // The host's own absolute paths: `/repo` on Linux and macOS, `C:\repo` (the current drive) on Windows.
    const repoRoot = resolve("/repo");
    const located = { file: join(repoRoot, "web", "collie.toml"), root: repoRoot };
    expect(iconTarget(located, "assets/a.png")).toBe(join(repoRoot, "web", "assets", "a.png"));
    // checkIconPath refuses `..` first; this is the second check on the joined path.
    expect(iconTarget(located, "../../etc/a.png")).toBeNull();
    expect(iconTarget({ file: join(repoRoot, "collie.toml"), root: repoRoot }, "..")).toBeNull();
    // A sibling whose name starts with the root's is not below it.
    expect(iconTarget(located, "../../repo-other/a.png")).toBeNull();
  });
});

describe("the cache", () => {
  function setup() {
    const root = repo(folder());
    write(join(root, "collie.toml"), '[project]\nicon = "assets/logo.png"\n');
    const bytes = png();
    write(join(root, "assets", "logo.png"), bytes);
    mkdirSync(join(root, "src"));
    return { root, bytes };
  }

  test("get answers from memory: nothing on the first ask, the version once the background read lands", async () => {
    const { root, bytes } = setup();
    const pictures = new ProjectPictures(true, []);
    expect(pictures.get(join(root, "src"))).toBeUndefined();
    await pictures.refresh([join(root, "src")]);
    expect(pictures.get(join(root, "src"))).toBe(pictureVersion(bytes));
  });

  test("a changed picture gets a new version only after its stamp clock, never faster", async () => {
    const { root } = setup();
    let now = 1_000;
    const pictures = new ProjectPictures(true, [], () => now);
    await pictures.refresh([root]);
    const first = pictures.get(root);
    const next = png(256, 256);
    write(join(root, "assets", "logo.png"), next);
    now += STAMP_TTL_MS - 1;
    await pictures.refresh([root]);
    expect(pictures.get(root)).toBe(first);
    now += 1;
    await pictures.refresh([root]);
    expect(pictures.get(root)).toBe(pictureVersion(next));
  });

  test("a picture that turns hostile drops the version", async () => {
    const { root } = setup();
    let now = 1_000;
    const pictures = new ProjectPictures(true, [], () => now);
    await pictures.refresh([root]);
    write(join(root, "assets", "logo.png"), png(128, 128, { animated: true }));
    now += STAMP_TTL_MS;
    await pictures.refresh([root]);
    expect(pictures.get(root)).toBeUndefined();
  });

  test("off is off: no version and no bytes", async () => {
    const { root, bytes } = setup();
    const pictures = new ProjectPictures(false, []);
    await pictures.refresh([root]);
    expect(pictures.get(root)).toBeUndefined();
    expect(await pictures.bytesOf(pictureVersion(bytes))).toBeNull();
  });

  test("bytesOf serves only a version the cache resolved, and only while the bytes still match", async () => {
    const { root, bytes } = setup();
    const pictures = new ProjectPictures(true, []);
    await pictures.refresh([root]);
    const version = pictureVersion(bytes);
    expect((await pictures.bytesOf(version))?.bytes).toEqual(bytes);
    expect(await pictures.bytesOf("0".repeat(12))).toBeNull();
    expect(await pictures.bytesOf("../../etc/passwd")).toBeNull();
    write(join(root, "assets", "logo.png"), png(200, 200));
    expect(await pictures.bytesOf(version)).toBeNull();
  });

  test("an icon that leaves the repository is never resolved", async () => {
    const outer = folder();
    write(join(outer, "secret.png"), png());
    const root = repo(join(outer, "repo"));
    write(join(root, "collie.toml"), '[project]\nicon = "../secret.png"\n');
    const pictures = new ProjectPictures(true, []);
    await pictures.refresh([root]);
    expect(pictures.get(root)).toBeUndefined();
    expect((await pictures.report(root)).refused).toEqual(["project.icon has an empty, . or .. step"]);
  });

  test("the report lists the file, what it ignored and whether the picture passed", async () => {
    const { root } = setup();
    write(join(root, "collie.toml"), '[project]\nicon = "assets/logo.png"\ncolor = "red"\n[launch]\nx = 1\n');
    const report = await new ProjectPictures(true, []).report(root);
    expect(report).toMatchObject({ file: join(root, "collie.toml"), ignored: ["project.color", "launch"], refused: [], icon: { path: "assets/logo.png", ok: true } });
  });
});

describe("the route", () => {
  test("the route's grammar is one opaque segment", () => {
    expect(PROJECT_PICTURE_ROUTE.exec("/api/project-picture/abcdef012345abcdef012345")?.[1]).toBe("abcdef012345abcdef012345");
    expect(PROJECT_PICTURE_ROUTE.exec("/api/project-picture/a/b")).toBeNull();
  });

  test("a held version answers its bytes with the hill image's headers and its type", async () => {
    const bytes = new Uint8Array(png());
    const res = await projectPictureRoute("abcdef012345abcdef012345", { bytesOf: async (v) => (v === "abcdef012345abcdef012345" ? { mime: "image/png", bytes } : null) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    for (const [name, value] of Object.entries(HILL_MEDIA_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("every miss is the same 404, and no source at all is a miss", async () => {
    for (const res of [await projectPictureRoute("abcdef012345abcdef012345", undefined), await projectPictureRoute("x", { bytesOf: async () => null })]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(HILL_MEDIA_MISSING);
    }
  });
});

/** Control codes the project file's names and paths may never carry (L2): C1, line and paragraph separators, bidi. */
const HOSTILE_CODES = [0x009b, 0x0085, 0x2028, 0x2029, 0x202e, 0x2066, 0x200e, 0x200f, 0x061c];
/** The same, as a TOML `\u` escape run, so the parser itself produces the characters. */
const HOSTILE_TOML = HOSTILE_CODES.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("");
const HOSTILE_TEXT = String.fromCodePoint(...HOSTILE_CODES);

/** A promise that never settles: a mount that hangs. */
const never = () => new Promise<never>(() => undefined);

function makeFifo(path: string): boolean {
  try {
    return Bun.spawnSync(["mkfifo", path]).exitCode === 0;
  } catch {
    return false;
  }
}

describe("a folder whose disk hangs (M1)", () => {
  function projectWith(icon = "logo.png") {
    const root = repo(folder());
    write(join(root, "collie.toml"), `[project]\nicon = "${icon}"\n`);
    const bytes = png();
    write(join(root, icon), bytes);
    return { root, bytes, picture: join(root, icon) };
  }

  test("one folder out of time costs only that folder, and a read that never ends starts no second one in 30 cycles (R1)", async () => {
    const a = projectWith();
    const b = projectWith();
    const calls: string[] = [];
    const readPicture: PictureReader = (path, denied) => {
      calls.push(path);
      return path === a.picture ? never() : readProjectPicture(path, denied);
    };
    let now = 1_000;
    const pictures = new ProjectPictures(true, [], () => now, { readPicture, timeMs: 20 });
    const started = performance.now();
    await pictures.refresh([a.root, b.root]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(pictures.get(b.root)).toBe(pictureVersion(b.bytes));
    expect(pictures.get(a.root)).toBeUndefined();
    for (let cycle = 0; cycle < 30; cycle++) {
      now += LOCATE_TTL_MS + STAMP_TTL_MS;
      await pictures.refresh([a.root, b.root]);
      pictures.get(a.root);
    }
    // The hung read is still the one read out for A: no pile.
    expect(calls.filter((p) => p === a.picture)).toHaveLength(1);
    expect(pictures.readsOut()).toBe(1);
  });

  test("the whole bridge has at most READS_MAX reads out, across folders (R1)", async () => {
    const projects = Array.from({ length: READS_MAX + 3 }, () => projectWith());
    let calls = 0;
    const readPicture: PictureReader = () => {
      calls += 1;
      return never();
    };
    let now = 1_000;
    const pictures = new ProjectPictures(true, [], () => now, { readPicture, timeMs: 20 });
    for (let cycle = 0; cycle < 5; cycle++) {
      await pictures.refresh(projects.map((p) => p.root));
      now += LOCATE_TTL_MS + STAMP_TTL_MS;
    }
    expect(pictures.readsOut()).toBe(READS_MAX);
    expect(calls).toBeLessThanOrEqual(READS_MAX);
  });

  test("with every read slot taken, the route answers the miss at once (R1)", async () => {
    const good = projectWith();
    const hung = Array.from({ length: READS_MAX }, () => projectWith());
    const hungPaths = new Set(hung.map((p) => p.picture));
    let blocked = false;
    const readPicture: PictureReader = (path, denied) => (blocked && hungPaths.has(path) ? never() : readProjectPicture(path, denied));
    let now = 1_000;
    const pictures = new ProjectPictures(true, [], () => now, { readPicture, timeMs: 20_000 });
    await pictures.refresh([good.root]);
    const version = pictureVersion(good.bytes);
    blocked = true;
    now += LOCATE_TTL_MS + STAMP_TTL_MS;
    void pictures.refresh(hung.map((p) => p.root));
    // Let the folder reads reach their hung picture reads.
    for (let i = 0; i < 50 && pictures.readsOut() < READS_MAX; i++) await Bun.sleep(5);
    expect(pictures.readsOut()).toBe(READS_MAX);
    const started = performance.now();
    expect(await pictures.bytesOf(version)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("bytesOf for a picture whose read now hangs answers null within the time limit", async () => {
    const a = projectWith();
    let hang = false;
    const readPicture: PictureReader = (path, denied) => (hang ? never() : readProjectPicture(path, denied));
    const pictures = new ProjectPictures(true, [], Date.now, { readPicture, timeMs: 50 });
    await pictures.refresh([a.root]);
    const version = pictureVersion(a.bytes);
    expect((await pictures.bytesOf(version))?.bytes).toEqual(a.bytes);
    hang = true;
    const started = performance.now();
    expect(await pictures.bytesOf(version)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("the async picture reader keeps every check (M1)", () => {
  test("a valid PNG is read; its version is 24 hex", async () => {
    const dir = folder();
    const bytes = png();
    const read = await readProjectPicture(write(join(dir, "a.png"), bytes), []);
    expect(read).toMatchObject({ ok: true, mime: "image/png" });
    if (read.ok) expect(read.version).toMatch(/^[0-9a-f]{24}$/);
  });

  test("a symlink to a valid PNG is refused", async () => {
    const dir = folder();
    const real = write(join(dir, "real.png"), png());
    symlinkSync(real, join(dir, "link.png"));
    expect(await readProjectPicture(join(dir, "link.png"), [])).toMatchObject({ ok: false, why: expect.stringContaining("symlink") });
  });

  test("a path through a symlinked folder is refused", async () => {
    const dir = folder();
    write(join(dir, "real", "a.png"), png());
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    expect(await readProjectPicture(join(dir, "linked", "a.png"), [])).toMatchObject({ ok: false, why: expect.stringContaining("symlinked folder") });
  });

  test("a FIFO is refused and the read does not hang", async () => {
    const dir = folder();
    const path = join(dir, "fifo.png");
    if (!makeFifo(path)) return;
    const started = performance.now();
    const read = await readProjectPicture(path, []);
    // Windows has no FIFO on disk: Git for Windows' `mkfifo` (on the runner's PATH) makes an MSYS
    // stand-in that is no regular file the OS can open. It is refused all the same; only the reason
    // differs.
    expect(read.ok).toBe(false);
    if (NAMED_PIPES_ON_DISK) expect(read).toMatchObject({ ok: false, why: "is not a regular file" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a file over 256 KB is refused", async () => {
    const dir = folder();
    const path = write(join(dir, "big.png"), png(128, 128, { pad: PROJECT_PICTURE_BYTES_MAX }));
    expect(await readProjectPicture(path, [])).toMatchObject({ ok: false, why: "is larger than 256 KB" });
  });

  test("a path under a denied folder is refused", async () => {
    const dir = folder();
    const path = write(join(dir, "state", "a.png"), png());
    expect(await readProjectPicture(path, [join(dir, "state")])).toMatchObject({ ok: false, why: expect.stringContaining("Collie's own folders") });
  });

  test("a path with a .git segment is refused", async () => {
    const dir = folder();
    const path = write(join(dir, ".git", "a.png"), png());
    expect(await readProjectPicture(path, [])).toMatchObject({ ok: false, why: expect.stringContaining(".git") });
  });

  test("an animated PNG is refused", async () => {
    const dir = folder();
    const path = write(join(dir, "a.png"), png(128, 128, { animated: true }));
    expect(await readProjectPicture(path, [])).toMatchObject({ ok: false, why: expect.stringContaining("animated") });
  });
});

describe("a crew member's picture, checked on the lead (M2.1)", () => {
  const bytes = png();
  const version = pictureVersion(bytes);

  async function expectMiss(res: Response) {
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(HILL_MEDIA_MISSING);
  }

  test("a valid picture answers 200 with the type from its bytes, the hill's media headers and none of the member's", async () => {
    const member = new Response(bytes, { headers: { "content-type": "text/html", etag: '"member"', "set-cookie": "sid=1", "x-member": "yes" } });
    const res = await forwardedPictureRoute(version, member);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    for (const [name, value] of Object.entries(HILL_MEDIA_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    for (const name of ["etag", "set-cookie", "x-member"]) expect(res.headers.get(name)).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("a version that is not the bytes' hash is a miss", async () => {
    await expectMiss(await forwardedPictureRoute("0".repeat(24), new Response(bytes)));
    await expectMiss(await forwardedPictureRoute("../../etc/passwd", new Response(bytes)));
  });

  test("a body over 256 KB is a miss, and an endless body is not read past the cap", async () => {
    const big = png(128, 128, { pad: PROJECT_PICTURE_BYTES_MAX });
    await expectMiss(await forwardedPictureRoute(pictureVersion(big), new Response(big)));
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Promise.resolve();
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expectMiss(await forwardedPictureRoute(version, new Response(endless)));
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  test("bytes that are not an image, and an animated PNG, are a miss", async () => {
    const html = new TextEncoder().encode("<!doctype html><script>1</script>");
    await expectMiss(await forwardedPictureRoute(pictureVersion(html), new Response(html)));
    const moving = png(128, 128, { animated: true });
    await expectMiss(await forwardedPictureRoute(pictureVersion(moving), new Response(moving)));
  });

  test("a member status 500 and a content-encoding are a miss", async () => {
    await expectMiss(await forwardedPictureRoute(version, new Response(bytes, { status: 500 })));
    await expectMiss(await forwardedPictureRoute(version, new Response(bytes, { headers: { "content-encoding": "gzip" } })));
  });
});

describe("readCappedBody", () => {
  test("exactly the cap passes, one byte more is null", async () => {
    expect((await readCappedBody(new Response(new Uint8Array(100)), 100))?.length).toBe(100);
    expect(await readCappedBody(new Response(new Uint8Array(101)), 100)).toBeNull();
  });

  test("a body split over many chunks is joined in order", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect(await readCappedBody(new Response(stream), 10)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a null body is empty bytes", async () => {
    expect(await readCappedBody(new Response(null), 10)).toEqual(new Uint8Array());
  });

  test("a stream that errors is null", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });
    expect(await readCappedBody(new Response(stream), 10)).toBeNull();
  });
});

describe("a hostile worktree pointer (L1)", () => {
  test("a commondir naming another repository's .git does not reach that repository's collie.toml", async () => {
    const base = folder();
    const other = join(base, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    write(join(other, "collie.toml"), "[project]\n");
    const evil = join(base, "evil");
    mkdirSync(join(evil, "fake"), { recursive: true });
    mkdirSync(join(evil, "sub"));
    writeFileSync(join(evil, ".git"), "gitdir: fake\n");
    writeFileSync(join(evil, "fake", "commondir"), `${join(other, ".git")}\n`);
    expect(await locateProjectFile(join(evil, "sub"))).toBeNull();
  });

  test("a git dir that is not under worktrees/ is not believed either", async () => {
    const main = repo(folder());
    write(join(main, "collie.toml"), "[project]\n");
    writeFileSync(join(main, ".git", "commondir"), ".\n");
    const wt = folder();
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git")}\n`);
    expect(await locateProjectFile(wt)).toBeNull();
  });

  test("a genuine worktree with an absolute commondir still reaches the main checkout", async () => {
    const main = repo(folder());
    write(join(main, "collie.toml"), "[project]\n");
    const wtGit = join(main, ".git", "worktrees", "wt");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), `${join(main, ".git")}\n`);
    const wt = folder();
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    writeFileSync(join(wtGit, "gitdir"), `${join(wt, ".git")}\n`);
    expect(await locateProjectFile(wt)).toEqual({ file: join(main, "collie.toml"), root: main });
  });

  test("a .git file that borrows another repository's real worktree entry gets no main checkout (R4)", async () => {
    // The victim has a real worktree entry, back link and all, for its own worktree.
    const victim = repo(folder());
    write(join(victim, "collie.toml"), "[project]\n");
    const entry = join(victim, ".git", "worktrees", "real");
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "commondir"), "../..\n");
    const victimWt = folder();
    writeFileSync(join(victimWt, ".git"), `gitdir: ${entry}\n`);
    writeFileSync(join(entry, "gitdir"), `${join(victimWt, ".git")}\n`);
    expect(await locateProjectFile(victimWt)).toEqual({ file: join(victim, "collie.toml"), root: victim });
    // Case A: an absolute pointer to that entry. Case B: a relative one. Case C: through a symlink.
    const evilA = folder();
    writeFileSync(join(evilA, ".git"), `gitdir: ${entry}\n`);
    const evilB = folder();
    writeFileSync(join(evilB, ".git"), `gitdir: ${relative(evilB, entry)}\n`);
    const evilC = folder();
    symlinkSync(entry, join(evilC, "lnk"));
    writeFileSync(join(evilC, ".git"), "gitdir: lnk\n");
    for (const evil of [evilA, evilB, evilC]) expect(await locateProjectFile(evil)).toBeNull();
  });

  test("a layout made by a real `git worktree add` still reaches the main checkout (R4)", async () => {
    const main = folder();
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
    try {
      git(main, "init", "-q");
      write(join(main, "README"), "x\n");
      git(main, "add", "README");
      git(main, "commit", "-q", "-m", "x");
      // Not committed, so the worktree's checkout has none of its own.
      write(join(main, "collie.toml"), "[project]\n");
    } catch {
      return; // no git on this host
    }
    const wt = join(folder(), "wt");
    git(main, "worktree", "add", "-q", wt);
    expect(await locateProjectFile(wt)).toEqual({ file: join(main, "collie.toml"), root: main });
  });
});

describe("one resolve, one truth (R2)", () => {
  test("the descriptor is compared with the caller's own path, never a fresh resolve", async () => {
    const dir = folder();
    mkdirSync(join(dir, "real"));
    const inside = write(join(dir, "real", "a.png"), png());
    symlinkSync(join(dir, "real"), join(dir, "flip"));
    const through = join(dir, "flip", "a.png");
    // The caller checked `through` as if it were real: the open lands elsewhere, so nothing is read.
    expect(await readSmallFile(through, 1 << 20, through)).toBeNull();
    // The same file named by the path that really holds it is read.
    expect(await readSmallFile(inside, 1 << 20, inside)).not.toBeNull();
  });

  test("the open file must be the file the caller's first lstat saw", async () => {
    const dir = folder();
    const a = write(join(dir, "a.png"), png());
    const b = write(join(dir, "b.png"), png());
    const seen = await lstat(b);
    expect(await readSmallFile(a, 1 << 20, a, { dev: seen.dev, ino: seen.ino })).toBeNull();
  });
});

describe("a slow member body (R3)", () => {
  test("a body that stops sending ends as no bytes at the time limit", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) controller.enqueue(new Uint8Array(10));
        return new Promise(() => undefined);
      },
    });
    const started = performance.now();
    expect(await readCappedBody(new Response(body), 1024, 50)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("control characters in names and paths (L2)", () => {
  test("the ignored names of a table and a key hold none", () => {
    const read = parseProjectFile(`["a${HOSTILE_TOML}b"]\nx = 1\n[project]\n"k${HOSTILE_TOML}z" = 1\n`);
    expect(read.parseError).toBe(false);
    expect(read.ignored).toEqual(["ab", "project.kz"]);
    for (const name of read.ignored) for (const ch of name) expect(isControlCode(ch.codePointAt(0) ?? 0)).toBe(false);
  });

  test("an icon path holding any of them is refused", () => {
    for (const code of HOSTILE_CODES) expect(checkIconPath(`a${String.fromCodePoint(code)}b.png`).ok).toBe(false);
    expect(checkIconPath(`a${HOSTILE_TEXT}.png`).ok).toBe(false);
    expect(parseProjectFile(`[project]\nicon = "a${HOSTILE_TOML}.png"\n`)).toMatchObject({ settings: {}, refused: ["project.icon holds a control character"] });
  });

  test("isControlCode and cleanName cover the ranges and leave a plain name alone", () => {
    for (const code of [...HOSTILE_CODES, 0x00, 0x1b, 0x7f, 0x80, 0x9f, 0x202a, 0x202d, 0x2067, 0x2069]) expect(isControlCode(code)).toBe(true);
    for (const code of [0x20, 0x41, 0x7e, 0xa0, 0x2027, 0x202f, 0x2065, 0x206a, 0x1f600]) expect(isControlCode(code)).toBe(false);
    expect(cleanName(`a${HOSTILE_TEXT}b`)).toBe("ab");
    expect(cleanName(HOSTILE_TEXT)).toBe("?");
    expect(cleanName("project.name-1")).toBe("project.name-1");
  });
});

describe("the descriptor check and the small-file reader (L4)", () => {
  test("an open descriptor is the file at its real path and no other", async () => {
    const dir = folder();
    const path = write(join(dir, "a.txt"), "one");
    const other = write(join(dir, "b.txt"), "two");
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      expect(await descriptorIs(handle.fd, path, stat)).toBe(true);
      expect(await descriptorIs(handle.fd, other, stat)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test("off Linux the descriptor's file named through a linked folder is refused, by its own path it passes", async () => {
    // #830's Windows run: off Linux there is no kernel name for a descriptor, and `lstat` follows every
    // step but the last, so the same file reached through a linked folder passed. Run here as win32.
    const dir = folder();
    mkdirSync(join(dir, "real"));
    const inside = write(join(dir, "real", "a.png"), png());
    symlinkSync(join(dir, "real"), join(dir, "flip"));
    const handle = await open(inside, "r");
    try {
      const stat = await handle.stat();
      expect(await descriptorIs(handle.fd, realpathSync.native(inside), stat, "win32")).toBe(true);
      expect(await descriptorIs(handle.fd, join(realpathSync.native(dir), "flip", "a.png"), stat, "win32")).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test("readSmallFile reads a plain file and refuses a final symlink, a folder and a file over the cap", async () => {
    const dir = folder();
    const path = write(join(dir, "a.txt"), "hello");
    expect(new TextDecoder().decode((await readSmallFile(path, 100)) ?? new Uint8Array())).toBe("hello");
    symlinkSync(path, join(dir, "link.txt"));
    expect(await readSmallFile(join(dir, "link.txt"), 100)).toBeNull();
    expect(await readSmallFile(dir, 100)).toBeNull();
    expect(await readSmallFile(path, 4)).toBeNull();
    expect(await readSmallFile(join(dir, "missing"), 100)).toBeNull();
  });
});

// The phone reads a picture's header before it decodes (web/src/lib/project-picture-wire.ts). Its grammar
// is its own copy of the bridge's, so the two are held to the same answers here.
describe("the phone's header reader agrees with the bridge's", () => {
  const cases: [string, Uint8Array][] = [
    ["png 128", png()],
    ["png 64x1024", png(64, 1024)],
    ["png 63", png(63, 128)],
    ["png 1025", png(1025, 128)],
    ["jpeg", jpeg()],
    ["jpeg 2000", jpeg(2000, 100)],
    ["webp vp8x", webp()],
    ["webp 40", webp(40, 40)],
    ["truncated png", png().slice(0, 20)],
    ["not a picture", new TextEncoder().encode("<svg></svg>")],
    ["apng", png(128, 128, { animated: true })],
    ["webp anim chunk", webp(256, 256, { anim: true })],
    ["webp anim flag", webp(256, 256, { flag: true })],
  ];
  for (const [name, bytes] of cases) {
    test(name, () => {
      const mime = hillImageMime(bytes);
      const size = mime === null ? null : hillImageSize(bytes, mime);
      const phone = pictureHeader(bytes);
      expect(phone === null ? null : { mime: phone.mime, width: phone.width, height: phone.height }).toEqual(mime === null || size === null ? null : { mime, ...size });
      // Every rule the phone checks (size, type, sides, animation) answers as the bridge's own check does.
      expect(pictureHeaderFits(bytes)).toBe(mime !== null && checkProjectPicture(bytes, mime) === null);
    });
  }

  test("fuzz: a picture with random bytes changed gets the same yes or no from both", () => {
    let seed = 811;
    const random = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const bases = [png(), png(128, 128, { animated: true }), jpeg(), webp(), webp(256, 256, { anim: true }), webp(256, 256, { flag: true })];
    for (let round = 0; round < 3000; round++) {
      const bytes = Uint8Array.from(bases[round % bases.length]!);
      const flips = 1 + Math.floor(random() * 4);
      for (let f = 0; f < flips; f++) bytes[Math.floor(random() * Math.min(bytes.length, 64))] = Math.floor(random() * 256);
      const mime = hillImageMime(bytes);
      expect(pictureHeaderFits(bytes)).toBe(mime !== null && checkProjectPicture(bytes, mime) === null);
    }
  });
});

// R8: a workspace repository that holds member repositories as plain folders speaks for a member that has
// no `collie.toml` of its own.
describe("an enclosing repository (R8)", () => {
  /** A repository at `path`, made as a folder with its own `.git`. */
  const member = (path: string) => {
    mkdirSync(path, { recursive: true });
    return repo(path);
  };

  test("a session in a member with no file finds the workspace's", async () => {
    const ws = repo(folder());
    write(join(ws, "collie.toml"), "[project]\n");
    const athena = member(join(ws, "athena"));
    mkdirSync(join(athena, "src"));
    expect(await locateProjectFile(join(athena, "src"))).toEqual({ file: join(ws, "collie.toml"), root: ws, enclosing: ws });
  });

  test("the member's own file wins", async () => {
    const ws = repo(folder());
    write(join(ws, "collie.toml"), "[project]\n");
    const athena = member(join(ws, "athena"));
    write(join(athena, "collie.toml"), "[project]\n");
    expect(await locateProjectFile(athena)).toEqual({ file: join(athena, "collie.toml"), root: athena });
  });

  test("a file in a folder of the workspace between it and the member speaks first", async () => {
    const ws = repo(folder());
    write(join(ws, "collie.toml"), "[project]\n");
    write(join(ws, "group", "collie.toml"), "[project]\n");
    const m = member(join(ws, "group", "m"));
    expect(await locateProjectFile(m)).toEqual({ file: join(ws, "group", "collie.toml"), root: ws, enclosing: ws });
  });

  test("three levels: a member of a member of a workspace", async () => {
    const ws = repo(folder());
    write(join(ws, "collie.toml"), "[project]\n");
    const mid = member(join(ws, "mid"));
    const leaf = member(join(mid, "leaf"));
    expect(await locateProjectFile(leaf)).toEqual({ file: join(ws, "collie.toml"), root: ws, enclosing: ws });
  });

  test("the search stops after ENCLOSING_MAX enclosing repositories", async () => {
    const top = repo(folder());
    write(join(top, "collie.toml"), "[project]\n");
    // Nest ENCLOSING_MAX repositories under `top`, then the session's own: `top` is one level too far.
    let at = top;
    for (let i = 0; i < ENCLOSING_MAX; i++) at = member(join(at, `r${String(i)}`));
    const session = member(join(at, "session"));
    expect(await locateProjectFile(session)).toBeNull();
    // One level less, and it is found.
    expect(await locateProjectFile(at)).toEqual({ file: join(top, "collie.toml"), root: top, enclosing: top });
  });

  test("a parent that is not a repository gives nothing", async () => {
    const plain = folder();
    write(join(plain, "collie.toml"), "[project]\n");
    const m = member(join(plain, "m"));
    expect(await locateProjectFile(m)).toBeNull();
  });

  test("a member inside a linked worktree of the workspace finds the workspace's main checkout", async () => {
    const main = repo(folder());
    write(join(main, "collie.toml"), "[project]\n");
    const wtGit = join(main, ".git", "worktrees", "wt");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = folder();
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    writeFileSync(join(wtGit, "gitdir"), `${join(wt, ".git")}\n`);
    const m = member(join(wt, "athena"));
    expect(await locateProjectFile(m)).toEqual({ file: join(main, "collie.toml"), root: main, enclosing: main });
  });

  test("the workspace's icon must stay inside the workspace, and doctor names where the file came from", async () => {
    const ws = repo(folder());
    write(join(ws, "collie.toml"), '[project]\nicon = "logo.png"\n');
    write(join(ws, "logo.png"), png());
    const m = member(join(ws, "m"));
    const report = await new ProjectPictures(true, []).report(m);
    expect(report).toMatchObject({ file: join(ws, "collie.toml"), enclosing: ws, icon: { ok: true } });
    const pictures = new ProjectPictures(true, []);
    await pictures.refresh([m]);
    expect(pictures.get(m)).toBe(pictureVersion(png()));
  });
});

describe("the project file's read keeps its first look (S3)", () => {
  test("a file swapped between the look and the read is not read", async () => {
    const dir = folder();
    const path = write(join(dir, "collie.toml"), '[project]\nicon = "a.png"\n');
    const swap = write(join(dir, "other.toml"), '[project]\nicon = "b.png"\n');
    const read = await readProjectFile(path, async () => {
      // Same path, another file: only the device and inode of the first look can tell.
      renameSync(swap, path);
    });
    expect(read.settings).toEqual({});
    expect(read.problem).not.toBeNull();
  });

  test("with no swap the same file is read", async () => {
    const dir = folder();
    const path = write(join(dir, "collie.toml"), '[project]\nicon = "a.png"\n');
    expect((await readProjectFile(path, async () => undefined)).problem).toBeNull();
  });
});
