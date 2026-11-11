import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseJson, type JsonValue } from "../../web/src/lib/json.ts";
import { parseWalkyRequest } from "../walky/parse.ts";
import { isCodePath, trickCodeHash } from "./code-hash.ts";
import { folderBytes, spawnGit, type GitRunner } from "./fetch.ts";
import { OFFICIAL_FETCH_BYTES_MAX, OFFICIAL_GIT, OFFICIAL_LINES, OfficialTricks, type OfficialTricksDeps } from "./official-install.ts";
import { officialStateOf, parseOfficialList, renderOfficialList, shippedOfficialList, OFFICIAL_ENTRIES_MAX, OFFICIAL_REPOS, type OfficialEntry } from "./official.ts";
import { ORIGIN_FILE, parseOrigin, renderOrigin, renderProposalOrigin } from "./origin.ts";
import { APPROVED_DIR, approvedCopyDir, switchesPath, TRICKS_DIR } from "./paths.ts";
import { tricksOfficialRoute } from "./routes.ts";
import { PENDING_SETTLE_MS, TricksService } from "./service.ts";
import { parseSwitches, withSwitch, writeSwitches } from "./switches.ts";

// The From Collie list (official.ts) and the add from it (official-install.ts). Every source is a bare
// repository under the test's temp dir, reached as `file://` through the test seam: nothing here touches
// the network. Each case runs real git a few times, so the limit is longer than the default.

setDefaultTimeout(30_000);
const posix = process.platform !== "win32";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-official-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const REPO = "https://github.com/AltanS/collie-tricks";
const C1 = "1".repeat(40);
const H1 = "a".repeat(64);

function entryFields(over: Partial<Record<keyof OfficialEntry, JsonValue>> = {}) {
  return { id: "legs", name: "Legs", description: "Counts legs.", repo: REPO, dir: "legs", commit: C1, hash: H1, contract: 1, ...over };
}
const entry = (over: Partial<Record<keyof OfficialEntry, JsonValue>> = {}): JsonValue => entryFields(over);
const listOf = (...tricks: JsonValue[]): JsonValue => ({ v: 1, tricks });

// ── the list ─────────────────────────────────────────────────────────────────

describe("the list this release carries", () => {
  test("it parses, lists the three tricks and not release-gates, and names only the official repository", () => {
    const list = shippedOfficialList();
    if (!list.ok) throw new Error(list.reason);
    expect(list.entries.map((e) => e.id)).toEqual(["design-review", "pr-inbox", "running-builds"]);
    expect(list.entries.map((e) => e.name)).toEqual(["Design Review", "PR Inbox", "Running Builds"]);
    expect(list.entries.some((e) => e.id === "release-gates")).toBe(false);
    for (const e of list.entries) {
      expect(OFFICIAL_REPOS).toContain(e.repo);
      expect(e.dir).toBe(e.id);
      expect(e.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.description).not.toContain("—");
    }
  });

  test("the file is written in the maintainer script's own shape", async () => {
    const text = await readFile(join(import.meta.dir, "official.json"), "utf8");
    const list = parseOfficialList(parseJson(text));
    if (!list.ok) throw new Error(list.reason);
    expect(renderOfficialList(list.entries)).toBe(text);
  });
});

describe("the strict reader", () => {
  test("a good list reads, and renders back to the same entries", () => {
    const list = parseOfficialList(listOf(entry(), entry({ id: "pr-inbox", dir: "pr-inbox" })));
    if (!list.ok) throw new Error(list.reason);
    expect(list.entries).toHaveLength(2);
    expect(parseOfficialList(parseJson(renderOfficialList(list.entries)))).toEqual(list);
  });

  const refused: [string, JsonValue][] = [
    ["an http repository", listOf(entry({ repo: "http://github.com/AltanS/collie-tricks" }))],
    ["another owner", listOf(entry({ repo: "https://github.com/someone/collie-tricks" }))],
    ["another host", listOf(entry({ repo: "https://gitlab.com/AltanS/collie-tricks" }))],
    ["a .git spelling not on the allowlist", listOf(entry({ repo: `${REPO}.git` }))],
    ["a user in the URL", listOf(entry({ repo: "https://x@github.com/AltanS/collie-tricks" }))],
    ["a file URL", listOf(entry({ repo: "file:///tmp/repo" }))],
    ["a folder that climbs", listOf(entry({ dir: "../legs" }))],
    ["a folder of two steps", listOf(entry({ dir: "a/legs" }))],
    ["a dot folder", listOf(entry({ dir: ".git" }))],
    ["an empty folder", listOf(entry({ dir: "" }))],
    ["an id with a capital", listOf(entry({ id: "Legs" }))],
    ["a short commit", listOf(entry({ commit: "1".repeat(39) }))],
    ["an upper-case commit", listOf(entry({ commit: "A".repeat(40) }))],
    ["a branch for a commit", listOf(entry({ commit: "main" }))],
    ["a short hash", listOf(entry({ hash: "a".repeat(16) }))],
    ["a name with a control character", listOf(entry({ name: "Le\u0007gs" }))],
    ["a description with a direction mark", listOf(entry({ description: "Counts ‮legs." }))],
    ["a description past the cap", listOf(entry({ description: "x".repeat(141) }))],
    ["an empty name", listOf(entry({ name: "" }))],
    ["a contract this Collie does not speak", listOf(entry({ contract: 3 }))],
    ["a contract that is no whole number", listOf(entry({ contract: 1.5 }))],
    ["an unknown key", listOf({ ...entryFields(), url: REPO })],
    ["a missing key", listOf({ id: "legs", name: "Legs", description: "x", repo: REPO, dir: "legs", commit: C1, contract: 1 })],
    ["one id twice", listOf(entry(), entry())],
    ["another version", { v: 2, tricks: [entry()] }],
    ["an unknown top key", { v: 1, tricks: [], more: true }],
    ["no tricks array", { v: 1 }],
    ["too many entries", listOf(...Array.from({ length: OFFICIAL_ENTRIES_MAX + 1 }, (_, i) => entry({ id: `t${String(i)}`, dir: `t${String(i)}` })))],
  ];
  for (const [what, value] of refused) {
    test(`refuses ${what}`, () => {
      expect(parseOfficialList(value).ok).toBe(false);
    });
  }
});

