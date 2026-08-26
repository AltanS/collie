import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";
import type { OperatorQuickReplyRow } from "./types.ts";

// The operator's own Quick-dock groups, read from `quick-replies.toml` next to their `.env` — the
// third sibling of `commands.toml` and `keys.toml`, down to the discovery rule and the mtime-checked
// live reload (operator-file.ts owns all three).
//
// WHY THIS FILE EXISTS. The shipped dock is a list of English phrases ("yes", "commit and push"),
// and web/src/lib/quick-replies.ts says as much: that list is content policy, not detection. An
// operator whose harness prefers "approve" over "yes", or who simply works in another language, has
// no route to either today — the palette and the tray both grew one, the dock did not.
//
// Replacement (not merge) is the resolution rule, for the reason ADR 0018 gives; resolution itself
// lives client-side in `web/src/lib/quick-replies.ts`. This module only decides what a row IS.

/** A parsed `quick-replies.toml` document, before a byte of it is believed. */
interface QuickRepliesDocument {
  replies?: unknown;
}

/**
 * Turn a parsed TOML document into dock groups, dropping anything malformed with one warning line.
 *
 * Pure and total: it never throws and never reads a file, so the grammar is unit-testable without
 * fs. Every rejection is a DROP of the offending row, never of the file — one typo'd row must not
 * cost the operator the rest of their groups.
 *
 * ```toml
 * [[replies]]
 * scope = "claude"              # optional; omitted = addresses every pane
 * title = "confirm"             # required; the group's heading, and its identity
 * items = ["yes", "no"]         # required; sent verbatim, one per button
 * ```
 *
 * Nothing is defaulted into existence: a row with no `title` or no usable `items` is a row that
 * would render as a nameless or empty group, so it is dropped and said out loud instead.
 */
export function validateOperatorQuickReplies(
  doc: QuickRepliesDocument | null | undefined,
  warn = defaultWarn,
): OperatorQuickReplyRow[] {
  const rows = doc?.replies;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`replies` must be an array of [[replies]] tables — ignoring the file's rows");
    return [];
  }
  const out: OperatorQuickReplyRow[] = [];
  const at = new Map<string, number>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warn("ignoring a row that is not a [[replies]] table");
      continue;
    }
    const row = raw as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (title === "") {
      warn(`ignoring a row with no title: ${JSON.stringify(row.items)}`);
      continue;
    }
    const items = readItems(row.items, title, warn);
    if (items === null) continue;
    let agent = "";
    if (row.scope !== undefined) {
      // Fail closed. Dropping an unusable scope would WIDEN the row to every pane — the opposite of
      // what a scope was typed for.
      if (typeof row.scope !== "string" || row.scope.trim() === "") {
        warn(`ignoring "${title}" — scope must be a non-empty agent name`);
        continue;
      }
      agent = row.scope.trim().toLowerCase();
    }
    const parsed: OperatorQuickReplyRow = {
      ...(agent ? { agent } : {}),
      title,
      items,
    };
    // Identity is scope+title, matching keys.toml's scope+label: two groups sharing one heading on
    // one pane would be two sections a thumb cannot tell apart. The later row wins IN PLACE, so
    // correcting a group does not reshuffle the dock.
    const key = `${agent} ${title}`;
    const prev = at.get(key);
    if (prev !== undefined) {
      warn(`"${title}" redefined — the later row wins`);
      out[prev] = parsed;
      continue;
    }
    at.set(key, out.length);
    out.push(parsed);
  }
  return out;
}

/** The row's `items` array, trimmed of blanks — or null (already warned) when nothing is left. */
function readItems(value: unknown, title: string, warn: (message: string) => void): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    warn(`ignoring "${title}" — items must be a non-empty array of strings`);
    return null;
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      // Unlike a key chord, one bad item does not change what the others send — but a row is a
      // group the operator composed, and silently serving a shorter one hides the typo. Drop the
      // row so the warning is the only surprise.
      warn(`ignoring "${title}" — ${JSON.stringify(entry)} is not a string`);
      return null;
    }
    const item = entry.trim();
    // A blank button would type nothing and submit — the one tap that looks harmless and is not.
    if (item === "") {
      warn(`ignoring "${title}" — an item is blank`);
      return null;
    }
    items.push(item);
  }
  return items;
}

function defaultWarn(message: string): void {
  console.warn(`[quick-replies] ${message}`);
}

/**
 * A reader for the operator's `quick-replies.toml` — the same mtime cache, the same "no file is not
 * an error" rule and the same hold-the-last-good-rows failure posture `commands.toml` and
 * `keys.toml` get, because it is literally the same reader (operator-file.ts).
 */
export function createOperatorQuickReplies(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<OperatorQuickReplyRow[]> {
  return createOperatorFileReader(path, validateOperatorQuickReplies, io, warn);
}
