import { hostname } from "node:os";

import type { JsonValue } from "../json.ts";

/** The longest host name a lead banks. A DNS name is at most 253 characters (RFC 1035). */
export const HOST_NAME_MAX = 253;

/**
 * Read one machine name off any value, or `null` when it is not a usable one.
 *
 * The one reading both halves of the `host` field use (CREW_PROTOCOL.md §19, M77 spec 01): the
 * member cleans what `os.hostname()` returns before it sends it, and the lead cleans what a member
 * sent before it banks it. `null` means **"this machine did not say"**, never an empty name: a
 * value that is absent, not a string, blank, longer than {@link HOST_NAME_MAX} or holding a control
 * character is all the same silence, and nothing groups on a guess.
 */
export function cleanHost(raw: JsonValue | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > HOST_NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  return /[\u0000-\u001f\u007f]/.test(trimmed) ? null : trimmed;
}

/** This machine's own name, as `os.hostname()` spells it, or `null` where the OS gives none. */
export function machineHost(): string | null {
  return cleanHost(hostname());
}
