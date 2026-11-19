import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HILL_MEDIA_BYTES_MAX } from "../../web/src/lib/hill/wire.ts";
import { isImageSrc, mediaVersionOf, trickMediaPath } from "../../web/src/lib/tricks/schema.ts";
import { HOST } from "../host.ts";
import { TRICKS_MEDIA_ROUTE } from "../server.ts";
import { mediaVersionOfBytes, readTrickMedia, TrickMediaSync, TrickMediaVersions } from "./media.ts";
import { tricksMediaRoute } from "./routes.ts";
import type { TricksSurface } from "./service.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-trick-media-"));
  roots.push(dir);
  return dir;
}

/** A PNG's signature and an IHDR, enough for the sniff. */
function png(padding = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x86, 0, 0, 0, 0xf0]);
  return bytes;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

/** A trick folder with a `media/` folder, and an `outside` folder beside it. */
function trick() {
  const root = tempDir();
  const dir = join(root, "tricks", "look");
  mkdirSync(join(dir, "media", "shots"), { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { dir, outside };
}

describe("a trick's picture", () => {
  test("a PNG, a JPEG and a WebP of media/ are served, typed by their bytes", () => {
    const { dir } = trick();
    writeFileSync(join(dir, "media", "chart.png"), png());
    writeFileSync(join(dir, "media", "shots", "b.jpeg"), JPEG);
    writeFileSync(join(dir, "media", "c.webp"), WEBP);
    expect(readTrickMedia(dir, "media/chart.png")?.mime).toBe("image/png");
    expect(readTrickMedia(dir, "media/shots/b.jpeg")?.mime).toBe("image/jpeg");
    expect(readTrickMedia(dir, "media/c.webp")?.mime).toBe("image/webp");
    expect(readTrickMedia(dir, "media/chart.png")?.bytes).toEqual(png());
  });

  test("the name never decides the type: an SVG, a GIF or HTML under a .png name is refused", () => {
    const { dir } = trick();
    writeFileSync(join(dir, "media", "a.png"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    writeFileSync(join(dir, "media", "b.png"), "GIF89a\u0001\u0000\u0001\u0000");
    writeFileSync(join(dir, "media", "c.png"), "<!doctype html><script>alert(1)</script>");
    for (const name of ["a.png", "b.png", "c.png"]) expect(readTrickMedia(dir, `media/${name}`), name).toBeNull();
  });

  test("only media/: a file elsewhere in the trick folder, its code included, is never served", () => {
    const { dir } = trick();
    writeFileSync(join(dir, "top.png"), png());
    mkdirSync(join(dir, "shots"));
    writeFileSync(join(dir, "shots", "a.png"), png());
    for (const rel of ["top.png", "shots/a.png", "program.ts", "trick.toml", "media", "media/"]) expect(readTrickMedia(dir, rel), rel).toBeNull();
  });

  test("no step out and no hidden name: .., ., a dot file, an absolute path, a NUL, an encoded step", () => {
    const { dir, outside } = trick();
    writeFileSync(join(outside, "x.png"), png());
    writeFileSync(join(dir, "media", ".hidden.png"), png());
    const bad = ["media/../../../outside/x.png", "media/./a.png", "media/.hidden.png", "media/a/../b.png", `${outside}/x.png`, "/etc/x.png", "media/a\0.png", "media//a.png", "media/%2e%2e/x.png", "media/a.svg", "media/a.gif", "MEDIA/a.png"];
    for (const rel of bad) {
      expect(isImageSrc(rel), rel).toBe(false);
      expect(readTrickMedia(dir, rel), rel).toBeNull();
    }
  });

  test("no symlink: not the file, not media/ itself, not a folder below it", () => {
    const { dir, outside } = trick();
    writeFileSync(join(outside, "x.png"), png());
    symlinkSync(join(outside, "x.png"), join(dir, "media", "link.png"));
    symlinkSync(outside, join(dir, "media", "away"));
    expect(readTrickMedia(dir, "media/link.png")).toBeNull();
    expect(readTrickMedia(dir, "media/away/x.png")).toBeNull();
    const second = trick();
    writeFileSync(join(second.outside, "y.png"), png());
    rmSync(join(second.dir, "media"), { recursive: true });
    symlinkSync(second.outside, join(second.dir, "media"));
    expect(readTrickMedia(second.dir, "media/y.png")).toBeNull();
  });

  test("a trick folder reached through a symlinked parent still serves its own media/", () => {
    const { dir } = trick();
    writeFileSync(join(dir, "media", "a.png"), png());
    const alias = join(tempDir(), "alias");
    symlinkSync(dir, alias);
    expect(readTrickMedia(alias, "media/a.png")?.mime).toBe("image/png");
  });

  test("at most 2 MB, a regular file, and a folder that is gone is a miss", () => {
    const { dir } = trick();
    writeFileSync(join(dir, "media", "fits.png"), png(HILL_MEDIA_BYTES_MAX - 33));
    writeFileSync(join(dir, "media", "big.png"), png(HILL_MEDIA_BYTES_MAX - 32));
    mkdirSync(join(dir, "media", "folder.png"));
    expect(readTrickMedia(dir, "media/fits.png")?.bytes.length).toBe(HILL_MEDIA_BYTES_MAX);
    expect(readTrickMedia(dir, "media/big.png")).toBeNull();
    expect(readTrickMedia(dir, "media/folder.png")).toBeNull();
    expect(readTrickMedia(dir, "media/missing.png")).toBeNull();
    expect(readTrickMedia(join(dir, "gone"), "media/fits.png")).toBeNull();
  });

  test("never under a .git folder", () => {
    const { dir } = trick();
    mkdirSync(join(dir, "media", ".git"));
    writeFileSync(join(dir, "media", ".git", "a.png"), png());
    expect(readTrickMedia(dir, "media/.git/a.png")).toBeNull();
  });

  test("the phone's path encodes each step and carries the rev as a query", () => {
    expect(trickMediaPath("m_abcdefghij", "look", "media/shots/case 24.png", 7)).toBe("/api/tricks/m_abcdefghij/look/media/shots/case%2024.png?rev=7");
    expect(trickMediaPath("lodge", "look", "media/a.png")).toBe("/api/tricks/lodge/look/media/a.png");
  });

  test("the phone's path carries the picture's version as ?v=, with or without the rev", () => {
    expect(trickMediaPath("lodge", "look", "media/a.png", 7, "0123456789ab")).toBe("/api/tricks/lodge/look/media/a.png?rev=7&v=0123456789ab");
    expect(trickMediaPath("lodge", "look", "media/a.png", undefined, "0123456789ab")).toBe("/api/tricks/lodge/look/media/a.png?v=0123456789ab");
  });

  test("mediaVersionOf reads a version off a row, and nothing for an old row or a bad version", () => {
    expect(mediaVersionOf({ media: { "media/a.png": "0123456789ab" } }, "media/a.png")).toBe("0123456789ab");
    expect(mediaVersionOf({ media: { "media/a.png": "0123456789ab" } }, "media/b.png")).toBeUndefined();
    expect(mediaVersionOf({}, "media/a.png")).toBeUndefined();
    expect(mediaVersionOf(undefined, "media/a.png")).toBeUndefined();
    expect(mediaVersionOf({ media: { "media/a.png": "nope" } }, "media/a.png")).toBeUndefined();
  });
});

describe("a trick's picture versions", () => {
  test("each picture the route would serve has a 12 hex version of its bytes", () => {
    const { dir } = trick();
    writeFileSync(join(dir, "media", "a.png"), png());
    writeFileSync(join(dir, "media", "shots", "b.jpeg"), JPEG);
    const versions = new TrickMediaVersions().of(dir);
    expect(Object.keys(versions)).toEqual(["media/a.png", "media/shots/b.jpeg"]);
    expect(versions["media/a.png"]).toBe(mediaVersionOfBytes(png()));
    expect(versions["media/a.png"]).toMatch(/^[0-9a-f]{12}$/);
    expect(versions["media/a.png"]).not.toBe(versions["media/shots/b.jpeg"]);
  });

  test("a file replaced under the same name gets a new version", () => {
    const { dir } = trick();
    const file = join(dir, "media", "a.png");
    const held = new TrickMediaVersions();
    writeFileSync(file, png(64));
    const before = held.of(dir)["media/a.png"];
    const second = png(64);
    second[40] = 9;
    writeFileSync(file, second);
    expect(held.of(dir)["media/a.png"]).toBe(mediaVersionOfBytes(second));
    expect(held.of(dir)["media/a.png"]).not.toBe(before);
    // A longer file moves the size.
    writeFileSync(file, png(80));
    expect(held.of(dir)["media/a.png"]).toBe(mediaVersionOfBytes(png(80)));
  });

  test("the same bytes keep the version, also when the file is written again", () => {
    const { dir } = trick();
    const file = join(dir, "media", "a.png");
    const held = new TrickMediaVersions();
    writeFileSync(file, png());
    const before = held.of(dir)["media/a.png"];
    expect(held.of(dir)["media/a.png"]).toBe(before);
    writeFileSync(file, png());
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(held.of(dir)["media/a.png"]).toBe(before);
  });

  test("a file that is not read again keeps its version while its size and time hold", () => {
    const { dir } = trick();
    const file = join(dir, "media", "a.png");
    const held = new TrickMediaVersions();
    // A whole second: a time in float seconds does not survive the trip through utimes exactly on NTFS (100 ns ticks).
    const at = Math.floor(Date.now() / 1000);
    writeFileSync(file, png(64));
    utimesSync(file, at, at);
    const first = held.of(dir)["media/a.png"];
    // Same size and the same modified time, other bytes: the held version stands (the walk never rereads it).
    const other = png(64);
    other[40] = 7;
    writeFileSync(file, other);
    utimesSync(file, at, at);
    expect(held.of(dir)["media/a.png"]).toBe(first);
  });

  test("a symlink, a hidden name, a file that is no picture, one over 2 MB and a missing folder are left out", () => {
    const { dir, outside } = trick();
    writeFileSync(join(outside, "x.png"), png());
    symlinkSync(join(outside, "x.png"), join(dir, "media", "link.png"));
    writeFileSync(join(dir, "media", ".hidden.png"), png());
    writeFileSync(join(dir, "media", "note.txt"), "text");
    writeFileSync(join(dir, "media", "fake.png"), "<svg/>");
    writeFileSync(join(dir, "media", "big.png"), png(HILL_MEDIA_BYTES_MAX));
    writeFileSync(join(dir, "media", "ok.png"), png());
    const held = new TrickMediaVersions();
    expect(Object.keys(held.of(dir))).toEqual(["media/ok.png"]);
    expect(held.of(join(dir, "gone"))).toEqual({});
  });

  test("a removed picture leaves the map, and retain forgets a folder", () => {
    const { dir } = trick();
    const file = join(dir, "media", "a.png");
    const held = new TrickMediaVersions();
    writeFileSync(file, png());
    expect(Object.keys(held.of(dir))).toEqual(["media/a.png"]);
    rmSync(file);
    expect(held.of(dir)).toEqual({});
    held.retain(new Set());
  });

  test("the route serves a picture with a v query, with a rev query and with none: the name alone picks the file", async () => {
    const asked: string[] = [];
    const tricks: Pick<TricksSurface, "media"> = {
      media: async (host, id, rel) => {
        asked.push(`${host}/${id}/${rel}`);
        return { mime: "image/png", bytes: png() };
      },
    };
    const paths = [
      trickMediaPath("lodge", "look", "media/a.png"),
      trickMediaPath("lodge", "look", "media/a.png", 3),
      trickMediaPath("lodge", "look", "media/a.png", 3, "0123456789ab"),
      trickMediaPath("lodge", "look", "media/a.png", undefined, "ba9876543210"),
    ];
    for (const path of paths) {
      const match = TRICKS_MEDIA_ROUTE.exec(new URL(path, "http://bridge").pathname);
      expect(match, path).not.toBeNull();
      if (match === null) continue;
      expect((await tricksMediaRoute(tricks, match))?.mime).toBe("image/png");
    }
    expect(asked).toEqual(Array.from({ length: 4 }, () => "lodge/look/media/a.png"));
  });
});

describe("a picture changed by hand reaches the approved copy", () => {
  /** An installed folder and an approved copy beside it, each with a `media/`. */
  function pair() {
    const { dir, outside } = trick();
    const copy = join(dir, "..", "copy");
    mkdirSync(join(copy, "media"), { recursive: true });
    return { src: dir, copy, outside };
  }
  const later = (file: string, seconds: number) => utimesSync(file, new Date(), new Date(Date.now() + seconds * 1000));

  test("a replaced source picture is copied and the copy's version moves", () => {
    const { src, copy } = pair();
    const sync = new TrickMediaSync();
    const versions = new TrickMediaVersions();
    writeFileSync(join(src, "media", "a.png"), png(64));
    writeFileSync(join(copy, "media", "a.png"), png(64));
    expect(sync.sync(src, copy)).toBe(0);
    const before = versions.of(copy)["media/a.png"];
    const other = png(64);
    other[40] = 9;
    writeFileSync(join(src, "media", "a.png"), other);
    later(join(src, "media", "a.png"), 5);
    expect(sync.sync(src, copy)).toBe(1);
    expect(readFileSync(join(copy, "media", "a.png"))).toEqual(Buffer.from(other));
    expect(versions.of(copy)["media/a.png"]).not.toBe(before);
    expect(versions.of(copy)["media/a.png"]).toBe(mediaVersionOfBytes(other));
    // Nothing moved since: nothing written.
    expect(sync.sync(src, copy)).toBe(0);
  });

  test("a new picture in a folder below media/ is added", () => {
    const { src, copy } = pair();
    writeFileSync(join(src, "media", "shots", "b.jpeg"), JPEG);
    expect(new TrickMediaSync().sync(src, copy)).toBe(1);
    expect(readFileSync(join(copy, "media", "shots", "b.jpeg"))).toEqual(Buffer.from(JPEG));
  });

  test("a non-picture, a link, a hidden file, an oversize file and an executable are not copied", () => {
    const { src, copy, outside } = pair();
    writeFileSync(join(outside, "x.png"), png());
    symlinkSync(join(outside, "x.png"), join(src, "media", "link.png"));
    writeFileSync(join(src, "media", ".hidden.png"), png());
    writeFileSync(join(src, "media", "note.txt"), "text");
    writeFileSync(join(src, "media", "fake.png"), "<svg/>");
    writeFileSync(join(src, "media", "big.png"), png(HILL_MEDIA_BYTES_MAX));
    writeFileSync(join(src, "media", "run.png"), png());
    chmodSync(join(src, "media", "run.png"), 0o755);
    writeFileSync(join(src, "media", "ok.png"), png());
    // Windows has no executable bit (chmod leaves the mode at 0666), so there run.png is a plain picture and is copied.
    const execBit = HOST.platform !== "win32";
    expect(new TrickMediaSync().sync(src, copy)).toBe(execBit ? 1 : 2);
    expect(readdirNames(join(copy, "media"))).toEqual(execBit ? ["ok.png"] : ["ok.png", "run.png"]);
  });

  test("a file the program wrote is kept: never deleted, and not replaced while the source is unchanged", () => {
    const { src, copy } = pair();
    const sync = new TrickMediaSync();
    writeFileSync(join(src, "media", "a.png"), png(64));
    writeFileSync(join(copy, "media", "a.png"), png(64));
    sync.sync(src, copy);
    // The program draws its own picture and overwrites a.png in the copy.
    const mine = png(80);
    writeFileSync(join(copy, "media", "a.png"), mine);
    writeFileSync(join(copy, "media", "made.png"), png(90));
    expect(sync.sync(src, copy)).toBe(0);
    expect(readFileSync(join(copy, "media", "a.png"))).toEqual(Buffer.from(mine));
    // The source file is deleted: the copy keeps both.
    rmSync(join(src, "media", "a.png"));
    expect(sync.sync(src, copy)).toBe(0);
    expect(existsSync(join(copy, "media", "a.png"))).toBe(true);
    expect(existsSync(join(copy, "media", "made.png"))).toBe(true);
  });

  test("a source change wins once over what the program wrote", () => {
    const { src, copy } = pair();
    const sync = new TrickMediaSync();
    writeFileSync(join(src, "media", "a.png"), png(64));
    writeFileSync(join(copy, "media", "a.png"), png(64));
    sync.sync(src, copy);
    writeFileSync(join(copy, "media", "a.png"), png(80));
    const edited = png(70);
    writeFileSync(join(src, "media", "a.png"), edited);
    later(join(src, "media", "a.png"), 5);
    expect(sync.sync(src, copy)).toBe(1);
    expect(readFileSync(join(copy, "media", "a.png"))).toEqual(Buffer.from(edited));
    // The program writes again: the source has not changed, so it stays.
    writeFileSync(join(copy, "media", "a.png"), png(80));
    expect(sync.sync(src, copy)).toBe(0);
    expect(readFileSync(join(copy, "media", "a.png"))).toEqual(Buffer.from(png(80)));
  });

  test("after a restart the first look keeps a newer program file and takes a newer source", () => {
    const { src, copy } = pair();
    writeFileSync(join(src, "media", "kept.png"), png(64));
    writeFileSync(join(src, "media", "hand.png"), png(64));
    writeFileSync(join(copy, "media", "kept.png"), png(80));
    writeFileSync(join(copy, "media", "hand.png"), png(64));
    later(join(copy, "media", "kept.png"), 10);
    const edited = png(72);
    writeFileSync(join(src, "media", "hand.png"), edited);
    later(join(src, "media", "hand.png"), 20);
    expect(new TrickMediaSync().sync(src, copy)).toBe(1);
    expect(readFileSync(join(copy, "media", "kept.png"))).toEqual(Buffer.from(png(80)));
    expect(readFileSync(join(copy, "media", "hand.png"))).toEqual(Buffer.from(edited));
  });

  test("a name that is a link in the copy, or a media/ that is a link, is never written through", () => {
    const { src, copy, outside } = pair();
    writeFileSync(join(outside, "target.png"), png(40));
    writeFileSync(join(src, "media", "a.png"), png(64));
    symlinkSync(join(outside, "target.png"), join(copy, "media", "a.png"));
    expect(new TrickMediaSync().sync(src, copy)).toBe(0);
    expect(readFileSync(join(outside, "target.png"))).toEqual(Buffer.from(png(40)));
    rmSync(join(copy, "media"), { recursive: true });
    symlinkSync(outside, join(copy, "media"));
    expect(new TrickMediaSync().sync(src, copy)).toBe(0);
    expect(existsSync(join(outside, "a.png"))).toBe(false);
  });

  test("no temp file is left behind", () => {
    const { src, copy } = pair();
    writeFileSync(join(src, "media", "a.png"), png());
    new TrickMediaSync().sync(src, copy);
    expect(readdirNames(join(copy, "media"), true)).toEqual(["a.png"]);
  });
});

function readdirNames(dir: string, hidden = false): string[] {
  return readdirSync(dir)
    .filter((name) => hidden || !name.startsWith("."))
    .toSorted();
}
