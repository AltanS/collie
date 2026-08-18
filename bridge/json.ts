// The one name for "a value that came out of (or is going into) JSON.parse/JSON.stringify".
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
