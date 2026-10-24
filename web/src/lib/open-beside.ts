// "New agent in this space" on a large screen (ADR 0120): the new pane opens BESIDE the focused column.
//
// The add column's sheet sends the person to the New page with the pane whose space the agent starts
// in. The New page is a different route, so the strip is not mounted while the agent starts, and the
// pane that comes back is one the strip has never held. Left alone the strip would replace the focused
// column with it (`arrive`). This note, left by the sheet, makes it open beside the focus instead.
//
// The note carries the panes the space held when it was left, so only a pane the space did NOT have
// counts as the new one: a visit to any other pane of the space, after the person backed out of the
// New page, never opens beside. It is in memory only (a reload forgets it, and the pane then simply
// replaces the focus) and it expires, so a start abandoned for good does not wait forever.

/** How long a note waits for its pane: the person may take their time on the New page. */
export const OPEN_BESIDE_TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, { known: ReadonlySet<string>; at: number }>();

/** Leave a note for the space at `spaceKey`, with the column keys it holds now. A newer note replaces it. */
export function queueOpenBeside(spaceKey: string, known: Iterable<string>, now: number = Date.now()): void {
  pending.set(spaceKey, { known: new Set(known), at: now });
}

/** Whether the pane at `columnKey` is the new pane the space was waiting for. Reads; takes nothing. */
export function isOpenBeside(spaceKey: string, columnKey: string, now: number = Date.now()): boolean {
  const note = pending.get(spaceKey);
  return note !== undefined && now - note.at <= OPEN_BESIDE_TTL_MS && !note.known.has(columnKey);
}

/** The strip took the note: forget it. */
export function takeOpenBeside(spaceKey: string): void {
  pending.delete(spaceKey);
}

/** Test seam. */
export function __resetOpenBeside(): void {
  pending.clear();
}
