import { describe, expect, test } from "bun:test";
import { feedUrl, FEEDS, readFeed, versionFromRelease, versionsFromDistTags, type Fetcher } from "./feeds";

const answer = (body: string, status = 200): Fetcher => async () => ({ ok: status === 200, status, text: async () => body });

describe("the release feeds", () => {
  test("Claude Code and Codex read npm dist-tags, with no token", () => {
    expect(feedUrl(FEEDS.claude!)).toBe("https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags");
    expect(feedUrl(FEEDS.codex!)).toBe("https://registry.npmjs.org/-/package/@openai%2fcodex/dist-tags");
  });

  test("the others read the latest GitHub release", () => {
    expect(feedUrl(FEEDS.pi!)).toBe("https://api.github.com/repos/earendil-works/pi/releases/latest");
    expect(feedUrl(FEEDS.opencode!)).toBe("https://api.github.com/repos/anomalyco/opencode/releases/latest");
  });

  test("dist-tags give the plain versions of the named tags, once each", () => {
    const body = JSON.stringify({ latest: "2.1.301", next: "2.1.301", stable: "2.1.292", beta: "2.2.0-beta.1" });
    expect(versionsFromDistTags(body, ["latest"])).toEqual(["2.1.301"]);
    expect(versionsFromDistTags(body, ["latest", "next", "beta"])).toEqual(["2.1.301"]);
  });

  test("a release answer gives a version, and a prerelease or a draft gives none", () => {
    expect(versionFromRelease(JSON.stringify({ tag_name: "v0.9.4" }))).toBe("0.9.4");
    expect(versionFromRelease(JSON.stringify({ tag_name: "v0.9.4", prerelease: true }))).toBeNull();
    expect(versionFromRelease(JSON.stringify({ tag_name: "v0.9.4", draft: true }))).toBeNull();
    expect(versionFromRelease(JSON.stringify({ tag_name: "nightly" }))).toBeNull();
  });

  test("readFeed returns the pairs with the url they came from", async () => {
    const found = await readFeed("claude", FEEDS.claude!, answer(JSON.stringify({ latest: "2.1.301" })));
    expect(found).toEqual([{ harness: "claude", version: "2.1.301", source: feedUrl(FEEDS.claude!) }]);
  });

  test("a feed that answers an error throws, so the caller logs it", async () => {
    await expect(readFeed("claude", FEEDS.claude!, answer("x", 503))).rejects.toThrow(/503/);
  });
});
