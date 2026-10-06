// Which dialog card the pane screen draws, decided from the blocks web's harness dispatcher built.
//
// NOTHING HERE PARSES A SCREEN. `buildBlocks` (web/src/lib/harness/index.ts, through the pane's own
// adapter and the unread-dialog post-pass) owns every decision about what is on screen. This module
// only maps the one lifted block to what a card shows, in the words the React card dock uses
// (web/src/components/card-dock.tsx and the six block components), so it can be tested over real
// captures without a browser.
//
// The card kinds, and what each gets:
//   - prompt-select: one button per option, the option's own key badge, the family caption;
//   - menu: the footer's own actions, the arrows the screen advertised, the printed scale as chips;
//   - unread-dialog: the one key its harness declared as the way out (ADR 0053);
//   - keys-only: the wizard, multi-select and preview-select dialogs. The React app draws these as
//     native forms; this shell draws their screen region and leaves the answer to the Keys row,
//     which still reaches the dialog (ADR 0056 point 1 names the Keys drawer as live under a card).
// The completion popup (`autocomplete`) owns no keyboard, so it is no card: its rows stay in the
// mirror, and the composer stays free.
import type {
  Block,
  MenuBlock,
  MultiSelectBlock,
  PreviewSelectBlock,
  PromptFamily,
  PromptOption,
  PromptSelectBlock,
  StyledLine,
  UnreadDialogBlock,
  WizardBlock,
} from "@web/lib/blocks";
import { blockOwnsKeyboard } from "@web/lib/harness/dialog-contract";
import { t } from "@web/lib/i18n";
import { keyLabel } from "@web/lib/key-queue";

export interface CardOption {
  option: PromptOption;
  label: string;
  description: string | undefined;
  /** The badge: the option's own key label, else its first key drawn as the dialog prints it. */
  badge: string;
}

export interface PromptCard {
  kind: "prompt-select";
  block: PromptSelectBlock;
  caption: string;
  question: string;
  options: CardOption[];
}

export interface MenuCard {
  kind: "menu";
  block: MenuBlock;
  caption: string;
  /** The screen printed its whole scale, so the card draws chips instead of the region's rows. */
  readsBody: boolean;
}

export interface UnreadCard {
  kind: "unread-dialog";
  block: UnreadDialogBlock;
  caption: string;
  /** The declared key, as its chip reads ("Esc", "Ctrl C"). */
  keyName: string;
}

export interface KeysOnlyCard {
  kind: "keys-only";
  block: WizardBlock | MultiSelectBlock | PreviewSelectBlock;
  caption: string;
}

export type DialogCard = PromptCard | MenuCard | UnreadCard | KeysOnlyCard;

/** The prompt family's caption (prompt-select-block.tsx `familyCaption`). */
export function familyCaption(family: PromptFamily): string {
  switch (family) {
    case "select":
      return t("prompt.family.select");
    case "permission":
      return t("prompt.family.permission");
    case "trust":
      return t("prompt.family.trust");
    case "plan":
      return t("prompt.family.plan");
  }
}

/** An option's badge when it carries no label of its own (prompt-select-block.tsx `keyBadgeFallback`). */
export function keyBadgeFallback(key: string): string {
  if (key === "Down") return "↓";
  if (key === "Up") return "↑";
  if (key === "Left") return "←";
  if (key === "Right") return "→";
  if (key === "Enter") return "⏎";
  if (key === "Escape") return "Esc";
  return key;
}

/** Whether the menu card reads the screen's printed scale (menu-block.tsx `readsBody`). */
export function menuReadsBody(block: MenuBlock): boolean {
  const leftRight = block.menu.nav.leftRight;
  const scale = leftRight?.values ?? [];
  return leftRight !== undefined && scale.length >= 2 && scale.indexOf(leftRight.label) >= 0;
}

function promptCard(block: PromptSelectBlock): PromptCard {
  const { prompt } = block;
  return {
    kind: "prompt-select",
    block,
    caption: prompt.caption ?? familyCaption(prompt.family),
    question: prompt.question,
    options: prompt.options.map((option) => ({
      option,
      label: option.label,
      description: option.description,
      badge: option.keyLabel ?? keyBadgeFallback(option.keys[0] ?? ""),
    })),
  };
}

/** The card for the pane's blocks, or null when no dialog owns the screen. At most one block lifts. */
export function dialogCardOf(blocks: readonly Block[]): DialogCard | null {
  for (const block of blocks) {
    switch (block.kind) {
      case "raw":
      case "autocomplete":
        continue;
      case "prompt-select":
        return promptCard(block);
      case "menu":
        return { kind: "menu", block, caption: block.menu.title, readsBody: menuReadsBody(block) };
      case "unread-dialog":
        return { kind: "unread-dialog", block, caption: t("unreadDialog.caption"), keyName: keyLabel(block.cancel.key) };
      case "wizard":
      case "multi-select":
      case "preview-select":
        return { kind: "keys-only", block, caption: t("dialog.chooseOption") };
    }
  }
  return null;
}

/** Whether a dialog on screen has the keyboard, so a typed reply would land in it (web's #34 gate). */
export function dialogOwnsKeyboard(blocks: readonly Block[]): boolean {
  return blocks.some(blockOwnsKeyboard);
}

/** The rows the mirror draws: every block no card took (raw output and a completion popup's rows). */
export function mirrorLines(blocks: readonly Block[]): StyledLine[] {
  const out: StyledLine[] = [];
  for (const block of blocks) {
    if (block.kind === "raw" || block.kind === "autocomplete") out.push(...block.lines);
  }
  return out;
}
