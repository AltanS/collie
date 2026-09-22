import type { CSSProperties, MouseEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type {
  Block,
  MenuModel,
  MultiSelectModel,
  PreviewSelectModel,
  PromptModel,
  UnreadDialogModel,
  WizardModel,
} from "@/lib/blocks";
import type { MultiSelectIntent } from "@/lib/multi-select-action";
import { PromptSelectBlock, type PromptBlockAction } from "@/components/prompt-select-block";
import { WizardBlock } from "@/components/wizard-block";
import { PreviewSelectBlock, type PreviewBlockAction } from "@/components/preview-select-block";
import { MultiSelectBlock } from "@/components/multi-select-block";
import { MenuBlock, type MenuBlockAction } from "@/components/menu-block";
import { AutocompleteBlock } from "@/components/autocomplete-block";
import { UnreadDialogBlock } from "@/components/unread-dialog-block";

// ── THE CARD DOCKS IN ONE SLOT (.adr/0059) ─────────────────────────────────────────────────────
// The lifted card used to render INSIDE the mirror's scroller, after the <pre>, so where its bottom
// edge landed depended on how much text stood above it, on trailing rows, and on scroll state. On a
// short screen it floated mid-page. It renders here instead: one slot in the pane view's column,
// below the mirror's scroller and directly above the chrome block (the actions belt and the input),
// outside every scroller. Every card kind, every harness, the same bottom edge.
//
// The blocks are NOT built here. AgentChat builds them once per `display` and hands the same array
// to AnsiOutput (which draws the raw blocks) and to this dock (which draws the one card), so the
// grammars run once per poll, exactly as they did when AnsiOutput built them itself.
//
// THE CARD INSTANCE SURVIVES POLLS. ADR 0056's Terminal toggle is `useState` inside PromptPanel, and
// it lasts only as long as React keeps the instance: the card is one conditional element at a fixed
// position in this dock, the same shape it had inside AnsiOutput, so a re-render of the same dialog
// reuses it and a change of kind (or the dialog leaving) resets it. Do not key the card on anything
// that changes per poll, and do not render the dock's wrapper conditionally on anything but "is
// there a card" — either would remount the card and drop the operator's Terminal choice.

/** The (at most one) prompt-select block, always at the tail. */
type PromptBlock = Extract<Block, { kind: "prompt-select" }>;
/** The (at most one) wizard block, tail, mutually exclusive with prompt-select. */
type WizBlock = Extract<Block, { kind: "wizard" }>;
/** The (at most one) preview-select block, tail, mutually exclusive with the two above. */
type PrevBlock = Extract<Block, { kind: "preview-select" }>;
/** The (at most one) multi-select block, tail, mutually exclusive with the other dialog blocks. */
type MultiBlock = Extract<Block, { kind: "multi-select" }>;
/** The (at most one) generic-menu block, lifted only when all four above declined. */
type GenericMenuBlock = Extract<Block, { kind: "menu" }>;
/** The (at most one) completion-popup block: the only non-raw kind that is NOT a modal. The agent's
 *  input box is live under it, so it renders with no controls and locks nothing. */
type AutoBlock = Extract<Block, { kind: "autocomplete" }>;
/** The (at most one) unread-dialog card. The post-pass emits it only when NOTHING else lifted, so it
 *  is mutually exclusive with every kind above by construction (harness/index.ts). */
type UnreadBlock = Extract<Block, { kind: "unread-dialog" }>;

export interface CardDockProps {
  /** The pane's blocks, as AgentChat built them for the mirror. Only the non-raw one is drawn here. */
  blocks: readonly Block[];
  /** Injected handler for a prompt-select tap (the race guard lives in AgentChat). Absent (or with a
   *  disabled card) means the buttons render but don't act; the dock never touches the network. */
  onPromptAction?: (
    action: PromptBlockAction,
    prompt: PromptModel,
  ) => boolean | void | Promise<boolean | void>;
  /** Injected handler for a wizard tap, one race-guarded keystroke per control (lib/wizard-action.ts). */
  onWizardAction?: (keys: string[], wizard: WizardModel) => void | Promise<void>;
  /** Injected handler for a preview-dialog tap (lib/preview-action.ts). */
  onPreviewAction?: (action: PreviewBlockAction, preview: PreviewSelectModel) => void | Promise<void>;
  /** Injected handler for a multi-select tap (lib/multi-select-action.ts). */
  onMultiSelectAction?: (action: MultiSelectIntent, multi: MultiSelectModel) => void | Promise<void>;
  /** Injected handler for a generic-menu tap (lib/menu-action.ts). */
  onMenuAction?: (action: MenuBlockAction, menu: MenuModel) => void | Promise<void>;
  /** Injected handler for the unread-dialog card's one declared key (.adr/0053). */
  onUnreadDialogAction?: (key: string, cancel: UnreadDialogModel) => void | Promise<void>;
  /** Disable every card's controls (read-only device, gone pane). */
  promptDisabled?: boolean;
  /** The soft keyboard is up: the dock's cap drops from 55dvh to 40dvh. */
  composing?: boolean;
  /** The mirror's chosen face (`mirrorFont`), so a card's `font-mono` rows and its Terminal mirror
   *  keep the family the mirror above them is drawn in. */
  faceClassName?: string;
  faceStyle?: CSSProperties;
  /** The mirror's "tap to type" handler, so a tap on the card's own terminal rows (the unread-dialog
   *  card's whole-pane mirror, a card put down to Terminal) still focuses the composer, exactly as it
   *  did while the card lived inside the mirror. The handler declines a tap on a control itself. */
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
}

/** The one card on screen, as a React element, or null when every block is raw. */
function liftedCard({
  blocks,
  onPromptAction,
  onWizardAction,
  onPreviewAction,
  onMultiSelectAction,
  onMenuAction,
  onUnreadDialogAction,
  promptDisabled,
}: CardDockProps): ReactNode {
  const promptBlock = blocks.find((b): b is PromptBlock => b.kind === "prompt-select");
  if (promptBlock) {
    return (
      <PromptSelectBlock
        prompt={promptBlock.prompt}
        lines={promptBlock.lines}
        disabled={promptDisabled || !onPromptAction}
        onAction={(action) => onPromptAction?.(action, promptBlock.prompt) ?? false}
      />
    );
  }
  const wizardBlock = blocks.find((b): b is WizBlock => b.kind === "wizard");
  if (wizardBlock) {
    return (
      <WizardBlock
        wizard={wizardBlock.wizard}
        lines={wizardBlock.lines}
        disabled={promptDisabled || !onWizardAction}
        onAction={(keys) => onWizardAction?.(keys, wizardBlock.wizard)}
      />
    );
  }
  const previewBlock = blocks.find((b): b is PrevBlock => b.kind === "preview-select");
  if (previewBlock) {
    return (
      <PreviewSelectBlock
        preview={previewBlock.preview}
        lines={previewBlock.lines}
        disabled={promptDisabled || !onPreviewAction}
        onAction={(action) => onPreviewAction?.(action, previewBlock.preview)}
      />
    );
  }
  const multiBlock = blocks.find((b): b is MultiBlock => b.kind === "multi-select");
  if (multiBlock) {
    return (
      <MultiSelectBlock
        multi={multiBlock.multi}
        lines={multiBlock.lines}
        disabled={promptDisabled || !onMultiSelectAction}
        onAction={(action) => onMultiSelectAction?.(action, multiBlock.multi)}
      />
    );
  }
  const menuBlock = blocks.find((b): b is GenericMenuBlock => b.kind === "menu");
  if (menuBlock) {
    return (
      <MenuBlock
        menu={menuBlock.menu}
        lines={menuBlock.lines}
        disabled={promptDisabled || !onMenuAction}
        onAction={(action) => onMenuAction?.(action, menuBlock.menu)}
      />
    );
  }
  // The least confident arm, and last of the controls for that reason: it is reached only when no
  // grammar claimed the screen at all (.adr/0053). It renders the WHOLE pane itself, which is why
  // the mirror's raw blocks are empty whenever it is showing.
  const unreadBlock = blocks.find((b): b is UnreadBlock => b.kind === "unread-dialog");
  if (unreadBlock) {
    return (
      <UnreadDialogBlock
        cancel={unreadBlock.cancel}
        lines={unreadBlock.lines}
        disabled={promptDisabled || !onUnreadDialogAction}
        onAction={(key) => onUnreadDialogAction?.(key, unreadBlock.cancel)}
      />
    );
  }
  // No handler and no `disabled`: the completion popup emits no keystroke, so there is nothing for a
  // read-only device to be refused. Last only because it is the least specific tail shape; every
  // dialog above means there is no input box, and a popup means there is one.
  const autoBlock = blocks.find((b): b is AutoBlock => b.kind === "autocomplete");
  if (autoBlock) return <AutocompleteBlock autocomplete={autoBlock.autocomplete} />;
  return null;
}

/**
 * The slot the lifted card docks in (.adr/0059). Renders NOTHING when there is no card, so a pane
 * with none keeps its column exactly as it was: no padding, no rule, no empty box.
 *
 * HEIGHT. Capped at 55dvh, 40dvh with the soft keyboard up, and scrolled inside, so a tall card (the
 * /model mirror, a long /resume list, an unread-dialog card carrying the whole pane) never pushes the
 * composer off the screen. `dvh` already tracks the keyboard (hooks/use-keyboard.ts), so the cap is
 * a share of what is really visible.
 *
 * LOOK. The page background and one uniform 1px top rule: a docked sheet standing on the column, not
 * a second card around the card. `px-3` is the mirror list's own gutter, so the card's edges line up
 * with the terminal text above it.
 */
export function CardDock(props: CardDockProps) {
  const card = liftedCard(props);
  if (card === null) return null;
  return (
    // `role="presentation"`, the mirror wrapper's own reading: a layout box whose click adds nothing
    // a keyboard user lacks (the textarea is the next tabbable thing).
    <div
      role="presentation"
      data-slot="card-dock"
      className={cn(
        "shrink-0 overflow-y-auto overscroll-contain border-t border-border bg-background px-3 pt-2 pb-2",
        props.composing ? "max-h-[40dvh]" : "max-h-[55dvh]",
        props.faceClassName,
      )}
      style={props.faceStyle}
      onClick={props.onClick}
    >
      {card}
    </div>
  );
}
