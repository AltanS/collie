import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectFileFindings, projectFileLine } from "./project-file-finding.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

/** A 128 x 128 PNG that passes every picture rule (the CRCs are zero: nothing checks them). */
function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(128), ...be32(128), 8, 6, 0, 0, 0]), ...chunk("IDAT", Array.from({ length: 16 }, () => 0)), ...chunk("IEND", [])]);
}

const clean = { file: "/repo/collie.toml", enclosing: null, problem: null, ignored: [], refused: [], icon: { path: "a.png", ok: true, why: null } };

describe("the project-file row", () => {
  test("no file is no row", () => {
    expect(projectFileLine({ file: null, enclosing: null, problem: null, ignored: [], refused: [], icon: null })).toBeNull();
  });

  test("a clean file is ok and names the file and the picture", () => {
    expect(projectFileLine(clean)).toMatchObject({ check: "project-file", status: "ok", detail: "/repo/collie.toml · picture a.png passes" });
  });

  test("a file from an enclosing repository says so", () => {
    expect(projectFileLine({ ...clean, file: "/ws/collie.toml", enclosing: "/ws" })?.detail).toContain("from the enclosing repository /ws");
  });

  test("control characters in the folder path never reach the terminal (R7)", () => {
    const detail = projectFileLine({ ...clean, file: "/re\u009bpo\u202e/x\u200f/collie.toml" })?.detail ?? "";
    expect(detail).toContain("/repo/x/collie.toml");
    expect([...detail].some((ch) => [0x9b, 0x202e, 0x200f].includes(ch.codePointAt(0) ?? 0))).toBe(false);
  });

  test("ignored names alone stay ok; a refused value or picture warns", () => {
    expect(projectFileLine({ ...clean, ignored: ["commands", "project.name"] })).toMatchObject({ status: "ok", detail: expect.stringContaining("ignored: commands, project.name") });
    expect(projectFileLine({ ...clean, refused: ["project.icon is not a text"], icon: null })?.status).toBe("warn");
    expect(projectFileLine({ ...clean, icon: { path: "a.png", ok: false, why: "is an animated or unreadable PNG" } })).toMatchObject({ status: "warn", detail: expect.stringContaining("is an animated") });
  });

  test("the operator's switch off is one ok row, and nothing is read", async () => {
    expect(await projectFileFindings({ env: { COLLIE_PROJECT_FILES: "0" }, folder: "/nowhere", stateDir: "/nowhere/state", configDir: "/nowhere/config" })).toEqual([
      expect.objectContaining({ check: "project-file", status: "ok", detail: expect.stringContaining("off") }),
    ]);
  });

  test("a picture inside the bridge's own state folder is reported as refused", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "collie-finding-")));
    made.push(root);
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    mkdirSync(stateDir);
    mkdirSync(configDir);
    writeFileSync(join(root, "collie.toml"), '[project]\nicon = "state/logo.png"\n');
    writeFileSync(join(stateDir, "logo.png"), png());
    const open = await projectFileFindings({ env: {}, folder: root, stateDir, configDir });
    expect(open).toEqual([expect.objectContaining({ check: "project-file", status: "warn", detail: expect.stringContaining("Collie's own folders") })]);
    expect(open[0]?.detail).not.toContain("passes");
    // The same picture outside the private folders passes, so the refusal above is the folder's doing.
    writeFileSync(join(root, "collie.toml"), '[project]\nicon = "logo.png"\n');
    writeFileSync(join(root, "logo.png"), png());
    expect(await projectFileFindings({ env: {}, folder: root, stateDir, configDir })).toEqual([expect.objectContaining({ status: "ok", detail: expect.stringContaining("passes") })]);
  });

  test("an icon that is not text is a warning that names the key and why", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "collie-finding-")));
    made.push(root);
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    for (const icon of ["5", '{ path = "a.png" }']) {
      writeFileSync(join(root, "collie.toml"), `[project]\nicon = ${icon}\n`);
      expect(await projectFileFindings({ env: {}, folder: root, stateDir: join(root, "state"), configDir: join(root, "config") })).toEqual([
        expect.objectContaining({ check: "project-file", status: "warn", detail: expect.stringContaining("refused: project.icon is not a text") }),
      ]);
    }
  });
});
