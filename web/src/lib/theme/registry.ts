// One entry of the community theme registry, and the one check that decides whether it is kept
// (M59 spec 06).
//
// The registry is a file the website's daily sweep writes. Its address is one constant in
// `bridge/themes/registry.ts` and appears nowhere under `web/src`. The HOST fetches it on a tap and
// the phone reads the host's copy; the page itself never fetches it (`connect-src 'self'`,
// ADR 0106). Both sides run this module over every entry, so a poisoned registry, a tampered state
// file and an older host all meet the same rule:
//
//   • `repo` is a GitHub `owner/name` slug and nothing else. The phone builds the repo link from it;
//     the registry names no URL at all.
//   • `sha` is a 40-hex commit, `path` is `collie-theme.json` or `themes/<name>.collie-theme.json`.
//   • `text` is the theme file itself, and it must pass `parseTheme` with the import cap and no
//     shipped id, exactly as a file import must.
//   • `stars` is optional: the repo's star count, a whole number from 0 to {@link STARS_MAX}. A value
//     that is anything else is left out, and the entry is kept without it.
//
// An entry that fails any of the first four is dropped, never repaired. Extra keys on an entry are
// ignored and never kept: only the fields above leave this function. The maker is never a field: it is
// the owner half of `repo` ({@link ownerOf}), so a registry cannot claim another name.
//
// Like `schema.ts`, this file loads without a DOM or React, because the bridge imports it.

import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import { THEME_MAX_BYTES, parseTheme, type Theme } from "./schema";

// ONE RULE WITH THE SITE (F13). The site's sweep and its registry schema use these four patterns,
// character for character, and a test on each side pins the sources, so an entry one side lists the
// other never refuses. Change them on both sides in the same breath.

/** A GitHub owner as GitHub issues one: a letter or digit first, then letters, digits and hyphens, 39 at most. */
export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub `owner/name`: the owner rule above, and a name of 1 to 100 that is not `.` or `..`. */
export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A full commit sha, lower-case hex. */
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** `collie-theme.json` at the root, or `themes/<stem>.collie-theme.json` with a stem of at most 80. */
export const PATH_PATTERN = /^(?:collie-theme\.json|themes\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\.collie-theme\.json)$/;

/** The most stars an entry may claim. More is not a count the phone shows. */
export const STARS_MAX = 10_000_000;

/** One kept entry, as the host stores it and the phone reads it. */
export interface RegistryEntry {
  repo: string;
  sha: string;
  path: string;
  text: string;
  /** The repo's star count when the site gave one that passes the check. */
  stars?: number;
}

/** A kept entry and the theme its text parsed to. */
export interface RegistryTheme {
  entry: RegistryEntry;
  theme: Theme;
}

/** True for a repo slug the phone may build a link from. */
export function isRepoSlug(value: string): boolean {
  return REPO_PATTERN.test(value);
}

/** An entry and its parsed theme, or undefined when any field fails its rule. */
export function readRegistryEntry(value: JsonValue | undefined): RegistryTheme | undefined {
  const record = asJsonObject(value);
  if (record === undefined) return undefined;
  const repo = asJsonString(record.repo);
  const sha = asJsonString(record.sha);
  const path = asJsonString(record.path);
  const text = asJsonString(record.text);
  if (repo === undefined || sha === undefined || path === undefined || text === undefined) return undefined;
  if (!isRepoSlug(repo) || !SHA_PATTERN.test(sha) || !PATH_PATTERN.test(path)) return undefined;
  const parsed = parseTheme(text, { maxBytes: THEME_MAX_BYTES });
  if (!parsed.ok) return undefined;
  const entry: RegistryEntry = { repo, sha, path, text };
  const stars = asJsonNumber(record.stars);
  if (stars !== undefined && Number.isSafeInteger(stars) && stars >= 0 && stars <= STARS_MAX) entry.stars = stars;
  return { entry, theme: parsed.theme };
}

/** The maker of a listed theme: the owner half of its checked slug, never a field of the registry. */
export function ownerOf(repo: string): string {
  return repo.slice(0, repo.indexOf("/"));
}

/** The GitHub page of a repo, built on the phone from a checked slug. */
export function repoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

/**
 * A new-issue link on Collie's own repository that reports a listed theme. Built on the phone and
 * opened as a link: nothing is sent until the person submits the form on GitHub themselves.
 */
export function reportUrl(entry: Pick<RegistryEntry, "repo" | "sha" | "path">): string {
  const title = `Theme report: ${entry.repo}`;
  const body = [
    `Repository: ${entry.repo}`,
    `File: ${entry.path}`,
    `Commit: ${entry.sha}`,
    "",
    "What is wrong with this theme?",
  ].join("\n");
  const query = new URLSearchParams({ title, body });
  return `https://github.com/AltanS/collie/issues/new?${query.toString()}`;
}