// ── the fixture repository ───────────────────────────────────────────────────

/** git for the fixture itself, with no config of the person running the tests. */
function fixtureGit(cwd: string, args: string[], home: string): string {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const run = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`fixture git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

type FixtureFile = { text: string; exec?: boolean } | { link: string };

/** A bare repository holding one commit per tree. Answers its file URL and the commits. */
async function fixtureRepo(commits: Record<string, FixtureFile>[]): Promise<{ url: string; shas: string[] }> {
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
  fixtureGit(work, ["push", "-q", bare, "HEAD:refs/heads/main"], home);
  fixtureGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"], home);
  return { url: `file://${bare}`, shas };
}

const MANIFEST = (id: string, extra = ""): string => `id = "${id}"\nname = "Trick ${id}"\nrun = "./program.sh"\nplaces = ["belt"]\n${extra}`;
const PROGRAM = (v: string): FixtureFile => ({ text: `#!/bin/sh\n# ${v}\nprintf '{"v":1,"parts":[]}\\n'\n`, exec: true });

/** The code hash a trick's files have, as the maintainer script takes it: written out and hashed. */
async function hashOf(files: Record<string, FixtureFile>): Promise<string> {
  const dir = await tempDir();
  for (const [rel, file] of Object.entries(files)) {
    if ("link" in file) continue;
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), file.text, { mode: file.exec === true ? 0o755 : 0o644 });
  }
  const hashed = await trickCodeHash(dir);
  if (!hashed.ok) throw new Error(hashed.reason);
  return hashed.hash;
}

interface Rig {
  configDir: string;
  stateDir: string;
  official: OfficialTricks;
  service: TricksService;
  gitArgs: string[][];
  gitEnvs: Record<string, string>[];
  audit: string[];
  /** The entries the rig offers; a test edits them. */
  entries: OfficialEntry[];
  hooks: { beforeFetch?: () => Promise<void> };
}

