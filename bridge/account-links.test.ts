import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACCOUNT_ADAPTERS } from "./account-adapters.ts";
import { inspectLinks, planLinks, prepareSharedFolder, realLinkDisk, runLinkPass } from "./account-links.ts";
import { accountTest } from "./accounts-skip.ts";

const share = { dirs: ["projects", "skills"], files: ["settings.json", "CLAUDE.md"] };

describe("planLinks (pure)", () => {
  const base = { defaultReal: "/d", accountDir: "/a", share };

  accountTest("a fresh default: folders are made and linked, missing files skipped", () => {
    const plan = planLinks({ ...base, defaults: {}, account: {} });
    expect(plan.unlinked).toEqual([]);
    expect(plan.actions).toEqual([
      { op: "mkdir", path: "/d/projects" },
      { op: "link", at: "/a/projects", target: "/d/projects", name: "projects" },
      { op: "mkdir", path: "/d/skills" },
      { op: "link", at: "/a/skills", target: "/d/skills", name: "skills" },
    ]);
  });

  accountTest("a file link points at the real file, one level", () => {
    const plan = planLinks({ ...base, defaults: { "settings.json": { kind: "file", real: "/dots/settings.json" } }, account: {} });
    expect(plan.actions).toContainEqual({ op: "link", at: "/a/settings.json", target: "/dots/settings.json", name: "settings.json" });
  });

  test("a real entry, a wrong link and a chain are reported and left alone", () => {
    const plan = planLinks({
      ...base,
      defaults: {
        projects: { kind: "dir", real: "/d/projects" },
        skills: { kind: "dir", real: "/d/skills" },
        "settings.json": { kind: "file", real: "/dots/settings.json" },
        "CLAUDE.md": { kind: "dir", real: "/d/CLAUDE.md" },
      },
      account: {
        projects: { kind: "dir" },
        skills: { kind: "link", target: "/elsewhere/skills" },
        // A chain: the account links the default's link, not the real file.
        "settings.json": { kind: "link", target: "/d/settings.json" },
      },
    });
    expect(plan.actions).toEqual([]);
    expect(plan.unlinked.toSorted()).toEqual(["CLAUDE.md", "projects", "settings.json", "skills"]);
  });

  test("an existing correct link is left as it is", () => {
    const plan = planLinks({
      ...base,
      defaults: { projects: { kind: "dir", real: "/d/projects" } },
      account: { projects: { kind: "link", target: "/d/projects" } },
    });
    expect(plan.actions.filter((a) => a.op === "link" && a.name === "projects")).toEqual([]);
    expect(plan.unlinked).toEqual([]);
  });
});

describe("runLinkPass on a temp folder", () => {
  let root = "";
  let def = "";
  let acct = "";
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "collie-acct-links-")));
    def = join(root, "default");
    acct = join(root, "acct");
    await mkdir(def, { mode: 0o700 });
    await mkdir(acct, { mode: 0o700 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the Claude share list links folders and files, and a second run changes nothing", async () => {
    await mkdir(join(def, "projects"));
    await writeFile(join(def, "settings.json"), "{}");
    const claude = ACCOUNT_ADAPTERS.claude.share;
    const first = await runLinkPass(realLinkDisk, def, acct, claude);
    expect(first.unlinked).toEqual([]);
    expect(first.linked).toContain("projects");
    expect(first.linked).toContain("settings.json");
    // A file the default lacks is skipped.
    expect(first.linked).not.toContain("CLAUDE.md");
    expect(await readlink(join(acct, "projects"))).toBe(join(def, "projects"));
    // A folder the default lacked was made there, owner-only.
    if (process.platform !== "win32") expect((await stat(join(def, "plugins"))).mode & 0o777).toBe(0o700);
    // Nothing that stays per account was touched.
    await expect(lstat(join(acct, ".claude.json"))).rejects.toThrow();
    const second = await runLinkPass(realLinkDisk, def, acct, claude);
    expect(second).toEqual({ linked: [], unlinked: [] });
  });

  test("an entry that appears later in the default is linked on the next pass", async () => {
    await runLinkPass(realLinkDisk, def, acct, share);
    await writeFile(join(def, "CLAUDE.md"), "# notes");
    const next = await runLinkPass(realLinkDisk, def, acct, share);
    expect(next.linked).toEqual(["CLAUDE.md"]);
  });

  test("a real file in the account folder is never replaced", async () => {
    await writeFile(join(def, "settings.json"), "{}");
    await writeFile(join(acct, "settings.json"), '{"mine":true}');
    const out = await runLinkPass(realLinkDisk, def, acct, share);
    expect(out.unlinked).toContain("settings.json");
    expect((await lstat(join(acct, "settings.json"))).isSymbolicLink()).toBe(false);
  });

  test("a default file that is a link is linked by its real file, so the chain is one level", async () => {
    await writeFile(join(root, "real-settings.json"), "{}");
    await symlink(join(root, "real-settings.json"), join(def, "settings.json"));
    await runLinkPass(realLinkDisk, def, acct, share);
    expect(await readlink(join(acct, "settings.json"))).toBe(join(root, "real-settings.json"));
  });

  test("a wrong link stays and is reported; a dangling link is not a free name", async () => {
    await mkdir(join(def, "skills"));
    await symlink(join(root, "nowhere"), join(acct, "skills"));
    const plan = await inspectLinks(realLinkDisk, def, acct, share);
    expect(plan.unlinked).toContain("skills");
    await runLinkPass(realLinkDisk, def, acct, share);
    expect(await readlink(join(acct, "skills"))).toBe(join(root, "nowhere"));
  });
});

describe("prepareSharedFolder", () => {
  let root = "";
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "collie-acct-prep-")));
    await mkdir(join(root, "default"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a missing folder is made 0700; an empty one is taken", async () => {
    expect(await prepareSharedFolder(realLinkDisk, join(root, "default"), join(root, "new"), share)).toEqual({ ok: true });
    if (process.platform !== "win32") expect((await stat(join(root, "new"))).mode & 0o777).toBe(0o700);
    await mkdir(join(root, "empty"));
    expect(await prepareSharedFolder(realLinkDisk, join(root, "default"), join(root, "empty"), share)).toEqual({ ok: true });
  });

  test("a folder with someone's files is refused; one an earlier create linked is taken", async () => {
    await mkdir(join(root, "used"));
    await writeFile(join(root, "used", "notes.txt"), "x");
    expect(await prepareSharedFolder(realLinkDisk, join(root, "default"), join(root, "used"), share)).toMatchObject({ ok: false, problem: "not empty" });
    await mkdir(join(root, "again"));
    await runLinkPass(realLinkDisk, join(root, "default"), join(root, "again"), share);
    expect(await prepareSharedFolder(realLinkDisk, join(root, "default"), join(root, "again"), share)).toEqual({ ok: true });
  });

  test("a file in place of the folder is refused", async () => {
    await writeFile(join(root, "file"), "x");
    expect(await prepareSharedFolder(realLinkDisk, join(root, "default"), join(root, "file"), share)).toMatchObject({ ok: false, problem: "not a folder" });
  });
});
