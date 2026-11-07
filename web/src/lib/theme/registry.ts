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
//
// An entry that fails any of these is dropped, never repaired. Extra keys on an entry are ignored and
// never kept: only the four fields above leave this function.
//
// Like `schema.ts`, this file loads without a DOM or React, because the bridge imports it.

import { asJsonObject, asJsonString, type JsonValue } from "../json";
import { THEME_MAX_BYTES, parseTheme, type Theme } from "./schema";

/** A GitHub `owner/name`: GitHub's own limits on both halves, and no `..` as a whole half. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PATH_PATTERN = /^(?:collie-theme\.json|themes\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.collie-theme\.json)$/;

/** One kept entry, as the host stores it and the phone reads it. */
export interface RegistryEntry {
  repo: string;
  sha: string;
  path: string;
  text: string;
}

/** A kept entry and the theme its text parsed to. */
export interface RegistryTheme {
  entry: RegistryEntry;
  theme: Theme;
}

/** True for a repo slug the phone may build a link from. `.` and `..` are never a half. */
export function isRepoSlug(value: string): boolean {
  if (!REPO_PATTERN.test(value)) return false;
  return value.split("/").every((half) => half !== "." && half !== "..");
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
  return { entry: { repo, sha, path, text }, theme: parsed.theme };
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
