import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compareReleaseTags,
  deletedDocsPages,
  docsBranchTags,
  hasPickTrailer,
  splitNameStatus,
  newestReleaseTag,
  pathsOutsideDocs,
  parseArgs,
} from "./docs-line.ts";

const SCRIPT = join(import.meta.dir, "docs-line.ts");

// A bare runner has no git identity, so every commit in this file gets one from the environment.
const IDENT = {
  GIT_AUTHOR_NAME: "Docs Line Test",
  GIT_AUTHOR_EMAIL: "docs-line@example.invalid",
  GIT_COMMITTER_NAME: "Docs Line Test",
  GIT_COMMITTER_EMAIL: "docs-line@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENT },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("newestReleaseTag", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  test("picks the highest semver, not the last or the lexical one", () => {
    const listing = [
      `${sha}\trefs/tags/v1.9.0`,
      `${sha}\trefs/tags/v1.24.1`,
      `${sha}\trefs/tags/v1.24.1^{}`,
      `${sha}\trefs/tags/v1.10.3`,
    ].join("\n");
    expect(newestReleaseTag(listing)).toBe("v1.24.1");
  });
  test("ignores suffixed tags and other refs", () => {
    const listing = [
      `${sha}\trefs/tags/v1.2.0`,
      `${sha}\trefs/tags/v1.3.0-edge.1`,
      `${sha}\trefs/tags/v2.0.0-rc.1`,
      `${sha}\trefs/tags/nightly`,
      `${sha}\trefs/heads/v9.9.9`,
    ].join("\r\n");
    expect(newestReleaseTag(listing)).toBe("v1.2.0");
  });
  test("returns null for an empty listing", () => {
    expect(newestReleaseTag("")).toBeNull();
    expect(newestReleaseTag(`${sha}\trefs/tags/v1.0.0-beta.1\n`)).toBeNull();
  });
});

describe("compareReleaseTags", () => {
  test("orders by number, and throws on a suffixed tag", () => {
    expect(compareReleaseTags("v1.9.0", "v1.10.0")).toBeLessThan(0);
    expect(compareReleaseTags("v2.0.0", "v1.99.99")).toBeGreaterThan(0);
    expect(compareReleaseTags("v1.2.3", "v1.2.3")).toBe(0);
    expect(() => compareReleaseTags("v1.2.3-edge.1", "v1.2.3")).toThrow();
  });
});

describe("docsBranchTags", () => {
  test("lists plain docs/vX.Y.Z branches only", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const listing = [
      `${sha}\trefs/heads/docs/v1.2.0`,
      `${sha}\trefs/heads/docs/v1.3.0`,
      `${sha}\trefs/heads/docs/other`,
      `${sha}\trefs/heads/main`,
    ].join("\n");
    expect(docsBranchTags(listing)).toEqual(["v1.2.0", "v1.3.0"]);
  });
});

describe("pathsOutsideDocs", () => {
  test("accepts docs/ and the root README.md", () => {
    expect(pathsOutsideDocs(["docs/crew.md", "docs/images/a.svg", "README.md"])).toEqual([]);
  });
  test("names every path outside the line", () => {
    expect(
      pathsOutsideDocs(["docs/a.md", "cli/x.ts", "web/README.md", "docsx/a.md", "CHANGELOG.md"]),
    ).toEqual(["cli/x.ts", "web/README.md", "docsx/a.md", "CHANGELOG.md"]);
  });
  test("an empty list is docs-only", () => {
    expect(pathsOutsideDocs([])).toEqual([]);
  });
});

describe("parseArgs", () => {
  test("takes commits and --dry-run, refuses the rest", () => {
    expect(parseArgs(["abc", "--dry-run", "def"])).toEqual({
      commits: ["abc", "def"],
      dryRun: true,
      allowUnmerged: false,
    });
    expect(parseArgs(["--allow-unmerged", "abc"]).allowUnmerged).toBe(true);
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["--force", "abc"])).toThrow();
  });
});