async function rig(entries: OfficialEntry[], extra: Partial<OfficialTricksDeps> = {}): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const gitArgs: string[][] = [];
  const gitEnvs: Record<string, string>[] = [];
  const audit: string[] = [];
  const hooks: Rig["hooks"] = {};
  const git: GitRunner = async (args, opts) => {
    gitArgs.push([...args]);
    gitEnvs.push(opts.env);
    if (args.includes("fetch")) await hooks.beforeFetch?.();
    return await spawnGit(args, opts);
  };
  const service = new TricksService({
    configDir,
    stateDir,
    memberId: "bluefin",
    world: () => ({ machine: "desk", sessions: [], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    warn: () => {},
  });
  const held = { entries };
  const official = new OfficialTricks({
    configDir,
    stateDir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_DIR: "/nowhere", GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/evil'" },
    entries: () => held.entries,
    lane: (work) => service.officialLane(work),
    audit: (e) => audit.push(`${e.action} ${e.detail.trick ?? ""}`),
    warn: () => {},
    git,
    allowFile: true,
    ...extra,
  });
  return {
    configDir,
    stateDir,
    official,
    service,
    gitArgs,
    gitEnvs,
    audit,
    get entries() {
      return held.entries;
    },
    set entries(next: OfficialEntry[]) {
      held.entries = next;
    },
    hooks,
  };
}

const trickDir = (r: Pick<Rig, "configDir">, id: string): string => join(r.configDir, TRICKS_DIR, id);

/** Nothing left behind: no fetch folder under the state folder, no staged or set-aside folder in the tricks folder. */
async function expectNoLeftovers(r: Rig): Promise<void> {
  const state = await readdir(join(r.stateDir, TRICKS_DIR)).catch(() => []);
  expect(state.filter((n) => n.startsWith(".fetch-"))).toEqual([]);
  const tricks = await readdir(join(r.configDir, TRICKS_DIR)).catch(() => []);
  expect(tricks.filter((n) => n.startsWith(".collie-add-") || n.startsWith(".collie-old-"))).toEqual([]);
}

/** A list entry for the fixture: its file URL, a commit, and the hash the tree's folder has. */
function fixtureEntry(url: string, commit: string, hash: string, id = "legs"): OfficialEntry {
  return { id, name: `Trick ${id}`, description: "Counts legs.", repo: url, dir: id, commit, hash, contract: 1 };
}

const V1 = { "legs/trick.toml": { text: MANIFEST("legs") }, "legs/program.sh": PROGRAM("one"), "legs/config.toml": { text: "rows = 8\n" }, "other/x.txt": { text: "x" } };
const V2 = { "legs/trick.toml": { text: MANIFEST("legs") }, "legs/program.sh": PROGRAM("two"), "legs/config.toml": { text: "rows = 8\n" } };
const V1_LEGS = { "trick.toml": V1["legs/trick.toml"], "program.sh": V1["legs/program.sh"] };
const V2_LEGS = { "trick.toml": V2["legs/trick.toml"], "program.sh": V2["legs/program.sh"] };

// ── states ───────────────────────────────────────────────────────────────────

describe("an entry's state on this machine", () => {
  const e = { id: "legs", repo: REPO, dir: "legs", commit: C1 };
  test("absent, added, update and taken", async () => {
    const configDir = await tempDir();
    const dir = join(configDir, TRICKS_DIR, "legs");
    expect(await officialStateOf(configDir, e)).toBe("absent");
    await mkdir(dir, { recursive: true });
    expect(await officialStateOf(configDir, e)).toBe("taken");
    const origin = { url: REPO, ref: C1, commit: C1, subdir: "legs", at: "2026-11-11T09:00:00.000Z" };
    await writeFile(join(dir, ORIGIN_FILE), renderOrigin(origin));
    expect(await officialStateOf(configDir, e)).toBe("added");
    await writeFile(join(dir, ORIGIN_FILE), renderOrigin({ ...origin, commit: "2".repeat(40) }));
    expect(await officialStateOf(configDir, e)).toBe("update");
    await writeFile(join(dir, ORIGIN_FILE), renderOrigin({ ...origin, url: "https://github.com/someone/else" }));
    expect(await officialStateOf(configDir, e)).toBe("taken");
    await writeFile(join(dir, ORIGIN_FILE), renderOrigin({ ...origin, subdir: "other" }));
    expect(await officialStateOf(configDir, e)).toBe("taken");
    await writeFile(join(dir, ORIGIN_FILE), renderProposalOrigin({ by: "agent", host: "desk", label: null, at: origin.at }));
    expect(await officialStateOf(configDir, e)).toBe("taken");
  });

  test.if(posix)("a link or a file by that name is taken, never followed", async () => {
    const configDir = await tempDir();
    await mkdir(join(configDir, TRICKS_DIR), { recursive: true });
    const elsewhere = await tempDir();
    await writeFile(join(elsewhere, ORIGIN_FILE), renderOrigin({ url: REPO, ref: C1, commit: C1, subdir: "legs", at: "2026-11-11T09:00:00.000Z" }));
    await symlink(elsewhere, join(configDir, TRICKS_DIR, "legs"));
    expect(await officialStateOf(configDir, e)).toBe("taken");
    await rm(join(configDir, TRICKS_DIR, "legs"));
    await writeFile(join(configDir, TRICKS_DIR, "legs"), "x");
    expect(await officialStateOf(configDir, e)).toBe("taken");
  });

  test("the origin record keeps `official`, and a record without it reads as before", () => {
    const base = { url: REPO, ref: null, commit: C1, subdir: "legs", at: "2026-11-11T09:00:00.000Z" };
    expect(renderOrigin(base)).not.toContain("official");
    expect(parseOrigin(renderOrigin(base))).toEqual(base);
    expect(parseOrigin(renderOrigin({ ...base, official: true }))).toEqual({ ...base, official: true });
  });
});

// ── the add ──────────────────────────────────────────────────────────────────

describe.if(posix)("adding from the list", () => {
  test("fetches the listed commit, installs it off with an official origin, and the switch approves exactly the listed hash", async () => {
    const repo = await fixtureRepo([V1]);
    const hash = await hashOf(V1_LEGS);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", hash)]);
    expect((await r.official.reply()).tricks.map((t) => [t.id, t.state])).toEqual([["legs", "absent"]]);
    const answer = await r.official.install("legs", "add");
    expect(answer).toEqual({ status: 200, body: { id: "legs", state: "added" } });
    const dir = trickDir(r, "legs");
    expect((await readdir(dir)).toSorted()).toEqual([ORIGIN_FILE, "config.toml", "program.sh", "trick.toml"]);
    expect(parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"))).toMatchObject({ url: repo.url, ref: repo.shas[0], commit: repo.shas[0], subdir: "legs", official: true });
    // Off, and no approved copy yet: the switch makes it.
    expect(parseSwitches(await readFile(switchesPath(r.stateDir), "utf8").catch(() => null)).switches.on.has("legs")).toBe(false);
    expect(await readdir(join(r.configDir, TRICKS_DIR, APPROVED_DIR)).catch(() => [])).toEqual([]);
    const listed = (await r.service.reply(undefined)).tricks.find((t) => t.id === "legs");
    expect(listed).toMatchObject({ on: false, state: "off", provenance: { via: "repo", sha: repo.shas[0] } });
    expect((await r.official.reply()).tricks.map((t) => t.state)).toEqual(["added"]);
    expect(r.audit).toEqual(["trick.official.add legs"]);
    // The person's switch: the copy it approves hashes to the list's hash.
    const on = await r.service.setSwitch("bluefin", "legs", true);
    expect(on.status).toBe(200);
    const sw = parseSwitches(await readFile(switchesPath(r.stateDir), "utf8")).switches.on.get("legs");
    expect(sw?.hash).toBe(hash);
    expect((await stat(approvedCopyDir(r.configDir, "legs", hash))).isDirectory()).toBe(true);
    await expectNoLeftovers(r);
  });

  test("the git runs carry the hardening, no redirect, no credential helper and no global config", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    await r.official.install("legs", "add");
    for (const args of r.gitArgs) {
      for (const kv of ["core.hooksPath=/dev/null", "protocol.allow=never", "submodule.recurse=false", "filter.lfs.smudge=", ...OFFICIAL_GIT]) expect(args).toContain(kv);
    }
    const fetchArgs = r.gitArgs.find((a) => a.includes("fetch")) ?? [];
    expect(fetchArgs.slice(-3)).toEqual(["--", repo.url, repo.shas[0] ?? ""]);
    expect(fetchArgs).toContain("--depth=1");
    for (const env of r.gitEnvs) {
      expect(env.GIT_CONFIG_GLOBAL).toBe(devNull);
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });

  test("another hash than the list's installs nothing, removes what was fetched, and says so plainly", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", "b".repeat(64))]);
    const answer = await r.official.install("legs", "add");
    expect(answer).toEqual({ status: 422, body: { error: "mismatch", message: OFFICIAL_LINES.mismatch } });
    expect(OFFICIAL_LINES.mismatch).toBe("The code did not match this release. Nothing was added.");
    expect(await stat(trickDir(r, "legs")).catch(() => null)).toBeNull();
    expect(r.audit).toEqual([]);
    await expectNoLeftovers(r);
  });

  test("a commit the repository does not serve, or an unreachable repository, is the plain network line, and nothing stays", async () => {
    const repo = await fixtureRepo([V1]);
    const hash = await hashOf(V1_LEGS);
    const missing = await rig([fixtureEntry(repo.url, "e".repeat(40), hash)]);
    expect(await missing.official.install("legs", "add")).toEqual({ status: 502, body: { error: "unreachable", message: "GitHub did not answer. Nothing was added." } });
    await expectNoLeftovers(missing);
    const gone = await rig([fixtureEntry(`file://${join(await tempDir(), "nothing.git")}`, repo.shas[0] ?? "", hash)]);
    expect((await gone.official.install("legs", "add")).status).toBe(502);
    expect(await stat(trickDir(gone, "legs")).catch(() => null)).toBeNull();
    await expectNoLeftovers(gone);
  });

  test("a symbolic link, a folder that holds another trick, or a manifest Collie refuses is a mismatch", async () => {
    const linked = await fixtureRepo([{ ...V1, "legs/helper.sh": { link: "/etc/passwd" } }]);
    const a = await rig([fixtureEntry(linked.url, linked.shas[0] ?? "", await hashOf(V1_LEGS))]);
    expect((await a.official.install("legs", "add")).status).toBe(422);
    const other = await fixtureRepo([{ "legs/trick.toml": { text: MANIFEST("arms") }, "legs/program.sh": PROGRAM("one") }]);
    const b = await rig([fixtureEntry(other.url, other.shas[0] ?? "", H1)]);
    expect((await b.official.install("legs", "add")).status).toBe(422);
    const broken = await fixtureRepo([{ "legs/trick.toml": { text: MANIFEST("legs", "contract = 9\n") }, "legs/program.sh": PROGRAM("one") }]);
    const c = await rig([fixtureEntry(broken.url, broken.shas[0] ?? "", H1)]);
    expect((await c.official.install("legs", "add")).status).toBe(422);
    for (const r of [a, b, c]) {
      expect(await stat(trickDir(r, "legs")).catch(() => null)).toBeNull();
      await expectNoLeftovers(r);
    }
  });

  test("a second add while one runs answers busy; the first one lands", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS)), fixtureEntry(repo.url, repo.shas[0] ?? "", H1, "other")]);
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const { promise: inFetch, resolve: entered } = Promise.withResolvers<void>();
    r.hooks.beforeFetch = async () => {
      entered();
      await gate;
    };
    const first = r.official.install("legs", "add");
    await inFetch;
    expect(await r.official.install("other", "add")).toEqual({ status: 409, body: { error: "busy", message: OFFICIAL_LINES.busy } });
    expect(await r.official.install("legs", "add")).toMatchObject({ status: 409, body: { error: "busy" } });
    open();
    expect((await first).status).toBe(200);
    await expectNoLeftovers(r);
  });

  test("a folder of that id that appears during the fetch (a concurrent collie trick add) is never written over", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    r.hooks.beforeFetch = async () => {
      await mkdir(trickDir(r, "legs"), { recursive: true });
      await writeFile(join(trickDir(r, "legs"), "mine.txt"), "the person's");
    };
    expect(await r.official.install("legs", "add")).toEqual({ status: 409, body: { error: "taken", message: OFFICIAL_LINES.taken } });
    expect(await readdir(trickDir(r, "legs"))).toEqual(["mine.txt"]);
    await expectNoLeftovers(r);
  });

  test("a trick of that id from another origin is taken: the add refuses before any fetch", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    await mkdir(trickDir(r, "legs"), { recursive: true });
    await writeFile(join(trickDir(r, "legs"), "trick.toml"), MANIFEST("legs"));
    expect((await r.official.reply()).tricks.map((t) => t.state)).toEqual(["taken"]);
    expect(await r.official.install("legs", "add")).toMatchObject({ status: 409, body: { error: "taken" } });
    expect(await r.official.install("legs", "update")).toMatchObject({ status: 409, body: { error: "taken" } });
    expect(r.gitArgs).toEqual([]);
    expect(await readdir(trickDir(r, "legs"))).toEqual(["trick.toml"]);
  });

  test("a switch entry a removed folder left behind is written off: an added trick is off", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    await writeSwitches(r.stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-10T09:00:00Z", "c".repeat(64)));
    expect((await r.official.install("legs", "add")).status).toBe(200);
    expect(parseSwitches(await readFile(switchesPath(r.stateDir), "utf8")).switches.on.has("legs")).toBe(false);
  });

  test("a fetch past the time cap is the network line, and nothing stays", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))], { timeoutMs: 100 });
    r.hooks.beforeFetch = async () => {
      await Bun.sleep(250);
    };
    expect(await r.official.install("legs", "add")).toMatchObject({ status: 502, body: { error: "unreachable" } });
    expect(await stat(trickDir(r, "legs")).catch(() => null)).toBeNull();
    await expectNoLeftovers(r);
  });

  test("a repository that sends more than the byte cap is refused as too large before anything is read, and nothing stays", async () => {
    // Random bytes do not compress: the pack holds about what the file holds.
    const big = await fixtureRepo([{ ...V1, "other/blob.txt": { text: randomBytes(96 * 1024).toString("base64") } }]);
    const r = await rig([fixtureEntry(big.url, big.shas[0] ?? "", await hashOf(V1_LEGS))], { maxBytes: 64 * 1024 });
    const answer = await r.official.install("legs", "add");
    expect(answer).toEqual({ status: 422, body: { error: "too-large", message: OFFICIAL_LINES.mismatch } });
    // Refused after the fetch, before the tree was listed or a file read.
    expect(r.gitArgs.some((a) => a.includes("ls-tree") || a.includes("cat-file"))).toBe(false);
    expect(await stat(trickDir(r, "legs")).catch(() => null)).toBeNull();
    await expectNoLeftovers(r);
    // The same repository under the real cap is fine: the cap is about size, not about content.
    expect(OFFICIAL_FETCH_BYTES_MAX).toBe(20 * 1024 * 1024);
    const roomy = await rig([fixtureEntry(big.url, big.shas[0] ?? "", await hashOf(V1_LEGS))]);
    expect((await roomy.official.install("legs", "add")).status).toBe(200);
  });

  test("folderBytes counts by lstat, never through a link, and stops once past the cap", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a"), "x".repeat(1000));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b"), "y".repeat(500));
    const outside = await tempDir();
    await writeFile(join(outside, "huge"), "z".repeat(100_000));
    await symlink(outside, join(dir, "link"));
    const all = await folderBytes(dir, 1_000_000);
    expect(all).toBeGreaterThanOrEqual(1500);
    expect(all).toBeLessThan(100_000);
    expect(await folderBytes(dir, 10)).toBeGreaterThan(10);
  });

  test("not on the list is 404; a crew member offers nothing and adds nothing", async () => {
    const repo = await fixtureRepo([V1]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", H1)]);
    expect(await r.official.install("arms", "add")).toEqual({ status: 404, body: { error: "unknown-official" } });
    const member = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", H1)], { runsOn: () => ({ lead: "desk" }) });
    expect(await member.official.reply()).toEqual({ tricks: [], runsOn: { lead: "desk" } });
    expect(await member.official.install("legs", "add")).toMatchObject({ status: 409, body: { error: "runs-on" } });
    expect(member.gitArgs).toEqual([]);
  });
});

