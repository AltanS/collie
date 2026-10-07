// The reader's place across a "Load older" page (research note 07, f.5: kody's list prepends with key
// dedupe but does not hold the anchor; this does). The old rule kept the distance from the BOTTOM,
// which is right only while nothing below the new turns changes height. Blocks carry
// `content-visibility: auto` and a 64 px stand-in, so a block that has not drawn yet is a guess; the
// first VISIBLE block is a better anchor, because it is what the reader's eye is on.
//
// Before the page lands: measure the first block that is still (partly) in view and how far its top
// sits below the scroller's top (`anchorOf`). After the commit and the browser's layout: find the same
// block by its stable key, measure again, and move `scrollTop` by what it drifted (`restoredTop`).
// If the browser's own scroll anchoring already held it, the drift is 0 and nothing is written. If the
// block is gone (it cannot be: pages only add above), fall back to the old distance from the bottom.
//
// Pure over plain numbers, so the rule is tested without a DOM; `chat.tsx` takes the measurements.

/** One block's box, in viewport coordinates, and its stable key (the block's first item id). */
export interface BlockBox {
  key: string;
  top: number;
  bottom: number;
}

/** What to hold: the block under the reader's eye, and its top's distance below the scroller's top. */
export interface Anchor {
  key: string;
  offset: number;
  /** `scrollHeight - scrollTop` at the same moment: the fallback when the block is gone. */
  fromBottom: number;
}

/**
 * The anchor for the first block whose bottom edge is below the scroller's top (the first one still
 * in view, even if only its tail is). `null` when there is no block at all.
 */
export function anchorOf(blocks: readonly BlockBox[], containerTop: number, fromBottom: number): Anchor | null {
  const block = blocks.find((b) => b.bottom > containerTop);
  if (block === undefined) return null;
  return { key: block.key, offset: block.top - containerTop, fromBottom };
}

/**
 * The `scrollTop` that puts the anchored block back at its old offset, given the measurements after
 * layout. Returns the CURRENT scrollTop when the block already sits there (nothing to write).
 */
export function restoredTop(
  anchor: Anchor,
  now: { scrollTop: number; scrollHeight: number; containerTop: number; blocks: readonly BlockBox[] },
): number {
  const block = now.blocks.find((b) => b.key === anchor.key);
  if (block === undefined) return now.scrollHeight - anchor.fromBottom;
  const drift = block.top - now.containerTop - anchor.offset;
  return now.scrollTop + drift;
}
