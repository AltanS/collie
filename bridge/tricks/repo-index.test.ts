import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TRICKS_OFF_LINE } from "../../web/src/lib/tricks/schema.ts";
import { readPhoneSource, REPO_INDEX_TERMINAL_LINE } from "../../web/src/lib/tricks/repo-index.ts";
import { trickCodeHash } from "./code-hash.ts";
import { FetchSlot, spawnGit, type GitRunner, type GitRunOptions } from "./fetch.ts";
import { ORIGIN_FILE, parseOrigin } from "./origin.ts";
import { switchesPath, trickStateDir, tricksConfigDir, tricksStateDir } from "./paths.ts";
import { gitLinkOf, REPO_FETCH_PREFIX, RepoIndexTricks, type RepoIndexDeps } from "./repo-index.ts";
import { parseSwitches, updateSwitches, withSwitch } from "./switches.ts";

// A repository's index on the phone (package J), against local bare repositories. Nothing here reaches the
// network: the git seam maps the pasted https link to a fixture folder, so the host rule sees the real link and
// git fetches a local one. The fixtures need POSIX (exec bits, real git).

setDefaultTimeout(30_000);
const posix = process.platform !== "win32";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-repo-index-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function fixtureGit(cwd: string, args: string[], home: string): string {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const run = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`fixture git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/** A bare repository of one commit holding `tree`. */
async function fixtureRepo(tree: Record<string, string | Uint8Array>): Promise<{ bare: string; sha: string }> {
  const root = await tempDir();
  const home = join(root, "home");
  await mkdir(home);
  const work = join(root, "work");
  const bare = join(root, "repo.git");
  fixtureGit(root, ["init", "-q", "--bare", bare], home);
  fixtureGit(root, ["init", "-q", work], home);
  for (const [rel, text] of Object.entries(tree)) {
    const path = join(work, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
  fixtureGit(work, ["add", "-A"], home);
  fixtureGit(work, ["commit", "-q", "-m", "one"], home);
  const sha = fixtureGit(work, ["rev-parse", "HEAD"], home);
  fixtureGit(work, ["push", "-q", bare, "HEAD:refs/heads/main"], home);
  fixtureGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"], home);
  return { bare, sha };
}

const LINK = "https://github.com/owner/repo";
const MANIFEST = (id: string): string => `# A trick.\nid = "${id}"\nname = "Trick ${id}"\nrun = "./program.sh"\nplaces = ["belt"]\n`;
const PROGRAM = "#!/bin/sh\nprintf '{\"v\":1,\"parts\":[]}\\n'\n";
const INDEX = JSON.stringify({
  contract: 1,
  tricks: [
    { folder: "idle-watch", name: "Idle Watch", about: "Marks a session that waits for you." },
    { folder: "lodge-board", name: "Lodge Board", about: "Shows the workshop's open jobs." },
  ],
});
const REPO = { "collie-tricks.json": INDEX, "idle-watch/trick.toml": MANIFEST("idle-watch"), "idle-watch/program.sh": PROGRAM, "lodge-board/trick.toml": MANIFEST("lodge-board"), "lodge-board/program.sh": PROGRAM };

interface Call {
  args: string[];
  env: Record<string, string>;
}

interface Rig {
  deps: RepoIndexDeps;
  repo: RepoIndexTricks;
  calls: Call[];
  audits: { action: string; detail: Record<string, string> }[];
  configDir: string;
  stateDir: string;
}

/** The seam: every git run is recorded, and the pasted link is fetched from `bare`. `hold` stalls each fetch until it settles. */
function seamGit(bare: string, calls: Call[], hold?: Promise<void>): GitRunner {
  return async (args: readonly string[], opts: GitRunOptions) => {
    calls.push({ args: [...args], env: opts.env });
    if (hold !== undefined && args.includes("fetch")) await hold;
    return await spawnGit(
      args.map((a) => (a === LINK || a === `${LINK}.git` ? bare : a)),
      opts,
    );
  };
}

async function rig(bare: string, more: Partial<RepoIndexDeps> = {}, hold?: Promise<void>): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const calls: Call[] = [];
  const audits: Rig["audits"] = [];
  const deps: RepoIndexDeps = {
    configDir,
    stateDir,
    // A GIT_* variable of the unit never reaches git; a token-shaped value must never reach the audit.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), GIT_DIR: "/home/dev/elsewhere", GIT_ASKPASS: "/home/dev/askpass" },
    git: seamGit(bare, calls, hold),
    allowFile: true,
    audit: (entry) => audits.push(entry),
    now: () => Date.parse("2026-11-17T09:00:00.000Z"),
    ...more,
  };
  return { deps, repo: new RepoIndexTricks(deps), calls, audits, configDir, stateDir };
}

