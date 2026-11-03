import type { Block } from "@/lib/blocks";

/** Completion docks too, but does not answer a dialog. Keep this cheap predicate off the UI chunk. */
const DIALOG_CARD_KINDS: ReadonlySet<Block["kind"]> = new Set<Block["kind"]>(["prompt-select", "wizard", "preview-select", "multi-select", "menu", "unread-dialog"]);

/** The place "Answer the dialog" goes to. */
export function hasDialogCard(blocks: Block[]): boolean {
  return blocks.some((block) => DIALOG_CARD_KINDS.has(block.kind));
}
