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
//   - wizard, multi-select, preview-select: native forms, as the React app draws them. Every control
//     is one tap, one verified keystroke through web's action modules (ADR 0080); the card keeps no
//     form state of its own, the terminal is the one source of truth. The stepper strip the three
//     share is derived here (`stepperView`) so it tests without a browser.
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
  WizardOption,
  WizardStepChip,
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

/** The stepper strip of a multi-question dialog (web/src/components/wizard-stepper.tsx), derived. */
export interface StepperView {
  steps: WizardStepChip[];
  /** The wizard's review step: the trailing Submit chip is the current one. */
  submitCurrent: boolean;
  /** The first question has nothing to its left (the TUI clamps there), so Back is disabled. */
  backDisabled: boolean;
  /** Next is disabled beyond the lock: the review step has nothing after it. */
  nextDisabled: boolean;
  /** The spoken position, "Step 2 of 4: Scope". Empty when no chip reads as current. */
  position: string;
}

/** The stepper for a dialog's chips (wizard-stepper.tsx's own derivation). */
export function stepperView(steps: WizardStepChip[], submitCurrent = false, nextDisabled = false): StepperView {
  const currentIndex = steps.findIndex((s) => s.current);
  const position = submitCurrent
    ? t("dialog.stepPosition.submit", { index: steps.length + 1, total: steps.length + 1 })
    : currentIndex >= 0
      ? t("dialog.stepPosition.step", {
          index: currentIndex + 1,
          total: steps.length + 1,
          label: steps[currentIndex]!.label,
        })
      : "";
  return {
    steps,
    submitCurrent,
    backDisabled: !submitCurrent && (steps[0]?.current ?? false),
    nextDisabled,
    position,
  };
}

export interface WizardCard {
  kind: "wizard";
  block: WizardBlock;
  /** The step's heading: its question, or "Review your answers". Also the panel's name. */
  caption: string;
  stepper: StepperView;
  /** The question step's answers, in screen order. Empty on the review step. */
  answers: WizardOption[];
  /** The "Chat about this" rows: they end the whole wizard, so the card draws them apart. */
  escapes: WizardOption[];
}

export interface MultiSelectCard {
  kind: "multi-select";
  block: MultiSelectBlock;
  /** The checkbox screen's question, or "Ready to submit your answers?" on the review. */
  caption: string;
  /** Only a wizard step of a multi-question dialog has one. */
  stepper: StepperView | null;
}

export interface PreviewSelectCard {
  kind: "preview-select";
  block: PreviewSelectBlock;
  /** The wizard form's question, else the plain "Choose an option" group caption. */
  caption: string;
  stepper: StepperView | null;
  /** The label of the pointed option, whose preview pane shows below. */
  pointedLabel: string | undefined;
  /** The TUI's own note input has focus: any key we sent would be typed into it, so all locks. */
  terminalEditing: boolean;
}

export type DialogCard = PromptCard | MenuCard | UnreadCard | WizardCard | MultiSelectCard | PreviewSelectCard;

function wizardCard(block: WizardBlock): WizardCard {
  const { wizard } = block;
  const review = wizard.phase === "review";
  const options = wizard.phase === "question" ? wizard.options : [];
  return {
    kind: "wizard",
    block,
    caption: wizard.phase === "review" ? t("dialog.reviewAnswers") : wizard.question,
    // The TUI clamps navigation: Right on the review step is a no-op, so the arrow is disabled.
    stepper: stepperView(wizard.steps, review, review),
    answers: options.filter((o) => !o.escape),
    escapes: options.filter((o) => o.escape),
  };
}

function multiSelectCard(block: MultiSelectBlock): MultiSelectCard {
  const { multi } = block;
  return {
    kind: "multi-select",
    block,
    caption: multi.phase === "checkbox" ? multi.question : t("dialog.readySubmit"),
    stepper: multi.phase === "checkbox" && multi.steps ? stepperView(multi.steps) : null,
  };
}

function previewSelectCard(block: PreviewSelectBlock): PreviewSelectCard {
  const { preview } = block;
  return {
    kind: "preview-select",
    block,
    caption: preview.steps !== null ? preview.question : t("dialog.chooseOption"),
    stepper: preview.steps !== null ? stepperView(preview.steps) : null,
    pointedLabel: preview.options.find((o) => o.pointed)?.label,
    terminalEditing: preview.note.state === "editing",
  };
}

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
        return wizardCard(block);
      case "multi-select":
        return multiSelectCard(block);
      case "preview-select":
        return previewSelectCard(block);
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