const rid = (): string => crypto.randomUUID();

describe("the phone's link", () => {
  test("credentials, an IP address, localhost, a port, upper case and another host fetch nothing", async () => {
    const r = await rig("/nowhere");
    const cases: [string, string][] = [
      ["https://user:secret@github.com/owner/repo", "invalid"],
      ["https://ghp_tokenvalue@github.com/owner/repo", "invalid"],
      ["http://github.com/owner/repo", "invalid"],
      ["https://github.com/owner/repo?x=1", "invalid"],
      ["https://github.com/owner", "invalid"],
      ["https://github.com/owner/../repo", "invalid"],
      ["https://127.0.0.1/owner/repo", "host"],
      ["https://[::1]/owner/repo", "host"],
      ["https://localhost/owner/repo", "host"],
      ["https://github.com:443/owner/repo", "host"],
      ["https://GitHub.com/owner/repo", "host"],
      ["https://github.com./owner/repo", "host"],
      ["https://git.example.test/owner/repo", "host"],
    ];
    for (const [url, error] of cases) {
      const answer = await r.repo.list({ rid: rid(), url });
      const got: string | null = "error" in answer.body ? answer.body.error : null;
      expect({ url, status: answer.status, error: got }).toEqual({ url, status: 409, error });
      if (error === "host" && "message" in answer.body) expect(answer.body.message).toBe(REPO_INDEX_TERMINAL_LINE);
    }
    expect(r.calls).toHaveLength(0);
    expect(r.audits).toHaveLength(0);
  });

  test("a body of another shape or a request id that is not one is repo-invalid", async () => {
    const r = await rig("/nowhere");
    for (const body of [undefined, {}, { rid: "x", url: LINK }, { rid: rid(), url: LINK, more: 1 }, { rid: rid(), url: 5 }]) {
      expect(await r.repo.list(body)).toEqual({ status: 400, body: { error: "repo-invalid" } });
    }
    for (const body of [{ rid: rid(), url: LINK, folder: "../x", commit: "a".repeat(40) }, { rid: rid(), url: LINK, folder: "a/b", commit: "a".repeat(40) }, { rid: rid(), url: LINK, folder: ".hidden", commit: "a".repeat(40) }, { rid: rid(), url: LINK, folder: "idle-watch", commit: "HEAD" }]) {
      expect(await r.repo.add(body)).toEqual({ status: 400, body: { error: "repo-invalid" } });
    }
    expect(r.calls).toHaveLength(0);
  });

  test("tricks switched off as a whole: both routes answer the switch's sentence and fetch nothing", async () => {
    const r = await rig("/nowhere", { offLine: () => TRICKS_OFF_LINE });
    expect(await r.repo.list({ rid: rid(), url: LINK })).toEqual({ status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } });
    expect(await r.repo.add({ rid: rid(), url: LINK, folder: "idle-watch", commit: "a".repeat(40) })).toEqual({ status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } });
    expect(r.calls).toHaveLength(0);
  });
});

