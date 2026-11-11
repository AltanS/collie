import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { trickCodeHash } from "../bridge/tricks/code-hash.ts";
import { ORIGIN_FILE, parseOrigin } from "../bridge/tricks/origin.ts";
import { APPROVED_DIR, approvedTrickDir, PENDING_DIR, switchesPath, trickStateDir } from "../bridge/tricks/paths.ts";
import { parseSwitches } from "../bridge/tricks/switches.ts";
import { EXIT, type Io } from "./io.ts";
import { realFiles } from "./sys.ts";
import { ADD_LIMITS, cmdTrickAdd, cmdTrickRemove, cmdTrickUpdate, GIT_HARDENING, manifestBlurb, OFFICIAL_TRICKS_REPO, parseTrickSource, sourceRefProblem, spawnGit, type GitRunner, type TrickAddDeps } from "./trick-add.ts";
import { cmdTrickList, cmdTrickSwitch } from "./trick.ts";

// `collie trick add`, `update` and `remove` (review 15), against a local bare repository through the test
// seam. Nothing here reaches the network: every source is a folder under the test's temp dir. Each case
// runs real git a few times, so a busy machine gets a longer limit than the default 5 s. The fixture
// cases build symlinks, exec bits and sh hooks, which a Windows runner cannot make, so they run on POSIX;
// the source and hardening cases run everywhere.

