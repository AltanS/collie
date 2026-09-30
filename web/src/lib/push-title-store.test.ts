import { describe, expect, test } from "vitest";

import {
  parsePushTitles,
  pushTitlesCacheName,
  pushTitlesKey,
  readPushTitles,
  serialisePushTitles,
  writePushTitles,
  type PushTitleCaches,
} from "@/lib/push-title-store";

// The table the page leaves for the service worker (ADR 0074). What is pinned here is what fails
// SILENTLY on a phone: a read that throws instead of falling back to English, a stored value from
// another build that leaks through, and two mounts on one origin reading each other's language.

/** An in-memory Cache Storage: one Map per cache name, keyed by the request URL. */
function fakeCaches(): PushTitleCaches & { stores: Map<string, Map<string, string>> } {
  const stores = new Map<string, Map<string, string>>();
  return {
    stores,
    open: async (name) => {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return {
        match: async (key: RequestInfo | URL) => {
          const text = store.get(String(key));
          return text === undefined ? undefined : new Response(text);
        },
        put: async (key: RequestInfo | URL, response: Response) => {
          store.set(String(key), await response.text());
        },
      };
    },
  };
}

describe("where the table lives", () => {
  test("the root mount keeps the plain name; a path mount gets its own cache", () => {
    expect(pushTitlesCacheName("/")).toBe("collie-push-titles");
    expect(pushTitlesCacheName("/collie/")).toBe("collie-push-titles:/collie/");
  });

  test("the key is a URL under the mount", () => {
    expect(pushTitlesKey("https://h.ts.net", "/")).toBe("https://h.ts.net/push-titles.json");
    expect(pushTitlesKey("https://h.ts.net", "/collie/")).toBe("https://h.ts.net/collie/push-titles.json");
  });
});

describe("parsePushTitles", () => {
  test("keeps a known code with a string template", () => {
    const text = serialisePushTitles({ locale: "ko", titles: { "agent.blocked": "{agent} 입력 대기" } });
    expect(parsePushTitles(text)).toEqual({ "agent.blocked": "{agent} 입력 대기" });
  });

  test("drops what this build cannot use, and survives what is not a table at all", () => {
    const text = JSON.stringify({ titles: { "agent.blocked": 7, "agent.thinking": "{agent} …", "herd.done": "ok" } });
    expect(parsePushTitles(text)).toEqual({ "herd.done": "ok" });
    expect(parsePushTitles("not json")).toEqual({});
    expect(parsePushTitles(JSON.stringify({ titles: ["agent.blocked"] }))).toEqual({});
    expect(parsePushTitles("null")).toEqual({});
  });
});

describe("the round trip between the page and the worker", () => {
  test("what the page writes is what the worker reads", async () => {
    const caches = fakeCaches();
    await writePushTitles(caches, "https://h.ts.net", "/", {
      locale: "ko",
      titles: { "agent.done": "{agent} 작업 완료" },
    });
    expect(await readPushTitles(caches, "https://h.ts.net", "/")).toEqual({ "agent.done": "{agent} 작업 완료" });
  });

  test("two mounts on one origin never read each other's language", async () => {
    const caches = fakeCaches();
    await writePushTitles(caches, "https://h.ts.net", "/a/", { locale: "de", titles: { "agent.done": "{agent} ist fertig" } });
    expect(await readPushTitles(caches, "https://h.ts.net", "/b/")).toEqual({});
  });

  test("nothing written, or storage that refuses, reads as an empty table — English, not a throw", async () => {
    expect(await readPushTitles(fakeCaches(), "https://h.ts.net", "/")).toEqual({});
    const refusing: PushTitleCaches = {
      open: () => Promise.reject(new Error("SecurityError")),
    };
    expect(await readPushTitles(refusing, "https://h.ts.net", "/")).toEqual({});
  });
});
