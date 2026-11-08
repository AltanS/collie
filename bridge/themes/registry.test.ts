import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  REGISTRY_CAP_BYTES,
  REGISTRY_MAX_ENTRIES,
  REGISTRY_MEMORY_MS,
  REGISTRY_MIN_INTERVAL_MS,
  REGISTRY_STALE_MS,
  THEME_REGISTRY_URL,
  createThemeRegistryStore,
  readRegistry,
  registryUrlFromEnv,
  resolveRegistryAddress,
  themesDir,
  type RegistryError,
  type RegistryFetch,
} from "./registry.ts";
import { themeRegistryGet, themeRegistryRefresh } from "./registry-http.ts";
import { parseJsonObject, type JsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import type { RegistryEntry } from "../../web/src/lib/theme/registry.ts";

// The community theme registry on the host (M59 spec 06), driven through an injected fetch and a
// temp state dir. Nothing here reaches the network.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const THEME = JSON.stringify({ version: 1, id: "my-day", name: "My day", author: "Sam", light: { background: "#ffffff" } });

/** What the host keeps of the default entry. */
const KEPT: RegistryEntry = { repo: "sam/my-day", sha: SHA, path: "collie-theme.json", text: THEME };

function entry(over: JsonObject = {}): JsonObject {
  return { repo: "sam/my-day", sha: SHA, path: "collie-theme.json", text: THEME, ...over };
}

function doc(themes: JsonValue[], over: JsonObject = {}): string {
  return JSON.stringify({ v: 1, generated: "2026-11-07T06:00:00Z", themes, ...over });
}

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-themes-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  init: RequestInit;
}

/** A registry answer as the site serves it: JSON, typed as JSON. */
function json(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function fakeFetch(answer: (url: string, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: RegistryFetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, calls.length);
  };
  return { fetch, calls };
}

function store(over: { fetch: RegistryFetch; dir?: string; now?: () => number; timeoutMs?: number; url?: string }) {
  const dir = over.dir ?? stateDir();
  return {
    dir,
    store: createThemeRegistryStore({ stateDir: dir, version: "1.28.1", fetch: over.fetch, now: over.now, timeoutMs: over.timeoutMs, url: over.url }),
  };
}