setDefaultTimeout(30_000);
const posix = process.platform !== "win32";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-trick-add-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** git for the fixture itself, with no config of the person running the tests. */
function fixtureGit(cwd: string, args: string[], home: string): string {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const run = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`fixture git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

type FixtureFile = { text: string; exec?: boolean } | { link: string };
/** A plain file of the fixture. */
const txt = (text: string): FixtureFile => ({ text });

/** A bare repository holding one commit per entry of `commits`, each a whole tree. Answers its path and the commits. */
async function fixtureRepo(commits: Record<string, FixtureFile>[], tags: Record<string, number> = {}): Promise<{ bare: string; shas: string[]; home: string }> {
  const root = await tempDir();
  const home = join(root, "fixture-home");
  await mkdir(home);
  const work = join(root, "work");
  const bare = join(root, "repo.git");
  fixtureGit(root, ["init", "-q", "--bare", bare], home);
  fixtureGit(root, ["init", "-q", work], home);
  const shas: string[] = [];
  for (const tree of commits) {
    for (const name of await readdir(work)) if (name !== ".git") await rm(join(work, name), { recursive: true, force: true });
    for (const [rel, file] of Object.entries(tree)) {
      const path = join(work, rel);
      await mkdir(dirname(path), { recursive: true });
      if ("link" in file) await symlink(file.link, path);
      else await writeFile(path, file.text, { mode: file.exec === true ? 0o755 : 0o644 });
    }
    fixtureGit(work, ["add", "-A"], home);
    fixtureGit(work, ["commit", "-q", "--allow-empty", "-m", `commit ${String(shas.length + 1)}`], home);
    shas.push(fixtureGit(work, ["rev-parse", "HEAD"], home));
  }
  for (const [tag, i] of Object.entries(tags)) fixtureGit(work, ["tag", tag, shas[i] ?? "HEAD"], home);
  fixtureGit(work, ["push", "-q", bare, "HEAD:refs/heads/main", "--tags"], home);
  fixtureGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"], home);
  return { bare, shas, home };
}

const MANIFEST = (id: string, extra = ""): string => `# A trick that counts sessions.\nid = "${id}"\nname = "Trick ${id}"\nrun = "./program.sh"\nplaces = ["belt"]\n${extra}`;
const PROGRAM = { text: '#!/bin/sh\nprintf \'{"v":1,"parts":[]}\\n\'\n', exec: true };
const NETWORK_PROGRAM = { text: '#!/bin/sh\ncurl -s https://example.com/status\nprintf \'{"v":1,"parts":[]}\\n\'\n', exec: true };

interface Rig extends TrickAddDeps {
  out: string[];
  err: string[];
  configDir: string;
  stateDir: string;
  home: string;
  /** Every argv git was run with. */
  gitArgs: string[][];
}

async function rig(official?: string): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const home = join(root, "home");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(home, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const gitArgs: string[][] = [];
  const git: GitRunner = async (args, opts) => {
    gitArgs.push([...args]);
    return await spawnGit(args, opts);
  };
  const seam = official === undefined ? { allowLocal: true } : { allowLocal: true, officialRepo: official };
  return {
    out,
    err,
    configDir,
    stateDir,
    home,
    gitArgs,
    io,
    git,
    seam,
    ctx: { configDir, stateDir, port: 18_998, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_DIR: "/nowhere", GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/evil'" } },
    files: realFiles,
    fetch: async () => {
      throw new Error("no bridge in this test");
    },
    now: () => Date.parse("2026-11-10T09:41:00Z"),
  };
}

const trickDir = (r: Rig, id: string): string => join(r.configDir, "tricks", id);

/** Nothing left behind: no fetch folder under the state folder, no staged folder in the tricks folder. */
async function expectNoLeftovers(r: Rig): Promise<void> {
  const state = await readdir(join(r.stateDir, "tricks")).catch(() => []);
  expect(state.filter((n) => n.startsWith(".fetch-"))).toEqual([]);
  const tricks = await readdir(join(r.configDir, "tricks")).catch(() => []);
  // The folders of approved and pending copies are the bridge's, not a leftover of add or update.
  expect(tricks.filter((n) => n.startsWith(".") && n !== APPROVED_DIR && n !== PENDING_DIR)).toEqual([]);
}

describe("collie trick add: the source", () => {
  test("a bare name is that folder of the official repository, with or without a ref", () => {
    expect(parseTrickSource("legs")).toEqual({ url: OFFICIAL_TRICKS_REPO, ref: null, subdir: "legs" });
    expect(parseTrickSource("legs#v1")).toEqual({ url: OFFICIAL_TRICKS_REPO, ref: "v1", subdir: "legs" });
  });

  test("a URL takes //<folder> and #<ref> in either order", () => {
    const want = { url: "https://github.com/o/r", ref: "main", subdir: "tricks/legs" };
    expect(parseTrickSource("https://github.com/o/r//tricks/legs#main")).toEqual(want);
    expect(parseTrickSource("https://github.com/o/r#main//tricks/legs")).toEqual(want);
    expect(parseTrickSource("https://github.com/o/r.git")).toEqual({ url: "https://github.com/o/r.git", ref: null, subdir: null });
  });

  test("refuses what is not a plain https source", () => {
    for (const raw of [
      "http://github.com/o/r",
      "git@github.com:o/r.git",
      "ssh://github.com/o/r",
      "file:///tmp/repo",
      "/tmp/repo",
      "ext::sh -c touch% /tmp/x",
      "https://user:pw@github.com/o/r",
      "https://github.com/o/r?x=1",
      "https://github.com/o/r#-uhack",
      "https://github.com/o/r#a..b",
      "https://github.com/o/r#a:b",
      "https://github.com/o/r//../up",
      "https://github.com/o/r//.git",
      "https://github.com/o/r//a/.hidden",
      "legs//sub",
    ]) {
      expect("error" in parseTrickSource(raw)).toBe(true);
    }
  });

  test("the official repository in another spelling is refused, and the sentence names its URL (review 7 M2)", () => {
    const sha = "9".repeat(40);
    for (const url of [
      `${OFFICIAL_TRICKS_REPO}.git`,
      `${OFFICIAL_TRICKS_REPO}/`,
      `${OFFICIAL_TRICKS_REPO}.git/`,
      OFFICIAL_TRICKS_REPO.toLowerCase(),
      OFFICIAL_TRICKS_REPO.replace("github.com", "www.github.com"),
      OFFICIAL_TRICKS_REPO.replace("github.com", "GitHub.COM"),
      OFFICIAL_TRICKS_REPO.replace("github.com", "github.com."),
      OFFICIAL_TRICKS_REPO.replace("AltanS", "%41ltanS"),
    ]) {
      // The probe's form: refused (a trailing `/` before `//legs` makes a folder name that is refused too).
      for (const raw of [`${url}//legs#${sha}`, `${url}//legs`]) expect("error" in parseTrickSource(raw)).toBe(true);
      for (const raw of [`${url}#${sha}`, `${url}#v1`]) {
        const read = parseTrickSource(raw);
        expect("error" in read ? read.error : "taken").toBe(`${url} is the official repository of tricks, written another way. Write it as ${OFFICIAL_TRICKS_REPO}`);
      }
      // The commit rule holds for every spelling on its own too.
      expect(sourceRefProblem({ url, ref: sha })).toContain("not by a commit id");
    }
    // The official spelling still takes a branch or a tag, and refuses a commit id.
    expect(parseTrickSource(`${OFFICIAL_TRICKS_REPO}//legs#v1`)).toEqual({ url: OFFICIAL_TRICKS_REPO, ref: "v1", subdir: "legs" });
    expect("error" in parseTrickSource(`${OFFICIAL_TRICKS_REPO}//legs#${sha}`)).toBe(true);
  });

  test("a local path is a source only under the tests' seam", () => {
    expect("error" in parseTrickSource("/tmp/repo")).toBe(true);
    expect(parseTrickSource("/tmp/repo//legs", { allowLocal: true })).toEqual({ url: "/tmp/repo", ref: null, subdir: "legs" });
  });

  test("every git run carries the hardening, https only, no hooks, no submodules, no LFS smudge", () => {
    const flat = GIT_HARDENING.join(" ");
    for (const kv of ["core.hooksPath=/dev/null", "protocol.allow=never", "protocol.https.allow=always", "protocol.file.allow=never", "protocol.ext.allow=never", "submodule.recurse=false", "filter.lfs.smudge=", "core.fsmonitor=false"]) {
      expect(flat).toContain(`-c ${kv}`);
    }
  });

  test("the first comment line of trick.toml is its description in the list", () => {
    expect(manifestBlurb("# Counts the sessions.\nid = \"x\"\n")).toBe("Counts the sessions.");
    expect(manifestBlurb("id = \"x\"\n# later\n")).toBe("-");
  });
});

describe.if(posix)("collie trick add", () => {
  test("adds a trick at the top of a repository, off, with its origin record", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, "README.md": txt("# legs\n") }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    const dir = trickDir(r, "legs");
    expect(await readFile(join(dir, "trick.toml"), "utf8")).toBe(MANIFEST("legs"));
    expect(((await stat(join(dir, "program.sh"))).mode & 0o111) !== 0).toBe(true);
    const origin = parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"));
    expect(origin).toEqual({ url: repo.bare, ref: null, commit: repo.shas[0] ?? "", subdir: null, at: "2026-11-10T09:41:00.000Z" });
    expect(r.out.join("\n")).toContain(`at commit ${repo.shas[0] ?? ""}`);
    expect(r.out.at(-1)).toBe("The trick is off. Read it, then: collie trick on legs");
    // Off: no switch was written.
    expect(parseSwitches(await readFile(switchesPath(r.stateDir), "utf8").catch(() => null)).switches.on.size).toBe(0);
    // Git never wrote a working tree: no checkout, a bare repository, no template.
    expect(r.gitArgs.some((a) => a.includes("checkout") || a.includes("clone"))).toBe(false);
    expect(r.gitArgs[0]).toContain("--template=");
    await expectNoLeftovers(r);
    // The origin record is outside the code hash: a hash taken without it is the same.
    const before = await trickCodeHash(dir);
    await rm(join(dir, ORIGIN_FILE));
    expect(await trickCodeHash(dir)).toEqual(before);
  });

  test("adds one folder of a repository that holds several, and leaves dot files and node_modules out", async () => {
    const repo = await fixtureRepo([
      {
        "legs/trick.toml": txt(MANIFEST("legs")),
        "legs/program.sh": PROGRAM,
        "legs/.hidden.ts": txt("export const x = 1;\n"),
        "legs/node_modules/pkg/index.js": txt("module.exports = 1;\n"),
        "legs/lib/util.sh": txt("echo hi\n"),
        "clock/trick.toml": txt(MANIFEST("clock")),
        "clock/program.sh": PROGRAM,
      },
    ]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [`${repo.bare}//legs`])).toBe(EXIT.OK);
    const dir = trickDir(r, "legs");
    expect((await readdir(dir)).toSorted()).toEqual([ORIGIN_FILE, "lib", "program.sh", "trick.toml"].toSorted());
    expect(await readFile(join(dir, "lib", "util.sh"), "utf8")).toBe("echo hi\n");
    expect(await readdir(join(r.configDir, "tricks"))).toEqual(["legs"]);
    expect(r.out.join("\n")).toContain("2 dot files, dot folders and node_modules files left out");
    expect(parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"))?.subdir).toBe("legs");
  });

  test("takes a tag, a branch or a full commit as the ref", async () => {
    const repo = await fixtureRepo(
      [
        { "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM },
        { "trick.toml": txt(MANIFEST("legs")), "program.sh": NETWORK_PROGRAM },
      ],
      { v1: 0 },
    );
    const tagged = await rig();
    expect(await cmdTrickAdd(tagged, [`${repo.bare}#v1`])).toBe(EXIT.OK);
    expect(parseOrigin(await readFile(join(trickDir(tagged, "legs"), ORIGIN_FILE), "utf8"))).toMatchObject({ ref: "v1", commit: repo.shas[0] });
    expect(await readFile(join(trickDir(tagged, "legs"), "program.sh"), "utf8")).toBe(PROGRAM.text);
    const pinned = await rig();
    expect(await cmdTrickAdd(pinned, [`${repo.bare}#${repo.shas[0] ?? ""}`])).toBe(EXIT.OK);
    expect(parseOrigin(await readFile(join(trickDir(pinned, "legs"), ORIGIN_FILE), "utf8"))?.commit).toBe(repo.shas[0]);
    const branch = await rig();
    expect(await cmdTrickAdd(branch, [`${repo.bare}#main`])).toBe(EXIT.OK);
    expect(parseOrigin(await readFile(join(trickDir(branch, "legs"), ORIGIN_FILE), "utf8"))?.commit).toBe(repo.shas[1]);
    // The newer commit reaches the network: the check scan says so after the add.
    expect(branch.out.join("\n")).toContain("reaches the network");
  });

  test("takes only a branch or a tag by name: a pull request's ref, or a short name git would read as one, is refused", async () => {
    const repo = await fixtureRepo([
      { "legs/trick.toml": txt(MANIFEST("legs")), "legs/program.sh": PROGRAM },
      { "legs/trick.toml": txt(MANIFEST("legs")), "legs/program.sh": NETWORK_PROGRAM },
    ]);
    // A stranger's pull request: GitHub serves refs/pull/N/head through the repository's own URL.
    fixtureGit(repo.bare, ["update-ref", "refs/pull/1/head", repo.shas[0] ?? ""], repo.home);
    for (const raw of [`${repo.bare}//legs#refs/pull/1/head`, `${repo.bare}//legs#pull/1/head`, `${repo.bare}//legs#refs/remotes/x`]) {
      const r = await rig();
      expect(await cmdTrickAdd(r, [raw])).not.toBe(EXIT.OK);
      expect(r.err.join("\n")).toMatch(/is not a branch or a tag|has no branch or tag named pull\/1\/head/u);
      expect(await readdir(join(r.configDir, "tricks")).catch(() => [])).toEqual([]);
      await expectNoLeftovers(r);
    }
    // A short name is looked up as exactly a tag or a branch, and the fetch names the full ref.
    const r = await rig();
    expect(await cmdTrickAdd(r, [`${repo.bare}//legs#main`])).toBe(EXIT.OK);
    expect(r.gitArgs.find((a) => a.includes("fetch"))).toContain("refs/heads/main");
    const full = await rig();
    expect(await cmdTrickAdd(full, [`${repo.bare}//legs#refs/heads/main`])).toBe(EXIT.OK);
  });

  test("the official repository takes a branch or a tag, never a pull request's ref or a bare commit id", async () => {
    const repo = await fixtureRepo(
      [
        { "legs/trick.toml": txt(MANIFEST("legs")), "legs/program.sh": PROGRAM },
        { "legs/trick.toml": txt(MANIFEST("legs")), "legs/program.sh": NETWORK_PROGRAM },
      ],
      { v1: 0 },
    );
    fixtureGit(repo.bare, ["update-ref", "refs/pull/7/head", repo.shas[0] ?? ""], repo.home);
    for (const raw of ["legs#refs/pull/7/head", `legs#${repo.shas[0] ?? ""}`, `legs#${repo.shas[1] ?? ""}`]) {
      const r = await rig(repo.bare);
      expect(await cmdTrickAdd(r, [raw])).not.toBe(EXIT.OK);
      expect(r.err.join("\n")).toMatch(/is not a branch or a tag|not by a commit id/u);
      expect(r.gitArgs).toEqual([]);
    }
    expect(parseTrickSource(`legs#${"a".repeat(40)}`)).toEqual({ error: expect.stringContaining("not by a commit id") });
    // Another repository keeps the documented full commit id.
    expect(parseTrickSource(`https://github.com/o/r#${"a".repeat(40)}`)).toEqual({ url: "https://github.com/o/r", ref: "a".repeat(40), subdir: null });
    const tagged = await rig(repo.bare);
    expect(await cmdTrickAdd(tagged, ["legs#v1"])).toBe(EXIT.OK);
    const branch = await rig(repo.bare);
    expect(await cmdTrickAdd(branch, ["legs#refs/heads/main"])).toBe(EXIT.OK);
  });

  test("refuses a symbolic link anywhere in the trick, and leaves nothing behind", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, ".config/link": { link: "/etc/passwd" } }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain(".config/link is a symbolic link");
    expect(r.err.join("\n")).toContain("Nothing was added.");
    expect(await stat(trickDir(r, "legs")).catch(() => null)).toBeNull();
    await expectNoLeftovers(r);
  });

  test("refuses a trick over the caps", async () => {
    const big = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, "data.bin": txt("x".repeat(ADD_LIMITS.bytes + 1)) }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [big.bare])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain(`more than ${String(ADD_LIMITS.bytes / (1024 * 1024))} MB`);
    const data = Object.fromEntries(Array.from({ length: ADD_LIMITS.files }, (_, i) => [`data/${String(i)}.txt`, txt(String(i))]));
    const many = { "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, ...data };
    const wide = await fixtureRepo([many]);
    const w = await rig();
    expect(await cmdTrickAdd(w, [wide.bare])).toBe(EXIT.FAIL);
    expect(w.err.join("\n")).toContain(`more than ${String(ADD_LIMITS.files)}`);
    await expectNoLeftovers(w);
  });

  test("refuses a manifest the strict reader refuses, or none", async () => {
    const bad = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs", 'colour = "red"\n')), "program.sh": PROGRAM }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [bad.bare])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain("trick.toml");
    const newer = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs", "contract = 99\n")), "program.sh": PROGRAM }]);
    const n = await rig();
    expect(await cmdTrickAdd(n, [newer.bare])).toBe(EXIT.FAIL);
    expect(n.err.join("\n")).toContain("newer Collie");
    const none = await fixtureRepo([{ "program.sh": PROGRAM }]);
    const o = await rig();
    expect(await cmdTrickAdd(o, [none.bare])).toBe(EXIT.FAIL);
    expect(o.err.join("\n")).toContain("there is no trick.toml");
    await expectNoLeftovers(o);
  });

  test("refuses a trick that is already there and points at update", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain("To fetch it again: collie trick update legs");
    await expectNoLeftovers(r);
  });

  test("a failed fetch leaves no temp folder", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [`${repo.bare}#no-such-branch`])).toBe(EXIT.FAIL);
    // A short name is looked up as a tag or a branch first (fetch.ts `fetchRef`).
    expect(r.err.join("\n")).toContain("has no branch or tag named no-such-branch");
    await expectNoLeftovers(r);
  });

  test("never runs a hook: not the person's global hooks folder, not a template's, not an inherited GIT_ variable", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, ".githooks/post-checkout": { text: "#!/bin/sh\ntouch hooked\n", exec: true } }]);
    const r = await rig();
    const marker = join(r.home, "hook-ran");
    const hooks = join(r.home, "hooks");
    const template = join(r.home, "template");
    await mkdir(hooks);
    await mkdir(join(template, "hooks"), { recursive: true });
    const hook = `#!/bin/sh\ntouch ${marker}\n`;
    for (const name of ["post-checkout", "post-merge", "reference-transaction", "post-index-change", "pre-auto-gc", "fsmonitor-watchman"]) {
      await writeFile(join(hooks, name), hook);
      await chmod(join(hooks, name), 0o755);
      await writeFile(join(template, "hooks", name), hook);
      await chmod(join(template, "hooks", name), 0o755);
    }
    await writeFile(join(r.home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${template}\n`);
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    expect(await stat(marker).catch(() => null)).toBeNull();
    expect(await stat(join(trickDir(r, "legs"), ".githooks")).catch(() => null)).toBeNull();
  });

  test("with no source lists the official repository's tricks and adds nothing", async () => {
    const repo = await fixtureRepo([{ "legs/trick.toml": txt(MANIFEST("legs")), "legs/program.sh": PROGRAM, "clock/trick.toml": txt(MANIFEST("clock")), "README.md": txt("# tricks\n") }]);
    const r = await rig(repo.bare);
    expect(await cmdTrickAdd(r, [])).toBe(EXIT.OK);
    const text = r.out.join("\n");
    expect(text).toMatch(/clock\s+Trick clock\s+A trick that counts sessions\./u);
    expect(text).toMatch(/legs\s+Trick legs\s+A trick that counts sessions\./u);
    expect(text).toContain("collie trick add <id>");
    expect(await stat(join(r.configDir, "tricks")).catch(() => null)).toBeNull();
    // A bare name is a folder of that repository.
    expect(await cmdTrickAdd(r, ["clock"])).toBe(EXIT.OK);
    expect(parseOrigin(await readFile(join(trickDir(r, "clock"), ORIGIN_FILE), "utf8"))).toMatchObject({ url: repo.bare, subdir: "clock" });
  });

  test("list shows where an added trick came from", async () => {
    const repo = await fixtureRepo([{ "legs/trick.toml": txt(MANIFEST("legs")), "legs/program.sh": PROGRAM }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [`${repo.bare}//legs`])).toBe(EXIT.OK);
    r.out.length = 0;
    expect(await cmdTrickList(r, [])).toBe(EXIT.OK);
    expect(r.out[1]).toContain(`legs@${(repo.shas[0] ?? "").slice(0, 7)}`);
  });
});