describe.if(posix)("reading an index", () => {
  test("lists the index at the commit read, with what is here, and audits the host and the path only", async () => {
    const fx = await fixtureRepo(REPO);
    const r = await rig(fx.bare);
    await mkdir(join(tricksConfigDir(r.configDir), "lodge-board"), { recursive: true });
    const id = rid();
    const answer = await r.repo.list({ rid: id, url: LINK });
    expect(answer).toEqual({
      status: 200,
      body: {
        rid: id,
        code: "ok",
        url: LINK,
        host: "github.com",
        repo: "owner/repo",
        commit: fx.sha,
        tricks: [
          { folder: "idle-watch", name: "Idle Watch", about: "Marks a session that waits for you.", here: false },
          { folder: "lodge-board", name: "Lodge Board", about: "Shows the workshop's open jobs.", here: true },
        ],
      },
    });
    expect(r.audits).toEqual([{ action: "trick.repo.list", detail: { host: "github.com", repo: "owner/repo", commit: fx.sha.slice(0, 12), result: "ok", tricks: "2" } }]);
    const audit = JSON.stringify(r.audits);
    expect(audit).not.toContain("https://");
    expect(audit).not.toContain("askpass");
    // The temp folder went.
    expect((await readdir(tricksStateDir(r.stateDir))).filter((n) => n.startsWith(REPO_FETCH_PREFIX))).toEqual([]);
  });

  test("every git run follows no redirect, reads no operator git config and no credential helper, https only", async () => {
    const fx = await fixtureRepo(REPO);
    const r = await rig(fx.bare);
    expect((await r.repo.list({ rid: rid(), url: LINK })).status).toBe(200);
    expect(r.calls.length).toBeGreaterThan(0);
    for (const call of r.calls) {
      const flat = call.args.join(" ");
      expect(flat).toContain("-c http.followRedirects=false");
      expect(flat).toContain("-c credential.helper=");
      expect(flat).toContain("-c protocol.https.allow=always");
      expect(flat).toContain("-c core.hooksPath=/dev/null");
      expect(call.env.GIT_CONFIG_GLOBAL).toBe(devNull);
      expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(call.env.GIT_DIR).toBeUndefined();
      expect(call.env.GIT_ASKPASS).toBeUndefined();
    }
    // The bridge never sets `allowFile`: then `file` is refused by config and by GIT_ALLOW_PROTOCOL.
    const prod = await rig(fx.bare, { allowFile: false });
    const refused = await prod.repo.list({ rid: rid(), url: LINK });
    expect(refused.status).toBe(502);
    for (const call of prod.calls) {
      expect(call.args.join(" ")).toContain("-c protocol.file.allow=never");
      expect(call.env.GIT_ALLOW_PROTOCOL).toBe("https");
    }
  });

  test("a redirect to another host is refused: git is told not to follow one, and a failed fetch is unreachable", async () => {
    const r = await rig("/nowhere");
    // The seam answers the fetch as git does when the server redirects and redirects are off.
    r.deps.git = async (args, opts) => {
      r.calls.push({ args: [...args], env: opts.env });
      if (args.includes("fetch")) return { code: 128, stdout: new Uint8Array(0), stderr: "fatal: unable to access: The requested URL returned error: 301", timedOut: false, capped: false };
      return await spawnGit(args, opts);
    };
    const repo = new RepoIndexTricks(r.deps);
    const answer = await repo.list({ rid: rid(), url: LINK });
    expect(answer.status).toBe(502);
    expect("error" in answer.body && answer.body.error).toBe("unreachable");
    const fetch = r.calls.find((c) => c.args.includes("fetch"));
    expect(fetch?.args.join(" ")).toContain("http.followRedirects=false");
    expect(r.audits.at(-1)).toEqual({ action: "trick.repo.list", detail: { host: "github.com", repo: "owner/repo", result: "unreachable" } });
  });

  test("a repository with no index says so and names the folder form; a higher contract is refused with one sentence", async () => {
    const bare = await fixtureRepo({ "idle-watch/trick.toml": MANIFEST("idle-watch") });
    const none = await (await rig(bare.bare)).repo.list({ rid: rid(), url: LINK });
    expect(none.status).toBe(422);
    expect("error" in none.body && none.body.error).toBe("no-index");
    expect("message" in none.body && none.body.message).toContain("collie trick add <url>//<folder>");
    const later = await fixtureRepo({ "collie-tricks.json": JSON.stringify({ contract: 2, tricks: [] }) });
    const answer = await (await rig(later.bare)).repo.list({ rid: rid(), url: LINK });
    expect(answer.status).toBe(422);
    expect("message" in answer.body && answer.body.message).toBe("collie-tricks.json is written for contract 2, and this Collie reads contract 1; update Collie to read it.");
  });

  test("a repository larger than the cap is refused before anything is read", async () => {
    const big = new Uint8Array(256 * 1024);
    crypto.getRandomValues(big.subarray(0, 65536));
    crypto.getRandomValues(big.subarray(65536, 131072));
    crypto.getRandomValues(big.subarray(131072, 196608));
    crypto.getRandomValues(big.subarray(196608));
    const fx = await fixtureRepo({ ...REPO, "noise.bin": big });
    const r = await rig(fx.bare, { maxBytes: 64 * 1024 });
    const answer = await r.repo.list({ rid: rid(), url: LINK });
    expect(answer.status).toBe(422);
    expect("error" in answer.body && answer.body.error).toBe("too-large");
    expect(r.calls.some((c) => c.args.includes("cat-file"))).toBe(false);
  });

  test("one fetch at a time per bridge: a second tap while one runs is busy, the official add's slot included", async () => {
    const fx = await fixtureRepo(REPO);
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = new FetchSlot();
    const r = await rig(fx.bare, { slot }, hold);
    const first = r.repo.list({ rid: rid(), url: LINK });
    // Bounded wait for the first fetch to start (the seam stalls it at `fetch`).
    for (let i = 0; i < 200 && !r.calls.some((c) => c.args.includes("fetch")); i += 1) await Bun.sleep(10);
    const second = await r.repo.list({ rid: rid(), url: LINK });
    expect(second.status).toBe(409);
    expect("error" in second.body && second.body.error).toBe("busy");
    expect(slot.busy).toBe(true);
    expect(slot.take()).toBe(false);
    release();
    expect((await first).status).toBe(200);
    expect(slot.busy).toBe(false);
  });
});

