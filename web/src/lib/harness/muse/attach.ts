// Muse's ATTACH TOKENS, read as evidence that a send with attachments landed.
//
// Same contract as the paste supplement (paste.ts): the #34 guard only submits once it SEES the
// typed text, but Muse transforms what lands in the box — an image path is attached on sight and
// painted as `[Image #N]`, N in attach order, and any other path is double-quoted in place — so
// the box holds tokens, not our message, and the generic substring match structurally cannot
// succeed. This module is the adapter's second look (HarnessAdapter.draftCarriesSend): it rewrites
// the read draft back into sent-text space and requires equality there.
//
// Probed live 2026-09-23 (Muse 1.3.0): `/…/a.jpg` → `❯ [Image #1]`; a second image → `❯ [Image
// #1] [Image #2]`; `/tmp/x` → `❯ "/tmp/x"`. The pre-clear sweep removes chips, so a retype
// re-attaches from #1 and retries stay clean.
//
// Soundness (every failure mode stalls, never submits):
//   * A chip with no corresponding sent run (stale chip, count mismatch) unmaps → false.
//   * Positional mapping + whole-string equality: a wrong correspondence leaves a sent run missing
//     or duplicated in the rewrite → unequal → false.
//   * A quoted span unquotes only when the sent text carries it bare; user-typed quotes (which the
//     generic match verifies first) keep failing here, never passing.
//   * Anything outside the grammar (an image extension outside the set, chips mixed with paste
//     tokens) fails here and stalls exactly as today.
//
// One residual hole, the same kind as the paste token's: a chip carries no content, so a stale
// `[Image #1]` from another image would vouch for a send of one bare image path that never landed.
// It needs the pre-clear sweep to have been skipped (the forced send) AND every typed key lost; a
// typed path that did land adds a second chip, and the count check refuses that.

/** What counts as an image path in the sent text, by extension (case-insensitive). Static on
 *  purpose: the adapter is offline-pure and cannot see the server-published UploadCapability, and
 *  a miss here stalls safe (the generic match and the paste supplement run first anyway). */
const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "bmp",
  "heic",
  "heif",
  "tif",
  "tiff",
  "svg",
]);

/** An attach chip as the box paints it. Global: the draft can hold several. */
const CHIP = /\[Image #(\d+)\]/g;

/** A double-quoted span. Muse quotes paths it does not attach; the span unquotes only against
 *  sent text carrying it bare (below). */
const QUOTED = /"([^"]+)"/g;

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Whitespace-separated runs of the sent text ending in an image extension, in order. */
function imageRuns(sent: string): string[] {
  return sent.split(/\s+/).filter((run) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(run);
    return m !== null && IMAGE_EXTENSIONS.has(m[1]!.toLowerCase());
  });
}

/**
 * Whether a draft holding attach tokens is consistent with the text just sent. Every `[Image #N]`
 * must map to the Nth image run of the sent text, every quoted span must unwrap to text the sent
 * text carries bare, and the rewritten draft must equal the sent text whitespace-stripped (the box
 * folds the paragraph breaks the sent text keeps).
 */
export function museAttachCarriesSend(sent: string, draft: string): boolean {
  const hasChip = draft.includes("[Image #");
  const hasQuote = draft.includes('"');
  if (!hasChip && !hasQuote) return false;
  let rewritten = draft;
  if (hasChip) {
    const runs = imageRuns(sent);
    const numbers = [...draft.matchAll(CHIP)].map((m) => Number(m[1]));
    if (numbers.length === 0) return false;
    if (numbers.some((n) => n < 1 || n > runs.length)) return false;
    rewritten = rewritten.replace(CHIP, (_match, n: string) => runs[Number(n) - 1]!);
  }
  if (rewritten.includes('"')) {
    rewritten = rewritten.replace(QUOTED, (match, inner: string) =>
      sent.includes(inner) ? inner : match,
    );
    if (rewritten.includes('"')) return false;
  }
  return stripWhitespace(rewritten) === stripWhitespace(sent);
}
