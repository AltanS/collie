// The slow cases of repo-index.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnGit, type GitRunner, type GitRunOptions } from "./fetch.ts";
import { tricksStateDir } from "./paths.ts";
import { REPO_FETCH_PREFIX, RepoIndexTricks, type RepoIndexDeps } from "./repo-index.ts";

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

describe.if(posix)("a git that hangs", () => {
  test("is killed at the deadline, with the process it started, and the answer is a refusal", async () => {
    const fx = await fixtureRepo(REPO);
    const root = await tempDir();
    const bin = join(root, "bin");
    await mkdir(bin);
    const pidFile = join(root, "hung.pid");
    const real = Bun.which("git");
    if (real === null) throw new Error("no git for the fixture");
    // A git that does what git does, except `fetch`: that one starts a long sleep and hangs on it.
    await writeFile(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = fetch ]; then echo $$ > "$HUNG_PID"; exec sleep 60; fi\ndone\nexec ${real} "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    const r = await rig(fx.bare, { timeoutMs: 1500 });
    const hung = new RepoIndexTricks({ ...r.deps, git: undefined, allowFile: false, now: undefined, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), HUNG_PID: pidFile } });
    const started = Date.now();
    const answer = await hung.list({ rid: rid(), url: LINK });
    const took = Date.now() - started;
    expect(took).toBeLessThan(20_000);
    expect(answer.status).not.toBe(200);
    expect("error" in answer.body && answer.body.error).toBe("unreachable");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    // The slot is free and the temp folder went.
    expect((await readdir(tricksStateDir(r.stateDir)).catch(() => [])).filter((n) => n.startsWith(REPO_FETCH_PREFIX))).toEqual([]);
  });
});
