import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HILL_MEDIA_BYTES_MAX } from "../../web/src/lib/hill/wire.ts";
import { isImageSrc, trickMediaPath } from "../../web/src/lib/tricks/schema.ts";
import { readTrickMedia } from "./media.ts";

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
});
