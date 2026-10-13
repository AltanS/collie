import type { ReleaseNotes, UpdateNotes } from "./types";

// ── WHICH RELEASE NOTES THE UPDATES PAGE SHOWS (1.21.1) ─────────────────────────────────────────
//
// One list at a time. With a release on offer, the page shows what the offer brings, newest
// first, because that is what the operator is about to confirm. With nothing on offer, it shows
// what the running version changed, which is what an operator who just updated came to read
// ("What changed in 1.21.1").
//
// The host decides what each list holds (`GET /api/update/check`'s `releaseNotes`); this only
// chooses between the two. An offer whose releases published no notes (every release before
// 1.21.1) shows no list rather than falling back to the running version's, because notes about the
// version already installed, under an "Update to" button, read as notes about the update.

export interface NotesView {
  readonly kind: "offered" | "current";
  /** The version the heading names: the newest offered, or the running one. */
  readonly version: string;
  /** Newest first. One entry for `current`. */
  readonly entries: readonly ReleaseNotes[];
}

/** The list the page shows, or null when there is none. */
export function notesView(notes: UpdateNotes | undefined, releaseAvailable: boolean): NotesView | null {
  if (notes === undefined) return null;
  if (releaseAvailable) {
    const offered = notes.offered.filter((entry) => entry.groups.length > 0).toReversed();
    const newest = offered[0];
    return newest === undefined ? null : { kind: "offered", version: newest.version, entries: offered };
  }
  const current = notes.current;
  if (current === null || current.groups.length === 0) return null;
  return { kind: "current", version: current.version, entries: [current] };
}

/**
 * A lead, split on its backticks. The odd pieces were `code` in the CHANGELOG and render as code;
 * nothing else in a lead is markup. An unpaired backtick is kept as text.
 */
export function leadPieces(lead: string): { text: string; code: boolean }[] {
  const parts = lead.split("`");
  if (parts.length % 2 === 0) return [{ text: lead, code: false }];
  return parts.flatMap((text, i) => (text === "" ? [] : [{ text, code: i % 2 === 1 }]));
}
