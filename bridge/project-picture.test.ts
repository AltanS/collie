import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_PICTURE_BYTES_MAX } from "../web/src/lib/project-picture-wire.ts";
import { HILL_MEDIA_HEADERS, HILL_MEDIA_MISSING, PROJECT_PICTURE_ROUTE, projectPictureRoute } from "./server.ts";
import { checkIconPath, locateProjectFile, NEVER_TABLES, parseProjectFile, PROJECT_FILE_BYTES_MAX, PROJECT_KEYS, readProjectFile } from "./project-file.ts";
import { checkProjectPicture, iconTarget, pictureVersion, pngAnimated, ProjectPictures, readProjectPicture, STAMP_TTL_MS, webpAnimated } from "./project-picture.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh real folder (its real path, so a symlinked tmp does not confuse the checks). */
function folder(prefix = "collie-project-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
    mkdirSync(join(wt, "src"));
    expect(await locateProjectFile(join(wt, "src"))).toEqual({ file: join(main, "collie.toml"), root: main });
    write(join(wt, "collie.toml"), "[project]\n");
    expect(await locateProjectFile(join(wt, "src"))).toEqual({ file: join(wt, "collie.toml"), root: wt });
  });

  test("a submodule is a tree of its own: no reach into the outer repository", async () => {
    const outer = repo(folder());
    write(join(outer, "collie.toml"), "[project]\n");
    const sub = join(outer, "vendor", "lib");
    mkdirSync(join(outer, ".git", "modules", "lib"), { recursive: true });
    write(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(await locateProjectFile(sub)).toBeNull();
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
    execFileSync("mkfifo", [join(dir, "fifo.toml")]);
    expect((await readProjectFile(join(dir, "fifo.toml"))).problem).toBe("is not a regular file");
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
  test("PNG, JPEG and WebP inside the limits pass; the version is the sha256's first 12 hex", async () => {
    const dir = folder();
    for (const [name, bytes] of [["a.png", png()], ["b.jpg", jpeg()], ["c.webp", webp()]] as const) {
      const read = await readProjectPicture(write(join(dir, name), bytes), []);
      expect(read).toMatchObject({ ok: true, version: pictureVersion(bytes) });
    }
    expect(pictureVersion(png())).toMatch(/^[0-9a-f]{12}$/);
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
    execFileSync("mkfifo", [join(dir, "fifo.png")]);
    expect((await readProjectPicture(join(dir, "fifo.png"), [])).ok).toBe(false);
    expect((await readProjectPicture(real, [join(dir, "real")])).ok).toBe(false);
  });

  test("the joined path must stay strictly below the repository root", () => {
    const located = { file: "/repo/web/collie.toml", root: "/repo" };
    expect(iconTarget(located, "assets/a.png")).toBe("/repo/web/assets/a.png");
    // checkIconPath refuses `..` first; this is the second check on the joined path.
    expect(iconTarget(located, "../../etc/a.png")).toBeNull();
    expect(iconTarget({ file: "/repo/collie.toml", root: "/repo" }, "..")).toBeNull();
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
    expect(PROJECT_PICTURE_ROUTE.exec("/api/project-picture/abcdef012345")?.[1]).toBe("abcdef012345");
    expect(PROJECT_PICTURE_ROUTE.exec("/api/project-picture/a/b")).toBeNull();
  });

  test("a held version answers its bytes with the hill image's headers and its type", async () => {
    const bytes = new Uint8Array(png());
    const res = await projectPictureRoute("abcdef012345", { bytesOf: async (v) => (v === "abcdef012345" ? { mime: "image/png", bytes } : null) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    for (const [name, value] of Object.entries(HILL_MEDIA_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("every miss is the same 404, and no source at all is a miss", async () => {
    for (const res of [await projectPictureRoute("abcdef012345", undefined), await projectPictureRoute("x", { bytesOf: async () => null })]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(HILL_MEDIA_MISSING);
    }
  });
});
