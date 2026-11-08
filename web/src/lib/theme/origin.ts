// Where an imported theme came from: the community list (with its repo, file and commit), a file or a
// paste. The About sheet shows it, and Update compares it with the host's copy of the list.
//
// NEVER INSIDE THE THEME. A theme file has a closed set of keys and `readLibrary` re-parses every
// entry with `parseTheme`, which refuses an unknown key, so an origin there would drop the theme. The
// store keeps origins in a sibling map of the same library blob: `{ version, themes, origins }`. An
// older Collie reads `version` and `themes` and ignores the rest, so a rollback keeps every theme.
//
// CHECKED ON EVERY READ, like the themes beside it. A registry origin's repo, path and sha must pass
// the same patterns a registry entry passes (registry.ts), and `at` must be a whole number of
// milliseconds. A bad origin is dropped and its theme kept: the theme then reads "Added on this
// device". No URL is ever stored; the About sheet builds its links from the checked parts.
//
// Like `schema.ts` and `registry.ts`, this file loads without a DOM or React.

import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import { PATH_PATTERN, SHA_PATTERN, isRepoSlug } from "./registry";

/** Where a theme in a preview came from, before it is kept. */
export type ThemeSourceRef =
  | { kind: "registry"; repo: string; path: string; sha: string }
  | { kind: "file" }
  | { kind: "paste" };

/** Where a kept theme came from, and when it was kept (milliseconds since the epoch). */
export type ThemeOrigin = ThemeSourceRef & { at: number };

/** A source as the trial and the store accept it, or undefined when any part fails its rule. */
export function readSourceRef(value: JsonValue | undefined): ThemeSourceRef | undefined {
  const record = asJsonObject(value);
  if (record === undefined) return undefined;
  const kind = asJsonString(record.kind);
  if (kind === "file" || kind === "paste") return { kind };
  if (kind !== "registry") return undefined;
  const repo = asJsonString(record.repo);
  const path = asJsonString(record.path);
  const sha = asJsonString(record.sha);
  if (repo === undefined || path === undefined || sha === undefined) return undefined;
  if (!isRepoSlug(repo) || !PATH_PATTERN.test(path) || !SHA_PATTERN.test(sha)) return undefined;
  return { kind, repo, path, sha };
}

/** The source of a theme picked from the community list: its repo, file and commit, already checked there. */
export function registryRef(entry: { repo: string; path: string; sha: string }): ThemeSourceRef {
  return { kind: "registry", repo: entry.repo, path: entry.path, sha: entry.sha };
}

/** A stored origin, or undefined when it fails a rule. */
export function readOrigin(value: JsonValue | undefined): ThemeOrigin | undefined {
  const ref = readSourceRef(value);
  const at = asJsonNumber(asJsonObject(value)?.at);
  if (ref === undefined || at === undefined || !Number.isSafeInteger(at) || at < 0) return undefined;
  return { ...ref, at };
}

/** A source kept at `at`. */
export function stamp(ref: ThemeSourceRef, at: number): ThemeOrigin {
  return { ...ref, at };
}

/** The short commit the About sheet shows. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The theme file on GitHub at the commit it was installed from, built from the checked parts. */
export function fileUrl(origin: { repo: string; path: string; sha: string }): string {
  return `https://github.com/${origin.repo}/blob/${origin.sha}/${origin.path}`;
}
