/** What `shareEqual` walks: data that arrived as JSON (an absent optional field reads `undefined`). */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * `next`, with every part that deep-equals the matching part of `prev` swapped for `prev`'s own
 * object. When nothing changed, `prev` itself comes back, so a caller can compare one reference and
 * skip the state update entirely. When one file changed, every other repo and file keeps its
 * identity, so a memo keyed on them holds. For data parsed from JSON only.
 */
export function shareEqual<T>(prev: T, next: T): T {
  // SAFETY: both sides are JSON the bridge sent (the doc above), and the walk returns either `prev`
  // or a value that deep-equals `next`, so the result has `next`'s type.
  return shareJson(prev as JsonValue, next as JsonValue) as T;
}

function shareJson(prev: JsonValue, next: JsonValue): JsonValue {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const kept = shareJson(prev[i], item);
      if (kept !== prev[i]) same = false;
      return kept;
    });
    return same ? prev : out;
  }
  if (isObject(prev) && isObject(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: JsonObject = {};
    for (const key of keys) {
      const kept = shareJson(prev[key], next[key]);
      if (!Object.hasOwn(prev, key) || kept !== prev[key]) same = false;
      out[key] = kept;
    }
    return same ? prev : out;
  }
  return next;
}

function isObject(value: JsonValue): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}
