import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import {
  MAX_BASE_REF_LENGTH,
  askGit,
  isValidBaseRef,
  parseBase,
  refNamesCommit,
  resolveBase,
  resolveDefaultBranch,
  type GitAsk,
} from "./worktree-base.ts";

// Where a new worktree starts from (ADR 0089, amended). Three claims:
//
//   1. A ref off the wire is a NAME. Anything that could read as a flag, a revision expression or a
//      path trick is refused before git is started, and git is only ever given argv arrays.
//   2. `default` resolves in a fixed order: origin/HEAD (as a local branch), main, master, nothing.
//   3. Nothing fetches. The real-git cases run in throwaway repos with no remote reachable.

describe("isValidBaseRef", () => {
  test("accepts the refs a branch picker sends", () => {
    for (const ok of ["main", "master", "develop", "feature/x", "worktree/brisk-otter-3fa9", "release-1.2", "a", "v1.0.0", "x".repeat(MAX_BASE_REF_LENGTH)]) {
      expect(isValidBaseRef(ok)).toBe(true);
    }
  });

  test("refuses empty, over-long and flag-shaped refs", () => {
    for (const bad of ["", "x".repeat(MAX_BASE_REF_LENGTH + 1), "-", "-x", "--upload-pack=evil", "--end-of-options", "-C"]) {
      expect(isValidBaseRef(bad)).toBe(false);
    }
  });

  test("refuses whitespace and control characters, inside or at the edge", () => {
    for (const bad of [" main", "main ", "ma in", "ma\tin", "ma\nin", "ma\rin", "ma\0in", "ma\x7fin", "ma in", "ma in", "main\n--exec=x"]) {
      expect(isValidBaseRef(bad)).toBe(false);
    }
  });

  test("refuses the sequences and characters git forbids", () => {
    for (const bad of ["a..b", "a@{1}", "@{-1}", "a\\b", "a~1", "a^", "HEAD^{commit}", "a:b", "a?", "a*", "a[0]", "a//b", "a/", "/a", "a.", "a.lock", "a/b.lock", "a.lock/b", "@", ".hidden", "a/.hidden", "a/..", "../x"]) {
      expect(isValidBaseRef(bad)).toBe(false);
    }
  });

  test("lets shell metacharacters through to git, which only ever gets argv", () => {
    // Not refused here: they are legal in a ref name. They are inert because no shell is involved.
    for (const odd of ["a;b", "a$(b)", "a`b`", "a|b", "a&b", "a>b", "a'b"]) {
      expect(isValidBaseRef(odd)).toBe(true);
    }
  });
});

describe("parseBase", () => {
  test("absent and null mean no preference", () => {
    expect(parseBase(undefined)).toEqual({ ok: true, base: undefined });
    expect(parseBase(null)).toEqual({ ok: true, base: undefined });
  });

  test("the two documented shapes parse", () => {
    expect(parseBase({ kind: "default" })).toEqual({ ok: true, base: { kind: "default" } });
    expect(parseBase({ kind: "ref", ref: "feature/x" })).toEqual({ ok: true, base: { kind: "ref", ref: "feature/x" } });
  });

  test("every other shape is a refusal", () => {
    const refusals: JsonValue[] = [
      "main",
      42,
      true,
      [],
      {},
      { kind: "other" },
      { kind: "ref" },
      { kind: "ref", ref: 7 },
      { kind: "ref", ref: "" },
      { kind: "ref", ref: "-x" },
      { kind: "ref", ref: "a b" },
      { kind: "ref", ref: "a..b" },
      { kind: "ref", ref: "x.lock" },
      { kind: "ref", ref: "x".repeat(MAX_BASE_REF_LENGTH + 1) },
    ];
    for (const bad of refusals) {
      expect(parseBase(bad)).toEqual({ ok: false });
    }
  });

  test("a default with a stray ref ignores it; the ref is never read", () => {
    expect(parseBase({ kind: "default", ref: "--evil" })).toEqual({ ok: true, base: { kind: "default" } });
  });
});

