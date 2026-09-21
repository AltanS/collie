// The UNREAD-DIALOG MODEL — the harness-NEUTRAL payload of an `unread-dialog` Block.
//
// An "unread dialog" is the screen NO grammar claimed: every one of an adapter's detectors declined,
// the adapter's own `composerReady` still answered a definite `false`, and the pane is not blank. The
// block is produced by a post-pass OUTSIDE every adapter (harness/index.ts, `withUnreadDialog`), so no
// adapter's fail-closed contract is loosened to make one (.adr/0053).
//
// The model carries NOTHING read off the screen except a freshness signature. The key is the
// adapter's own DECLARATION (`HarnessAdapter.cancelKey`), written by whoever knows the harness and
// checked against that harness's captures — never a footer parse. A declaration cannot be fooled by a
// phrase, which is the whole point: the bug this exists for was a classifier answering a question
// about a dialog from one line of text.
//
// Types + the pure comparators — no detection, no harness conventions. This module imports nothing,
// so `lib/blocks.ts` can re-export it without a cycle.

/** How many non-blank tail rows the signature is taken over. Enough to catch a modal repainting
 *  under the operator's thumb, few enough that a scrolling transcript above it is not part of the
 *  identity of the screen. */
const SIGNATURE_TAIL_LINES = 12;

/** A screen no grammar read, plus the one key its harness declared as the way out of a modal. */
export interface UnreadDialogModel {
  /** The adapter's declared `cancelKey`, verbatim — a Herdr key token ("Escape", "ctrl+c"). */
  key: string;
  /** The agent whose adapter declared it (its registry key), for provenance in the guard and tests. */
  agent: string;
  /**
   * A byte-signature of the screen's non-blank tail. The race guard compares it, so a tap on a stale
   * render cannot fire the key at the screen that replaced it. It MUST be non-empty and MUST change
   * when the tail's text changes.
   */
  signature: string;
}

/** The signature of a screen's non-blank tail — the last {@link SIGNATURE_TAIL_LINES} rows that
 *  carry text, joined. Blank rows are dropped first so a TUI padding its frame out to the terminal
 *  height cannot push the real content out of the window. */
export function unreadDialogSignature(texts: string[]): string {
  const nonBlank = texts.filter((t) => t.trim() !== "");
  return nonBlank.slice(-SIGNATURE_TAIL_LINES).join("\n");
}

/** Whether two derivations are the SAME unread screen — the check a COMMITTING key must pass.
 *
 *  Part of the CONTRACT, not of any harness: the race guard (lib/dialog-guard.ts) compares whatever
 *  produced the block through exactly this function. */
export function unreadDialogsEqual(a: UnreadDialogModel, b: UnreadDialogModel): boolean {
  return unreadDialogsSameIdentity(a, b);
}

/** The same comparison again, deliberately. The card has ONE key and that key commits, and nothing
 *  about the card is expected to change under a tap — so there is no weaker "identity" reading to
 *  give. The two names exist because the dialog contract asks for both; collapsing them to one field
 *  would hide that this kind answered the question rather than skipped it. */
export function unreadDialogsSameIdentity(a: UnreadDialogModel, b: UnreadDialogModel): boolean {
  return a.key === b.key && a.agent === b.agent && a.signature === b.signature;
}
