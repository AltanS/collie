import { describe, expect, test } from "bun:test";

import {
  classifyGhRun,
  fetchGithubWork,
  findGh,
  ghArgv,
  ghEnv,
  ghMessage,
  githubAnswer,
  GITHUB_FRESH_FLOOR_MS,
  GITHUB_SEARCHES,
  GITHUB_TTL_MS,
  GITHUB_WORK_QUERY,
  GithubWork,
  normalizeGithubWork,
  type GhDeps,
  type GhChildEnvironment,
  type GhRun,
  type GhRunner,
  type GithubWorkSurface,
} from "./github-work.ts";
import type { JsonValue } from "./json.ts";
import type { SessionRuntime } from "./sessions.ts";
import { serveGithubRoute, type GithubRouteCaller } from "./server.ts";

// The GitHub work screen's bridge half (bridge/github-work.ts). Nothing here reaches the network or
// spawns a process: the runner, the clock and the `gh` lookup are all injected.

// ── Fixtures: GitHub's GraphQL answer, as `gh api graphql` prints it ─────────

function prNode(over: Partial<Record<string, JsonValue>> = {}): JsonValue {
  return {
    number: 7,
    title: "Fix the thing",
    url: "https://github.com/acme/app/pull/7",
    isDraft: false,
    updatedAt: "2026-10-08T10:00:00Z",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    author: { login: "aryrabelo" },
    repository: { nameWithOwner: "acme/app" },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...over,
  };
}

function rollup(state: string, runs: [string, number][], contexts: [string, number][], totalCount: number): JsonValue {
  return {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state,
            contexts: {
              totalCount,
              checkRunCountsByState: runs.map(([s, count]) => ({ state: s, count })),
              statusContextCountsByState: contexts.map(([s, count]) => ({ state: s, count })),
            },
          },
        },
      },
    ],
  };
}

const ISSUE: JsonValue = {
  number: 12,
  title: "Crash on start",
  url: "https://github.com/acme/app/issues/12",
  updatedAt: "2026-10-07T09:00:00Z",
  author: null,
  repository: { nameWithOwner: "acme/app" },
  labels: { nodes: [{ name: "bug", color: "D73A4A" }, { name: "odd", color: "#zz" }] },
};

function body(login = "aryrabelo", mine: JsonValue[] = [prNode()], mineTotal = mine.length): JsonValue {
  return {
    data: {
      viewer: { login },
      mine: { issueCount: mineTotal, nodes: mine },
      review: { issueCount: 0, nodes: [] },
      issues: { issueCount: 41, nodes: [ISSUE] },
    },
  };
}

function okRun(json: JsonValue = body()): GhRun {
  return { code: 0, stdout: JSON.stringify(json), stderr: "", timedOut: false, capped: false };
}

function failRun(code: number, stderr: string): GhRun {
  return { code, stdout: "", stderr, timedOut: false, capped: false };
}