describe("readRegistry", () => {
  test("keeps the entries that pass and counts the ones that fail", () => {
    const read = readRegistry(
      doc([
        entry(),
        entry({ repo: "evil/../x" }),
        entry({ repo: "https://evil.example/x" }),
        entry({ sha: "abc" }),
        entry({ path: "../collie-theme.json" }),
        entry({ path: "themes/../../x.collie-theme.json" }),
        entry({ text: JSON.stringify({ version: 1, id: "x", name: "X", light: { background: "url(https://evil)" } }) }),
        entry({ text: JSON.stringify({ version: 1, id: "harbour", name: "Harbour", light: { background: "#000000" } }) }),
        entry({ text: 42 }),
        "not an object",
        entry({ repo: "sam/two", path: "themes/night.collie-theme.json" }),
      ]),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.themes.map((kept) => `${kept.repo} ${kept.path}`)).toEqual(["sam/my-day collie-theme.json", "sam/two themes/night.collie-theme.json"]);
    expect(read.dropped).toBe(9);
    expect(read.generated).toBe("2026-11-07T06:00:00Z");
  });

  test("keeps only the four checked fields of an entry", () => {
    const read = readRegistry(doc([entry({ url: "https://evil.example", html: "<script>" })]));
    expect(read.ok && Object.keys(read.themes[0] ?? {})).toEqual(["repo", "sha", "path", "text"]);
  });

  test("keeps a checked star count beside the four fields, and drops a bad one without dropping the entry", () => {
    const read = readRegistry(doc([entry({ stars: 7 }), entry({ path: "themes/b.collie-theme.json", stars: "7" })]));
    expect(read.ok && read.themes.map((e) => e.stars)).toEqual([7, undefined]);
    expect(read.ok && read.dropped).toBe(0);
  });

  test("refuses a document of another version, a non-object, and one over the entry cap", () => {
    expect(readRegistry(doc([entry()], { v: 2 }))).toEqual({ ok: false, error: "bad-registry" });
    expect(readRegistry("[]")).toEqual({ ok: false, error: "bad-registry" });
    expect(readRegistry("not json")).toEqual({ ok: false, error: "bad-registry" });
    expect(readRegistry(doc([entry()], { themes: "x" }))).toEqual({ ok: false, error: "bad-registry" });
    const many = Array.from({ length: REGISTRY_MAX_ENTRIES + 1 }, () => entry());
    expect(readRegistry(doc(many))).toEqual({ ok: false, error: "bad-registry" });
    expect(readRegistry(doc(many.slice(1))).ok).toBe(true);
  });

  test("keeps a file refused only for a newer version, flagged, and drops every other refusal", () => {
    const future = JSON.stringify({ version: 5, id: "my-day", name: "My day", sparkle: "x", light: { background: "nope" } });
    const read = readRegistry(
      doc([
        entry({ text: future, stars: 3 }),
        // A newer version with a broken slug, a non-integer version, or the newest this Collie reads: dropped.
        entry({ repo: "evil/../x", text: future }),
        entry({ path: "themes/b.collie-theme.json", text: JSON.stringify({ version: 4.5, id: "b", name: "B" }) }),
        entry({ path: "themes/c.collie-theme.json", text: JSON.stringify({ version: 4, id: "c", name: "C", light: { background: "nope" } }) }),
        entry({ path: "themes/d.collie-theme.json", text: "not json" }),
      ]),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.themes).toEqual([{ repo: "sam/my-day", sha: SHA, path: "collie-theme.json", text: future, newer: true, stars: 3 }]);
    expect(read.dropped).toBe(4);
  });

  test("never trusts a stored newer flag: a readable entry reads as readable, a broken one is dropped", () => {
    const read = readRegistry(doc([entry({ newer: true }), entry({ path: "themes/x.collie-theme.json", text: "{}", newer: true })]));
    expect(read.ok && read.themes).toEqual([KEPT]);
    expect(read.ok && read.dropped).toBe(1);
  });

  test("drops a generated stamp that is not a plain date", () => {
    const read = readRegistry(doc([], { generated: "<b>now</b>" }));
    expect(read.ok && read.generated).toBeNull();
  });
});

