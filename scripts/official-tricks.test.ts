import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { officialExtrasHash, trickCodeHash } from "../bridge/tricks/code-hash.ts";
import { parseOfficialList, renderOfficialList, type OfficialEntry } from "../bridge/tricks/official.ts";
import { parseJson } from "../web/src/lib/json.ts";
import { LIST_FILE, parseArgs, rolled, runOfficial } from "./official-tricks.ts";

// The maintainer script that keeps the official list in step with the tricks repository. The
// repository is a temp git repository; the script reads it through `file://`. No network.

setDefaultTimeout(30_000);
const posix = process.platform !== "win32";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-official-script-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, args: string[], home: string): string {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const run = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

const MANIFEST = (name: string): string => `id = "legs"\nname = "${name}"\nrun = "./program.sh"\nplaces = ["belt"]\n`;
const PROGRAM = (v: string): string => `#!/bin/sh\n# ${v}\nprintf '{"v":1,"parts":[]}\\n'\n`;

interface Repo {
  dir: string;
  /** Commit the files; `origin/main` follows, as after a push and a fetch. */
  commit(files: Record<string, string>): Promise<string>;
  /** Point `origin/main` at `sha`. */
  pinMain(sha: string): void;
}

async function repo(): Promise<Repo> {
  const root = await tempDir();
  const home = join(root, "home");
  const dir = join(root, "tricks");
  await mkdir(home);
  await mkdir(dir);
  git(dir, ["init", "-q"], home);
  return {
    dir,
    async commit(files) {
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), text, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
      }
      git(dir, ["add", "-A"], home);
      git(dir, ["commit", "-q", "-m", "c"], home);
      const sha = git(dir, ["rev-parse", "HEAD"], home);
      git(dir, ["update-ref", "refs/remotes/origin/main", sha], home);
      return sha;
    },
    pinMain(sha) {
      git(dir, ["update-ref", "refs/remotes/origin/main", sha], home);
    },
  };
}

/** The hash the folder's two files have, taken by the real hash function. */
async function hashOf(manifest: string, program: string): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "trick.toml"), manifest);
  await writeFile(join(dir, "program.sh"), program, { mode: 0o755 });
  const hashed = await trickCodeHash(dir);
  if (!hashed.ok) throw new Error(hashed.reason);
  return hashed.hash;
}

/** The extras hash of a folder with no config.toml and no media/. */
function emptyExtras(): string {
  const none = officialExtrasHash([]);
  if (!none.ok) throw new Error("no extras");
  return none.hash;
}

const START: OfficialEntry = {
  id: "legs",
  name: "Legs",
  description: "Counts legs.",
  repo: "https://github.com/AltanS/collie-tricks",
  dir: "legs",
  commit: "0".repeat(40),
  hash: "0".repeat(64),
  extras: "0".repeat(64),
  rules: null,
  contract: 1,
  previous: [],
};

async function listFile(entries: OfficialEntry[]): Promise<string> {
  const file = join(await tempDir(), "official.json");
  await writeFile(file, renderOfficialList(entries));
  return file;
}

async function entriesOf(file: string): Promise<OfficialEntry[]> {
  const list = parseOfficialList(parseJson(await readFile(file, "utf8")));
  if (!list.ok) throw new Error(list.reason);
  return list.entries;
}