/** A runner that answers from a queue (a run, a pending promise, or a throw) and records each argv. */
class FakeGh {
  readonly calls: { argv: readonly string[]; env: GhChildEnvironment }[] = [];
  readonly queue: (GhRun | Promise<GhRun> | Error)[] = [];
  readonly run: GhRunner = (argv, env) => {
    this.calls.push({ argv, env });
    const next = this.queue.shift() ?? okRun();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
}

function rig(ghPath: string | null = "/usr/bin/gh") {
  const gh = new FakeGh();
  const clock = { now: 1_000_000 };
  const deps: GhDeps = { run: gh.run, ghPath: () => ghPath, env: { HOME: "/home/op" }, now: () => clock.now };
  const work = new GithubWork(deps);
  return { gh, clock, deps, work };
}

// ── The query and the child ──────────────────────────────────────────────────

describe("the query and the gh child", () => {
  test("the query is one read: it starts with `query ` and names no mutation", () => {
    expect(GITHUB_WORK_QUERY.startsWith("query ")).toBe(true);
    expect(GITHUB_WORK_QUERY.toLowerCase()).not.toContain("mutation");
    // One document, three searches, 30 items each.
    expect([...GITHUB_WORK_QUERY.matchAll(/search\(query: \$\w+, type: ISSUE, first: 30\)/g)]).toHaveLength(3);
  });

  test("the argv is gh, then -f pairs only — the query and the three searches as variables", () => {
    const argv = ghArgv("/opt/gh");
    expect(argv.slice(0, 3)).toEqual(["/opt/gh", "api", "graphql"]);
    expect(argv.slice(3)).toEqual([
      "-f",
      `query=${GITHUB_WORK_QUERY}`,
      "-f",
      "mine=is:open is:pr author:@me archived:false sort:updated-desc",
      "-f",
      "review=is:open is:pr review-requested:@me archived:false sort:updated-desc",
      "-f",
      "issues=is:open is:issue assignee:@me archived:false sort:updated-desc",
    ]);
    expect(GITHUB_SEARCHES.issues).not.toContain("author:@me");
  });

  test("the env drops COLLIE_* and the git relocators, keeps gh's login, and adds the three switches", () => {
    const env = ghEnv({
      HOME: "/home/op",
      PATH: "/usr/bin",
      GH_TOKEN: "kept",
      GH_HOST: "github.example",
      XDG_CONFIG_HOME: "/home/op/.config",
      COLLIE_GITHUB: "on",
      COLLIE_VAPID_PRIVATE: "secret",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      UNSET: undefined,
    });
    expect(env).toEqual({
      HOME: "/home/op",
      PATH: "/usr/bin",
      GH_TOKEN: "kept",
      GH_HOST: "github.example",
      XDG_CONFIG_HOME: "/home/op/.config",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    });
  });
});

// ── normalize ────────────────────────────────────────────────────────────────

describe("normalizeGithubWork — GitHub's JSON into the wire lists", () => {
  function onlyPr(node: JsonValue) {
    const out = normalizeGithubWork(body("me", [node]), "2026-10-08T12:00:00.000Z");
    if (!out.ok) throw new Error(out.message);
    return out.data.mine.items[0]!;
  }

  test("a PR: repo, number, title, url, author, draft and updatedAt come through as GitHub sent them", () => {
    expect(onlyPr(prNode({ isDraft: true }))).toEqual({
      repo: "acme/app",
      number: 7,
      title: "Fix the thing",
      url: "https://github.com/acme/app/pull/7",
      author: "aryrabelo",
      draft: true,
      updatedAt: "2026-10-08T10:00:00Z",
      checks: "none",
      checkCounts: { failing: 0, pending: 0, passing: 0, total: 0 },
      review: "approved",
      mergeable: "mergeable",
    });
  });

  test("no rollup on the head commit is `none`, with every count zero", () => {
    expect(onlyPr(prNode()).checks).toBe("none");
    // A PR with no commits node at all reads the same.
    const bare = onlyPr(prNode({ commits: { nodes: [] } }));
    expect(bare.checks).toBe("none");
    expect(bare.checkCounts).toEqual({ failing: 0, pending: 0, passing: 0, total: 0 });
  });

  test("the rollup state maps to four words", () => {
    const of = (state: string) => onlyPr(prNode({ commits: rollup(state, [], [], 0) })).checks;
    expect(of("SUCCESS")).toBe("success");
    expect(of("FAILURE")).toBe("failure");
    expect(of("ERROR")).toBe("failure");
    expect(of("PENDING")).toBe("pending");
    expect(of("EXPECTED")).toBe("pending");
  });

  test("counts sum check runs and status contexts into failing, pending and passing; total is GitHub's", () => {
    const pr = onlyPr(
      prNode({
        commits: rollup(
          "FAILURE",
          [
            ["FAILURE", 2],
            ["TIMED_OUT", 1],
            ["CANCELLED", 1],
            ["ACTION_REQUIRED", 1],
            ["STARTUP_FAILURE", 1],
            ["QUEUED", 1],
            ["IN_PROGRESS", 2],
            ["WAITING", 1],
            ["SUCCESS", 3],
            ["NEUTRAL", 1],
            ["SKIPPED", 1],
            // Neither table names these: they count only in `total`.
            ["COMPLETED", 4],
            ["STALE", 1],
          ],
          [
            ["ERROR", 1],
            ["FAILURE", 1],
            ["PENDING", 1],
            ["EXPECTED", 1],
            ["SUCCESS", 2],
          ],
          30,
        ),
      }),
    );
    expect(pr.checks).toBe("failure");
    expect(pr.checkCounts).toEqual({ failing: 2 + 1 + 1 + 1 + 1 + 1 + 1, pending: 1 + 2 + 1 + 1 + 1, passing: 3 + 1 + 1 + 2, total: 30 });
  });

  test("mergeable UNKNOWN is unknown, never `mergeable`; anything unrecognised is unknown too", () => {
    expect(onlyPr(prNode({ mergeable: "UNKNOWN" })).mergeable).toBe("unknown");
    expect(onlyPr(prNode({ mergeable: "CONFLICTING" })).mergeable).toBe("conflicting");
    expect(onlyPr(prNode({ mergeable: "MERGEABLE" })).mergeable).toBe("mergeable");
    expect(onlyPr(prNode({ mergeable: null })).mergeable).toBe("unknown");
  });

  test("reviewDecision maps to four words, null to none", () => {
    expect(onlyPr(prNode({ reviewDecision: "CHANGES_REQUESTED" })).review).toBe("changes-requested");
    expect(onlyPr(prNode({ reviewDecision: "REVIEW_REQUIRED" })).review).toBe("required");
    expect(onlyPr(prNode({ reviewDecision: null })).review).toBe("none");
  });

  test("a deleted author is null, not a crash", () => {
    expect(onlyPr(prNode({ author: null })).author).toBeNull();
  });

  test("totals are GitHub's issueCount, which may exceed the 30 items; a node missing its identity is dropped", () => {
    const out = normalizeGithubWork(body("me", [prNode(), {}, prNode({ number: 8 })], 86), "t");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.mine.items.map((p) => p.number)).toEqual([7, 8]);
    expect(out.data.mine.total).toBe(86);
    expect(out.data.review).toEqual({ items: [], total: 0 });
    expect(out.data.issues.total).toBe(41);
    expect(out.data.login).toBe("me");
    expect(out.data.fetchedAt).toBe("t");
  });

  test("an issue keeps up to five labels, colour as six lowercase hex digits", () => {
    const out = normalizeGithubWork(body(), "t");
    if (!out.ok) throw new Error(out.message);
    expect(out.data.issues.items).toEqual([
      {
        repo: "acme/app",
        number: 12,
        title: "Crash on start",
        url: "https://github.com/acme/app/issues/12",
        author: null,
        updatedAt: "2026-10-07T09:00:00Z",
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "odd", color: "ededed" },
        ],
      },
    ]);
  });

  test("GitHub's `errors` with no `data` is not an answer, and says why", () => {
    const out = normalizeGithubWork({ errors: [{ message: "Something went wrong\nsecond line" }] }, "t");
    expect(out).toEqual({ ok: false, message: "Something went wrong" });
    // No viewer login: nobody can say whose list it is.
    expect(normalizeGithubWork({ data: { viewer: null } }, "t").ok).toBe(false);
  });
});

