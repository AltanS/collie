// Where the linked parts live, and which are linked (M99 spec 09, README decision 12).
//
// `collie link <harness>` writes the part and a record; `collie unlink <harness>` removes both. The
// bridge reads the records to open the inside socket only when at least one harness is linked, so a
// link needs no restart of anything the verb does not own. One folder per machine user, shared by every
// Collie instance on it: an instance never keeps a part of its own, and a link never replaces a newer
// part with an older one.
//
// Pure paths and one read; nothing here writes.

import { join } from "node:path";

import { asJsonNumber, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";

const LINK_SUFFIX = ".link.json";

/** `$XDG_CONFIG_HOME`, else `~/.config`. */
export function configHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const declared = env.XDG_CONFIG_HOME?.trim();
  return declared !== undefined && declared !== "" ? declared : join(home, ".config");
}

/** The machine's parts folder: `<config home>/collie/inside`. */
export function partsRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(configHome(env, home), "collie", "inside");
}

/** The link record of one harness: written last by `link`, removed first by `unlink`. */
export function linkRecordPath(env: Readonly<Record<string, string | undefined>>, home: string, harness: string): string {
  return join(partsRoot(env, home), `${harness}${LINK_SUFFIX}`);
}

/** A link record: the harness, the part's version, and the epoch ms of the link. */
export interface LinkRecord {
  readonly harness: string;
  readonly version: string;
  readonly at: number;
}

export function parseLinkRecord(text: string | null, harness: string): LinkRecord | null {
  const row = text === null ? undefined : parseJsonObject(text);
  if (row === undefined || asJsonString(row.harness) !== harness) return null;
  const version = asJsonString(row.version);
  const at = asJsonNumber(row.at);
  return version === undefined || at === undefined ? null : { harness, version, at };
}

/**
 * The harnesses with a valid link record, read from the parts folder: `list` names the folder's
 * entries, `read` returns a file's text or null. The bridge names no harness; the record does.
 */
export function linkedHarnesses(env: Readonly<Record<string, string | undefined>>, home: string, files: { list(path: string): string[]; read(path: string): string | null }): string[] {
  const root = partsRoot(env, home);
  return files
    .list(root)
    .filter((name) => name.endsWith(LINK_SUFFIX))
    .map((name) => name.slice(0, -LINK_SUFFIX.length))
    .filter((harness) => /^[a-z][a-z0-9-]{0,31}$/u.test(harness) && parseLinkRecord(files.read(join(root, `${harness}${LINK_SUFFIX}`)), harness) !== null)
    .toSorted();
}
