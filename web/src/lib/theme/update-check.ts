// Update (theme sources): does the host's copy of the community list hold a newer file for a theme
// this phone installed from it? Pure, so the About sheet only draws the answer.
//
// MATCHED ON THE FILE, NEVER ON THE ID. A fork of the starter keeps the id `petal`, so an id match
// would offer one maker's file as an update to another's. The match is the (repo, path) pair, exact.
//
// NEVER A DOWNGRADE. A copy the host fetched before the install may list an older commit of the same
// file. So a different sha counts only when the copy's `generated` is later than the install time;
// a copy that is not, or that has no stamp, is "unknown", and the sheet offers Check for updates,
// which is the same one tap Refresh is in Browse. Nothing here fetches.

import { readRegistryEntry, type RegistryTheme } from "./registry";
import type { ThemeOrigin } from "./origin";
import type { JsonValue } from "../json";

export type UpdateCheck =
  /** The list holds another commit of the same file, from after the install. */
  | { kind: "newer"; item: RegistryTheme }
  /** The list was made after the install and holds this commit, or a check found nothing newer. */
  | { kind: "current" }
  /** The list was made after the install and no longer holds the file. */
  | { kind: "unlisted" }
  /** The copy is missing or older than the install: only a check can say. */
  | { kind: "unknown" };

interface CopyOfList {
  generated: string | null;
  themes: readonly JsonValue[];
}

type RegistryOrigin = Extract<ThemeOrigin, { kind: "registry" }>;

/** What the host's copy says about `origin`. `checked`: the person already asked the host to fetch once. */
export function checkForUpdate(origin: RegistryOrigin, copy: CopyOfList, checked: boolean): UpdateCheck {
  const made = copy.generated === null ? Number.NaN : Date.parse(copy.generated);
  if (!(made > origin.at)) return checked ? { kind: "current" } : { kind: "unknown" };
  for (const value of copy.themes) {
    const item = readRegistryEntry(value);
    if (item === undefined || item.entry.repo !== origin.repo || item.entry.path !== origin.path) continue;
    return item.entry.sha === origin.sha ? { kind: "current" } : { kind: "newer", item };
  }
  return { kind: "unlisted" };
}
