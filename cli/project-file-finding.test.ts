import { describe, expect, test } from "bun:test";

import { projectFileFindings, projectFileLine } from "./project-file-finding.ts";

const clean = { file: "/repo/collie.toml", problem: null, ignored: [], refused: [], icon: { path: "a.png", ok: true, why: null } };

describe("the project-file row", () => {
  test("no file is no row", () => {
    expect(projectFileLine({ file: null, problem: null, ignored: [], refused: [], icon: null })).toBeNull();
  });

  test("a clean file is ok and names the file and the picture", () => {
    expect(projectFileLine(clean)).toMatchObject({ check: "project-file", status: "ok", detail: "/repo/collie.toml · picture a.png passes" });
  });

  test("ignored names alone stay ok; a refused value or picture warns", () => {
    expect(projectFileLine({ ...clean, ignored: ["commands", "project.name"] })).toMatchObject({ status: "ok", detail: expect.stringContaining("ignored: commands, project.name") });
    expect(projectFileLine({ ...clean, refused: ["project.icon is not a text"], icon: null })?.status).toBe("warn");
    expect(projectFileLine({ ...clean, icon: { path: "a.png", ok: false, why: "is an animated or unreadable PNG" } })).toMatchObject({ status: "warn", detail: expect.stringContaining("is an animated") });
  });

  test("the operator's switch off is one ok row, and nothing is read", async () => {
    expect(await projectFileFindings({ env: { COLLIE_PROJECT_FILES: "0" }, folder: "/nowhere", privateFolders: [] })).toEqual([
      expect.objectContaining({ check: "project-file", status: "ok", detail: expect.stringContaining("off") }),
    ]);
  });
});
