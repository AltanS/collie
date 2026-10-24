import type { Files } from "./sys.ts";

/**
 * Whether a folder the emitter is about to write into is this user's own and private: a real folder,
 * not a link, owned by this uid, and writable by nobody else. A folder that fails is skipped.
 *
 * Its own module so the beacon emitter, the permission hold, the statusLine wrapper and the usage
 * store share one rule without importing one another (`cli/beacon.ts` re-exports it).
 */
export function privateDir(deps: { readonly files: Files; readonly uid?: number | undefined }, dir: string): boolean {
  if (deps.files.entryType(dir) !== "directory") return false;
  const mode = deps.files.mode(dir);
  if (mode !== null && (mode & 0o022) !== 0) return false;
  return deps.uid === undefined || deps.files.ownerUid(dir) === deps.uid;
}
