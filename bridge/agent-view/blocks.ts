// Morph's blocks: a screen is a list of top-level nodes, each with a stable id and the time it was last
// set, kept or shown (web/src/lib/agent-view/wire.ts, "A SCREEN IS A LIST OF BLOCKS"). This file holds the
// pure edits the block verbs make to a screen (`morph set`, `pending`, `remove`, `keep`) and the socket
// fields they read. The service (service.ts) runs each edit, checks the WHOLE screen that results with
// `parseAgentView`, and stores it only when it passes: a refused edit leaves the screen as it was.

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import {
  cleanViewLine,
  VIEW_BLOCK_ID_RE,
  VIEW_CHOICE_BLOCK,
  VIEW_PENDING_MAX,
  viewBlocksOf,
  nextBlockId,
  type ViewBlock,
  type ViewScreen,
} from "../../web/src/lib/agent-view/wire.ts";
import { readImageFields, type ViewFieldError, type ViewImageInput } from "./media.ts";
import type { ViewRefusalCode } from "./service.ts";

/** Where a block goes: at the end (or where it stands, when it exists), first, or after another block. */
export type ViewPlace = { readonly kind: "end" } | { readonly kind: "first" } | { readonly kind: "after"; readonly id: string };

/** A screen being edited: its nodes as JSON and its blocks, one per node, same order. */
export interface ViewDraft {
  readonly nodes: readonly JsonValue[];
  readonly blocks: readonly ViewBlock[];
}

/** An edit's refusal, in the words the CLI prints. */
export interface ViewEditError {
  readonly error: string;
}

/** The node a pending block holds, so every index of `view` stays aligned with `blocks`. */
export const PENDING_NODE: JsonObject = { kind: "spacer" };

/** The screen as a draft: no screen is an empty one. */
export function draftOf(view: ViewScreen | undefined): ViewDraft {
  if (view === undefined) return { nodes: [], blocks: [] };
  const nodes = parseJson(JSON.stringify(view.view));
  return { nodes: Array.isArray(nodes) ? nodes : [], blocks: viewBlocksOf(view) };
}

/** The blocks of a `show`: the ids its nodes named, `b1`, `b2`… for the rest, every one stamped `at`. */
export function shownBlocks(ids: readonly (string | null)[], at: string): ViewBlock[] {
  const taken = new Set(ids.filter((id): id is string => id !== null));
  return ids.map((id) => {
    if (id !== null) return { id, at };
    const minted = nextBlockId(taken);
    taken.add(minted);
    return { id: minted, at };
  });
}

function blockWords(id: string): string {
  return `no block "${id}" on this screen`;
}

/**
 * Put one block at its place: replace the block with that id where it stands, or insert it at the end,
 * first, or after another block. A place given for a block that exists moves it there.
 */
export function placed(draft: ViewDraft, { node, block, place }: { node: JsonValue; block: ViewBlock; place: ViewPlace }): ViewDraft | ViewEditError {
  const at = draft.blocks.findIndex((held) => held.id === block.id);
  if (at >= 0 && place.kind === "end") {
    return { nodes: draft.nodes.map((held, i) => (i === at ? node : held)), blocks: draft.blocks.map((held, i) => (i === at ? block : held)) };
  }
  if (place.kind === "after" && place.id === block.id) return { error: `a block cannot go after itself ("${block.id}")` };
  const nodes = draft.nodes.filter((_, i) => i !== at);
  const blocks = draft.blocks.filter((_, i) => i !== at);
  const index = insertAt(blocks, place);
  if (index === null) return { error: blockWords(place.kind === "after" ? place.id : block.id) };
  return { nodes: [...nodes.slice(0, index), node, ...nodes.slice(index)], blocks: [...blocks.slice(0, index), block, ...blocks.slice(index)] };
}

function insertAt(blocks: readonly ViewBlock[], place: ViewPlace): number | null {
  switch (place.kind) {
    case "end":
      return blocks.length;
    case "first":
      return 0;
    case "after": {
      const at = blocks.findIndex((held) => held.id === place.id);
      return at < 0 ? null : at + 1;
    }
  }
}

/** The screen without one block. The last block cannot go: a screen holds at least one, and `morph clear` takes the screen. */
export function removed(draft: ViewDraft, id: string): ViewDraft | ViewEditError {
  const at = draft.blocks.findIndex((held) => held.id === id);
  if (at < 0) return { error: blockWords(id) };
  if (draft.blocks.length === 1) return { error: "a screen keeps at least one block; `morph clear` takes the whole screen away" };
  return { nodes: draft.nodes.filter((_, i) => i !== at), blocks: draft.blocks.filter((_, i) => i !== at) };
}

/** The screen with these blocks stamped `at` again: still valid for the current request. Every id must name a block. */
export function keptBlocks(draft: ViewDraft, { ids, at }: { ids: readonly string[] | "all"; at: string }): ViewDraft | ViewEditError {
  if (ids !== "all") {
    const missing = ids.find((id) => id !== VIEW_CHOICE_BLOCK && !draft.blocks.some((held) => held.id === id));
    if (missing !== undefined) return { error: blockWords(missing) };
  }
  const keep = (id: string) => ids === "all" || ids.includes(id);
  return { nodes: draft.nodes, blocks: draft.blocks.map((held) => (keep(held.id) ? { ...held, at } : held)) };
}

// ── the socket's fields ──────────────────────────────────────────────────────────────────────────

/** The keys every socket request carries around a view op's own fields (bridge/walky/parse.ts). */
export const VIEW_REQUEST_KEYS: readonly string[] = ["v", "op", "markers", "trick", "session"];