// ── the update ───────────────────────────────────────────────────────────────

describe.if(posix)("updating an added trick to the list's commit", () => {
  test("off: the folder is replaced, the person's config.toml stays, and the origin moves", async () => {
    const repo = await fixtureRepo([V1, V2]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    expect((await r.official.install("legs", "add")).status).toBe(200);
    await writeFile(join(trickDir(r, "legs"), "config.toml"), "rows = 3\n");
    r.entries = [fixtureEntry(repo.url, repo.shas[1] ?? "", await hashOf(V2_LEGS))];
    expect((await r.official.reply()).tricks.map((t) => t.state)).toEqual(["update"]);
    expect(await r.official.install("legs", "add")).toMatchObject({ status: 409, body: { error: "added" } });
    expect(await r.official.install("legs", "update")).toEqual({ status: 200, body: { id: "legs", state: "added" } });
    expect(await readFile(join(trickDir(r, "legs"), "program.sh"), "utf8")).toContain("# two");
    expect(await readFile(join(trickDir(r, "legs"), "config.toml"), "utf8")).toBe("rows = 3\n");
    expect(parseOrigin(await readFile(join(trickDir(r, "legs"), ORIGIN_FILE), "utf8"))?.commit).toBe(repo.shas[1]);
    expect(await r.official.install("legs", "update")).toMatchObject({ status: 409, body: { error: "no-update" } });
    await expectNoLeftovers(r);
  });

  test("off: only code moves; media/, captures/, inputs/, logs, dot files and config.toml stay untouched, and a code edit is replaced", async () => {
    // The new version brings a picture and a config.toml of its own: neither is taken.
    const V2_MORE = { ...V2, "legs/media/new.png": { text: "theirs-new" }, "legs/lib/util.sh": { text: "# util v2\n" } };
    const V1_MORE = { ...V1, "legs/lib/util.sh": { text: "# util v1\n" }, "legs/old.sh": { text: "# goes\n" } };
    const repo = await fixtureRepo([V1_MORE, V2_MORE]);
    const legsOf = (tree: Record<string, FixtureFile>): Record<string, FixtureFile> =>
      Object.fromEntries(Object.entries(tree).filter(([rel]) => rel.startsWith("legs/")).map(([rel, file]) => [rel.slice(5), file]));
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(legsOf(V1_MORE)))]);
    expect((await r.official.install("legs", "add")).status).toBe(200);
    const dir = trickDir(r, "legs");
    // The person's own: settings, pictures, captures, inputs, a log at the top and one inside a code folder,
    // a dot file, and an edit of a code file.
    await writeFile(join(dir, "config.toml"), "rows = 3\n");
    await mkdir(join(dir, "media"), { recursive: true });
    await writeFile(join(dir, "media", "mine.png"), "mine");
    await mkdir(join(dir, "captures"));
    await writeFile(join(dir, "captures", "shot.png"), "shot");
    await mkdir(join(dir, "inputs"));
    await writeFile(join(dir, "inputs", "TODO.md"), "todo");
    await writeFile(join(dir, "run.log"), "log");
    await writeFile(join(dir, "lib", "debug.log"), "deep log");
    await writeFile(join(dir, ".mine"), "a dot file Collie does not know");
    await writeFile(join(dir, "program.sh"), "#!/bin/sh\n# my edit\n");
    r.entries = [fixtureEntry(repo.url, repo.shas[1] ?? "", await hashOf(legsOf(V2_MORE)))];
    expect(await r.official.install("legs", "update")).toEqual({ status: 200, body: { id: "legs", state: "added" } });
    const read = async (rel: string): Promise<string | null> => await readFile(join(dir, rel), "utf8").catch(() => null);
    expect(await read("config.toml")).toBe("rows = 3\n");
    expect(await read("media/mine.png")).toBe("mine");
    expect(await read("media/new.png")).toBeNull();
    expect(await read("captures/shot.png")).toBe("shot");
    expect(await read("inputs/TODO.md")).toBe("todo");
    expect(await read("run.log")).toBe("log");
    expect(await read("lib/debug.log")).toBe("deep log");
    expect(await read(".mine")).toBe("a dot file Collie does not know");
    // Code: the new version's, the person's edit replaced, a file the new version dropped removed.
    expect(await read("program.sh")).toContain("# two");
    expect(await read("lib/util.sh")).toBe("# util v2\n");
    expect(await read("old.sh")).toBeNull();
    expect(parseOrigin((await read(ORIGIN_FILE)) ?? "")?.commit).toBe(repo.shas[1]);
    // The folder now hashes to the list's hash: the switch would approve exactly it.
    const hashed = await trickCodeHash(dir);
    expect(hashed.ok ? hashed.hash : hashed.reason).toBe(r.entries[0]?.hash ?? "no entry");
    await expectNoLeftovers(r);
  });

  test("isCodePath names exactly what the code hash walks", () => {
    for (const rel of ["program.sh", "trick.toml", "lib/util.ts", "notes.txt", "deep/config.toml"]) expect({ rel, code: isCodePath(rel) }).toEqual({ rel, code: true });
    for (const rel of ["config.toml", "media/a.png", "captures/b.png", "inputs/TODO.md", "run.log", "lib/debug.log", ".mine", "lib/.hidden", "node_modules/x/index.js"]) {
      expect({ rel, code: isCodePath(rel) }).toEqual({ rel, code: false });
    }
  });

  test("off: a name the new code needs where the person's own entry stands refuses, and nothing changes", async () => {
    const V2_DIR = { ...V2, "legs/notes/index.sh": { text: "# a code folder now\n" } };
    const repo = await fixtureRepo([V1, V2_DIR]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    expect((await r.official.install("legs", "add")).status).toBe(200);
    // A log of the person's inside a folder the new version's code moves into.
    await mkdir(join(trickDir(r, "legs"), "notes"));
    await writeFile(join(trickDir(r, "legs"), "notes", "index.sh.log"), "mine");
    const V2_DIR_LEGS = { "trick.toml": V2["legs/trick.toml"], "program.sh": V2["legs/program.sh"], "notes/index.sh": { text: "# a code folder now\n" } };
    r.entries = [fixtureEntry(repo.url, repo.shas[1] ?? "", await hashOf(V2_DIR_LEGS))];
    // The log inside notes/ is the person's; the new code's notes/index.sh beside it is fine.
    expect((await r.official.install("legs", "update")).status).toBe(200);
    expect(await readFile(join(trickDir(r, "legs"), "notes", "index.sh.log"), "utf8")).toBe("mine");
    // Now a file of the person's where the next version needs a folder.
    const repo3 = await fixtureRepo([V1, { ...V2, "legs/run.log/x.sh": { text: "# never\n" } }]);
    const blocked = await rig([fixtureEntry(repo3.url, repo3.shas[0] ?? "", await hashOf(V1_LEGS))]);
    expect((await blocked.official.install("legs", "add")).status).toBe(200);
    await writeFile(join(trickDir(blocked, "legs"), "run.log"), "mine");
    const V3_LEGS = { "trick.toml": V2["legs/trick.toml"], "program.sh": V2["legs/program.sh"], "run.log/x.sh": { text: "# never\n" } };
    blocked.entries = [fixtureEntry(repo3.url, repo3.shas[1] ?? "", await hashOf(V3_LEGS))];
    const answer = await blocked.official.install("legs", "update");
    expect(answer).toMatchObject({ status: 500, body: { error: "failed" } });
    expect(await readFile(join(trickDir(blocked, "legs"), "run.log"), "utf8")).toBe("mine");
    expect(await readFile(join(trickDir(blocked, "legs"), "program.sh"), "utf8")).toContain("# one");
  });

  test("on: the approved copy keeps running and the new version waits for the yes through the runner's own path; a downgrade too", async () => {
    const repo = await fixtureRepo([V1, V2]);
    const h1 = await hashOf(V1_LEGS);
    const h2 = await hashOf(V2_LEGS);
    const clock = { t: Date.parse("2026-11-11T09:00:00Z") };
    const root = await tempDir();
    const configDir = join(root, "config");
    const stateDir = join(root, "state");
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const service = new TricksService({ configDir, stateDir, memberId: "bluefin", world: () => ({ machine: "desk", sessions: [], spaces: [] }), env: { PATH: process.env.PATH ?? "" }, warn: () => {}, now: () => clock.t });
    const held = { entries: [fixtureEntry(repo.url, repo.shas[0] ?? "", h1)] };
    const official = new OfficialTricks({ configDir, stateDir, env: { PATH: process.env.PATH ?? "" }, entries: () => held.entries, lane: (w) => service.officialLane(w), allowFile: true, now: () => clock.t });
    expect((await official.install("legs", "add")).status).toBe(200);
    expect((await service.setSwitch("bluefin", "legs", true)).status).toBe(200);
    held.entries = [fixtureEntry(repo.url, repo.shas[1] ?? "", h2)];
    expect((await official.install("legs", "update")).status).toBe(200);
    // The folder settles, then the runner takes its snapshot: the row carries the waiting version.
    for (const step of [1, PENDING_SETTLE_MS + 1]) {
      clock.t += step;
      await service.refresh(true);
    }
    const row = (await service.reply(undefined)).tricks.find((t) => t.id === "legs");
    expect(row).toMatchObject({ on: true, changed: true, pending: { hash: h2 } });
    // Still the approved version: nothing was approved by the update.
    expect(parseSwitches(await readFile(switchesPath(stateDir), "utf8")).switches.on.get("legs")?.hash).toBe(h1);
    // A list with the older commit again is an update like any other difference.
    held.entries = [fixtureEntry(repo.url, repo.shas[0] ?? "", h1)];
    expect((await official.reply()).tricks.map((t) => t.state)).toEqual(["update"]);
    expect((await official.install("legs", "update")).status).toBe(200);
    expect(await readFile(join(configDir, TRICKS_DIR, "legs", "program.sh"), "utf8")).toContain("# one");
  });

  test("an update whose hash does not match changes nothing", async () => {
    const repo = await fixtureRepo([V1, V2]);
    const r = await rig([fixtureEntry(repo.url, repo.shas[0] ?? "", await hashOf(V1_LEGS))]);
    expect((await r.official.install("legs", "add")).status).toBe(200);
    r.entries = [fixtureEntry(repo.url, repo.shas[1] ?? "", H1)];
    expect(await r.official.install("legs", "update")).toEqual({ status: 422, body: { error: "mismatch", message: OFFICIAL_LINES.updateMismatch } });
    expect(await readFile(join(trickDir(r, "legs"), "program.sh"), "utf8")).toContain("# one");
    expect(parseOrigin(await readFile(join(trickDir(r, "legs"), ORIGIN_FILE), "utf8"))?.commit).toBe(repo.shas[0]);
    await expectNoLeftovers(r);
  });
});

