import {
  HOST_PARAM,
  isLead,
  normalizeHost,
  normalizeScope,
  normalizeSession,
  paneScopeKey,
  SESSION_PARAM,
  scopeFromSearchParams,
  scopeFromUrl,
  scopeKey,
  internScope,
  scopeSearch,
  sessionSearch,
} from "./scope";

// lib/scope is the ONE place the two addressing params are composed into a string, and it must stay
// react-free so the service worker can import it. Everything here is pure.

describe("params", () => {
  it("uses the short single letters, session `s` and host `h`", () => {
    expect(SESSION_PARAM).toBe("s");
    expect(HOST_PARAM).toBe("h");
  });
});

describe("normalisation", () => {
  it("treats absent, empty and whitespace-only as the lead / primary session", () => {
    for (const raw of [null, undefined, "", "   ", "\t\n"]) {
      expect(normalizeSession(raw)).toBeUndefined();
      expect(normalizeHost(raw)).toBeUndefined();
    }
  });

  it("trims a real value", () => {
    expect(normalizeSession(" collie-demo ")).toBe("collie-demo");
    expect(normalizeHost(" badger ")).toBe("badger");
  });

  it("normalizeScope normalises both fields at once", () => {
    expect(normalizeScope({ host: "  ", session: " demo " })).toEqual({
      host: undefined,
      session: "demo",
    });
    expect(normalizeScope(undefined)).toEqual({ host: undefined, session: undefined });
  });

  // A departed host is NOT silently rewritten to the lead: quietly redirecting a write to a
  // different machine is the exact failure the host dimension exists to prevent. Unknown-ness is the
  // lead's 404 to give, not this module's to paper over.
  it("keeps an unknown host verbatim — it never falls back to the lead", () => {
    expect(normalizeHost("a-host-that-left")).toBe("a-host-that-left");
    expect(isLead({ host: "a-host-that-left" })).toBe(false);
  });

  it("isLead is true exactly when there is no host", () => {
    expect(isLead()).toBe(true);
    expect(isLead({})).toBe(true);
    expect(isLead({ session: "demo" })).toBe(true);
    expect(isLead({ host: "  " })).toBe(true);
    expect(isLead({ host: "badger" })).toBe(false);
  });
});

describe("scopeSearch", () => {
  it("emits nothing for the lead's primary session", () => {
    expect(scopeSearch()).toBe("");
    expect(scopeSearch({})).toBe("");
    expect(scopeSearch({ host: undefined, session: undefined })).toBe("");
    expect(scopeSearch({ host: "  ", session: "   " })).toBe("");
  });

  it("emits `?s=` alone for a named session on the lead — byte-identical to sessionSearch", () => {
    expect(scopeSearch({ session: "x" })).toBe("?s=x");
    expect(scopeSearch({ session: "collie-demo" })).toBe(sessionSearch("collie-demo"));
  });

  it("emits `?h=` alone for a peer's primary session", () => {
    expect(scopeSearch({ host: "b" })).toBe("?h=b");
  });

  // The order is load-bearing, not cosmetic: these strings are built independently by the app and by
  // the service worker, then COMPARED AS STRINGS (the SW's `client.url !== url` focus check, and the
  // loaders' nav-vs-revalidate discriminator). A differently-ordered but semantically equal string
  // would open a spurious second window and mis-classify a poll as a navigation.
  it("puts `h` before `s`, always", () => {
    expect(scopeSearch({ host: "b", session: "x" })).toBe("?h=b&s=x");
    // Key insertion order must not matter.
    expect(scopeSearch({ session: "x", host: "b" })).toBe("?h=b&s=x");
  });

  it("URL-encodes both values", () => {
    expect(scopeSearch({ host: "a b", session: "c d" })).toBe("?h=a%20b&s=c%20d");
    expect(scopeSearch({ host: "a&b" })).toBe("?h=a%26b");
  });
});

