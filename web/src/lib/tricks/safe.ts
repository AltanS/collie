// A TOLERANT READER FOR THE NODES OF A VIEW (M94 review), at the door the store reads through.
//
// The bridge's parser checked every part it sent, but a crew member on another version, or a proxy, may
// send a node whose `attrs` or `kids` is missing or of the wrong type, and the renderer reads both
// without asking. This is the one guard, applied to the JSON before it becomes a part (lib/tricks/read.ts):
// a node is an object with a string `kind`; `attrs`, when it is there, is an object (and is there for the
// three kinds whose types require it); `kids`, when it is there, is an array. A node that is not even an
// object with a kind becomes a node of the kind `invalid`, which the renderer's switch draws as the
// placeholder, in its own slot, so one bad node leaves the nodes around it drawn. A kid list that is no
// list reads as empty; a missing one is read as empty by `kidsOf` (layout.ts).
//
// A node that already fits comes out as it went in.

import { asJsonObject, asJsonString, type JsonValue } from "../json";

/** The kinds whose `attrs` the types require, so a node of one with none would be read through `undefined`. */
const ATTRS_REQUIRED: ReadonlySet<string> = new Set(["button", "link", "image"]);

/** The kind of a node that could not be read. The renderer has no case for it, so it draws the placeholder. */
export const INVALID_KIND = "invalid";

/** One node whose `attrs` is an object where it is read and whose `kids`, where it has any, is an array. */
export function safeNode(raw: JsonValue | undefined): JsonValue {
  const node = asJsonObject(raw);
  const kind = asJsonString(node?.kind);
  if (node === undefined || kind === undefined) return { kind: INVALID_KIND, attrs: {} };
  const next = { ...node };
  const fits = asJsonObject(node.attrs) !== undefined || (node.attrs === undefined && !ATTRS_REQUIRED.has(kind));
  if (!fits) next.attrs = {};
  if (node.kids !== undefined) next.kids = Array.isArray(node.kids) ? node.kids.map(safeNode) : [];
  return next;
}

/** A part's value with its `view`, when it has a list, read node by node. Anything else is left as it came. */
export function safeValue(raw: JsonValue | undefined): JsonValue | undefined {
  const value = asJsonObject(raw);
  if (value === undefined || !Array.isArray(value.view)) return raw;
  return { ...value, view: value.view.map(safeNode) };
}
