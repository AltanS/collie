// The JSON preview's data half: parse a file's text, count what the tree would draw, and refuse a
// document too big to draw (ADR 0083, rule 4 of spec 04). A tree of React nodes for a 1 MiB file is
// tens of thousands of elements on a phone, so the cap is on nodes, and above it the view shows the
// source.

import { asJsonObject, type JsonValue } from "@/lib/json";

/** Above this many values (every object, array and leaf counts one) the tree is not drawn. */
export const JSON_TREE_MAX_NODES = 5000;

export type JsonTreeParse =
  | { kind: "ok"; value: JsonValue; nodes: number }
  | { kind: "error"; message: string }
  | { kind: "tooBig"; nodes: number };

/** How many values the document holds, stopping early once `limit` is passed. */
export function countJsonNodes(value: JsonValue, limit: number): number {
  let seen = 0;
  const stack: JsonValue[] = [value];
  while (stack.length > 0 && seen <= limit) {
    const next = stack.pop();
    if (next === undefined) break;
    seen++;
    // Loops, not `push(...many)`: a spread of a huge array overflows the call's argument limit.
    if (Array.isArray(next)) {
      for (const item of next) stack.push(item);
    } else {
      const object = asJsonObject(next);
      if (object !== undefined) for (const item of Object.values(object)) if (item !== undefined) stack.push(item);
    }
  }
  return seen;
}

/** Parse a file's text for the tree. */
export function parseJsonTree(text: string): JsonTreeParse {
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const nodes = countJsonNodes(value, JSON_TREE_MAX_NODES);
  if (nodes > JSON_TREE_MAX_NODES) return { kind: "tooBig", nodes };
  return { kind: "ok", value, nodes };
}