describe("reading a scope back", () => {
  it("round-trips through URLSearchParams", () => {
    for (const scope of [
      {},
      { session: "collie-demo" },
      { host: "badger" },
      { host: "badger", session: "collie-demo" },
      { host: "a b", session: "c d" },
    ]) {
      const params = new URLSearchParams(scopeSearch(scope));
      expect(scopeFromSearchParams(params)).toEqual({
        host: scope.host,
        session: scope.session,
      });
    }
  });

  it("reads a scope off a full URL", () => {
    expect(scopeFromUrl("http://localhost/pane/w1%3Ap1?h=badger&s=demo")).toEqual({
      host: "badger",
      session: "demo",
    });
    expect(scopeFromUrl("http://localhost/")).toEqual({ host: undefined, session: undefined });
  });

  // Backward compatibility is by NORMALISATION, not by branching: a link that predates the host
  // dimension resolves to the lead, no special case anywhere.
  it("resolves a pre-host link (`?s=` only) to the lead + that session", () => {
    expect(scopeFromUrl("http://localhost/?s=demo")).toEqual({ host: undefined, session: "demo" });
  });

  it("falls back to the lead on an unparseable URL rather than throwing", () => {
    expect(scopeFromUrl("not a url")).toEqual({});
    expect(scopeFromUrl(undefined)).toEqual({});
  });
});

describe("cache keys", () => {
  const NUL = "\u0000";

  it("keys a scope as the NUL-joined (host, session) pair, host first", () => {
    expect(scopeKey({ host: "b", session: "x" })).toBe(`b${NUL}x`);
    expect(scopeKey({ session: "x" })).toBe(`${NUL}x`);
    expect(scopeKey({})).toBe(NUL);
  });

  it("keys a pane as the full (host, session, paneId) triple", () => {
    expect(paneScopeKey({ host: "b", session: "x" }, "w1:p1")).toBe(`b${NUL}x${NUL}w1:p1`);
  });

  // The invariant this whole component exists for: a pane id is unique only within one session on
  // one machine, so no two scopes may ever produce the same key for the same id.
  it("never collides across hosts or sessions for the same pane id", () => {
    const keys = [
      paneScopeKey(undefined, "w1:p1"),
      paneScopeKey({ session: "demo" }, "w1:p1"),
      paneScopeKey({ host: "badger" }, "w1:p1"),
      paneScopeKey({ host: "badger", session: "demo" }, "w1:p1"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  // A NUL joiner keeps the fields unambiguous: without it, ("ab", "") and ("a", "b") would collide.
  it("cannot be confused by a value that contains the other field's text", () => {
    expect(scopeKey({ host: "ab" })).not.toBe(scopeKey({ host: "a", session: "b" }));
  });

  it("is byte-stable for the lead — a pure prefix extension of the session-only key", () => {
    expect(paneScopeKey({}, "w1:p1")).toBe(`${NUL}${NUL}w1:p1`);
    expect(paneScopeKey({ session: "demo" }, "w1:p1")).toBe(`${NUL}demo${NUL}w1:p1`);
    // Blank normalises, so a scope built from empty URL params keys identically to no scope at all.
    expect(paneScopeKey({ host: "", session: "" }, "w1:p1")).toBe(paneScopeKey(undefined, "w1:p1"));
  });
});

// The service worker (src/sw.ts) must be able to import this module — it has to build the very same
// `?h=`/`?s=` strings when it opens a notification's deep link, and it currently hand-inlines its own
// copy. A react/react-router import here would make that impossible, silently, at bundle time.
// Guarded as source text rather than by importing sw.ts, which can't run under jsdom.
// A scope replaced a plain string in React dep arrays and in `===` compares. Interning restores the
// identity stability that string had, so a poll that re-derives the same scope doesn't churn them.
describe("internScope", () => {
  it("returns the SAME instance for equal scopes", () => {
    expect(internScope({ host: "badger", session: "demo" })).toBe(
      internScope({ session: "demo", host: "badger" }),
    );
    expect(internScope()).toBe(internScope({}));
    expect(internScope({ host: "  ", session: "" })).toBe(internScope(undefined));
  });

  it("returns DIFFERENT instances for different scopes", () => {
    expect(internScope({ host: "badger" })).not.toBe(internScope({ session: "badger" }));
    expect(internScope({ host: "badger" })).not.toBe(internScope({}));
  });

  it("normalises on the way in and is frozen", () => {
    const scope = internScope({ host: " badger ", session: " demo " });
    expect(scope).toEqual({ host: "badger", session: "demo" });
    expect(Object.isFrozen(scope)).toBe(true);
  });
});

describe("lib/scope stays importable by the service worker", () => {
  it("imports nothing from react or react-router", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "scope.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
    // Belt and braces: no dynamic import / require of react either.
    expect(src).not.toMatch(/(import|require)\s*\(\s*["']react/);
  });
});
