// Update (theme sources): does the host's copy of the community list hold a newer file for a theme
// this phone installed from it? Pure, so the About sheet only draws the answer.
//
// MATCHED ON THE FILE, NEVER ON THE ID. A fork of the starter keeps the id `petal`, so an id match
// would offer one maker's file as an update to another's. The match is the (repo, path) pair: the
// path exact, the repo without regard to case, because GitHub treats `Sam/My-Day` and `sam/my-day`
// as one repository.
//
// NO CLOCK. The list holds the commit the site's sweep last saw, so another commit of the same file
// is the newer one. No time is compared: the phone's clock and the site's are not the same clock, and
// a gate on them hid real updates. `origin.at` stays, for the sheet's install date only. A host with
// no copy yet is "unknown", and the sheet offers Check for updates. Nothing here fetches.
//
// A LISTED FILE THIS COLLIE CANNOT READ is "needs-newer", never "unlisted": the file is still listed,
// at a version a newer Collie reads, and the person's copy keeps working.

import { asJsonObject, asJsonString, type JsonValue } from "../json";
import { readRegistryEntry, type RegistryTheme } from "./registry";
import type { ThemeOrigin } from "./origin";

export type UpdateCheck =
  /** The list holds another commit of the same file. */
  | { kind: "newer"; item: RegistryTheme }
  /** The list holds this commit. */
  | { kind: "current" }
  /** The list holds the file, at a version this Collie cannot read. */
  | { kind: "needs-newer" }
  /** The list no longer holds the file. */
  | { kind: "unlisted" }
  /** The host has no copy of the list yet: only a check can say. */
  | { kind: "unknown" };

interface CopyOfList {
  /** When the host fetched its copy, or null when it never has. */
  fetchedAt: string | null;
  themes: readonly JsonValue[];
}

type RegistryOrigin = Extract<ThemeOrigin, { kind: "registry" }>;

/** True when a raw list entry names the same file as `origin`: the path exact, the repo in any case. */
function sameFile(origin: RegistryOrigin, value: JsonValue): boolean {
  const record = asJsonObject(value);
  if (record === undefined) return false;
  const repo = asJsonString(record.repo);
  const path = asJsonString(record.path);
  return repo !== undefined && path === origin.path && repo.toLowerCase() === origin.repo.toLowerCase();
}

/** What the host's copy says about `origin`. */
export function checkForUpdate(origin: RegistryOrigin, copy: CopyOfList): UpdateCheck {
  if (copy.fetchedAt === null) return { kind: "unknown" };
  let unreadable = false;
  for (const value of copy.themes) {
    if (!sameFile(origin, value)) continue;
    const item = readRegistryEntry(value);
    if (item === undefined) {
      unreadable = true;
      continue;
    }
    return item.entry.sha === origin.sha ? { kind: "current" } : { kind: "newer", item };
  }
  return unreadable ? { kind: "needs-newer" } : { kind: "unlisted" };
}