describe.if(posix)("scripts/official-tricks.ts", () => {
  test("writes the commit, the real code hash and the manifest's name; then --check passes", async () => {
    const r = await repo();
    const sha = await r.commit({ "legs/trick.toml": MANIFEST("Legs Counter"), "legs/program.sh": PROGRAM("one"), "other/readme.txt": "x" });
    const file = await listFile([START]);
    const run = await runOfficial({ repoDir: r.dir, commit: sha, check: false, file });
    expect(run.code).toBe(0);
    expect(run.lines.at(-1)).toBe(`wrote ${file}`);
    const [entry] = await entriesOf(file);
    expect(entry).toEqual({ ...START, name: "Legs Counter", commit: sha, hash: await hashOf(MANIFEST("Legs Counter"), PROGRAM("one")), extras: emptyExtras(), previous: [{ commit: START.commit, hash: START.hash }] });
    // The description is the list's own line: the manifest has none.
    expect(entry?.description).toBe("Counts legs.");
    expect(await runOfficial({ repoDir: r.dir, commit: sha, check: true, file })).toEqual({ code: 0, lines: [`ok: ${file} is in step with ${sha.slice(0, 12)}`] });
  });

  test("--check fails on a list one commit behind, names each difference, and writes nothing", async () => {
    const r = await repo();
    const first = await r.commit({ "legs/trick.toml": MANIFEST("Legs"), "legs/program.sh": PROGRAM("one") });
    const file = await listFile([START]);
    expect((await runOfficial({ repoDir: r.dir, commit: first, check: false, file })).code).toBe(0);
    const before = await readFile(file, "utf8");
    const second = await r.commit({ "legs/program.sh": PROGRAM("two") });
    const run = await runOfficial({ repoDir: r.dir, commit: second, check: true, file });
    expect(run.code).toBe(1);
    expect(run.lines.some((l) => l.startsWith("legs: commit is"))).toBe(true);
    expect(run.lines.some((l) => l.startsWith("legs: hash is"))).toBe(true);
    expect(run.lines.at(-1)).toContain("stale:");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("a move to another commit keeps the old one in previous, newest first, capped, and never the current one", async () => {
    const r = await repo();
    const first = await r.commit({ "legs/trick.toml": MANIFEST("Legs"), "legs/program.sh": PROGRAM("one") });
    const file = await listFile([START]);
    expect((await runOfficial({ repoDir: r.dir, commit: first, check: false, file })).code).toBe(0);
    const h1 = (await entriesOf(file))[0]?.hash ?? "";
    const second = await r.commit({ "legs/program.sh": PROGRAM("two") });
    expect((await runOfficial({ repoDir: r.dir, commit: second, check: false, file })).code).toBe(0);
    expect((await entriesOf(file))[0]?.previous).toEqual([
      { commit: first, hash: h1 },
      { commit: START.commit, hash: START.hash },
    ]);
    // The same commit again changes nothing; a step back to the first drops it from previous.
    expect((await runOfficial({ repoDir: r.dir, commit: second, check: true, file })).code).toBe(0);
    expect((await runOfficial({ repoDir: r.dir, commit: first, check: false, file })).code).toBe(0);
    expect((await entriesOf(file))[0]?.previous.map((v) => v.commit)).toEqual([second, START.commit]);
    const many = Array.from({ length: 12 }, (_, i) => ({ commit: String(i + 1).padStart(40, "a"), hash: "c".repeat(64) }));
    expect(rolled({ commit: first, hash: h1, previous: many.slice(0, 8) }, second)).toHaveLength(8);
    expect(rolled({ commit: first, hash: h1, previous: many.slice(0, 8) }, second)[0]).toEqual({ commit: first, hash: h1 });
  });

  test("a commit that is not on origin/main is refused before any fetch, and the list stays as it was", async () => {
    const r = await repo();
    const first = await r.commit({ "legs/trick.toml": MANIFEST("Legs"), "legs/program.sh": PROGRAM("one") });
    const side = await r.commit({ "legs/program.sh": PROGRAM("a pull request") });
    r.pinMain(first);
    const file = await listFile([START]);
    const before = await readFile(file, "utf8");
    for (const check of [false, true]) {
      const run = await runOfficial({ repoDir: r.dir, commit: side, check, file });
      expect(run.code).toBe(1);
      expect(run.lines[0]).toBe(`error: ${side.slice(0, 12)} is not on origin/main of ${r.dir}: list only a commit of main (git -C ${r.dir} fetch origin first)`);
    }
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await runOfficial({ repoDir: r.dir, commit: first, check: false, file })).code).toBe(0);
  });

  test("the extras hash pins config.toml and media/; a log or a captures/ file in the folder stops the script", async () => {
    const r = await repo();
    const sha = await r.commit({ "legs/trick.toml": MANIFEST("Legs"), "legs/program.sh": PROGRAM("one"), "legs/config.toml": "rows = 8\n", "legs/media/icon.png": "png" });
    const file = await listFile([START]);
    expect((await runOfficial({ repoDir: r.dir, commit: sha, check: false, file })).code).toBe(0);
    const extras = officialExtrasHash([
      { rel: "config.toml", bytes: new TextEncoder().encode("rows = 8\n") },
      { rel: "media/icon.png", bytes: new TextEncoder().encode("png") },
    ]);
    expect(extras.ok && (await entriesOf(file))[0]?.extras === extras.hash).toBe(true);
    for (const stray of ["legs/run.log", "legs/captures/shot.png", "legs/inputs/a.md"]) {
      const bad = await repo();
      const at = await bad.commit({ "legs/trick.toml": MANIFEST("Legs"), "legs/program.sh": PROGRAM("one"), [stray]: "x" });
      const run = await runOfficial({ repoDir: bad.dir, commit: at, check: false, file: await listFile([START]) });
      expect(run.code).toBe(1);
      expect(run.lines[0]).toContain("is neither code, config.toml nor under media/");
    }
  });

  test("an uncommitted edit never reaches a hash: the script reads git, not the working tree", async () => {
    const r = await repo();
    const sha = await r.commit({ "legs/trick.toml": MANIFEST("Legs"), "legs/program.sh": PROGRAM("one") });
    await writeFile(join(r.dir, "legs", "program.sh"), PROGRAM("edited"));
    const file = await listFile([START]);
    expect((await runOfficial({ repoDir: r.dir, commit: sha, check: false, file })).code).toBe(0);
    expect((await entriesOf(file))[0]?.hash).toBe(await hashOf(MANIFEST("Legs"), PROGRAM("one")));
  });

  test("a folder the add would refuse stops the script, and the list stays as it was", async () => {
    const r = await repo();
    const sha = await r.commit({ "legs/trick.toml": 'id = "arms"\nname = "Arms"\nrun = "./program.sh"\nplaces = ["belt"]\n', "legs/program.sh": PROGRAM("one") });
    const file = await listFile([START]);
    const before = await readFile(file, "utf8");
    const run = await runOfficial({ repoDir: r.dir, commit: sha, check: false, file });
    expect(run.code).toBe(1);
    expect(run.lines[0]).toStartWith("error: legs:");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("a commit that is not 40 hex, or a list the reader refuses, is an error before any fetch", async () => {
    const file = await listFile([START]);
    expect((await runOfficial({ repoDir: "/nowhere", commit: "main", check: true, file })).code).toBe(2);
    const bad = join(await tempDir(), "bad.json");
    await writeFile(bad, JSON.stringify({ v: 1, tricks: [{ ...START, repo: "https://example.com/x/y" }] }));
    const run = await runOfficial({ repoDir: "/nowhere", commit: "1".repeat(40), check: true, file: bad });
    expect(run.code).toBe(1);
    expect(run.lines[0]).toStartWith("error: the list is refused:");
  });
});

describe("the flags", () => {
  test("--repo-dir and --commit are required; --file defaults to the list in the repository", () => {
    expect(parseArgs(["--repo-dir", "/r", "--commit", "a".repeat(40)])).toEqual({ ok: true, opts: { repoDir: "/r", commit: "a".repeat(40), check: false, file: LIST_FILE } });
    expect(parseArgs(["--repo-dir", "/r", "--commit", "a".repeat(40), "--check", "--file", "/f.json"])).toEqual({ ok: true, opts: { repoDir: "/r", commit: "a".repeat(40), check: true, file: "/f.json" } });
    expect(parseArgs(["--commit", "a".repeat(40)]).ok).toBe(false);
    expect(parseArgs(["--repo-dir", "--commit", "a".repeat(40)]).ok).toBe(false);
  });

  test("the shipped list is the file the script writes by default", async () => {
    expect(LIST_FILE).toEndWith(join("bridge", "tricks", "official.json"));
    expect(parseOfficialList(parseJson(await readFile(LIST_FILE, "utf8"))).ok).toBe(true);
  });
});

describe.if(posix)("scripts/official-tricks.ts pins the rules (review 8 V-N3)", () => {
  test("writes the sha256 of the trick's rules file, null for a trick without, and --check names a stale one", async () => {
    const r = await repo();
    const rules = "Draw one screen.\n";
    const manifest = 'id = "legs"\nname = "Legs"\ncontract = 2\nplaces = ["agent-view"]\nrules = "rules.md"\n';
    const sha = await r.commit({ "legs/trick.toml": manifest, "legs/rules.md": rules });
    const file = await listFile([START]);
    expect((await runOfficial({ repoDir: r.dir, commit: sha, check: false, file })).code).toBe(0);
    const [entry] = await entriesOf(file);
    expect(entry?.rules).toBe(new Bun.CryptoHasher("sha256").update(rules).digest("hex"));
    expect(entry?.contract).toBe(2);
    const stale = await listFile([{ ...START, commit: sha, contract: 2, rules: "c".repeat(64) }]);
    const run = await runOfficial({ repoDir: r.dir, commit: sha, check: true, file: stale });
    expect(run.code).toBe(1);
    expect(run.lines.some((line) => line.startsWith("legs: rules is "))).toBe(true);
  });
});
