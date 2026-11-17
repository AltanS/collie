import { useImperativeHandle, useLayoutEffect, useState, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from "react";

import { Collapse } from "@/components/ui/collapse";
import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";
import type {
  Block,
  MenuModel,
  MultiSelectModel,
  PreviewSelectModel,
  PromptModel,
  StyledLine,
  UnreadDialogModel,
  WizardModel,
} from "@/lib/blocks";
import type { MultiSelectIntent } from "@/lib/multi-select-action";
import type { Scope } from "@/lib/scope";
import { PromptSelectBlock, promptCardFits, type PromptBlockAction } from "@/components/prompt-select-block";
import { WizardBlock } from "@/components/wizard-block";
import { PreviewSelectBlock, type PreviewBlockAction } from "@/components/preview-select-block";
import { MultiSelectBlock } from "@/components/multi-select-block";
import { MenuBlock, type MenuBlockAction } from "@/components/menu-block";
import { AutocompleteBlock } from "@/components/autocomplete-block";
import { BoxTextBlock } from "@/components/box-text-block";
import { UnreadDialogBlock } from "@/components/unread-dialog-block";
import { CannotTellCard, type CannotTellCardProps } from "@/components/cannot-tell-card";

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
/** The (at most one) completion-popup block: NOT a modal, like `box-text`. The agent's input box is
 *  live under it, so it renders with no controls and locks nothing. */
type AutoBlock = Extract<Block, { kind: "autocomplete" }>;
/** The (at most one) text card of a titled box over the live input box. Keyless, like the popup. */
type BoxBlock = Extract<Block, { kind: "box-text" }>;
/** The (at most one) unread-dialog card. The post-pass emits it only when NOTHING else lifted, so it
 *  is mutually exclusive with every kind above by construction (harness/index.ts). */
type UnreadBlock = Extract<Block, { kind: "unread-dialog" }>;

export interface CardDockProps {
  /** The dock's own box, so the composer's "Answer the dialog" word can scroll to it and focus its
   *  first button (lib/dialog-focus.ts). */
  ref?: Ref<HTMLDivElement>;
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
  /** Injected handler for an answer typed into a wizard step's field (lib/wizard-action.ts); resolves
   *  whether it was sent, so the card keeps a refused draft. */
  onWizardAnswer?: (text: string, wizard: WizardModel) => Promise<boolean>;
  /** Injected handler for a preview-dialog tap (lib/preview-action.ts). */
  onPreviewAction?: (action: PreviewBlockAction, preview: PreviewSelectModel) => void | Promise<void>;
  /** Injected handler for a multi-select tap (lib/multi-select-action.ts). */
  onMultiSelectAction?: (action: MultiSelectIntent, multi: MultiSelectModel) => void | Promise<void>;
  /** Injected handler for an answer typed into a multi-select question's field
   *  (lib/multi-select-action.ts `type`); resolves whether it was sent, so the card keeps a refused draft. */
  onMultiSelectAnswer?: (text: string, multi: MultiSelectModel) => Promise<boolean>;
  /** Injected handler for a generic-menu tap (lib/menu-action.ts). */
  onMenuAction?: (action: MenuBlockAction, menu: MenuModel) => void | Promise<void>;
  /** Injected handler for the unread-dialog card's one declared key (.adr/0053). */
  onUnreadDialogAction?: (key: string, cancel: UnreadDialogModel) => void | Promise<void>;
  /** Opens Report a problem from the unread-dialog card (ADR 0123, amendment 2026-10-28). Absent, the
   *  card offers no report. */
  onUnreadDialogReport?: (cancel: UnreadDialogModel) => void;
  /** The unread-dialog card showed (M86 spec 05): called once per card instance for each pane and
   *  dialog. Absent, nothing is called. */
  onUnreadDialogShown?: (cancel: UnreadDialogModel) => void;
  /** Disable every card's controls (read-only device, gone pane). */
  promptDisabled?: boolean;
  /** Why the controls are off, drawn as one line under a dialog card (M102 spec 11): a button with no
   *  words beside it is a dead tap. The composer placeholder's own sentence. Absent, no line. */
  promptDisabledReason?: string;
  /** The pane the card answers for, and its scope. The prompt card enables only while the bridge has
   *  answered a read for it lately (lib/liveness.ts, M46 spec 11). */
  paneId?: string;
  scope?: Scope;
  /** The screen is drawn from the on-device cache (M46 spec 10): the prompt card stays locked. */
  stale?: boolean;
  /** A sign-in card's address hosts from the agent's adapter (Change login, M101); see BoxTextBlock. */
  signInHosts?: readonly string[];
  /** The sign-in card's read of those hosts is still in flight; see BoxTextBlock. */
  signInPending?: boolean;
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
  /** The device's Wrap lines setting, for the unread-dialog card, the one card that mirrors the whole
   *  pane: its mirror wraps or pans as the pane mirror above it does (#372). */
  wrap?: boolean;
  /**
   * A send refusal on a screen Collie cannot read opened the unread card with no declared key (M102
   * spec 03): the pane's rows to show. Only when no lifted card claims the screen; null or absent, none.
   */
  unreadFallback?: StyledLine[] | null;
  /** The Keys pad's road, for the unread card's caps of core keys the person's board lacks. */
  onUnreadPadKeys?: (keys: string[]) => Promise<boolean>;
  /** "Send past this screen" on the unread card: the composer's one send past this screen. */
  onUnreadTypeAnyway?: () => void;
  /** The screen asks for a secret: the unread card offers no "Send past this screen". */
  unreadSecret?: boolean;
  /**
   * The card of a send Collie cannot tell about (M102 spec 04): the composer's `unknown` send, with the screen
   * and the person's two answers. It docks only where no dialog card is lifted, and the unread card wins over it.
   * Null or absent, none.
   */
  cannotTell?: CannotTellCardProps | null;
  /**
   * The exit of an answer that cannot go (M102 spec 10): the line that says what happened, the live
   * screen and the person's Keys pad, in spec 03's card. While it is set it stands in for the dialog
   * card it is about; its cross brings that card back. Null or absent, none.
   */
  answerExit?: AnswerExitCard | null;
}

/** What the dock needs to draw an answer's exit. AgentChat sets it only while the same dialog is on screen. */
export interface AnswerExitCard {
  /** The one line: what happened to the answer. */
  readonly caption: string;
  /** The live screen. */
  readonly lines: StyledLine[];
  readonly onClose: () => void;
}

/** The block kinds that dock a dialog card: each answers a dialog on the pane. The completion popup
 *  docks a card too, but it answers nothing. */
const DIALOG_CARD_KINDS: ReadonlySet<Block["kind"]> = new Set<Block["kind"]>(["prompt-select", "wizard", "preview-select", "multi-select", "menu", "unread-dialog"]);

/** Whether the dock shows a dialog card for these blocks: the place "Answer the dialog" goes to. */
export function hasDialogCard(blocks: CardDockProps["blocks"]): boolean {
  return blocks.some((block) => DIALOG_CARD_KINDS.has(block.kind));
}

/** Whether the dock's card fits the dock (PromptPanel's `fit`) instead of scrolling it: a permission
 *  card with subject rows. AgentChat reads it too, to soften the reading floor for it. */
export function dockFits(blocks: CardDockProps["blocks"]): boolean {
  // The same pick as liftedCard: a prompt-select block wins over every other kind.
  const prompt = blocks.find((b): b is PromptBlock => b.kind === "prompt-select");
  return prompt !== undefined && promptCardFits(prompt.prompt);
}

/** A computed length in px, 0 for anything else (`auto`, `normal`). */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** The two heights of a card that fits the dock, in px, each with the dock's own padding and border. */
export interface FitSize {
  /** The least: every row of the card at its own height, its shrinking box at its `min-height`. */
  floor: number;
  /** The most it can use: the same rows, its shrinking box at its whole content, up to its `max-height`. */
  natural: number;
}

/**
 * The heights of a card that fits the dock (`[data-fit]`, PromptPanel): every row of the card at its
 * own height, its one shrinking box (`[data-fit-shrink]`) at its `min-height` for the floor and at
 * its content (its first child's scroll height, up to its `max-height`) for the natural height, plus
 * the gaps, the paddings, the borders and the card's margins. Measured from the rows on screen, so
 * it holds for any wording, locale, font or number of buttons; nothing in it is a guess. Null when
 * the dock holds no such card (any other card, or this one put down to its Terminal view).
 */
export function fitSize(dock: HTMLElement): FitSize | null {
  const card = dock.querySelector<HTMLElement>(":scope > [data-fit]");
  if (card === null) return null;
  const d = getComputedStyle(dock);
  const c = getComputedStyle(card);
  const rows = [...card.children];
  // Whatever else the dock holds beside the card (the line that says why the card is off) takes its own height.
  let fixed = [...dock.children].reduce((sum, child) => (child === card ? sum : sum + child.getBoundingClientRect().height), 0);
  let least = 0;
  let most = 0;
  for (const row of rows) {
    if (!row.hasAttribute("data-fit-shrink")) {
      fixed += row.getBoundingClientRect().height;
      continue;
    }
    const box = getComputedStyle(row);
    least += px(box.minHeight);
    const content = row.firstElementChild?.scrollHeight ?? 0;
    const max = box.maxHeight === "none" ? Number.POSITIVE_INFINITY : px(box.maxHeight);
    most += Math.max(px(box.minHeight), Math.min(content, max));
  }
  const edges =
    px(d.paddingTop) + px(d.paddingBottom) + px(d.borderTopWidth) + px(d.borderBottomWidth) +
    px(c.marginTop) + px(c.marginBottom) + px(c.paddingTop) + px(c.paddingBottom) + px(c.borderTopWidth) + px(c.borderBottomWidth) +
    px(c.rowGap) * Math.max(0, rows.length - 1);
  return { floor: Math.ceil(edges + fixed + least), natural: Math.ceil(edges + fixed + most) };
}

/** Two sizes are the same, so a measure that found nothing new renders nothing. */
function sameSize(a: FitSize | null, b: FitSize | null): boolean {
  return a === b || (a !== null && b !== null && a.floor === b.floor && a.natural === b.natural);
}

/**
 * The heights of the dock's card that fits ({@link fitSize}), kept current: on the dock's and every
 * row's resize (the width, a font, the keyboard) and on any change inside the card (the offline
 * note, a new question, new subject rows). Neither height depends on the dock's own height, so
 * setting the dock from them settles in one pass.
 */
function useFitSize(dock: HTMLDivElement | null, fits: boolean): FitSize | null {
  const [size, setSize] = useState<FitSize | null>(null);
  useLayoutEffect(() => {
    if (!fits || dock === null) return;
    const measure = () => {
      const next = fitSize(dock);
      setSize((prev) => (sameSize(prev, next) ? prev : next));
    };
    measure();
    const ro = hasResizeObserver() ? new ResizeObserver(measure) : null;
    const watch = () => {
      if (ro === null) return;
      ro.disconnect();
      ro.observe(dock);
      const card = dock.querySelector(":scope > [data-fit]");
      for (const row of card?.children ?? []) ro.observe(row);
    };
    watch();
    const mo = new MutationObserver(() => {
      watch();
      measure();
    });
    mo.observe(dock, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-fit"] });
    return () => {
      ro?.disconnect();
      mo.disconnect();
    };
  }, [dock, fits]);
  return fits ? size : null;
}

/** The dock's flex sizing for a card that fits it, from its two heights: see "THE ROOM OF A CARD THAT
 *  FITS" on {@link CardDock}. */
function fitStyle(size: FitSize, cap: string): CSSProperties {
  return {
    flexBasis: `${size.floor}px`,
    maxHeight: `min(${size.natural}px, max(${size.floor}px, ${cap}))`,
  };
}

/** The one card on screen, as a React element, or null when every block is raw. */
function liftedCard({
  blocks,
  onPromptAction,
  onWizardAction,
  onWizardAnswer,
  onPreviewAction,
  onMultiSelectAction,
  onMultiSelectAnswer,
  onMenuAction,
  onUnreadDialogAction,
  onUnreadDialogReport,
  onUnreadDialogShown,
  promptDisabled,
  paneId,
  scope,
  stale,
  wrap,
  unreadFallback,
  onUnreadPadKeys,
  onUnreadTypeAnyway,
  unreadSecret,
  cannotTell,
  signInHosts,
  signInPending,
  answerExit,
}: CardDockProps): ReactNode {
  // The exit of an answer that cannot go (M102 spec 10) stands in for the card whose answer did not go:
  // the person reads the live screen and presses keys on their own pad. No "Send past this screen": the screen
  // holds a question, and a message never goes into one (ADR 0142, hard stop 6a). No declared key: the
  // pad holds Esc, and the card draws a cap for a core key the person's board lacks.
  if (answerExit !== null && answerExit !== undefined) {
    return (
      <UnreadDialogBlock
        cancel={null}
        lines={answerExit.lines}
        caption={answerExit.caption}
        onClose={answerExit.onClose}
        disabled={promptDisabled}
        wrap={wrap}
        onAction={() => undefined}
        paneId={paneId}
        onPadKeys={onUnreadPadKeys}
      />
    );
  }
  const promptBlock = blocks.find((b): b is PromptBlock => b.kind === "prompt-select");
  if (promptBlock) {
    return (
      <PromptSelectBlock
        prompt={promptBlock.prompt}
        lines={promptBlock.lines}
        disabled={promptDisabled || !onPromptAction}
        paneId={paneId}
        scope={scope}
        stale={stale}
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
        paneId={paneId}
        scope={scope}
        stale={stale}
        onAction={(keys) => onWizardAction?.(keys, wizardBlock.wizard)}
        onAnswer={onWizardAnswer ? (text) => onWizardAnswer(text, wizardBlock.wizard) : undefined}
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
        paneId={paneId}
        scope={scope}
        stale={stale}
        onAction={(action) => onMultiSelectAction?.(action, multiBlock.multi)}
        onAnswer={onMultiSelectAnswer ? (text) => onMultiSelectAnswer(text, multiBlock.multi) : undefined}
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
        wrap={wrap}
        onAction={(key) => onUnreadDialogAction?.(key, unreadBlock.cancel)}
        onReport={onUnreadDialogReport === undefined ? undefined : () => onUnreadDialogReport(unreadBlock.cancel)}
        onShown={onUnreadDialogShown === undefined ? undefined : () => onUnreadDialogShown(unreadBlock.cancel)}
        paneId={paneId}
        onPadKeys={onUnreadPadKeys}
        onTypeAnyway={onUnreadTypeAnyway}
        secret={unreadSecret}
      />
    );
  }
  // The same card, opened by a send refused on a screen Collie cannot read (M102 spec 03): no declared
  // key, so the person's Keys pad and "Send past this screen" are the way on. Only when no other card claims it.
  if (unreadFallback !== null && unreadFallback !== undefined && !hasDialogCard(blocks)) {
    return (
      <UnreadDialogBlock
        cancel={null}
        lines={unreadFallback}
        disabled={promptDisabled}
        wrap={wrap}
        onAction={() => undefined}
        paneId={paneId}
        onPadKeys={onUnreadPadKeys}
        onTypeAnyway={onUnreadTypeAnyway}
        secret={unreadSecret}
      />
    );
  }
  // A send that ended unknown asks the person which it was (M102 spec 04). A dialog on the pane owns the
  // keys and wins, as the unread card above does; the completion popup and the box text yield to it, since
  // the person must answer it before the box means anything.
  if (cannotTell !== null && cannotTell !== undefined && !hasDialogCard(blocks)) {
    return <CannotTellCard key={cannotTell.facts.requestId} {...cannotTell} />;
  }
  // No handler and no `disabled`: the completion popup emits no keystroke, so there is nothing for a
  // read-only device to be refused. Last only because it is the least specific tail shape; every
  // dialog above means there is no input box, and a popup means there is one.
  const autoBlock = blocks.find((b): b is AutoBlock => b.kind === "autocomplete");
  if (autoBlock) return <AutocompleteBlock autocomplete={autoBlock.autocomplete} />;
  // Keyless like the popup, and for the same reason: the input box is live under the box it shows.
  const boxTextBlock = blocks.find((b): b is BoxBlock => b.kind === "box-text");
  if (boxTextBlock) return (
      <BoxTextBlock
        boxText={boxTextBlock.boxText}
        signInHosts={signInHosts !== undefined && signInHosts.length > 0 ? signInHosts : undefined}
        signInPending={signInPending}
      />
    );
  return null;
}

/**
 * The slot the lifted card docks in (.adr/0059). Renders NOTHING when there is no card, so a pane
 * with none keeps its column exactly as it was: no padding, no rule, no empty box.
 *
 * HEIGHT. Capped at 55dvh, 40dvh with the soft keyboard up, and scrolled inside, so a tall card (the
 * /model mirror, a long /resume list, an unread-dialog card carrying the whole pane) never pushes the
 * composer off the screen. `dvh` already tracks the keyboard (hooks/use-keyboard.ts), so the cap is
 * a share of what is really visible. It also SHRINKS (`min-h-0 shrink`): the reading box above it
 * holds a floor (agent-chat.tsx, #667), so on a short phone the dock gives up room before the chat does.
 * That floor, not the cap, is what bounds the dock on a phone: the column is the screen less the top
 * bar and tabs (about 97 px), the reading floor (30dvh, 20dvh with the keyboard up), and the belt
 * and composer (about 109 px). Measured on 2026-11-12 in Chromium: 384 px of dock on a 390 x 844
 * phone, 241 px on 360 x 640 and 185 px on 360 x 560, against a 55dvh cap of 464, 352 and 308. The
 * playground's phone frame is shorter than the page whose `dvh` it reads, so its dock is smaller
 * still (262 px in a 760 px frame on a 390 x 844 page).
 *
 * A COLUMN. The dock lays its card out as a flex column, so a card that opts in (PromptPanel's `fit`,
 * the permission card with subject rows) shrinks to the dock's height and gives the room to its one
 * scroller (the subject box) while its question, note lines and buttons keep their size. Every other
 * card keeps its full height, as a flex item does by default, and the dock scrolls it as before.
 *
 * THE ROOM OF A CARD THAT FITS. Such a card has two heights ({@link fitSize}, measured): its floor,
 * all its rows with the subject box at three rows, and its natural height, the subject box at all
 * its rows (up to the box's own max). The dock starts at the floor (its flex basis) and grows first
 * (weight 1000, the reading box 1) up to its natural height or its cap, whichever is less; a floor
 * over the cap wins over the cap. The reading box starts at its share of the screen (agent-chat.tsx)
 * and shrinks first (weight 1000 there, 1 here). So, as the screen gets shorter: the subject gives
 * up its spare rows down to three, then the chat goes under its share, down to nothing, and only
 * then does the dock go under its floor and scroll, from its top. The composer is never pushed off.
 * CSS alone cannot give a box a floor of "its rows but one box at its minimum": a box's min-content
 * height in the block axis is its whole content, so the two heights are measured.
 *
 * LOOK. The page background and one uniform 1px top rule: a docked sheet standing on the column, not
 * a second card around the card. `px-3` is the mirror list's own gutter, so the card's edges line up
 * with the terminal text above it.
 */
export function CardDock(props: CardDockProps) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  // The caller's ref still reaches the dock's box; ours watches it for the floor.
  useImperativeHandle(props.ref, () => dock!, [dock]);
  // The exit stands in for the card, and it scrolls as the unread card does: it never fits.
  const fits = (props.answerExit === null || props.answerExit === undefined) && dockFits(props.blocks);
  const size = useFitSize(dock, fits);
  const card = liftedCard(props);
  if (card === null) return null;
  const offWords = props.promptDisabled === true && hasDialogCard(props.blocks) ? props.promptDisabledReason : undefined;
  const cap = props.composing ? "40dvh" : "55dvh";
  return (
    // `role="presentation"`, the mirror wrapper's own reading: a layout box whose click adds nothing
    // a keyboard user lacks (the textarea is the next tabbable thing).
    <div
      ref={setDock}
      role="presentation"
      data-slot="card-dock"
      className={cn(
        "flex min-h-0 flex-col overflow-y-auto overscroll-contain border-t border-border bg-background px-3 pt-2 pb-2",
        // A card that fits grows first and shrinks last; the reading box does the opposite
        // (agent-chat.tsx). See "THE ROOM OF A CARD THAT FITS" above.
        fits ? "grow-[1000] shrink" : "shrink",
        props.composing ? "max-h-[40dvh]" : "max-h-[55dvh]",
        props.faceClassName,
      )}
      style={size === null ? props.faceStyle : { ...props.faceStyle, ...fitStyle(size, cap) }}
      onClick={props.onClick}
    >
      {card}
      <Collapse open={offWords !== undefined}>
        {offWords !== undefined && (
          <p data-slot="card-off" role="status" className="pt-1.5 text-xs leading-snug text-muted-foreground">
            {offWords}
          </p>
        )}
      </Collapse>
    </div>
  );
}
