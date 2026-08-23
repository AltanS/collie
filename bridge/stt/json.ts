import type { JsonObject, JsonValue } from "../json.ts";

// The two readers every untrusted JSON under `bridge/stt/` is narrowed through: the settings file
// on disk (`config.ts`) and the provider's HTTP response (`openai.ts`). They live in one file so
// the feature has exactly ONE place where a representation check happens, rather than the same
// three-line narrowing copied into each parse site with a chance to differ.

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