// ── classification ───────────────────────────────────────────────────────────

describe("what a gh run means", () => {
  test("the timeout timer wins over the exit code it caused", () => {
    expect(classifyGhRun({ ...failRun(143, ""), timedOut: true }, "t")).toEqual({
      ok: false,
      failure: { reason: "timeout", message: "gh did not answer within 20 s" },
    });
  });

  test("exit 4, or stderr naming `gh auth login`, is unauthenticated", () => {
    const four = classifyGhRun(failRun(4, ""), "t");
    expect(four).toEqual({ ok: false, failure: { reason: "gh-unauthenticated", message: "gh is not logged in" } });
    const words = classifyGhRun(failRun(1, "To get started with GitHub CLI, please run:  gh auth login\n"), "t");
    expect(words).toEqual({
      ok: false,
      failure: { reason: "gh-unauthenticated", message: "To get started with GitHub CLI, please run:  gh auth login" },
    });
  });

  test("any other failure is `error`, with the first stderr line", () => {
    expect(classifyGhRun(failRun(1, "\ngh: Bad credentials (HTTP 401)\nmore"), "t")).toEqual({
      ok: false,
      failure: { reason: "error", message: "gh: Bad credentials (HTTP 401)" },
    });
    expect(classifyGhRun(failRun(2, ""), "t")).toEqual({ ok: false, failure: { reason: "error", message: "gh exited with code 2" } });
    expect(classifyGhRun({ ...okRun(), capped: true }, "t")).toEqual({
      ok: false,
      failure: { reason: "error", message: "gh's answer was over 4 MiB" },
    });
    expect(classifyGhRun({ ...okRun(), stdout: "<html>" }, "t")).toEqual({
      ok: false,
      failure: { reason: "error", message: "gh's answer was not JSON" },
    });
  });

  test("a message is one line, printable, at most 300 characters, and never carries a token", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const msg = ghMessage(`\u001b[31mHTTP 401: token ${token} refused ${"x".repeat(400)}\nsecond`);
    expect(msg.length).toBe(300);
    expect(msg.endsWith("…")).toBe(true);
    expect(msg).not.toContain(token);
    expect(msg).not.toContain("\u001b");
    expect(msg).not.toContain("second");
  });

  test("no gh on the PATH is gh-missing, and nothing is run", async () => {
    const { gh, deps } = rig(null);
    expect(await fetchGithubWork(deps)).toEqual({ ok: false, failure: { reason: "gh-missing", message: "gh is not on the bridge's PATH or in the usual install folders" } });
    expect(gh.calls).toHaveLength(0);
  });

  test("a spawn that finds no file is gh-missing too; any other throw is `error`", async () => {
    const { gh, deps } = rig();
    gh.queue.push(Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
    expect(await fetchGithubWork(deps)).toEqual({ ok: false, failure: { reason: "gh-missing", message: "gh is not on the bridge's PATH or in the usual install folders" } });
    gh.queue.push(new Error("EACCES: permission denied"));
    expect(await fetchGithubWork(deps)).toEqual({ ok: false, failure: { reason: "error", message: "EACCES: permission denied" } });
  });

  test("the runner is handed the located gh first and the scrubbed env", async () => {
    const { gh, deps } = rig("/home/op/.local/bin/gh");
    const out = await fetchGithubWork({ ...deps, env: { HOME: "/home/op", COLLIE_GITHUB: "on" } });
    expect(out.ok).toBe(true);
    expect(gh.calls[0]!.argv[0]).toBe("/home/op/.local/bin/gh");
    expect(gh.calls[0]!.env.COLLIE_GITHUB).toBeUndefined();
    expect(gh.calls[0]!.env.GH_PROMPT_DISABLED).toBe("1");
  });
});