// ── the route and who reaches it ─────────────────────────────────────────────

describe("the add route", () => {
  test("takes exactly {} and the verb add or update; the source, the commit and the hash come from the list only", async () => {
    const calls: string[] = [];
    const surface = {
      reply: async () => ({ tricks: [] }),
      install: async (id: string, mode: "add" | "update") => {
        calls.push(`${mode} ${id}`);
        return { status: 200 as const, body: { id, state: "added" as const } };
      },
    };
    const route = /^\/api\/tricks\/official\/([^/]+)\/(add|update)$/;
    const add = route.exec("/api/tricks/official/le%67s/add");
    const update = route.exec("/api/tricks/official/legs/update");
    if (add === null || update === null) throw new Error("no match");
    expect((await tricksOfficialRoute(surface, add, {})).status).toBe(200);
    expect((await tricksOfficialRoute(surface, update, {})).status).toBe(200);
    for (const body of [undefined, null, [], { repo: "https://evil.example/x" }, { commit: C1 }, { hash: H1 }]) {
      expect(await tricksOfficialRoute(surface, add, body)).toEqual({ status: 400, body: { error: "official-invalid" } });
    }
    expect(calls).toEqual(["add legs", "update legs"]);
    expect(route.exec("/api/tricks/official/legs/remove")).toBeNull();
  });

  test("an agent's walky socket has no op that adds from the list", () => {
    for (const op of ["trick.official.add", "trick.add", "tricks.official", "trick.official"]) {
      expect(parseWalkyRequest(JSON.stringify({ v: 1, op, id: "legs" }))).toBeNull();
    }
  });
});

