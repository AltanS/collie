import { createHash } from "node:crypto";

import { asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { HILL_GROUP_HASH_RE, HILL_GROUP_PARTS, type HillCollieRef, type HillGroup, type HillGroupPart, type HillOption } from "../../web/src/lib/hill/wire.ts";
import { DECISION_VIEW_LIMITS, parseDecisionView, type View } from "../../web/src/lib/tricks/schema.ts";
import type { JsonValue } from "../json.ts";

// A GROUP OF CARDS (crew slice 8). One Decision of Collie's own whose code does not fit one card carries
// 2 to 8 cards (`HillDecision.group`). Each card is a Decision view under the one view cap
// (`DECISION_VIEW_LIMITS`), read by the schema's own reader, and stored with the SHA-256 of its JSON text.
// The group's digest covers the Decision's `ref` (the trick, and the hash of its code) and the cards'
// hashes in order, so a card that changes, moves or goes changes the digest.
//
// Only `HillService.postCollie` makes one: the post readers refuse `group` from an agent, a crew member
// or a trick (parse.ts `readPostFields`, service.ts `postAny`), and the decisions file reads one only on a
// Decision of Collie's own whose hashes all match (parse.ts `readDecision`).

/** The SHA-256 of a card's view as stored: its JSON text. */
export function groupPartHash(view: View): string {
  return createHash("sha256").update(JSON.stringify(view)).digest("hex");
}

/** The group's digest: the Decision's ref and the cards' hashes, in order. */
export function groupDigest(ref: HillCollieRef, hashes: readonly string[]): string {
  return createHash("sha256").update(["collie-hill-group", ref.type, ref.id, ref.hash, ...hashes].join("\0")).digest("hex");
}

/** One card's view through the schema's reader, within the view cap, or null. */
function readPartView(value: JsonValue | undefined): View | null {
  if (value === undefined) return null;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DECISION_VIEW_LIMITS.bytes) return null;
  return parseDecisionView(value, "/group").view ?? null;
}

/** A group from a post's cards, or the words of its refusal. */
export function makeGroup(input: { decline: string; parts: readonly View[] }, ref: HillCollieRef, options: readonly HillOption[]): { ok: true; group: HillGroup } | { ok: false; error: string } {
  if (input.parts.length < HILL_GROUP_PARTS.min || input.parts.length > HILL_GROUP_PARTS.max) return { ok: false, error: `a group has ${String(HILL_GROUP_PARTS.min)} to ${String(HILL_GROUP_PARTS.max)} cards` };
  if (!options.some((option) => option.intent === input.decline)) return { ok: false, error: "a group's decline is one of its options" };
  const parts: HillGroupPart[] = [];
  for (const raw of input.parts) {
    // Through JSON and the reader, so the hash is of the text the file and the phone hold.
    const view = readPartView(parseJson(JSON.stringify(raw)));
    if (view === null) return { ok: false, error: `card ${String(parts.length + 1)} of the group is refused by the view's reader` };
    parts.push({ view, sha256: groupPartHash(view) });
  }
  return { ok: true, group: { digest: groupDigest(ref, parts.map((part) => part.sha256)), decline: input.decline, parts } };
}

/** A stored group, read back: every card through the view reader, every hash and the digest checked. Null when any fails. */
export function readGroup(value: JsonValue | undefined, ref: HillCollieRef, options: readonly HillOption[]): HillGroup | null {
  const row = asJsonObject(value);
  const digest = asJsonString(row?.digest);
  const decline = asJsonString(row?.decline);
  const rawParts = Array.isArray(row?.parts) ? row.parts : undefined;
  if (digest === undefined || !HILL_GROUP_HASH_RE.test(digest) || decline === undefined || rawParts === undefined) return null;
  if (rawParts.length < HILL_GROUP_PARTS.min || rawParts.length > HILL_GROUP_PARTS.max) return null;
  if (!options.some((option) => option.intent === decline)) return null;
  const parts: HillGroupPart[] = [];
  for (const entry of rawParts) {
    const part = asJsonObject(entry);
    const sha256 = asJsonString(part?.sha256);
    const view = readPartView(part?.view);
    if (view === null || sha256 === undefined || groupPartHash(view) !== sha256) return null;
    parts.push({ view, sha256 });
  }
  return groupDigest(ref, parts.map((part) => part.sha256)) === digest ? { digest, decline, parts } : null;
}
