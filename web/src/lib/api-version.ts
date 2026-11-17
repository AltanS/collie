// The API number (M102 spec 14 decision 4): a minimal version word between the phone's bundle and the
// bridge. `/api/config` carries the bridge's number as `apiVersion`; the bundle carries its own here.
// When the two differ, the phone runs a bundle from another Collie than the one answering it: an old
// bridge silently ignores a field a newer bundle sends, and an old bundle misreads a newer answer.
// The phone says so once per page load (lib/api-skew.ts). The reload stays the self-updater's
// (lib/self-update.ts), which waits while anything unsent is open; nothing here reloads the page.
//
// Pure, with no DOM and no i18n: the bridge imports the number from here for its `/api/config`.
//
// Bump API_VERSION when a route, a field or a refusal changes in a way the other side reads wrong. A
// pure addition the other side can ignore (additive-optional) needs no bump.

import { asJsonNumber, type JsonValue } from "./json";

/** The API number of this source tree, the bundle's and the bridge's alike. */
export const API_VERSION = 1;

/**
 * Whether the bridge's `apiVersion` differs from this bundle's. An absent or malformed value is a bridge
 * older than the number and says nothing, so it is never read as a difference: the build id already
 * tells that case apart (lib/build.ts `isStaleBuild`).
 */
export function apiVersionsDiffer(server: JsonValue | undefined, bundle: number = API_VERSION): boolean {
  const number = asJsonNumber(server);
  return number !== undefined && Number.isInteger(number) && number !== bundle;
}
