// Where the linked parts live, and which are linked (M99 spec 09, README decision 12).
//
// `collie harness link <harness>` writes the part and a record; `collie harness unlink <harness>` removes both. The
// bridge reads the records to open the inside socket only when at least one harness is linked, so a
// link needs no restart of anything the verb does not own. One folder per machine user, shared by every
// Collie instance on it: an instance never keeps a part of its own, and a link never replaces a newer
// part with an older one.
//
// Pure paths and one read; nothing here writes.

import { isAbsolute, join } from "node:path";

import { asJsonNumber, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";

const LINK_SUFFIX = ".link.json";

/** `$XDG_CONFIG_HOME` when it is absolute (the spec ignores a relative one), else `~/.config`. */
export function configHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const declared = env.XDG_CONFIG_HOME?.trim() ?? "";
  return declared !== "" && isAbsolute(declared) ? declared : join(home, ".config");
}

/** The parts folder when nothing moves it: `~/.config/collie/inside`. */
export function defaultPartsRoot(home: string): string {
  return join(home, ".config", "collie", "inside");
}

/**
 * The machine's parts folder: `COLLIE_PARTS_DIR` when absolute, else `<config home>/collie/inside`.
 * The CLI and the bridge must read the same one, and a supervised bridge does not inherit the shell:
 * the service definition carries `COLLIE_PARTS_DIR` whenever the CLI's folder is not the default
 * (`cli/unit.ts` bridgeEnvironment), and the bridge names its folder in its hook target file so
 * `collie doctor` can compare (`link-folder`).
 */
export function partsRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const pinned = env.COLLIE_PARTS_DIR?.trim() ?? "";
  if (pinned !== "" && isAbsolute(pinned)) return pinned;
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
