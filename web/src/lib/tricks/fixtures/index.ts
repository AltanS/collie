// The tricks fixtures, by name, for the schema's tests and for slices 01 (the runner) and 02 (the
// renderer). Each valid document parses with zero refusals; each refused one names the exact paths
// its refusals carry. Load with relative imports only, like the schema, so the bridge can use them.

import { asJsonString, type JsonObject, type JsonValue } from "../../json";
import type { NodeKind, PlaceKind } from "../schema";

import facts from "./facts.json";
import legs from "./legs.json";
import manifests from "./manifests.json";
import nodes from "./nodes.json";
import places from "./places.json";
import refused from "./refused.json";
import replies from "./replies.json";
import tracker from "./tracker.json";

/**
 * One valid document per place. `dashboard`, `header.line`, `menu` and `settings` are later places:
 * they parse clean only with `places: PLACE_KINDS`, and give one "later" refusal at `/parts/0/at`
 * with the default.
 */
export const PLACE_DOCUMENTS = places satisfies { readonly [K in PlaceKind]: JsonValue };

/** One small view node per kind, as it would sit in a part's `view`. */
export const NODE_FIXTURES = nodes satisfies { readonly [K in NodeKind]: JsonValue };

/** A node fixture as a whole document: one session part whose view is the node. */
export function nodeDocument(kind: NodeKind): JsonObject {
  return { v: 1, parts: [{ at: "session", id: "node", view: NODE_FIXTURES[kind] }] };
}

/** The legs trick: belt mark `23/34`, a session with the steps, the first red case and "Rerun red". */
export const LEGS_DOCUMENT = legs satisfies JsonValue;

/** The tracker trick: a session listing the `darius due` rows and the next task. */
export const TRACKER_DOCUMENT = tracker satisfies JsonValue;

/** Documents that answer a tap (parse with `afterTap: true`): a draft, an open of a session, an open of a URL. */
export const REPLY_DOCUMENTS = replies satisfies { readonly [name: string]: JsonValue };

/** `trick.toml` after the TOML parse. `later` uses `watch`, `on`, `serve` and a later place. */
export const MANIFESTS = manifests satisfies { readonly [name: string]: JsonValue };

/** Facts documents as the bridge writes them, one per trigger and one for a `view:<match>` run. */
export const FACTS = facts satisfies { readonly [name: string]: JsonValue };

/** A document the parser refuses, and what it must say. */
export interface RefusedFixture {
  doc: JsonValue;
  /** The refusal paths, exactly and in order. */
  paths: string[];
  /** The ids of the parts that still draw. */
  keeps: string[];
  /** Parse it as the reply to a tap. */
  afterTap?: boolean;
  /** The document as a whole is refused (`documentRefused`). */
  whole?: boolean;
}

const encoder = new TextEncoder();

function bytesOf(value: JsonValue): number {
  return encoder.encode(JSON.stringify(value)).length;
}

const ROW_TEXT_MAX = 120;
/** `{"text":""}`: the bytes of a list item around its text. */
const ITEM_FRAME = 11;
const GROW_STEPS = 2000;

/**
 * A valid session part whose compact JSON is exactly `target` bytes: a list whose items are filled
 * with `x`. Every field stays inside its cap, so the only thing a parser can refuse is the size.
 */
export function sessionPartOfBytes(target: number, id = "big"): JsonObject {
  const items: JsonObject[] = [];
  const part: JsonObject = { at: "session", id, view: { kind: "list", rows: 50, items } };
  for (let step = 0; step < GROW_STEPS; step += 1) {
    const rest = target - bytesOf(part);
    if (rest === 0) return part;
    if (rest < 0) throw new Error(`a session part cannot be as small as ${target} bytes`);
    const sep = items.length > 0 ? 1 : 0;
    if (rest >= ITEM_FRAME + sep + 1) {
      items.push({ text: "x".repeat(Math.min(ROW_TEXT_MAX, rest - ITEM_FRAME - sep)) });
      continue;
    }
    // A gap too small for a new item: give the last one back 12 characters, then fill again.
    const last = items.at(-1);
    const text = last === undefined ? undefined : asJsonString(last.text);
    if (last === undefined || text === undefined || text.length <= 12) throw new Error(`cannot reach ${target} bytes`);
    last.text = text.slice(12);
  }
  throw new Error(`did not reach ${target} bytes`);
}

/** A valid document of exactly `target` bytes, from parts of about 16 000 bytes each. */
export function documentOfBytes(target: number): JsonObject {
  const parts: JsonObject[] = [];
  const doc: JsonObject = { v: 1, parts };
  const frame = bytesOf(doc);
  let rest = target - frame;
  for (let i = 0; rest > 0 && i < 24; i += 1) {
    const sep = parts.length > 0 ? 1 : 0;
    const size = rest - sep > 16_000 + 200 ? 16_000 : rest - sep;
    parts.push(sessionPartOfBytes(size, `p${i}`));
    rest = target - bytesOf(doc);
  }
  if (bytesOf(doc) !== target) throw new Error(`did not reach ${target} bytes`);
  return doc;
}

/** Every refused fixture by name, the generated over-size part included. Last in the file: it calls the builders above. */
/** The refused fixtures, keyed by a name that says what is wrong. */
export interface RefusedFixtures {
  readonly [name: string]: RefusedFixture;
}

export const REFUSED: RefusedFixtures = {
  ...refused,
  "oversized-part": {
    doc: { v: 1, parts: [sessionPartOfBytes(16 * 1024 + 1, "big"), { at: "belt", id: "belt", mark: { face: "ok" } }] },
    paths: ["/parts/0"],
    keeps: ["belt"],
  },
};
