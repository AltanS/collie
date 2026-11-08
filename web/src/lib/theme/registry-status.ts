// The host's status of the community theme list, read on the phone (F11).
//
// `GET` and `POST /api/themes/registry` answer a status object. The host is the person's own, but it
// may be older or newer than this page, so the page checks the shape before it draws from it, as it
// checks every entry (registry.ts): a field of the wrong type takes its empty value, an error word it
// does not know is dropped, and a body that is not an object is no status at all. Web-only: the
// bridge writes this object and never reads it.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";
import type { ThemeRegistryStatus } from "@/lib/types";

const REGISTRY_ERRORS = ["fetch-failed", "too-big", "bad-registry"] as const satisfies readonly NonNullable<ThemeRegistryStatus["error"]>[];

/** The longest date stamp or address kept from a status. */
const STATUS_TEXT_MAX = 200;

function boundedText(value: JsonValue | undefined): string | null {
  const text = asJsonString(value);
  return text !== undefined && text.length <= STATUS_TEXT_MAX ? text : null;
}

function count(value: JsonValue | undefined): number | null {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The status as the phone may use it, or undefined when the body is not an object. */
export function readRegistryStatus(value: JsonValue | undefined): ThemeRegistryStatus | undefined {
  const record = asJsonObject(value);
  if (record === undefined) return undefined;
  const status: ThemeRegistryStatus = {
    fetchedAt: boundedText(record.fetchedAt),
    ageMs: count(record.ageMs),
    generated: boundedText(record.generated),
    themes: Array.isArray(record.themes) ? record.themes : [],
    dropped: count(record.dropped) ?? 0,
    fetching: asJsonBoolean(record.fetching) === true,
  };
  const error = REGISTRY_ERRORS.find((word) => word === record.error);
  if (error !== undefined) status.error = error;
  const address = boundedText(record.address);
  if (address !== null) status.address = address;
  return status;
}