describe.if(posix)("adding from an index", () => {
  test("lands off with its own hash and an origin record that is never official; a switch left on goes off", async () => {
    const fx = await fixtureRepo(REPO);
    const r = await rig(fx.bare);
    await updateSwitches(r.stateDir, (now) => withSwitch(now, "idle-watch", true, "2026-11-16T09:00:00.000Z"));
    const id = rid();
    const answer = await r.repo.add({ rid: id, url: LINK, folder: "idle-watch", commit: fx.sha });
    if (answer.status !== 200) throw new Error(JSON.stringify(answer.body));
    const dir = join(tricksConfigDir(r.configDir), "idle-watch");
    const hashed = await trickCodeHash(dir);
    expect(hashed.ok && hashed.hash).toBe(answer.body.hash);
    expect(answer.body).toEqual({ rid: id, code: "ok", id: "idle-watch", hash: answer.body.hash });
    expect(parseSwitches(await readFile(switchesPath(r.stateDir), "utf8")).switches.on.has("idle-watch")).toBe(false);
    const origin = parseOrigin(await readFile(join(dir, ORIGIN_FILE), "utf8"));
    expect(origin).toEqual({ url: LINK, ref: null, commit: fx.sha, subdir: "idle-watch", at: "2026-11-17T09:00:00.000Z" });
    expect(await readFile(join(dir, ORIGIN_FILE), "utf8")).not.toContain("official");
    expect(r.audits.at(-1)).toEqual({ action: "trick.repo.add", detail: { host: "github.com", repo: "owner/repo", commit: fx.sha.slice(0, 12), trick: "idle-watch", hash: answer.body.hash.slice(0, 16), result: "ok" } });
  });

  test("review J, last read: the copies, the state folder and the switch entry a removed trick left are gone when an add lands, and the views and Hill keys are forgotten", async () => {
    const fx = await fixtureRepo(REPO);
    const forgotten: string[] = [];
    const r = await rig(fx.bare, { forgetTrick: (id) => void forgotten.push(id) });
    const state = trickStateDir(r.stateDir, "idle-watch");
    await mkdir(join(state, ".collie"), { recursive: true });
    await writeFile(join(state, ".collie", "values.json"), '{"v":1,"values":{"rows":9}}\n');
    await writeFile(join(state, "saved.json"), '{"old":true}\n');
    const copy = join(tricksConfigDir(r.configDir), ".collie-approved", "idle-watch", "c".repeat(16), "inputs");
    await mkdir(copy, { recursive: true });
    await updateSwitches(r.stateDir, (now) => withSwitch(now, "idle-watch", true, "2026-11-16T09:00:00.000Z", "c".repeat(64)));
    const answer = await r.repo.add({ rid: rid(), url: LINK, folder: "idle-watch", commit: fx.sha });
    expect(answer.status).toBe(200);
    expect(await stat(join(state, ".collie", "values.json")).catch(() => null)).toBeNull();
    expect(await stat(join(state, "saved.json")).catch(() => null)).toBeNull();
    expect(await stat(copy).catch(() => null)).toBeNull();
    expect(parseSwitches(await readFile(switchesPath(r.stateDir), "utf8")).switches.on.has("idle-watch")).toBe(false);
    expect(forgotten).toEqual(["idle-watch"]);
    // A folder of that name is a trick that exists, not a leftover: a second add is refused and removes nothing.
    await mkdir(join(state, ".collie"), { recursive: true });
    await writeFile(join(state, "saved.json"), '{"mine":true}\n');
    expect((await r.repo.add({ rid: rid(), url: LINK, folder: "idle-watch", commit: fx.sha })).status).toBe(409);
    expect((await stat(join(state, "saved.json"))).isFile()).toBe(true);
    expect(forgotten).toEqual(["idle-watch"]);
  });

  test("the same request id adds once; another body under it is refused", async () => {
    const fx = await fixtureRepo(REPO);
    const r = await rig(fx.bare);
    const id = rid();
    const body = { rid: id, url: LINK, folder: "idle-watch", commit: fx.sha };
    const [one, two] = await Promise.all([r.repo.add(body), r.repo.add(body)]);
    expect(one.status).toBe(200);
    expect(two).toEqual(one);
    const runs = r.calls.length;
    expect(await r.repo.add(body)).toEqual(one);
    expect(r.calls.length).toBe(runs);
    expect(await r.repo.add({ ...body, folder: "lodge-board" })).toEqual({ status: 409, body: { error: "request-id-reused", message: "This request id was already used for another request.", rid: id } });
    // A new request id for the same trick finds it here, and fetches nothing.
    const again = await r.repo.add({ ...body, rid: rid() });
    expect("error" in again.body && again.body.error).toBe("taken");
    expect(r.calls.length).toBe(runs);
  });

  test("a repository that moved since the list, a folder the index does not name, and a folder holding another id add nothing", async () => {
    const fx = await fixtureRepo({ ...REPO, "stray/trick.toml": MANIFEST("stray"), "collie-tricks.json": JSON.stringify({ contract: 1, tricks: [{ folder: "idle-watch", name: "Idle Watch", about: "Waits." }, { folder: "mixed", name: "Mixed", about: "Another id inside." }] }), "mixed/trick.toml": MANIFEST("other-id"), "mixed/program.sh": PROGRAM });
    const r = await rig(fx.bare);
    const moved = await r.repo.add({ rid: rid(), url: LINK, folder: "idle-watch", commit: "0".repeat(40) });
    expect("error" in moved.body && moved.body.error).toBe("moved");
    const stray = await r.repo.add({ rid: rid(), url: LINK, folder: "stray", commit: fx.sha });
    expect("error" in stray.body && stray.body.error).toBe("not-listed");
    const mixed = await r.repo.add({ rid: rid(), url: LINK, folder: "mixed", commit: fx.sha });
    expect("error" in mixed.body && mixed.body.error).toBe("refused");
    expect(await readdir(tricksConfigDir(r.configDir)).catch(() => [])).toEqual([]);
  });
});