/**
 * Fault C: an agent view is contract 2 only, read CLOSED. A field this Collie does not know on a write
 * refuses the write, in plain words that name the key, and nothing changes: a newer key may carry a
 * meaning this Collie cannot keep, and the agent can simply write again without it. Null: every key known.
 */
export function unknownViewField(fields: JsonObject, own: readonly string[], code: ViewRefusalCode): ViewFieldError | null {
  const extra = Object.keys(fields).find((key) => !VIEW_REQUEST_KEYS.includes(key) && !own.includes(key));
  if (extra === undefined) return null;
  return { error: `this write takes ${own.map((key) => `"${key}"`).join(", ")}, not "${extra}"; an agent view uses only the keys this Collie knows, so nothing was changed`, code };
}

/** A block id field: the pattern, and never the word that names the decision block. */
function blockId(raw: JsonValue | undefined, what = "a block id"): { readonly id: string } | ViewFieldError {
  const id = asJsonString(raw);
  if (id === undefined || !VIEW_BLOCK_ID_RE.test(id) || id === VIEW_CHOICE_BLOCK) return { error: `${what} is 1 to 32 of a-z, 0-9 and -, and not "${VIEW_CHOICE_BLOCK}"`, code: "bad_block" };
  return { id };
}

/** `after` (a block id) or `first` (true), never both; neither is the end. */
function placeOf(fields: JsonObject): ViewPlace | ViewFieldError {
  const first = asJsonBoolean(fields.first) === true;
  if (fields.after === undefined || fields.after === null) return first ? { kind: "first" } : { kind: "end" };
  if (first) return { error: "a block goes --first or --after <id>, not both", code: "bad_block" };
  const after = blockId(fields.after, "--after");
  return "error" in after ? after : { kind: "after", id: after.id };
}

/** `morph.set`'s fields: the block id, ONE node, where it goes, and pictures to add to the screen's set. */
export interface ViewSetFields {
  readonly id: string;
  readonly node: JsonValue;
  readonly place: ViewPlace;
  readonly images: readonly ViewImageInput[];
}

export function readSetFields(fields: JsonObject): ViewSetFields | ViewFieldError {
  const unknown = unknownViewField(fields, ["id", "node", "after", "first", "images"], "bad_view");
  if (unknown !== null) return unknown;
  const checked = blockId(fields.id);
  if ("error" in checked) return checked;
  const id = checked.id;
  if (fields.node === undefined || fields.node === null) return { error: "a block is one node", code: "bad_view" };
  const place = placeOf(fields);
  if ("error" in place) return place;
  const images = readImageFields(fields.images);
  if ("error" in images) return images;
  return { id, node: fields.node, place, images };
}

/** `morph.pending`'s fields: the block id, its label, where it goes. */
export interface ViewPendingFields {
  readonly id: string;
  readonly label: string;
  readonly place: ViewPlace;
}

export function readPendingFields(fields: JsonObject): ViewPendingFields | ViewFieldError {
  const unknown = unknownViewField(fields, ["id", "label", "after", "first"], "bad_block");
  if (unknown !== null) return unknown;
  const checked = blockId(fields.id);
  if ("error" in checked) return checked;
  const id = checked.id;
  const raw = asJsonString(fields.label);
  const label = raw === undefined ? null : cleanViewLine(raw, VIEW_PENDING_MAX);
  if (label === null) return { error: `a pending block's label is one line of 1 to ${String(VIEW_PENDING_MAX)} characters`, code: "bad_block" };
  const place = placeOf(fields);
  if ("error" in place) return place;
  return { id, label, place };
}

/** `morph.remove`'s field: the block id. */
export function readRemoveFields(fields: JsonObject): { readonly id: string } | ViewFieldError {
  return unknownViewField(fields, ["id"], "bad_block") ?? blockId(fields.id);
}

/** `morph.choice`'s fields: the decision block, or null to drop it (`clear: true`). */
export function readChoiceFields(fields: JsonObject): { readonly choice: JsonValue | null } | ViewFieldError {
  const unknown = unknownViewField(fields, ["choice", "clear"], "bad_choice");
  if (unknown !== null) return unknown;
  if (asJsonBoolean(fields.clear) === true) {
    return fields.choice === undefined || fields.choice === null ? { choice: null } : { error: "`--clear` takes no choice", code: "bad_choice" };
  }
  if (fields.choice === undefined || fields.choice === null) return { error: "name the choice's JSON file, or --clear", code: "bad_choice" };
  return { choice: fields.choice };
}

/** `morph.keep`'s fields: block ids (and `choice`), or every block (`all: true`). */
export function readKeepFields(fields: JsonObject): { readonly ids: readonly string[] | "all" } | ViewFieldError {
  const unknown = unknownViewField(fields, ["ids", "all"], "bad_block");
  if (unknown !== null) return unknown;
  if (asJsonBoolean(fields.all) === true) return Array.isArray(fields.ids) && fields.ids.length > 0 ? { error: "`--all` takes no ids", code: "bad_block" } : { ids: "all" };
  if (!Array.isArray(fields.ids) || fields.ids.length === 0) return { error: "name the blocks to keep, or --all", code: "bad_block" };
  const ids: string[] = [];
  for (const raw of fields.ids) {
    const id = asJsonString(raw);
    if (id === VIEW_CHOICE_BLOCK) {
      ids.push(id);
      continue;
    }
    const checked = blockId(raw);
    if ("error" in checked) return checked;
    ids.push(checked.id);
  }
  return { ids };
}
