// The harness release feeds (M56 spec 10). Reading a feed is one plain HTTPS GET with no token and no
// account. Claude Code and Codex publish on npm, so their feed is the registry's dist-tags. pi and
// opencode publish GitHub releases, so their feed is the newest release that is no draft and no
// prerelease. A feed gives plain `x.y.z` versions only: a tag like `0.163.0-alpha.11` is no release.

import { asJsonObject, asJsonString, parseJson } from "../../../web/src/lib/json";

export type Feed =
  | { readonly kind: "npm"; readonly pkg: string; readonly tags: readonly string[] }
  | { readonly kind: "github"; readonly repo: string };

export interface FeedVersion {
  readonly harness: string;
  readonly version: string;
  /** The URL that was read, for the log. */
  readonly source: string;
}

/** The feed of each harness the lab knows. */
export interface FeedTable {
  readonly [harness: string]: Feed | undefined;
}

export const FEEDS: FeedTable = {
  claude: { kind: "npm", pkg: "@anthropic-ai/claude-code", tags: ["latest"] },
  codex: { kind: "npm", pkg: "@openai/codex", tags: ["latest"] },
  pi: { kind: "github", repo: "earendil-works/pi" },
  opencode: { kind: "github", repo: "anomalyco/opencode" },
};

export const PLAIN_VERSION = /^\d+\.\d+\.\d+$/u;
const FEED_TIMEOUT_MS = 15_000;

/** The URL of a feed. */
export function feedUrl(feed: Feed): string {
  return feed.kind === "npm" ? `https://registry.npmjs.org/-/package/${feed.pkg.replace("/", "%2f")}/dist-tags` : `https://api.github.com/repos/${feed.repo}/releases/latest`;
}

/** The plain versions the named dist-tags point at. A prerelease or a platform build is dropped. */
export function versionsFromDistTags(body: string, tags: readonly string[]): string[] {
  const node = asJsonObject(parseJson(body));
  if (node === undefined) throw new Error("the dist-tags answer is not a JSON object");
  const out: string[] = [];
  for (const tag of tags) {
    const version = asJsonString(node[tag]);
    if (version !== undefined && PLAIN_VERSION.test(version) && !out.includes(version)) out.push(version);
  }
  return out;
}

/** The version of a release answer, or null for a draft, a prerelease or a tag that holds no plain version. */
export function versionFromRelease(body: string): string | null {
  const node = asJsonObject(parseJson(body));
  if (node === undefined) throw new Error("the release answer is not a JSON object");
  if (node.draft === true || node.prerelease === true) return null;
  const tag = asJsonString(node.tag_name);
  const version = tag?.replace(/^[^\d]*/u, "");
  return version !== undefined && PLAIN_VERSION.test(version) ? version : null;
}

export type Fetcher = (url: string) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export const httpFetcher: Fetcher = (url) =>
  fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS), headers: { accept: "application/json", "user-agent": "collie-harness-lab" } });

/** One harness's new versions. A feed that cannot be read throws: the caller logs it and goes on. */
export async function readFeed(harness: string, feed: Feed, fetcher: Fetcher = httpFetcher): Promise<FeedVersion[]> {
  const source = feedUrl(feed);
  const answer = await fetcher(source);
  if (!answer.ok) throw new Error(`${harness}: ${source} answered ${String(answer.status)}`);
  const body = await answer.text();
  if (feed.kind === "npm") return versionsFromDistTags(body, feed.tags).map((version) => ({ harness, version, source }));
  const version = versionFromRelease(body);
  return version === null ? [] : [{ harness, version, source }];
}