describe("the link a link check refuses", () => {
  // Pinned by construction (REVIEW-J point 5): each of these must stop at the check, before git is asked
  // anything, whatever the shape of the check is later.
  const REFUSED: [string, string][] = [
    ["percent-encoding in the path", "https://github.com/owner/re%70o"],
    ["percent-encoded dot steps", "https://github.com/owner/%2e%2e/repo"],
    ["percent-encoding in the host", "https://github%2ecom/owner/repo"],
    ["a backslash", "https://github.com/owner\\repo"],
    ["a backslash before the host ends", "https://github.com\\@evil.example/owner/repo"],
    ["a newline inside", "https://github.com/owner/re\npo"],
    ["a newline then an option", "https://github.com/owner/repo\n--upload-pack=touch-x"],
    ["a carriage return inside", "https://github.com/owner/re\rpo"],
    ["a tab inside", "https://github.com/owner/re\tpo"],
    ["a space inside", "https://github.com/owner/re po"],
    ["an IDN host", "https://g\u00efthub.com/owner/repo"],
    ["a punycode host", "https://xn--gthub-zra.com/owner/repo"],
    ["a punycode lookalike of a listed host", "https://xn--github-9ua.com/owner/repo"],
    ["an IDN path", "https://github.com/owner/r\u00e9po"],
    ["ext::", "ext::sh -c touch% x"],
    ["ext:: after a scheme", "https://github.com/owner/repo ext::sh"],
    ["file://", "file:///etc/passwd"],
    ["git://", "git://github.com/owner/repo"],
    ["ssh://", "ssh://git@github.com/owner/repo"],
    ["scp form", "git@github.com:owner/repo"],
    ["scp form with a path", "github.com:owner/repo.git"],
    ["an option as the link", "--upload-pack=touch-x"],
    ["http", "http://github.com/owner/repo"],
    ["a user name", "https://user@github.com/owner/repo"],
    ["a fragment", "https://github.com/owner/repo#main"],
    ["a query", "https://github.com/owner/repo?x=1"],
  ];

  test("the parser refuses each, and the bridge fetches nothing for it", async () => {
    const r = await rig("/nowhere");
    for (const [what, url] of REFUSED) {
      expect({ what, refused: "code" in readPhoneSource(url) }).toEqual({ what, refused: true });
      const answer = await r.repo.list({ rid: rid(), url });
      expect({ what, ok: answer.status === 200 }).toEqual({ what, ok: false });
      const add = await r.repo.add({ rid: rid(), url, folder: "idle-watch", commit: "a".repeat(40) });
      expect({ what, ok: add.status === 200 }).toEqual({ what, ok: false });
    }
    expect(r.calls).toHaveLength(0);
    expect(r.audits).toHaveLength(0);
  });

  test("a clean link of each listed host is still taken", () => {
    for (const url of ["https://github.com/owner/repo", "https://github.com/owner/repo.git", "https://gitlab.com/group/sub/repo", "https://codeberg.org/owner/repo"]) {
      expect({ url, refused: "code" in readPhoneSource(url) }).toEqual({ url, refused: false });
    }
  });
});

