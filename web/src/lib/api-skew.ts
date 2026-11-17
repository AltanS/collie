// Says once per page load that the phone's bundle and the bridge differ in their API number (M102 spec
// 14 decision 4, lib/api-version.ts). Only words: the reload stays the self-updater's.

import { apiVersionsDiffer } from "./api-version";
import { t } from "./i18n";
import type { JsonValue } from "./json";
import { setStatus } from "./status";

/** How long the notice stays, in ms. */
const SKEW_NOTICE_MS = 8000;

let said = false;

/** Note the bridge's number from one `/api/config` answer. Says so once per page load when it differs. */
export function noteServerApiVersion(server: JsonValue | undefined): void {
  if (said || !apiVersionsDiffer(server)) return;
  said = true;
  setStatus(t("app.apiSkew"), "warn", SKEW_NOTICE_MS);
}

/** Test seam: forget that the notice was shown. */
export function __resetApiSkew(): void {
  said = false;
}