// ── the cache ────────────────────────────────────────────────────────────────

describe("GithubWork — TTL, single flight, stale-while-revalidate", () => {
  test("a cold request waits for the fetch; a second inside the TTL is served from cache", async () => {
    const { gh, clock, work } = rig();
    const first = await work.answer("desk", false);
    expect(first).toMatchObject({ state: "ok", machine: "desk", login: "aryrabelo", stale: false });
    expect(first.state === "ok" && first.fetchedAt).toBe(new Date(1_000_000).toISOString());
    expect(first.state === "ok" && first.error).toBeUndefined();
    clock.now += GITHUB_TTL_MS - 1;
    expect(await work.answer("desk", false)).toMatchObject({ state: "ok", stale: false });
    expect(gh.calls).toHaveLength(1);
  });

  test("two concurrent cold requests share ONE gh child", async () => {
    const { gh, work } = rig();
    const pending = Promise.withResolvers<GhRun>();
    gh.queue.push(pending.promise);
    const a = work.answer("desk", false);
    const b = work.answer("desk", true);
    pending.resolve(okRun());
    const [ra, rb] = await Promise.all([a, b]);
    expect(gh.calls).toHaveLength(1);
    expect(ra.state).toBe("ok");
    expect(rb.state).toBe("ok");
  });

  test("an expired answer comes back at once, stale, while ONE background refresh runs", async () => {
    const { gh, clock, work } = rig();
    await work.answer("desk", false);
    clock.now += GITHUB_TTL_MS;
    const pending = Promise.withResolvers<GhRun>();
    gh.queue.push(pending.promise);
    // The refresh has not answered, and the request still has its answer: the old one, stale.
    const stale = await work.answer("desk", false);
    expect(stale).toMatchObject({ state: "ok", login: "aryrabelo", stale: true });
    expect(gh.calls).toHaveLength(2);
    // A second request while that refresh runs starts no third child.
    expect(await work.answer("desk", false)).toMatchObject({ stale: true });
    expect(gh.calls).toHaveLength(2);
    // A `fresh` request while it runs joins it rather than starting another, and waits for it.
    const joined = work.answer("desk", true);
    pending.resolve(okRun(body("renamed")));
    expect(await joined).toMatchObject({ state: "ok", login: "renamed", stale: false });
    expect(await work.answer("desk", false)).toMatchObject({ state: "ok", login: "renamed", stale: false });
    expect(gh.calls).toHaveLength(2);
  });

  test("?fresh=1 bypasses the TTL but not the 10 s floor since the last fetch START", async () => {
    const { gh, clock, work } = rig();
    await work.answer("desk", false);
    clock.now += GITHUB_FRESH_FLOOR_MS - 1;
    await work.answer("desk", true);
    expect(gh.calls).toHaveLength(1);
    clock.now += 1;
    gh.queue.push(okRun(body("after")));
    // Past the floor, a fresh request WAITS for its fetch rather than answering stale.
    expect(await work.answer("desk", true)).toMatchObject({ login: "after", stale: false });
    expect(gh.calls).toHaveLength(2);
  });

  test("a failed refresh keeps the last good answer, stale and with the error; the next success clears it", async () => {
    const { gh, clock, work } = rig();
    await work.answer("desk", false);
    clock.now += GITHUB_FRESH_FLOOR_MS;
    gh.queue.push(failRun(1, "gh: Something went wrong (HTTP 502)"));
    const kept = await work.answer("desk", true);
    expect(kept).toMatchObject({ state: "ok", login: "aryrabelo", stale: true, error: "gh: Something went wrong (HTTP 502)" });
    expect(kept.state === "ok" && kept.mine.items).toHaveLength(1);
    clock.now += GITHUB_FRESH_FLOOR_MS;
    const healed = await work.answer("desk", true);
    expect(healed).toMatchObject({ state: "ok", stale: false });
    expect(healed.state === "ok" && "error" in healed).toBe(false);
  });

  test("a failure with nothing good cached is `unavailable`, with its reason, and is not re-run inside the TTL", async () => {
    const { gh, clock, work } = rig();
    gh.queue.push(failRun(4, ""));
    expect(await work.answer("desk", false)).toEqual({
      state: "unavailable",
      machine: "desk",
      reason: "gh-unauthenticated",
      message: "gh is not logged in",
    });
    clock.now += GITHUB_TTL_MS - 1;
    expect((await work.answer("desk", false)).state).toBe("unavailable");
    expect(gh.calls).toHaveLength(1);
    clock.now += 1;
    expect((await work.answer("desk", false)).state).toBe("ok");
    expect(gh.calls).toHaveLength(2);
  });

  test("peek never runs gh: cold, then the cached answer, even when it has expired", async () => {
    const { gh, clock, work } = rig();
    expect(work.peek("desk")).toEqual({ state: "cold", machine: "desk" });
    expect(gh.calls).toHaveLength(0);
    await work.answer("desk", false);
    clock.now += GITHUB_TTL_MS * 5;
    expect(work.peek("desk")).toMatchObject({ state: "ok", stale: true });
    expect(gh.calls).toHaveLength(1);
  });
});