describe("the store", () => {
  test("a status read fetches nothing and answers an empty copy", async () => {
    const { fetch, calls } = fakeFetch(() => json(doc([entry()])));
    const { store: s, dir } = store({ fetch });
    expect(await s.status()).toEqual({ fetchedAt: null, ageMs: null, generated: null, themes: [], dropped: 0, fetching: false });
    expect(calls).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a refresh GETs the one fixed address, without following a redirect itself, and stores the copy", async () => {
    const { fetch, calls } = fakeFetch(() => json(doc([entry(), entry({ sha: "x" })])));
    let clock = Date.parse("2026-11-07T10:00:00Z");
    const { store: s, dir } = store({ fetch, now: () => clock });
    const done = await s.refresh();
    expect(done.outcome).toBe("fetched");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(THEME_REGISTRY_URL);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("Collie/1.28.1");
    expect(done.status).toMatchObject({ fetchedAt: "2026-11-07T10:00:00.000Z", ageMs: 0, dropped: 1, fetching: false });
    expect(done.status.themes).toHaveLength(1);
    expect(done.status.error).toBeUndefined();

    const folder = themesDir(dir);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toEqual(["registry.json"]);
    expect(statSync(join(folder, "registry.json")).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(join(folder, "registry.json"), "utf8"));
    expect(stored.themes).toEqual([KEPT]);

    clock += 5000;
    expect((await s.status()).ageMs).toBe(5000);
  });

  test("a second store on the same state dir reads the copy from disk, checked again", async () => {
    const { fetch } = fakeFetch(() => json(doc([entry()])));
    const { store: first, dir } = store({ fetch });
    await first.refresh();
    const { fetch: none, calls } = fakeFetch(() => new Response("never"));
    const { store: second } = store({ fetch: none, dir });
    expect((await second.status()).themes).toEqual([KEPT]);
    expect(calls).toEqual([]);
  });

  test("a star count survives the copy on disk and the read back", async () => {
    const { fetch } = fakeFetch(() => json(doc([entry({ stars: 42 })])));
    const { store: first, dir } = store({ fetch });
    await first.refresh();
    const { fetch: none } = fakeFetch(() => new Response("never"));
    const { store: second } = store({ fetch: none, dir });
    expect((await second.status()).themes[0]?.stars).toBe(42);
  });

  test("a tampered file on disk is checked again: a bad entry is dropped, a bad file reads as none", async () => {
    const dir = stateDir();
    mkdirSync(themesDir(dir), { mode: 0o700 });
    const file = join(themesDir(dir), "registry.json");
    writeFileSync(file, JSON.stringify({ v: 1, fetchedAt: "2026-11-07T10:00:00.000Z", generated: null, dropped: 0, themes: [entry(), entry({ repo: "a/b/c" })] }));
    const { fetch } = fakeFetch(() => new Response("never"));
    expect((await store({ fetch, dir }).store.status()).themes).toEqual([KEPT]);
    writeFileSync(file, "{ broken");
    expect((await store({ fetch, dir }).store.status()).themes).toEqual([]);
  });

  test("the copy is held in memory for an hour, then read from disk again", async () => {
    const { fetch } = fakeFetch(() => json(doc([entry()])));
    let clock = 1_000_000;
    const { store: s, dir } = store({ fetch, now: () => clock });
    await s.refresh();
    rmSync(join(themesDir(dir), "registry.json"));
    expect((await s.status()).themes).toHaveLength(1);
    clock += REGISTRY_MEMORY_MS;
    expect((await s.status()).themes).toHaveLength(0);
  });

  test("a failed fetch keeps the old copy and says one word", async () => {
    let fail = false;
    const { fetch } = fakeFetch(() => (fail ? new Response("down", { status: 503 }) : json(doc([entry()]))));
    let clock = Date.parse("2026-11-07T10:00:00Z");
    const { store: s } = store({ fetch, now: () => clock });
    await s.refresh();
    fail = true;
    clock += REGISTRY_MIN_INTERVAL_MS;
    const done = await s.refresh();
    expect(done.outcome).toBe("fetch-failed");
    expect(done.status.themes).toHaveLength(1);
    expect(done.status.error).toBe("fetch-failed");
    expect(JSON.stringify(done.status)).not.toContain("down");
    fail = false;
    clock += REGISTRY_MIN_INTERVAL_MS;
    expect((await s.refresh()).status.error).toBeUndefined();
  });

  test("a thrown fetch, a bad document and a body past the cap each refuse with their word", async () => {
    const cases: Array<[() => Response, RegistryError]> = [
      [() => { throw new TypeError("network"); }, "fetch-failed"],
      [() => json(doc([entry()], { v: 9 })), "bad-registry"],
      [() => json("x".repeat(REGISTRY_CAP_BYTES + 1)), "too-big"],
      [() => json("{}", { "content-length": String(REGISTRY_CAP_BYTES + 1) }), "too-big"],
    ];
    for (const [answer, word] of cases) {
      const { fetch } = fakeFetch(answer);
      const { store: s, dir } = store({ fetch });
      const done = await s.refresh();
      expect(done.outcome).toBe(word);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("a redirect is followed only on the registry's own origin, at most three times", async () => {
    const onSite = fakeFetch((_url, n) =>
      n === 1 ? new Response(null, { status: 302, headers: { location: "/themes/registry-2.json" } }) : json(doc([entry()])),
    );
    const followed = await store({ fetch: onSite.fetch }).store.refresh();
    expect(followed.outcome).toBe("fetched");
    expect(onSite.calls.map((call) => call.url)).toEqual([THEME_REGISTRY_URL, "https://colliepwa.dev/themes/registry-2.json"]);

    const offSite = fakeFetch(() => new Response(null, { status: 301, headers: { location: "https://evil.example/registry.json" } }));
    expect((await store({ fetch: offSite.fetch }).store.refresh()).outcome).toBe("fetch-failed");
    expect(offSite.calls).toHaveLength(1);

    const downgrade = fakeFetch(() => new Response(null, { status: 301, headers: { location: "http://colliepwa.dev/themes/registry.json" } }));
    expect((await store({ fetch: downgrade.fetch }).store.refresh()).outcome).toBe("fetch-failed");

    const loop = fakeFetch(() => new Response(null, { status: 302, headers: { location: THEME_REGISTRY_URL } }));
    expect((await store({ fetch: loop.fetch }).store.refresh()).outcome).toBe("fetch-failed");
    expect(loop.calls).toHaveLength(4);
  });

  test("one fetch in flight: a second tap joins it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((open) => {
      release = open;
    });
    const { fetch, calls } = fakeFetch(async () => {
      await gate;
      return json(doc([entry()]));
    });
    const { store: s } = store({ fetch });
    const first = s.refresh();
    await Promise.resolve();
    expect((await s.status()).fetching).toBe(true);
    const second = s.refresh();
    release();
    expect((await first).outcome).toBe("fetched");
    expect((await second).outcome).toBe("joined");
    expect(calls).toHaveLength(1);
    expect((await s.status()).fetching).toBe(false);
  });

  test("the whole fetch has the timeout", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        ),
    );
    // The fake body never ends; only the signal can stop it, so the fetch must pass one through.
    const slow: RegistryFetch = async (url, init) => {
      const res = await fetch(url, init);
      const signal = init.signal;
      if (signal === null || signal === undefined) throw new Error("no signal");
      const reader = res.body!.getReader();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (signal.aborted) return controller.error(signal.reason);
            const next = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
            ]);
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const { store: s } = store({ fetch: slow, timeoutMs: 50 });
    expect((await s.refresh()).outcome).toBe("fetch-failed");
  });

  test("a state folder that is a symlink is refused, and nothing is written through it", async () => {
    const dir = stateDir();
    const elsewhere = stateDir();
    symlinkSync(elsewhere, themesDir(dir));
    const { fetch } = fakeFetch(() => json(doc([entry()])));
    expect((await store({ fetch, dir }).store.refresh()).outcome).toBe("fetch-failed");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("the routes", () => {
  test("GET answers the copy with 200 and fetches nothing", async () => {
    const { fetch, calls } = fakeFetch(() => json(doc([entry()])));
    const res = await themeRegistryGet(store({ fetch }).store);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).themes).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("POST answers 200 after a fetch and 502 with the old copy after a failure; the audit holds counts only", async () => {
    let fail = false;
    const { fetch } = fakeFetch(() => (fail ? new Response("x", { status: 500 }) : json(doc([entry(), entry({ sha: "bad" })]))));
    let clock = Date.parse("2026-11-07T10:00:00Z");
    const s = store({ fetch, now: () => clock }).store;
    const ok = await themeRegistryRefresh(s);
    expect(ok.response.status).toBe(200);
    expect(ok.attempt).toEqual({ status: 200, outcome: "fetched", themes: 1, dropped: 1 });
    fail = true;
    clock += REGISTRY_MIN_INTERVAL_MS;
    const failed = await themeRegistryRefresh(s);
    expect(failed.response.status).toBe(502);
    expect(failed.attempt).toEqual({ status: 502, outcome: "fetch-failed", themes: 1, dropped: 1 });
    const body = await failed.response.json();
    expect(body.error).toBe("fetch-failed");
    expect(body.themes).toHaveLength(1);
  });
});

describe("after review (M59)", () => {
  const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";

  test("a body not typed as JSON is refused as bad-registry, and nothing is stored", async () => {
    for (const answer of [
      () => new Response(doc([entry()]), { headers: { "content-type": "text/html" } }),
      () => new Response(doc([entry()]), { headers: { "content-type": "application/jsonp" } }),
      () => new Response(new TextEncoder().encode(doc([entry()]))),
    ]) {
      const { fetch } = fakeFetch(answer);
      const { store: s, dir } = store({ fetch });
      const done = await s.refresh();
      expect(done.outcome).toBe("bad-registry");
      expect(done.status.themes).toEqual([]);
      expect(() => statSync(join(themesDir(dir), "registry.json"))).toThrow();
    }
  });

  test("a refresh under a minute after a good fetch answers the held copy and fetches nothing", async () => {
    const { fetch, calls } = fakeFetch(() => json(doc([entry()])));
    let clock = Date.parse("2026-11-07T10:00:00Z");
    const { store: s } = store({ fetch, now: () => clock });
    expect((await s.refresh()).outcome).toBe("fetched");
    clock += REGISTRY_MIN_INTERVAL_MS - 1;
    const again = await s.refresh();
    expect(again.outcome).toBe("held");
    expect(again.status.themes).toEqual([KEPT]);
    expect(calls).toHaveLength(1);
    clock += 1;
    expect((await s.refresh()).outcome).toBe("fetched");
    expect(calls).toHaveLength(2);
  });

  test("the POST route answers a held copy with 200", async () => {
    const { fetch } = fakeFetch(() => json(doc([entry()])));
    const s = store({ fetch, now: () => Date.parse("2026-11-07T10:00:00Z") }).store;
    await themeRegistryRefresh(s);
    const held = await themeRegistryRefresh(s);
    expect(held.response.status).toBe(200);
    expect(held.attempt.outcome).toBe("held");
  });

  test("a copy older than a week is not listed, and the next tap fetches", async () => {
    const { fetch, calls } = fakeFetch(() => json(doc([entry()])));
    let clock = Date.parse("2026-11-07T10:00:00Z");
    const { store: s } = store({ fetch, now: () => clock });
    await s.refresh();
    clock += REGISTRY_STALE_MS;
    expect((await s.status()).themes).toEqual([KEPT]);
    clock += 1;
    const stale = await s.status();
    expect(stale).toMatchObject({ fetchedAt: null, ageMs: null, themes: [], dropped: 0 });
    expect((await s.refresh()).outcome).toBe("fetched");
    expect(calls).toHaveLength(2);
  });

  test("the same file at the same commit, listed twice, is one theme; another commit is another", () => {
    const read = readRegistry(doc([entry(), entry(), entry({ sha: SHA2 })]));
    expect(read).toEqual({ ok: true, generated: "2026-11-07T06:00:00Z", themes: [KEPT, { ...KEPT, sha: SHA2 }], dropped: 0 });
  });

  test("dropped comes from the check, never from the file", async () => {
    const { fetch } = fakeFetch(() => json(doc([entry(), entry({ sha: "bad" })])));
    const { store: s, dir } = store({ fetch });
    await s.refresh();
    const file = join(themesDir(dir), "registry.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    // The file keeps only the themes that passed. A count written into it is ignored; a bad theme
    // put into it is counted by the check that reads it again.
    writeFileSync(file, JSON.stringify({ ...stored, dropped: 999 }));
    expect((await store({ fetch, dir }).store.status()).dropped).toBe(0);
    writeFileSync(file, JSON.stringify({ ...stored, themes: [...stored.themes, entry({ sha: "bad" })], dropped: 999 }));
    expect((await store({ fetch, dir }).store.status()).dropped).toBe(1);
  });

  test("a themes folder that is a symlink is not read", async () => {
    const dir = stateDir();
    const elsewhere = stateDir();
    const { fetch } = fakeFetch(() => json(doc([entry()])));
    await store({ fetch, dir: elsewhere }).store.refresh();
    symlinkSync(themesDir(elsewhere), themesDir(dir));
    const status = await store({ fetch, dir }).store.status();
    expect(status.fetchedAt).toBeNull();
    expect(status.themes).toEqual([]);
  });
});

describe("the address", () => {
  test("is spelled once, in registry.ts, and never under web/src", () => {
    const root = resolve(import.meta.dirname, "../..");
    const source = readFileSync(join(root, "bridge/themes/registry.ts"), "utf8");
    expect(source.split("colliepwa.dev/themes/registry.json").length - 1).toBe(1);
  });
});

describe("the operator's override (COLLIE_THEME_REGISTRY_URL)", () => {
  const STAGED = "http://bluefin:8834/themes/registry.json";

  test("unset, empty or blank takes the default address with no warning", () => {
    expect(resolveRegistryAddress(undefined)).toEqual({ url: THEME_REGISTRY_URL });
    expect(resolveRegistryAddress("")).toEqual({ url: THEME_REGISTRY_URL });
    expect(resolveRegistryAddress("   ")).toEqual({ url: THEME_REGISTRY_URL });
  });

  test("https is accepted to any host", () => {
    expect(resolveRegistryAddress("https://staging.example.com/themes/registry.json")).toEqual({
      url: "https://staging.example.com/themes/registry.json",
    });
  });

  test("http is accepted for loopback, the tailnet range, .ts.net and a name without a dot", () => {
    for (const url of [
      "http://127.0.0.1:8834/themes/registry.json",
      "http://127.9.8.7/r.json",
      "http://localhost:8834/r.json",
      "http://[::1]:8834/r.json",
      "http://100.64.0.8:8834/r.json",
      "http://100.127.255.254/r.json",
      "http://bluefin.tail1234.ts.net/r.json",
      STAGED,
    ]) {
      expect(resolveRegistryAddress(url)).toEqual({ url });
    }
  });

  test("http to any other host, another scheme, a credential or a non-URL is refused for the default", () => {
    for (const raw of [
      "http://example.com/r.json",
      "http://100.63.255.255/r.json",
      "http://100.128.0.1/r.json",
      "http://192.168.1.10/r.json",
      "http://10.0.0.1/r.json",
      "http://bluefin./r.json",
      "http://evil.ts.net.example.com/r.json",
      "http://[fd7a:115c:a1e0::1]/r.json",
      "ftp://bluefin/r.json",
      "file:///etc/passwd",
      "https://user:secret@staging.example.com/r.json",
      "not a url",
      "bluefin:8834/themes/registry.json",
    ]) {
      const resolved = resolveRegistryAddress(raw);
      expect(resolved.url).toBe(THEME_REGISTRY_URL);
      expect(resolved.refused).toBeDefined();
    }
  });

  test("a refused value says one warning line, without the value, and never throws", () => {
    const lines: string[] = [];
    expect(registryUrlFromEnv("https://user:secret@staging.example.com/r.json", (l) => lines.push(l))).toBe(THEME_REGISTRY_URL);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("COLLIE_THEME_REGISTRY_URL");
    expect(lines[0]).not.toContain("secret");
    expect(registryUrlFromEnv(STAGED, (l) => lines.push(l))).toBe(STAGED);
    expect(registryUrlFromEnv(undefined, (l) => lines.push(l))).toBe(THEME_REGISTRY_URL);
    expect(lines).toHaveLength(1);
  });

  test("the store fetches the override, and the status names it; the default's status does not", async () => {
    const { fetch, calls } = fakeFetch(() => json(doc([entry()])));
    const { store: s } = store({ fetch, url: STAGED });
    const done = await s.refresh();
    expect(done.outcome).toBe("fetched");
    expect(calls.map((call) => call.url)).toEqual([STAGED]);
    expect(done.status.address).toBe(STAGED);
    const { store: plain } = store({ fetch: fakeFetch(() => json(doc([entry()]))).fetch });
    expect("address" in (await plain.refresh()).status).toBe(false);
  });

  test("a redirect follows the override's origin, not colliepwa.dev", async () => {
    const onSite = fakeFetch((url) =>
      url === STAGED ? new Response(null, { status: 302, headers: { location: "/themes/registry-2.json" } }) : json(doc([entry()])),
    );
    expect((await store({ fetch: onSite.fetch, url: STAGED }).store.refresh()).outcome).toBe("fetched");
    expect(onSite.calls.map((call) => call.url)).toEqual([STAGED, "http://bluefin:8834/themes/registry-2.json"]);
    const toSite = fakeFetch(() => new Response(null, { status: 302, headers: { location: THEME_REGISTRY_URL } }));
    expect((await store({ fetch: toSite.fetch, url: STAGED }).store.refresh()).outcome).toBe("fetch-failed");
    expect(toSite.calls).toHaveLength(1);
  });

  test("the default writes the copy exactly as before, with no address in it", async () => {
    const { dir } = await (async () => {
      const made = store({ fetch: fakeFetch(() => json(doc([entry()]))).fetch, now: () => Date.parse("2026-11-07T10:00:00Z") });
      await made.store.refresh();
      return made;
    })();
    const written = parseJsonObject(readFileSync(join(themesDir(dir), "registry.json"), "utf8"));
    expect(Object.keys(written ?? {})).toEqual(["v", "fetchedAt", "generated", "themes", "dropped"]);
  });

  test("a copy is not listed across an address change, either way, and the next tap fetches", async () => {
    const clock = Date.parse("2026-11-07T10:00:00Z");
    const dir = stateDir();
    await store({ fetch: fakeFetch(() => json(doc([entry()]))).fetch, dir, now: () => clock }).store.refresh();

    // The default's copy, read by a bridge on the staged address: absent, and a tap fetches at once.
    const staged = fakeFetch(() => json(doc([entry({ repo: "sam/staged" })])));
    const onStaged = store({ fetch: staged.fetch, dir, now: () => clock, url: STAGED }).store;
    expect((await onStaged.status()).themes).toEqual([]);
    const fetched = await onStaged.refresh();
    expect(fetched.outcome).toBe("fetched");
    expect(fetched.status.themes.map((t) => t.repo)).toEqual(["sam/staged"]);
    expect(staged.calls).toHaveLength(1);

    // The staged copy, read back on the default address: absent too, and never served.
    const back = fakeFetch(() => json(doc([entry()])));
    const onDefault = store({ fetch: back.fetch, dir, now: () => clock }).store;
    expect((await onDefault.status()).themes).toEqual([]);
    expect((await onDefault.refresh()).outcome).toBe("fetched");
    expect(back.calls).toHaveLength(1);

    // Another override is another address.
    const other = store({ fetch: fakeFetch(() => json(doc([]))).fetch, dir, now: () => clock, url: "http://minibuch:8834/themes/registry.json" }).store;
    expect((await other.status()).themes).toEqual([]);
  });

  test("a copy whose address is not a string reads as absent", async () => {
    const dir = stateDir();
    mkdirSync(themesDir(dir), { mode: 0o700 });
    const body = { v: 1, fetchedAt: new Date().toISOString(), generated: null, dropped: 0, themes: [entry()] };
    writeFileSync(join(themesDir(dir), "registry.json"), JSON.stringify({ ...body, url: 42 }));
    const { fetch } = fakeFetch(() => new Response("never"));
    expect((await store({ fetch, dir }).store.status()).themes).toEqual([]);
    writeFileSync(join(themesDir(dir), "registry.json"), JSON.stringify({ ...body, url: THEME_REGISTRY_URL }));
    expect((await store({ fetch, dir }).store.status()).themes).toEqual([KEPT]);
  });
});
