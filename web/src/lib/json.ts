// The one name for "a value that came out of (or is going into) JSON.parse/JSON.stringify".
//
// The web mirror of `bridge/json.ts` — the two trees are type-checked separately (web/tsconfig.json
// includes only `src`), so the type is restated rather than imported. Keep them identical.
//
// It exists so boundary code can say what it actually knows instead of falling back to `unknown`
// and re-asserting at every field access: everything reachable inside a parsed document IS one of
// these, by construction. `undefined` is admitted as an OBJECT PROPERTY value only — it is not a
// JSON value, but `JSON.stringify` drops such a key entirely, so a builder that leaves an optional
// field `undefined` produces exactly the document that omits it.

/** Any value JSON can carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. Optional properties are allowed; `JSON.stringify` omits them. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * Parse a JSON document into the only type that describes it. Returns `undefined` when the text
 * isn't JSON at all, so a caller branches on a value instead of wrapping every read in try/catch.
 */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction — a string, number, boolean, null,
    // an array of those, or an object of those. There is nothing else it can return.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** The parsed document narrowed to an object — `undefined` for a scalar, an array, `null`, or junk. */
export function parseJsonObject(text: string): JsonObject | undefined {
  return asJsonObject(parseJson(text));
}

/**
 * A JSON value narrowed to a string, or `undefined` when it is anything else.
 *
 * The tag check rather than `typeof` is deliberate: this module IS the boundary the lint rule
 * points at, so the representation question is asked here, once, and every caller downstream
 * branches on a domain value it can trust.
 */
export function asJsonString(value: JsonValue | undefined): string | undefined {
  // SAFETY: `Object.prototype.toString` reports the value's own primitive tag. It cannot be spoofed
  // by a parsed document — `Symbol.toStringTag` is a symbol key and `JSON.parse` only ever produces
  // string keys — so `[object String]` means the value IS a string.
  return Object.prototype.toString.call(value) === "[object String]"
    ? (value as string)
    : undefined;
}

/** A JSON value narrowed to a number, or `undefined` when it is anything else (NaN included —
 *  `JSON.parse` never produces one, so a NaN here came from somewhere that isn't JSON). */
export function asJsonNumber(value: JsonValue | undefined): number | undefined {
  // SAFETY: as in `asJsonString` — the tag reports the value's own primitive class, and
  // `[object Number]` cannot be produced by anything else `JSON.parse` returns.
  if (Object.prototype.toString.call(value) !== "[object Number]") return undefined;
  const n = value as number;
  return Number.isNaN(n) ? undefined : n;
}

/** A JSON value narrowed to a boolean, or `undefined` when it is anything else. */
export function asJsonBoolean(value: JsonValue | undefined): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

/** A JSON value narrowed to an object, or `undefined` when it is anything else. */
export function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return undefined;
  if (!(value instanceof Object)) return undefined;
  return value;
}