describe("the link git is given", () => {
  test("gitLinkOf adds .git when the path has none, and leaves one that has it", () => {
    const give = (url: string): string => {
      const source = readPhoneSource(url);
      if ("code" in source) throw new Error(url);
      return gitLinkOf(source);
    };
    expect(give("https://github.com/owner/repo")).toBe("https://github.com/owner/repo.git");
    expect(give("https://gitlab.com/group/repo")).toBe("https://gitlab.com/group/repo.git");
    expect(give("https://gitlab.com/group/sub/repo")).toBe("https://gitlab.com/group/sub/repo.git");
    expect(give("https://codeberg.org/owner/repo")).toBe("https://codeberg.org/owner/repo.git");
    expect(give("https://gitlab.com/group/repo.git")).toBe("https://gitlab.com/group/repo.git");
  });

  test("the fetch seam gets the link with .git on each of the three hosts, and the answer shows the link as pasted", async () => {
    for (const url of ["https://github.com/owner/repo", "https://gitlab.com/group/sub/repo", "https://codeberg.org/owner/repo", "https://gitlab.com/group/repo.git"]) {
      const r = await rig("/nowhere");
      const fetches: string[][] = [];
      r.deps.git = async (args, opts) => {
        r.calls.push({ args: [...args], env: opts.env });
        if (args.includes("fetch")) fetches.push([...args]);
        if (args.includes("fetch")) return { code: 128, stdout: new Uint8Array(0), stderr: "fatal: stop here", timedOut: false, capped: false };
        // The only other run before the fetch is `git init`. The test asks what the fetch is given, not whether this
        // machine's git can make a repository, so it is answered here and no real git runs.
        return { code: 0, stdout: new Uint8Array(0), stderr: "", timedOut: false, capped: false };
      };
      const repo = new RepoIndexTricks(r.deps);
      await repo.list({ rid: rid(), url });
      expect(fetches).toHaveLength(1);
      const want = url.endsWith(".git") ? url : `${url}.git`;
      // After the `--` that ends the options, the link is the one git is given.
      const after = fetches[0]?.slice((fetches[0]?.indexOf("--") ?? 0) + 1);
      expect({ url, given: after?.[0] }).toEqual({ url, given: want });
      expect(fetches[0]?.filter((a) => a.startsWith("https://"))).toEqual([want]);
    }
  });

  test.if(posix)("a list and an add read through the .git link, and the origin and the reply keep the link as pasted", async () => {
    const fx = await fixtureRepo(REPO);
    const r = await rig(fx.bare);
    const listed = await r.repo.list({ rid: rid(), url: LINK });
    if (listed.status !== 200) throw new Error(JSON.stringify(listed.body));
    expect(listed.body.url).toBe(LINK);
    const fetch = r.calls.find((c) => c.args.includes("fetch"));
    expect(fetch?.args).toContain(`${LINK}.git`);
    expect(fetch?.args).not.toContain(LINK);
    const added = await r.repo.add({ rid: rid(), url: LINK, folder: "idle-watch", commit: fx.sha });
    expect(added.status).toBe(200);
    const origin = parseOrigin(await readFile(join(tricksConfigDir(r.configDir), "idle-watch", ORIGIN_FILE), "utf8"));
    expect(origin?.url).toBe(LINK);
  });
});