describe.if(posix)("collie trick update", () => {
  test("replaces the code, keeps config.toml and the state folder, and the new code waits for a yes", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, "old.sh": txt("echo old\n"), "config.toml": txt("rows = 1\n") }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    const dir = trickDir(r, "legs");
    await writeFile(join(dir, "config.toml"), "rows = 42\n");
    const state = trickStateDir(r.stateDir, "legs");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "kept.json"), "{}");
    expect(await cmdTrickSwitch(r, ["legs"], true)).toBe(EXIT.OK);
    const approved = parseSwitches(await readFile(switchesPath(r.stateDir), "utf8")).switches.on.get("legs")?.hash;
    // A second commit: the program reaches the network, old.sh goes, new.sh comes.
    const next = await fixtureRepo([
      { "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM, "old.sh": txt("echo old\n"), "config.toml": txt("rows = 1\n") },
      { "trick.toml": txt(MANIFEST("legs")), "program.sh": NETWORK_PROGRAM, "new.sh": txt("echo new\n"), "config.toml": txt("rows = 2\n") },
    ]);
    // Point the record at the repository with the second commit (the same source, moved on).
    const record = parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"));
    await writeFile(join(dir, ORIGIN_FILE), JSON.stringify({ v: 1, ...record, url: next.bare, commit: next.shas[0] }));
    r.out.length = 0;
    expect(await cmdTrickUpdate(r, ["legs", "--dry-run"])).toBe(EXIT.OK);
    expect(r.out.join("\n")).toContain("files: 1 added, 1 changed, 1 removed");
    expect(r.out.join("\n")).toContain("reaches the network");
    expect(r.out.at(-1)).toBe("Nothing was changed (--dry-run).");
    expect(await readFile(join(dir, "old.sh"), "utf8")).toBe("echo old\n");
    r.out.length = 0;
    expect(await cmdTrickUpdate(r, ["legs"])).toBe(EXIT.OK);
    expect(await readFile(join(dir, "config.toml"), "utf8")).toBe("rows = 42\n");
    expect(await readFile(join(dir, "new.sh"), "utf8")).toBe("echo new\n");
    expect(await stat(join(dir, "old.sh")).catch(() => null)).toBeNull();
    expect(await readFile(join(state, "kept.json"), "utf8")).toBe("{}");
    expect(parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"))?.commit).toBe(next.shas[1]);
    const now = await trickCodeHash(dir);
    expect(now.ok && now.hash !== approved).toBe(true);
    expect(r.out.join("\n")).toContain("keeps running the version you approved; the new one waits for your yes");
    await expectNoLeftovers(r);
    // Again: nothing moved.
    r.out.length = 0;
    expect(await cmdTrickUpdate(r, ["legs"])).toBe(EXIT.OK);
    expect(r.out.at(-1)).toContain("Nothing to update.");
  });

  test("refuses a folder that add did not make, and a source that now holds another trick", async () => {
    const r = await rig();
    await mkdir(trickDir(r, "hand"), { recursive: true });
    expect(await cmdTrickUpdate(r, ["hand"])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain("was not added with collie trick add");
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM }]);
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    const other = await fixtureRepo([{ "trick.toml": txt(MANIFEST("clock")), "program.sh": PROGRAM }]);
    const dir = trickDir(r, "legs");
    const record = parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"));
    await writeFile(join(dir, ORIGIN_FILE), JSON.stringify({ v: 1, ...record, url: other.bare }));
    expect(await cmdTrickUpdate(r, ["legs"])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain("holds the trick clock");
    expect(await readFile(join(dir, "trick.toml"), "utf8")).toBe(MANIFEST("legs"));
    await expectNoLeftovers(r);
  });

  test("an origin record that names a local path is refused without the seam", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    const prod: TrickAddDeps = { ...r, seam: undefined };
    expect(await cmdTrickUpdate(prod, ["legs"])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain("is not an https URL");
  });
});

