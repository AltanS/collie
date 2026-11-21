// What a repository's `collie.toml` may say, held as structure (ADR 0160), and the enclosing-repository
// rule's way out.
//
// THE DISPLAY LIST. Every validator in PROJECT_KEYS must be one of these, each changing only what Collie
// SHOWS. A new key whose validator is not here fails the first test below: adding one is a decision that
// the key only shows something, written into this list in the same commit, never a quiet growth.
//
//   - checkIconPath: `[project] icon`, a relative path to a still picture, shown in the agent logo's place.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkIconPath, locateProjectFile, parseProjectFile, PROJECT_KEYS } from "./project-file.ts";
import { pictureVersion, ProjectPictures } from "./project-picture.ts";

const DISPLAY_ONLY: ReadonlyMap<unknown, string> = new Map([[checkIconPath, "project.icon"]]);

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder by the OS's own real path, the spelling the product answers (an 8.3 temp folder is expanded). */
function folder(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-project-file-")));
  made.push(dir);
  return dir;
}

/** `git init` without git: a `.git` folder with a HEAD and an objects folder. */
function repo(root: string): string {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
/** A 128 x 128 PNG that passes every picture rule (the CRCs are zero: nothing checks them). */
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(128), ...be32(128), 8, 6, 0, 0, 0]), ...chunk("IDAT", Array.from({ length: 16 }, () => 0)), ...chunk("IEND", [])]);

describe("a project file only ever changes what Collie shows", () => {
  test("every key's validator is on the display list in this file's header", () => {
    const keys = Object.entries(PROJECT_KEYS).flatMap(([table, checks]) => Object.entries(checks).map(([key, check]) => ({ name: `${table}.${key}`, check })));
    expect(keys.length).toBeGreaterThan(0);
    for (const { name, check } of keys) expect({ name, listed: DISPLAY_ONLY.get(check) }).toEqual({ name, listed: name });
  });

  test("an icon that is not text (a number, a table, a list) is refused by name, and nothing is kept", () => {
    for (const text of ["[project]\nicon = 5\n", '[project]\nicon = { path = "a.png" }\n', '[project.icon]\npath = "a.png"\n', '[project]\nicon = ["a.png"]\n']) {
      const read = parseProjectFile(text);
      expect(read.settings).toEqual({});
      expect(read.refused).toEqual(["project.icon is not a text"]);
      expect(read.parseError).toBe(false);
    }
  });
});

// THE WAY OUT OF THE ENCLOSING REPOSITORY (R8). A member repository that wants no picture, while its
// workspace names one, puts a `collie.toml` of its own with no icon: the nearest file wins and says nothing.
describe("a member's own file with no icon", () => {
  test("wins over the workspace's picture, and the member's sessions show no picture", async () => {
    const ws = repo(folder());
    write(join(ws, "collie.toml"), '[project]\nicon = "logo.png"\n');
    write(join(ws, "logo.png"), png());
    const member = repo(join(ws, "athena"));
    mkdirSync(join(member, "src"));
    const pictures = new ProjectPictures(true, []);
    // Without a file of its own, the member shows the workspace's picture.
    await pictures.refresh([join(member, "src")]);
    expect(pictures.get(join(member, "src"))).toBe(pictureVersion(png()));

    for (const own of ["", "[project]\n"]) {
      write(join(member, "collie.toml"), own);
      expect(await locateProjectFile(join(member, "src"))).toEqual({ file: join(member, "collie.toml"), root: member });
      const fresh = new ProjectPictures(true, []);
      await fresh.refresh([join(member, "src")]);
      expect(fresh.get(join(member, "src"))).toBeUndefined();
      expect(await fresh.report(join(member, "src"))).toMatchObject({ file: join(member, "collie.toml"), enclosing: null, icon: null });
    }
  });
});