// ── the route ────────────────────────────────────────────────────────────────

describe("GET /api/github", () => {
  // SAFETY: the GitHub route only tests `rt instanceof Response` and never reads a member of the
  // runtime, so a stub with none of them stands for "resolved locally".
  const localRuntime = { name: "default" } as SessionRuntime;

  function caller(opts: { denyAt?: "read"; resolve?: Response } = {}) {
    const asked: string[] = [];
    const c: GithubRouteCaller = {
      gate: (level) => {
        asked.push(`gate:${level}`);
        return level === opts.denyAt ? new Response("device not paired", { status: 403 }) : null;
      },
      resolve: () => {
        asked.push("resolve");
        return Promise.resolve(opts.resolve ?? localRuntime);
      },
    };
    return { c, asked };
  }

  function surface() {
    const r = rig();
    const github: GithubWorkSurface = { machine: () => "desk", work: r.work };
    return { ...r, github };
  }

  const at = (query = "") => {
    const url = new URL(`http://localhost/api/github${query}`);
    return { req: new Request(url), url };
  };

  test("off answers `off` with this machine's name and never looks for or runs gh", async () => {
    const lookups: string[] = [];
    const { gh } = rig();
    const github: GithubWorkSurface = {
      machine: () => "desk",
      work: new GithubWork({
        run: gh.run,
        ghPath: () => {
          lookups.push("which");
          return "/usr/bin/gh";
        },
        env: {},
        now: () => 0,
      }),
    };
    for (const q of ["", "?fresh=1", "?peek=1"]) {
      const { req, url } = at(q);
      const res = await serveGithubRoute(req, url, caller().c, false, github);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ state: "off", machine: "desk" });
    }
    expect(gh.calls).toHaveLength(0);
    expect(lookups).toEqual([]);
    expect(github.work.peek("desk")).toEqual({ state: "cold", machine: "desk" });
  });

  test("on: gated as a READ before the host resolves, then this machine's answer", async () => {
    const { gh, github } = surface();
    const { c, asked } = caller();
    const { req, url } = at();
    const res = await serveGithubRoute(req, url, c, true, github);
    expect(asked).toEqual(["gate:read", "resolve"]);
    expect(await res!.json()).toMatchObject({ state: "ok", machine: "desk", login: "aryrabelo" });
    expect(gh.calls).toHaveLength(1);
  });

  test("a refused gate answers its refusal and resolves nothing, runs nothing", async () => {
    const { gh, github } = surface();
    const { c, asked } = caller({ denyAt: "read" });
    const { req, url } = at();
    const res = await serveGithubRoute(req, url, c, true, github);
    expect(res!.status).toBe(403);
    expect(asked).toEqual(["gate:read"]);
    expect(gh.calls).toHaveLength(0);
  });

  test("a forwarded answer (another machine's) is handed back as it is, and nothing runs here", async () => {
    const { gh, github } = surface();
    const member = new Response(`{"error":"not found"}`, { status: 404 });
    const { c } = caller({ resolve: member });
    const { req, url } = at("?host=laptop");
    expect(await serveGithubRoute(req, url, c, true, github)).toBe(member);
    expect(gh.calls).toHaveLength(0);
  });

  test("?peek=1 answers cold without running gh; the request without it fetches", async () => {
    const { gh, github } = surface();
    const peek = at("?peek=1");
    expect(await (await serveGithubRoute(peek.req, peek.url, caller().c, true, github))!.json()).toEqual({ state: "cold", machine: "desk" });
    expect(gh.calls).toHaveLength(0);
    const plain = at();
    await serveGithubRoute(plain.req, plain.url, caller().c, true, github);
    expect(gh.calls).toHaveLength(1);
    expect(await githubAnswer(true, github, new URL("http://localhost/api/github?peek=1"))).toMatchObject({ state: "ok" });
    expect(gh.calls).toHaveLength(1);
  });

  test("another path or method is not this route", async () => {
    const { github } = surface();
    const { c, asked } = caller();
    const other = new URL("http://localhost/api/githubx");
    expect(await serveGithubRoute(new Request(other), other, c, true, github)).toBeNull();
    const url = new URL("http://localhost/api/github");
    expect(await serveGithubRoute(new Request(url, { method: "POST" }), url, c, true, github)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("findGh", () => {
  // A fake `which` over a fixed set of real paths: it answers for the first PATH entry holding gh.
  const which = (installed: string[]) => (cmd: string, path?: string): string | null =>
    (path ?? "").split(":").map((dir) => `${dir}/${cmd}`).find((p) => installed.includes(p)) ?? null;

  test("a launchd PATH without gh still finds a nix-darwin or Homebrew gh", () => {
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/op", USER: "op" };
    expect(findGh(env, which(["/run/current-system/sw/bin/gh"]))).toBe("/run/current-system/sw/bin/gh");
    expect(findGh(env, which(["/opt/homebrew/bin/gh"]))).toBe("/opt/homebrew/bin/gh");
    expect(findGh(env, which(["/etc/profiles/per-user/op/bin/gh"]))).toBe("/etc/profiles/per-user/op/bin/gh");
  });

  test("the service's own PATH wins over the fallback folders", () => {
    const env = { PATH: "/custom/bin:/usr/bin", HOME: "/Users/op", USER: "op" };
    expect(findGh(env, which(["/custom/bin/gh", "/opt/homebrew/bin/gh"]))).toBe("/custom/bin/gh");
  });

  test("no gh anywhere is null, which the fetch reports as gh-missing", () => {
    expect(findGh({ PATH: "/usr/bin", HOME: "/Users/op", USER: "op" }, which([]))).toBeNull();
  });
});
