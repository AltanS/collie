// A theme from a file or a paste that IS a listed theme (theme sources): the same About links and
// Update a theme installed from Browse gets. Pure, so the import path and the About sheet share it.
//
// MATCHED ON CONTENT, NEVER ON A NAME. Both sides go through `parseTheme`, and a match is the same
// canonical JSON (keys sorted at every depth), so white space and key order do not matter and one
// colour of difference is no match. An id or a name alone never matches.
//
// ONE ENTRY OR NOTHING. Two entries with the same content (a fork, a copy) give no source: Collie
// never guesses which repository a file came from. An entry this Collie cannot read (a newer
// version, whatever the host's `newer` flag says) never matches.
//
// THE HOST'S EXISTING COPY ONLY. The caller passes the list `GET /api/themes/registry` answered;
// nothing here, and nothing that calls it, makes the host fetch. No copy, no match.
//
// Like `schema.ts` and `registry.ts`, this file loads without a DOM or React.

import { asJsonObject, parseJsonObject, type JsonObject, type JsonValue } from "../json";
import { readRegistryEntry } from "./registry";
import type { ThemeSourceRef } from "./origin";
import { THEME_MAX_BYTES, parseTheme, type Theme } from "./schema";

/** A JSON value with every object's keys sorted, so two equal themes write one string. */
function sorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sorted);
  const record = asJsonObject(value);
  if (record === undefined) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(record).toSorted()) {
    const inner = record[key];
    if (inner !== undefined) out[key] = sorted(inner);
  }
  return out;
}

/** The canonical form of a theme the parser accepted: its JSON with sorted keys. */
function canonical(theme: Theme): string {
  const doc = parseJsonObject(JSON.stringify(theme));
  return doc === undefined ? "" : JSON.stringify(sorted(doc));
}

/** The canonical form of a theme after the parser, or undefined when the parser refuses it. */
function canonicalTheme(theme: Theme): string | undefined {
  const parsed = parseTheme(JSON.stringify(theme), { maxBytes: THEME_MAX_BYTES });
  return parsed.ok ? canonical(parsed.theme) : undefined;
}

/** True when two themes are the same theme: equal after the parser, key order aside. */
export function sameTheme(a: Theme, b: Theme): boolean {
  const left = canonicalTheme(a);
  return left !== undefined && left === canonicalTheme(b);
}

/** A source on the community list: its repo, file and commit. */
export type ListedSource = Extract<ThemeSourceRef, { kind: "registry" }>;

/**
 * The source of `theme` on the host's copy of the list: the repo, file and commit of the one entry
 * whose theme is the same, or undefined for none, for two or more, and for a theme the parser refuses.
 */
export function matchRegistryOrigin(theme: Theme, themes: readonly JsonValue[]): ListedSource | undefined {
  const wanted = canonicalTheme(theme);
  if (wanted === undefined) return undefined;
  let found: ListedSource | undefined;
  for (const value of themes) {
    const item = readRegistryEntry(value);
    if (item === undefined || canonical(item.theme) !== wanted) continue;
    if (found !== undefined) return undefined;
    found = { kind: "registry", repo: item.entry.repo, path: item.entry.path, sha: item.entry.sha };
  }
  return found;
}