/** A scripted git and the argv arrays it was asked. */
interface ScriptedGit {
  ask: GitAsk;
  calls: string[][];
}

/** A scripted git: answers by the first matching rule, and records every argv it was asked. */
function scripted(rules: Array<[string[], string | null]>): ScriptedGit {
  const calls: string[][] = [];
  const ask: GitAsk = (_repoRoot, args) => {
    calls.push([...args]);
    const hit = rules.find(([want]) => want.every((w, i) => args[i] === w) && want.length === args.length);
    return Promise.resolve(hit === undefined ? null : hit[1]);
  };
  return { ask, calls };
}

const ORIGIN_HEAD = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];
const local = (name: string) => ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`];

describe("resolveDefaultBranch order", () => {
  test("origin/HEAD wins when that local branch exists", async () => {
    const { ask, calls } = scripted([
      [ORIGIN_HEAD, "origin/develop"],
      [local("develop"), "abc"],
      [local("main"), "def"],
    ]);
    expect(await resolveDefaultBranch("/r", ask)).toBe("develop");
    expect(calls).toEqual([ORIGIN_HEAD, local("develop")]);
  });

  test("origin/HEAD naming a branch with no local copy falls to main", async () => {
    const { ask } = scripted([
      [ORIGIN_HEAD, "origin/develop"],
      [local("main"), "def"],
    ]);
    expect(await resolveDefaultBranch("/r", ask)).toBe("main");
  });

  test("no origin/HEAD: main, then master", async () => {
    expect(await resolveDefaultBranch("/r", scripted([[local("main"), "a"], [local("master"), "b"]]).ask)).toBe("main");
    expect(await resolveDefaultBranch("/r", scripted([[local("master"), "b"]]).ask)).toBe("master");
  });

  test("none of them: null, so no base is sent", async () => {
    expect(await resolveDefaultBranch("/r", scripted([]).ask)).toBeNull();
  });

  test("an origin/HEAD that is not under origin/ is not trusted", async () => {
    const { ask } = scripted([
      [ORIGIN_HEAD, "upstream/develop"],
      [local("upstream/develop"), "a"],
    ]);
    expect(await resolveDefaultBranch("/r", ask)).toBeNull();
  });

  test("an origin/HEAD that names an evil ref is not looked up", async () => {
    const { ask, calls } = scripted([[ORIGIN_HEAD, "origin/--upload-pack=x"]]);
    expect(await resolveDefaultBranch("/r", ask)).toBeNull();
    expect(calls.some((c) => c.some((a) => a.includes("--upload-pack")))).toBe(false);
  });
});

describe("resolveBase", () => {
  test("no request: no ref, and git is never asked", async () => {
    const { ask, calls } = scripted([]);
    expect(await resolveBase(undefined, "/r", ask)).toEqual({ ok: true, ref: undefined });
    expect(calls).toEqual([]);
  });

  test("default resolves, or comes up empty without failing", async () => {
    expect(await resolveBase({ kind: "default" }, "/r", scripted([[local("main"), "a"]]).ask)).toEqual({ ok: true, ref: "main" });
    expect(await resolveBase({ kind: "default" }, "/r", scripted([]).ask)).toEqual({ ok: true, ref: undefined });
  });

  test("a ref must pass git's own format check and name a commit", async () => {
    const good = scripted([
      [["check-ref-format", "--allow-onelevel", "feature/x"], ""],
      [local("feature/x"), "abc"],
    ]);
    expect(await resolveBase({ kind: "ref", ref: "feature/x" }, "/r", good.ask)).toEqual({ ok: true, ref: "feature/x" });

    const noFormat = scripted([[local("feature/x"), "abc"]]);
    expect(await resolveBase({ kind: "ref", ref: "feature/x" }, "/r", noFormat.ask)).toEqual({ ok: false });

    const noCommit = scripted([[["check-ref-format", "--allow-onelevel", "feature/x"], ""]]);
    expect(await resolveBase({ kind: "ref", ref: "feature/x" }, "/r", noCommit.ask)).toEqual({ ok: false });
  });

  test("a tag or remote ref that is no local branch still passes when it names a commit", async () => {
    const { ask } = scripted([
      [["check-ref-format", "--allow-onelevel", "v1.0.0"], ""],
      [["rev-parse", "--verify", "--quiet", "v1.0.0^{commit}"], "abc"],
    ]);
    expect(await refNamesCommit("/r", "v1.0.0", ask)).toBe(true);
  });

  test("a syntactically evil ref never reaches git at all", async () => {
    const { ask, calls } = scripted([]);
    for (const ref of ["-x", "a b", "a..b", "HEAD^"]) {
      expect(await refNamesCommit("/r", ref, ask)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test("the ref travels as ONE argv element, never spliced into a longer string", async () => {
    const { ask, calls } = scripted([[["check-ref-format", "--allow-onelevel", "a;touch-pwned"], ""]]);
    await refNamesCommit("/r", "a;touch-pwned", ask);
    const flat = calls.flat();
    expect(flat).toContain("a;touch-pwned");
    expect(flat).toContain("refs/heads/a;touch-pwned^{commit}");
    expect(calls.every((c) => c.every((arg) => !arg.includes(" ")))).toBe(true);
  });
});

// ── Real git, in throwaway repos ───────────────────────────────────────────────────────────────────

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "collie-worktree-base-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run a real git for set-up only, with a fixed identity and no global config. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return out.trim();
}

async function makeRepo(initial: string): Promise<string> {
  const repo = join(dir, "repo");
  await git(dir, "init", "-q", "-b", initial, repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  return repo;
}

describe("against a real repo", () => {
  test("main is the default of a fresh repo, and a master-only repo falls to master", async () => {
    const repo = await makeRepo("main");
    expect(await resolveDefaultBranch(repo)).toBe("main");
    await rm(repo, { recursive: true, force: true });
    const old = await makeRepo("master");
    expect(await resolveDefaultBranch(old)).toBe("master");
  });

  test("origin/HEAD is read from the repo, and wins over main", async () => {
    const repo = await makeRepo("main");
    await git(repo, "branch", "trunk");
    await git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await resolveDefaultBranch(repo)).toBe("trunk");
  });

  test("a repo with only other branches has no default; a folder that is no repo has none either", async () => {
    const repo = await makeRepo("dev");
    expect(await resolveDefaultBranch(repo)).toBeNull();
    expect(await resolveDefaultBranch(join(dir, "nowhere"))).toBeNull();
  });

  test("a ref passes only when it names a commit; evil refs create nothing", async () => {
    const repo = await makeRepo("main");
    await git(repo, "branch", "feature/x");
    await git(repo, "tag", "v1");
    expect(await refNamesCommit(repo, "feature/x")).toBe(true);
    expect(await refNamesCommit(repo, "v1")).toBe(true);
    expect(await refNamesCommit(repo, "feature/gone")).toBe(false);

    const marker = join(dir, "pwned");
    for (const evil of [`$(touch ${marker})`, `x;touch ${marker}`, "--help", "-x", "main^{tree}", "main~1", "HEAD@{1}"]) {
      expect(await refNamesCommit(repo, evil)).toBe(false);
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("askGit answers null for a failure and a trimmed string for a success", async () => {
    const repo = await makeRepo("main");
    expect(await askGit(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"])).toMatch(/^[0-9a-f]{40}$/);
    expect(await askGit(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/nope^{commit}"])).toBeNull();
  });

  test("resolveBase never fetches: a remote that cannot be reached is not touched", async () => {
    const repo = await makeRepo("main");
    await git(repo, "remote", "add", "origin", "ext::touch " + join(dir, "fetched"));
    expect(await resolveBase({ kind: "default" }, repo)).toEqual({ ok: true, ref: "main" });
    expect(existsSync(join(dir, "fetched"))).toBe(false);
  });
});