describe.if(posix)("collie trick remove", () => {
  test("refuses while the trick is on, then removes the folder, its state folder and its approved copies", async () => {
    const repo = await fixtureRepo([{ "trick.toml": txt(MANIFEST("legs")), "program.sh": PROGRAM }]);
    const r = await rig();
    expect(await cmdTrickAdd(r, [repo.bare])).toBe(EXIT.OK);
    await mkdir(trickStateDir(r.stateDir, "legs"), { recursive: true });
    expect(await cmdTrickSwitch(r, ["legs"], true)).toBe(EXIT.OK);
    expect(await cmdTrickRemove(r, ["legs"])).toBe(EXIT.FAIL);
    expect(r.err.join("\n")).toContain("collie trick off legs");
    expect(await cmdTrickSwitch(r, ["legs"], false)).toBe(EXIT.OK);
    expect(await cmdTrickRemove(r, ["legs"])).toBe(EXIT.OK);
    expect(await stat(trickDir(r, "legs")).catch(() => null)).toBeNull();
    expect(await stat(trickStateDir(r.stateDir, "legs")).catch(() => null)).toBeNull();
    expect(await stat(approvedTrickDir(r.configDir, "legs")).catch(() => null)).toBeNull();
    expect(await cmdTrickRemove(r, ["legs"])).toBe(EXIT.FAIL);
  });
});