describe.if(posix)("a git of a fetch has an empty home", () => {
  test("every git run gets one temp HOME and CURL_HOME that is empty, is not the operator's, and is gone after", async () => {
    const fx = await fixtureRepo(REPO);
    const r = await rig(fx.bare);
    const operatorHome = r.deps.env.HOME;
    const seen: { home: string | undefined; curl: string | undefined; entries: string[] | null }[] = [];
    const inner = r.deps.git;
    if (inner === undefined) throw new Error("no seam");
    r.deps.git = async (args, opts) => {
      const home = opts.env.HOME;
      seen.push({ home, curl: opts.env.CURL_HOME, entries: home === undefined ? null : await readdir(home).catch(() => null) });
      return await inner(args, opts);
    };
    const repo = new RepoIndexTricks(r.deps);
    expect((await repo.list({ rid: rid(), url: LINK })).status).toBe(200);
    expect(seen.length).toBeGreaterThan(2);
    for (const run of seen) {
      expect(run.home).toBeDefined();
      expect(run.home).not.toBe(operatorHome);
      expect(run.curl).toBe(run.home);
      expect(run.entries).toEqual([]);
    }
    expect(new Set(seen.map((s) => s.home)).size).toBe(1);
    expect(await stat(seen[0]?.home ?? "/nonexistent").catch(() => null)).toBeNull();
    // A second fetch gets its own.
    const first = seen[0]?.home;
    seen.length = 0;
    expect((await repo.list({ rid: rid(), url: LINK })).status).toBe(200);
    expect(seen[0]?.home).not.toBe(first);
  });
});

