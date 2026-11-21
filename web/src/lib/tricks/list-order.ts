import type { OfficialTricksReply, WireOfficialTrick, WireTrickInfo } from "./schema";

// THE ORDER OF SETTINGS → TRICKS (2026-11-12). One list, each trick once, in an order that never depends on a
// trick's state, so adding, removing, switching on or off, or a rights change alters a row, never its place:
//
//   1. the official tricks, in the order of the list this release carries (bridge/tricks/official.json, Morph
//      first): an entry that is not added yet holds its place with Add, and the added trick takes the same
//      place, under the same key, once it is installed;
//   2. then every other trick, the community's, by name and then by id. The compare is by code unit after a
//      locale-blind lower case, so the order is the same on every phone in every language.
//
// An entry another trick holds (`taken`: the person's own folder of that id, an unlisted ref, edited files) is
// not an official row: that trick is a community row and carries the entry, so its row can say why.

/** Where a row's trick comes from, for its label. Undefined while the phone does not know (no official list). */
export type TrickOrigin = "official" | "community";

/** One row of the list: an installed trick, or an official entry that is not added yet. */
export type TrickListRow =
  | { kind: "trick"; key: string; trick: WireTrickInfo; origin: TrickOrigin | undefined; entry: WireOfficialTrick | undefined }
  | { kind: "official"; key: string; entry: WireOfficialTrick };

/** Community order: by name (lower case, code units), then by id, then by host. Locale-blind. */
export function compareCommunity(a: Pick<WireTrickInfo, "name" | "id" | "host">, b: Pick<WireTrickInfo, "name" | "id" | "host">): number {
  const byName = codeUnitCompare(textOf(a, "name").toLowerCase(), textOf(b, "name").toLowerCase());
  if (byName !== 0) return byName;
  const byId = codeUnitCompare(textOf(a, "id"), textOf(b, "id"));
  if (byId !== 0) return byId;
  return codeUnitCompare(textOf(a, "host"), textOf(b, "host"));
}

/**
 * One field as text for the order, or "" when it cannot be read. A row that cannot be drawn keeps its switch
 * behind its own boundary (TrickBoundary); the order must not throw for it and take every other row down.
 */
function textOf(trick: Pick<WireTrickInfo, "name" | "id" | "host">, key: "name" | "id" | "host"): string {
  try {
    return String(trick[key]);
  } catch {
    return "";
  }
}

function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The official entries the order may read: none from a list that is not this machine's (a crew member's). */
function officialOf(list: OfficialTricksReply | null): readonly WireOfficialTrick[] | null {
  if (list === null || list.runsOn !== undefined || list.gate !== undefined) return null;
  return list.tricks;
}

/**
 * The rows of Settings → Tricks and the Hill, in order. `list` is the official list as read, or null while it is unknown
 * (not read, a failed read, a machine that runs none): then every trick is a row by name, with no label.
 */
export function trickListRows(tricks: readonly WireTrickInfo[], list: OfficialTricksReply | null): TrickListRow[] {
  const official = officialOf(list);
  if (official === null) return tricks.toSorted(compareCommunity).map((trick) => ({ kind: "trick", key: `c:${trick.host}/${trick.id}`, trick, origin: undefined, entry: undefined }));
  const rows: TrickListRow[] = [];
  const placed = new Set<WireTrickInfo>();
  const seen = new Set<string>();
  for (const entry of official) {
    if (seen.has(entry.id) || entry.state === "taken") continue;
    seen.add(entry.id);
    const trick = tricks.find((candidate) => candidate.id === entry.id && !placed.has(candidate));
    if (trick === undefined) {
      rows.push({ kind: "official", key: `o:${entry.id}`, entry });
      continue;
    }
    placed.add(trick);
    rows.push({ kind: "trick", key: `o:${entry.id}`, trick, origin: "official", entry });
  }
  const taken = new Map(official.filter((entry) => entry.state === "taken").map((entry) => [entry.id, entry]));
  const community = tricks.filter((trick) => !placed.has(trick)).toSorted(compareCommunity);
  for (const trick of community) rows.push({ kind: "trick", key: `c:${trick.host}/${trick.id}`, trick, origin: "community", entry: taken.get(trick.id) });
  return rows;
}
