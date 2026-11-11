import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HOST } from "../bridge/host.ts";
import { type ImageStageDeps, imageStagingRoot, pruneImageStaging, STAGE_MAX_AGE_MS, stageImagesForBridge, underPrivateTmp } from "./image-stage.ts";

// Staging a picture under /tmp for a bridge with its own private /tmp. The pictures live in the real /tmp
// (the folder the rule is about); the staging root is a folder of the test's own.

const linux = test.skipIf(HOST.platform !== "linux");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpFolder(prefix: string): string {
  const dir = mkdtempSync(join("/tmp", prefix));
  made.push(dir);
  return dir;
}

/** A PNG's signature and IHDR, padded. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x86, 0, 0, 3, 0x4c, 8, 2, 0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 40 }, () => 7)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

function setup() {
  const work = tmpFolder("stage-work-");
  const root = join(tmpFolder("stage-root-"), "image-staging");
  const clock = { now: Date.now() };
  return { work, root, clock, deps: { env: {}, home: "/home/nobody", stagingRoot: () => root, now: () => clock.now } satisfies ImageStageDeps };
}

describe("where staging goes", () => {
  test("the root is under XDG_CACHE_HOME when it is absolute, else under ~/.cache", () => {
    expect(imageStagingRoot({ env: { XDG_CACHE_HOME: "/x/cache" }, home: "/home/pat" })).toBe("/x/cache/collie/image-staging");
    expect(imageStagingRoot({ env: {}, home: "/home/pat" })).toBe("/home/pat/.cache/collie/image-staging");
    expect(imageStagingRoot({ env: { XDG_CACHE_HOME: "relative" }, home: "/home/pat" })).toBe("/home/pat/.cache/collie/image-staging");
  });

  test("only /tmp and /var/tmp are the folders PrivateTmp hides", () => {
    expect(underPrivateTmp("/tmp/a.png")).toBe(true);
    expect(underPrivateTmp("/var/tmp/x/a.png")).toBe(true);
    expect(underPrivateTmp("/tmpfoo/a.png")).toBe(false);
    expect(underPrivateTmp("/home/pat/a.png")).toBe(false);
  });
});

describe("staging a picture", () => {
  linux("copies it into a private folder, names it by index and the detected type, keeps the caption, and cleans up", () => {
    const s = setup();
    // The name lies about the type: the first bytes decide.
    writeFileSync(join(s.work, "a.txt"), PNG);
    writeFileSync(join(s.work, "b.png"), JPEG);
    const staged = stageImagesForBridge(s.deps, [{ path: join(s.work, "a.txt"), caption: "Now" }, { path: join(s.work, "b.png") }]);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.images.map((i) => i.caption)).toEqual(["Now", undefined]);
    const [first, second] = staged.images.map((i) => i.path);
    expect(first).toMatch(new RegExp(`^${s.root}/stage-[A-Za-z0-9]{6}/0\\.png$`));
    expect(second).toMatch(/\/1\.jpg$/);
    expect(new Uint8Array(readFileSync(first!))).toEqual(PNG);
    expect(new Uint8Array(readFileSync(second!))).toEqual(JPEG);
    expect(statSync(first!).mode & 0o777).toBe(0o600);
    const folder = join(first!, "..");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(staged.unstage(`${first!}: nope`)).toBe(`${join(s.work, "a.txt")}: nope`);
    staged.cleanup();
    expect(existsSync(folder)).toBe(false);
    staged.cleanup();
    expect(readdirSync(s.root)).toEqual([]);
  });

  test("a picture outside /tmp passes unchanged, and nothing is created", () => {
    const s = setup();
    const staged = stageImagesForBridge(s.deps, [{ path: "/home/pat/shots/a.png", caption: "Home" }]);
    expect(staged).toMatchObject({ ok: true, images: [{ path: "/home/pat/shots/a.png", caption: "Home" }] });
    expect(existsSync(s.root)).toBe(false);
  });

  linux("a mix stages only what is under /tmp, and keeps the order", () => {
    const s = setup();
    writeFileSync(join(s.work, "a.png"), PNG);
    const staged = stageImagesForBridge(s.deps, [{ path: "/home/pat/keep.png" }, { path: join(s.work, "a.png") }]);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.images[0]!.path).toBe("/home/pat/keep.png");
    expect(staged.images[1]!.path).toEndWith("/1.png");
    staged.cleanup();
  });

  linux("a refusal carries the bridge's words and the original path, and leaves no folder", () => {
    const s = setup();
    writeFileSync(join(s.work, "t.png"), "just text, not an image");
    writeFileSync(join(s.work, "ok.png"), PNG);
    symlinkSync(join(s.work, "ok.png"), join(s.work, "link.png"));
    const text = stageImagesForBridge(s.deps, [{ path: join(s.work, "ok.png") }, { path: join(s.work, "t.png") }]);
    expect(text).toEqual({ ok: false, code: "bad_image", error: `${join(s.work, "t.png")}: is not a PNG, JPEG or WebP image (read from its first bytes, not its name)` });
    const link = stageImagesForBridge(s.deps, [{ path: join(s.work, "link.png") }]);
    expect(link).toEqual({ ok: false, code: "bad_image", error: `${join(s.work, "link.png")}: is a symlink; name the file itself` });
    const gone = stageImagesForBridge(s.deps, [{ path: join(s.work, "none.png") }]);
    expect(gone).toMatchObject({ ok: false, code: "bad_image" });
    expect(readdirSync(s.root)).toEqual([]);
  });

  linux("a picture past the cap is refused as too large", () => {
    const s = setup();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    writeFileSync(join(s.work, "big.png"), big);
    expect(stageImagesForBridge(s.deps, [{ path: join(s.work, "big.png") }])).toMatchObject({ ok: false, code: "image_too_large" });
    expect(readdirSync(s.root)).toEqual([]);
  });

  linux("a staging root that cannot be made is a refusal with no code", () => {
    const s = setup();
    writeFileSync(join(s.work, "a.png"), PNG);
    writeFileSync(join(s.work, "blocker"), "x");
    const staged = stageImagesForBridge({ ...s.deps, stagingRoot: () => join(s.work, "blocker", "root") }, [{ path: join(s.work, "a.png") }]);
    expect(staged).toMatchObject({ ok: false, code: null });
  });
});

describe("pruning leftovers", () => {
  linux("removes stage folders older than an hour before staging, and only those", () => {
    const s = setup();
    mkdirSync(s.root, { recursive: true });
    const old = join(s.root, "stage-abcdef");
    const fresh = join(s.root, "stage-ghijkl");
    const stray = join(s.root, "other-folder");
    for (const dir of [old, fresh, stray]) mkdirSync(dir);
    writeFileSync(join(old, "0.png"), PNG);
    const long = (s.clock.now - STAGE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(old, long, long);
    utimesSync(stray, long, long);
    writeFileSync(join(s.work, "a.png"), PNG);
    const staged = stageImagesForBridge(s.deps, [{ path: join(s.work, "a.png") }]);
    expect(staged.ok).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stray)).toBe(true);
    if (staged.ok) staged.cleanup();
  });

  linux("follows no link: a symlink or a file named like a stage folder is left alone, and its target is not touched", () => {
    const s = setup();
    mkdirSync(s.root, { recursive: true });
    const target = tmpFolder("stage-target-");
    writeFileSync(join(target, "keep.txt"), "keep");
    symlinkSync(target, join(s.root, "stage-linkxx"));
    writeFileSync(join(s.root, "stage-filexx"), "file");
    const long = (s.clock.now - STAGE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(join(s.root, "stage-filexx"), long, long);
    pruneImageStaging(s.root, s.clock.now);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
    expect(readdirSync(s.root).toSorted()).toEqual(["stage-filexx", "stage-linkxx"]);
  });

  test("a missing root is no error", () => {
    expect(() => pruneImageStaging("/tmp/no-such-collie-staging-root", Date.now())).not.toThrow();
  });
});