describe("deletedDocsPages", () => {
  test("names a deleted top-level docs page, not an add, a change or an image", () => {
    const entries = splitNameStatus("D\tdocs/crew.md\nA\tdocs/new.md\nM\tdocs/a.md\nD\tdocs/images/x.svg\nD\tREADME.md\n");
    expect(deletedDocsPages(entries)).toEqual(["docs/crew.md"]);
  });
});

describe("hasPickTrailer", () => {
  test("matches the -x trailer for that sha only", () => {
    expect(hasPickTrailer("fix\n\n(cherry picked from commit abc123)\n", "abc123")).toBe(true);
    expect(hasPickTrailer("(cherry picked from commit abc1234)", "abc123")).toBe(false);
  });
});

describe("docs-line end to end", () => {
  let root: string;
  let origin: string;
  let clone: string;

  function write(rel: string, text: string): void {
    const file = join(clone, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  function commit(message: string, files: Record<string, string>): string {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git(clone, "add", "-A");
    git(clone, "commit", "--quiet", "-m", message);
    // Every fixture commit lands on origin's main, as the script requires; `unmerged()` skips this.
    git(clone, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    return git(clone, "rev-parse", "HEAD").trim();
  }

  /** A commit that exists only in the clone: origin's main does not have it. */
  function unmerged(message: string, files: Record<string, string>): string {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git(clone, "add", "-A");
    git(clone, "commit", "--quiet", "-m", message);
    return git(clone, "rev-parse", "HEAD").trim();
  }

  function docsLine(...args: string[]) {
    const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd: clone,
      env: { ...process.env, ...IDENT },
    });
    return { code: proc.exitCode, out: `${proc.stdout.toString()}${proc.stderr.toString()}` } satisfies {
      code: number;
      out: string;
    };
  }

  function originBranches(): string[] {
    return git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads/docs/")
      .split("\n")
      .filter((l) => l !== "");
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "docs-line-test-")));
    origin = join(root, "origin.git");
    clone = join(root, "clone");
    mkdirSync(origin);
    git(origin, "init", "--bare", "--quiet");
    mkdirSync(clone);
    git(clone, "init", "--quiet");
    git(clone, "remote", "add", "origin", origin);
    commit("release 0.1.0", {
      "README.md": "# Collie\n",
      "docs/a.md": "one\n",
      "cli/x.ts": "export const x = 1;\n",
    });
    git(clone, "tag", "v0.1.0");
    git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/main", "v0.1.0");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a commit touching cli/x.ts is refused before any branch exists", () => {
    const bad = commit("code and docs", { "cli/x.ts": "export const x = 2;\n", "docs/a.md": "two\n" });
    const res = docsLine(bad);
    expect(res.code).toBe(1);
    expect(res.out).toContain("cli/x.ts");
    expect(originBranches()).toEqual([]);
    expect(git(clone, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
    git(clone, "reset", "--quiet", "--hard", "HEAD~1");
  });

  test("--dry-run pushes nothing and prints the log", () => {
    const doc = commit("docs: fix a", { "docs/a.md": "dry\n" });
    const res = docsLine("--dry-run", doc);
    expect(res.code).toBe(0);
    expect(res.out).toContain("docs: fix a");
    expect(res.out).toContain("dry run");
    expect(res.out).toContain("the site would not be told");
    expect(originBranches()).toEqual([]);
  });

  test("a docs-only commit lands on docs/v0.1.0 with -x", () => {
    const doc = git(clone, "rev-parse", "HEAD").trim();
    const res = docsLine(doc);
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      "the branch has no docs-line.yml, so the site is not told; run: gh workflow run sync-docs.yml -R AltanS/collie-website",
    );
    expect(originBranches()).toEqual(["docs/v0.1.0"]);
    const body = git(origin, "log", "--format=%B", "v0.1.0..docs/v0.1.0");
    expect(body).toContain(`(cherry picked from commit ${doc})`);
    expect(git(origin, "diff", "--name-only", "v0.1.0", "docs/v0.1.0").trim()).toBe("docs/a.md");
    expect(git(clone, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
  });

  test("a second run appends to the existing branch", () => {
    const readme = commit("docs: readme", { "README.md": "# Collie, fixed\n" });
    const res = docsLine(readme);
    expect(res.code).toBe(0);
    const subjects = git(origin, "log", "--format=%s", "v0.1.0..docs/v0.1.0").trim().split("\n");
    expect(subjects).toEqual(["docs: readme", "docs: fix a"]);
  });

  test("an older docs branch is listed with its delete command, not deleted", () => {
    git(clone, "tag", "v0.2.0");
    git(clone, "push", "--quiet", "origin", "v0.2.0");
    const doc = commit("docs: after 0.2.0", { "docs/b.md": "b\n" });
    const res = docsLine(doc);
    expect(res.code).toBe(0);
    expect(res.out).toContain("git push origin --delete docs/v0.1.0");
    expect(originBranches().toSorted()).toEqual(["docs/v0.1.0", "docs/v0.2.0"]);
  });
  test("a conflicting pick exits 1, pushes nothing and leaves no worktree", () => {
    const home = git(clone, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(clone, "checkout", "--quiet", "-b", "side", "v0.1.0");
    const clash = commit("docs: clash", { "docs/a.md": "clash\n" });
    git(clone, "checkout", "--quiet", home);
    const before = git(origin, "rev-parse", "docs/v0.2.0").trim();
    const res = docsLine(clash);
    expect(res.code).toBe(1);
    expect(res.out).toContain("cherry-pick");
    expect(git(origin, "rev-parse", "docs/v0.2.0").trim()).toBe(before);
    expect(git(clone, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
  });
  test("a rename out of cli/ into docs/ is refused, because both paths are listed", () => {
    rmSync(join(clone, "cli/x.ts"));
    const moved = commit("move code into docs", { "docs/x.md": "export const x = 1;\n" });
    const res = docsLine("--dry-run", moved);
    expect(res.code).toBe(1);
    expect(res.out).toContain("cli/x.ts");
    git(clone, "reset", "--quiet", "--hard", "HEAD~1");
  });

  test("a deleted docs page is refused, since the release run and the site name pages", () => {
    rmSync(join(clone, "docs/b.md"));
    const gone = commit("docs: drop b", {});
    const res = docsLine("--dry-run", gone);
    expect(res.code).toBe(1);
    expect(res.out).toContain("docs/b.md");
    expect(res.out).toContain("docs page");
    git(clone, "reset", "--quiet", "--hard", "HEAD~1");
  });

  test("a commit that is not on origin/main is refused, and --allow-unmerged lifts that", () => {
    const local = unmerged("docs: local only", { "docs/local.md": "local\n" });
    const refused = docsLine("--dry-run", local);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      `${local} is not on origin/main; land it there first, or pass --allow-unmerged`,
    );
    const allowed = docsLine("--dry-run", "--allow-unmerged", local);
    expect(allowed.code).toBe(0);
    git(clone, "reset", "--quiet", "--hard", "HEAD~1");
  });

  test("the same commit twice is skipped, not a conflict, and the branch gets one commit", () => {
    const doc = commit("docs: once", { "docs/once.md": "once\n" });
    const first = docsLine(doc);
    expect(first.code).toBe(0);
    expect(first.out).toContain("docs/once.md");
    expect(first.out).toContain("files changed");
    const second = docsLine(doc);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already on the line");
    const picks = git(origin, "log", "--format=%s", "v0.2.0..docs/v0.2.0")
      .split("\n")
      .filter((l) => l === "docs: once");
    expect(picks).toHaveLength(1);
  });
});
