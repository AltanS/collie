import type { JsonObject, JsonValue } from "../json.ts";

// The readers every untrusted JSON under `bridge/stt/` is narrowed through: the settings file on
// disk (`config.ts`), the provider's HTTP response (`transcript.ts`), the JSON-RPC frames the
// operator's own `codex app-server` writes to its stdout (`codex-auth.ts`), and the unverified
// payload of the access token it hands back (`codex.ts`). They live in one file so the feature has
// exactly ONE place where a representation check happens, rather than the same three-line narrowing
// copied into each parse site with a chance to differ.

/** The record inside a parsed JSON value, or null when it is a scalar, an array, or absent. */
export function jsonRecord(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || value === undefined || Array.isArray(value)) return null;
  return value;
}

/** A string field of a parsed JSON value, or null when it is absent or not a string. */
export function jsonStringField(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  return value;
}

/**
 * A finite number field of a parsed JSON value, or null when it is absent or not one.
 *
 * `NaN` and the infinities are refused along with the non-numbers: the only reader is the JSON-RPC
 * correlation id in `codex-auth.ts`, and a non-finite id could never match a request Collie sent.
 */
export function jsonNumberField(value: JsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