// ── the git run's process group ──────────────────────────────────────────────

describe.if(posix)("a git run killed at its time cap", () => {
  test("takes its whole process group: a helper git started dies with it", async () => {
    // A stand-in `git` that starts a helper in the background (as `git fetch` starts `git-remote-https`),
    // writes the helper's pid, and waits. The run is killed at 300 ms; the helper must be gone too.
    const bin = await tempDir();
    const pidFile = join(bin, "helper.pid");
    await writeFile(join(bin, "git"), `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`);
    await chmod(join(bin, "git"), 0o755);
    const run = await spawnGit(["fetch"], { cwd: bin, env: { PATH: `${bin}:/usr/bin:/bin` }, timeoutMs: 300 });
    expect(run.timedOut).toBe(true);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    // Give the kernel a moment to reap; then the helper's pid answers no signal.
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      await Bun.sleep(50);
      alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
    }
    expect(alive).toBe(false);
  });

  test("an aborted signal kills the run and its group at once", async () => {
    const bin = await tempDir();
    await writeFile(join(bin, "git"), "#!/bin/sh\nsleep 30\n");
    await chmod(join(bin, "git"), 0o755);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const run = await spawnGit(["fetch"], { cwd: bin, env: { PATH: `${bin}:/usr/bin:/bin` }, timeoutMs: 20_000, signal: controller.signal });
    expect(run.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
