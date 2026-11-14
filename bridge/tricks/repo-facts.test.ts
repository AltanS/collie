import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../../web/src/lib/json.ts";
import {
  factsOf,
  githubRepoOf,
  parseRepoAnswer,
  readRepoFacts,
  RepoFacts,
  repoFactsUrl,
  REPO_FACTS_BAD_MS,
  REPO_FACTS_BYTES_MAX,
  REPO_FACTS_FILE,
  REPO_FACTS_GOOD_MS,
  REPO_FACTS_ORIGIN,
  REPO_FACTS_READS_PER_HOUR,
  REPO_FACTS_USER_AGENT,
  type RepoFactsFetch,
} from "./repo-facts.ts";

const REPO = "https://github.com/AltanS/collie-tricks";
const T0 = Date.parse("2026-11-12T09:00:00Z");
const HOUR = 60 * 60 * 1000;

/** GitHub's answer as it comes, with fields the bridge must never keep. */
function answer(extra: JsonObject = {}): string {
  return JSON.stringify({ id: 1, full_name: "AltanS/collie-tricks", owner: { login: "AltanS" }, stargazers_count: 42, pushed_at: "2026-11-10T08:30:00Z", private: false, ...extra });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch and the calls it saw. */
interface FakeFetch {
  fetch: RepoFactsFetch;
  calls: Call[];
}

/** A fake fetch: records each call and answers with what `respond` gives. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response(answer(), { status: 200 })): FakeFetch {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return await respond(url, init);
    },
  };
}

let stateDir = "";
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "repo-facts-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function cache(fetchFn: RepoFactsFetch, clock: { t: number }, onChange?: () => void): RepoFacts {
  return new RepoFacts({ stateDir, fetch: fetchFn, now: () => clock.t, onChange, timeoutMs: 50 });
}

describe("which source is read", () => {
  test("only https://github.com/<owner>/<repo>, with an optional .git and trailing slash", () => {
    expect(githubRepoOf(REPO)).toEqual({ owner: "AltanS", repo: "collie-tricks" });
    expect(githubRepoOf(`${REPO}.git`)).toEqual({ owner: "AltanS", repo: "collie-tricks" });
    expect(githubRepoOf(`${REPO}/`)).toEqual({ owner: "AltanS", repo: "collie-tricks" });
    expect(githubRepoOf("https://github.com/a-b/c.d_e")).toEqual({ owner: "a-b", repo: "c.d_e" });
  });

  test("a host that is not exactly github.com is never read", async () => {
    const fake = fakeFetch();
    const facts = cache(fake.fetch, { t: T0 });
    const hosts = [
      "https://www.github.com/AltanS/collie-tricks",
      "https://gitlab.com/AltanS/collie-tricks",
      "https://github.com.example/AltanS/collie-tricks",
      "https://api.github.com/AltanS/collie-tricks",
      "http://github.com/AltanS/collie-tricks",
      "https://github.com:443/AltanS/collie-tricks",
      "https://github.com:8443/AltanS/collie-tricks",
      "https://user@github.com/AltanS/collie-tricks",
      "https://user:pass@github.com/AltanS/collie-tricks",
      "https://user:tok@github.com/a/b",
      "ssh://git@github.com/AltanS/collie-tricks",
      "git@github.com:AltanS/collie-tricks.git",
      "/home/someone/tricks/legs",
      "not a url",
    ];
    for (const url of hosts) expect(githubRepoOf(url), url).toBeNull();
    facts.want(hosts);
    await facts.settled();
    expect(fake.calls).toEqual([]);
  });

  test("an owner or a name outside GitHub's rules is never read", async () => {
    const fake = fakeFetch();
    const facts = cache(fake.fetch, { t: T0 });
    const bad = [
      "https://github.com/AltanS/..",
      "https://github.com/AltanS/.",
      "https://github.com/AltanS/a..b",
      "https://github.com/AltanS/%2e%2e",
      "https://github.com/../collie-tricks",
      "https://github.com/-AltanS/collie-tricks",
      "https://github.com/AltanS-/collie-tricks",
      "https://github.com/Alt--anS/collie-tricks",
      "https://github.com/Alt_anS/collie-tricks",
      `https://github.com/${"a".repeat(40)}/collie-tricks`,
      `https://github.com/AltanS/${"r".repeat(101)}`,
      "https://github.com/AltanS/collie tricks",
      "https://github.com/AltanS/collie-tricks/tree/main",
      "https://github.com/AltanS",
      "https://github.com/AltanS/collie-tricks?tab=readme",
      "https://github.com/AltanS/collie-tricks#readme",
      "https://github.com/AltanS//collie-tricks",
    ];
    for (const url of bad) expect(githubRepoOf(url), url).toBeNull();
    facts.want(bad);
    await facts.settled();
    expect(fake.calls).toEqual([]);
  });

  test("the read goes to the fixed origin, with no credential and a plain user agent", async () => {
    const fake = fakeFetch();
    await readRepoFacts(fake.fetch, { owner: "AltanS", repo: "collie-tricks" });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe(`${REPO_FACTS_ORIGIN}/repos/AltanS/collie-tricks`);
    expect(new URL(call.url).origin).toBe("https://api.github.com");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.credentials).toBe("omit");
    expect(call.init.method).toBe("GET");
    const headers = new Headers(call.init.headers);
    expect(headers.get("user-agent")).toBe(REPO_FACTS_USER_AGENT);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect([...headers.keys()].toSorted()).toEqual(["accept", "user-agent"]);
    expect(repoFactsUrl({ owner: "a", repo: "b.c" })).toBe("https://api.github.com/repos/a/b.c");
  });
});

describe("what an answer may be", () => {
  test("a redirect is refused and never followed", async () => {
    for (const status of [301, 302, 307, 308]) {
      const fake = fakeFetch(() => new Response(null, { status, headers: { location: "https://evil.example/repos/x/y" } }));
      expect(await readRepoFacts(fake.fetch, { owner: "AltanS", repo: "collie-tricks" })).toBeNull();
      expect(fake.calls).toHaveLength(1);
    }
    // A fetch that says it followed one is refused too.
    const followed = fakeFetch(() => {
      const res = new Response(answer(), { status: 200 });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    });
    expect(await readRepoFacts(followed.fetch, { owner: "AltanS", repo: "collie-tricks" })).toBeNull();
  });

  test("any status but 200 is a failed read", async () => {
    for (const status of [204, 304, 403, 404, 429, 500]) {
      const fake = fakeFetch(() => new Response(status === 204 || status === 304 ? null : answer(), { status }));
      expect(await readRepoFacts(fake.fetch, { owner: "AltanS", repo: "collie-tricks" }), String(status)).toBeNull();
    }
  });

  test("an answer past 64 KiB is refused, with or without a length header", async () => {
    const big = answer({ description: "x".repeat(REPO_FACTS_BYTES_MAX) });
    const declared = fakeFetch(() => new Response(big, { status: 200, headers: { "content-length": String(big.length) } }));
    expect(await readRepoFacts(declared.fetch, { owner: "AltanS", repo: "collie-tricks" })).toBeNull();
    const streamed = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new TextEncoder().encode(big);
              for (let at = 0; at < chunk.byteLength; at += 4096) controller.enqueue(chunk.slice(at, at + 4096));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    expect(await readRepoFacts(streamed.fetch, { owner: "AltanS", repo: "collie-tricks" })).toBeNull();
    // Just under the cap reads.
    const fits = answer({ description: "x".repeat(REPO_FACTS_BYTES_MAX - answer().length - 40) });
    const ok = fakeFetch(() => new Response(fits, { status: 200 }));
    expect(await readRepoFacts(ok.fetch, { owner: "AltanS", repo: "collie-tricks" })).toEqual({ stars: 42, pushedAt: "2026-11-10T08:30:00Z" });
  });

  test("a read that does not answer in time is a failed read", async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(await readRepoFacts(hang.fetch, { owner: "AltanS", repo: "collie-tricks" }, { timeoutMs: 20 })).toBeNull();
  });

  test("the two fields are checked for their type; anything else is refused", () => {
    expect(parseRepoAnswer(answer())).toEqual({ stars: 42, pushedAt: "2026-11-10T08:30:00Z" });
    expect(parseRepoAnswer(answer({ stargazers_count: 0 }))).toEqual({ stars: 0, pushedAt: "2026-11-10T08:30:00Z" });
    expect(parseRepoAnswer(answer({ pushed_at: "2026-11-10T08:30:00.123Z" }))?.pushedAt).toBe("2026-11-10T08:30:00.123Z");
    for (const stars of ["42", -1, 1.5, Number.MAX_SAFE_INTEGER + 2, null, true, [42], { n: 42 }]) expect(parseRepoAnswer(answer({ stargazers_count: stars })), JSON.stringify(stars)).toBeNull();
    for (const pushed of [1731229800, "2026-11-10", "2026-11-10T08:30:00+01:00", "2026-13-40T99:99:99Z", "yesterday", null, ""]) expect(parseRepoAnswer(answer({ pushed_at: pushed })), JSON.stringify(pushed)).toBeNull();
    expect(parseRepoAnswer("not json")).toBeNull();
    expect(parseRepoAnswer("[]")).toBeNull();
    expect(factsOf(3, "2026-11-10T08:30:00Z")).toEqual({ stars: 3, pushedAt: "2026-11-10T08:30:00Z" });
  });

  test("the phone-facing facts hold the stars and the date only, never another field of GitHub's answer", async () => {
    const fake = fakeFetch();
    const facts = cache(fake.fetch, { t: T0 });
    facts.want([REPO]);
    await facts.settled();
    const shown = facts.facts(REPO);
    expect(shown).toEqual({ stars: 42, pushedAt: "2026-11-10T08:30:00Z" });
    expect(Object.keys(shown ?? {}).toSorted()).toEqual(["pushedAt", "stars"]);
    const file = await readFile(join(stateDir, "tricks", REPO_FACTS_FILE), "utf8");
    expect(file).not.toContain("full_name");
    expect(file).not.toContain("owner");
  });
});

describe("the cache", () => {
  test("a good answer is kept 6 hours: no read before, one read after", async () => {
    const clock = { t: T0 };
    const fake = fakeFetch();
    let changes = 0;
    const facts = cache(fake.fetch, clock, () => (changes += 1));
    expect(facts.facts(REPO)).toBeUndefined();
    facts.want([REPO]);
    await facts.settled();
    expect(fake.calls).toHaveLength(1);
    expect(changes).toBe(1);
    clock.t = T0 + REPO_FACTS_GOOD_MS - 1;
    facts.want([REPO, `${REPO}.git`, REPO.toLowerCase()]);
    await facts.settled();
    expect(fake.calls).toHaveLength(1);
    clock.t = T0 + REPO_FACTS_GOOD_MS;
    facts.want([REPO]);
    // The old answer is still served while the new read runs: the list never waits.
    expect(facts.facts(REPO)?.stars).toBe(42);
    await facts.settled();
    expect(fake.calls).toHaveLength(2);
    // The same answer again moves nothing, so the rev does not move either.
    expect(changes).toBe(1);
  });

  test("a failed read is kept 1 hour, and shows nothing", async () => {
    const clock = { t: T0 };
    let status = 500;
    const fake = fakeFetch(() => new Response(answer(), { status }));
    const facts = cache(fake.fetch, clock);
    facts.want([REPO]);
    await facts.settled();
    expect(facts.facts(REPO)).toBeUndefined();
    clock.t = T0 + REPO_FACTS_BAD_MS - 1;
    facts.want([REPO]);
    await facts.settled();
    expect(fake.calls).toHaveLength(1);
    status = 200;
    clock.t = T0 + REPO_FACTS_BAD_MS;
    facts.want([REPO]);
    await facts.settled();
    expect(fake.calls).toHaveLength(2);
    expect(facts.facts(REPO)?.stars).toBe(42);
  });

  test("a good answer that later fails shows nothing until a read answers again", async () => {
    const clock = { t: T0 };
    let status = 200;
    const fake = fakeFetch(() => new Response(answer(), { status }));
    let changes = 0;
    const facts = cache(fake.fetch, clock, () => (changes += 1));
    facts.want([REPO]);
    await facts.settled();
    status = 404;
    clock.t = T0 + REPO_FACTS_GOOD_MS;
    facts.want([REPO]);
    await facts.settled();
    expect(facts.facts(REPO)).toBeUndefined();
    expect(changes).toBe(2);
  });

  test("one read per repository at a time, however many lists ask", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = fakeFetch(async () => {
      await gate;
      return new Response(answer(), { status: 200 });
    });
    const facts = cache(fake.fetch, { t: T0 });
    for (let i = 0; i < 10; i += 1) facts.want([REPO, `${REPO}/`]);
    expect(fake.calls).toHaveLength(1);
    release();
    await facts.settled();
    expect(fake.calls).toHaveLength(1);
  });

  test("the whole bridge reads at most 20 repositories in a rolling hour", async () => {
    const clock = { t: T0 };
    const fake = fakeFetch();
    const facts = cache(fake.fetch, clock);
    const urls = Array.from({ length: 30 }, (_, i) => `https://github.com/owner${String(i)}/repo`);
    facts.want(urls);
    await facts.settled();
    expect(fake.calls).toHaveLength(REPO_FACTS_READS_PER_HOUR);
    // Above the cap the rest are served nothing, and nothing is read.
    expect(facts.facts(urls[25]!)).toBeUndefined();
    clock.t = T0 + HOUR - 1;
    facts.want(urls);
    await facts.settled();
    expect(fake.calls).toHaveLength(REPO_FACTS_READS_PER_HOUR);
    clock.t = T0 + HOUR;
    facts.want(urls);
    await facts.settled();
    expect(fake.calls).toHaveLength(30);
  });

  test("a restart keeps the cache, the negative cache and the hour's reads", async () => {
    const clock = { t: T0 };
    const first = fakeFetch((url) => new Response(answer(), { status: url.includes("/broken/") ? 404 : 200 }));
    const before = cache(first.fetch, clock);
    before.want([REPO, "https://github.com/broken/repo"]);
    await before.settled();
    const info = await stat(join(stateDir, "tricks", REPO_FACTS_FILE));
    // Windows has no POSIX mode bits, so only the mode expectation waits for another platform.
    if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);

    clock.t = T0 + HOUR / 2;
    const second = fakeFetch();
    const after = cache(second.fetch, clock);
    expect(after.facts(REPO)).toEqual({ stars: 42, pushedAt: "2026-11-10T08:30:00Z" });
    expect(after.facts("https://github.com/broken/repo")).toBeUndefined();
    after.want([REPO, "https://github.com/broken/repo"]);
    await after.settled();
    expect(second.calls).toEqual([]);
    // The two reads of the first run still count against the hour.
    after.want(Array.from({ length: 30 }, (_, i) => `https://github.com/other${String(i)}/repo`));
    await after.settled();
    expect(second.calls).toHaveLength(REPO_FACTS_READS_PER_HOUR - 2);
  });

  test("a file that is not the cache's reads as an empty cache", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const bad = [
      "not json",
      JSON.stringify({ v: 2, repos: {} }),
      JSON.stringify({ v: 1, repos: { "altans/collie-tricks": { at: T0, facts: { stars: "42", pushedAt: "2026-11-10T08:30:00Z" } } } }),
      JSON.stringify({ v: 1, repos: { "../x": { at: T0, facts: { stars: 1, pushedAt: "2026-11-10T08:30:00Z" } } } }),
    ];
    for (const text of bad) {
      await writeFile(join(stateDir, "tricks", REPO_FACTS_FILE), text);
      const facts = cache(fakeFetch().fetch, { t: T0 });
      expect(facts.facts(REPO), text).toBeUndefined();
      expect(facts.facts("https://github.com/../x"), text).toBeUndefined();
    }
  });

  test("a clock that moved back makes an entry stale, never fresh for longer", async () => {
    const clock = { t: T0 };
    const fake = fakeFetch();
    const facts = cache(fake.fetch, clock);
    facts.want([REPO]);
    await facts.settled();
    clock.t = T0 - HOUR;
    facts.want([REPO]);
    await facts.settled();
    expect(fake.calls).toHaveLength(2);
  });
});
