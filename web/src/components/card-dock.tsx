import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from "react";

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
import { paneScopeKey, type Scope } from "@/lib/scope";
import type { EditorDialog, SeenValue } from "@/lib/editor-action";
import type { DialogEditorObservation } from "@/lib/harness/editor-model";
import { NOTE_MAX_LENGTH } from "@/lib/harness/preview-model";
import { QuestionNoteEditor } from "@/components/ui/question-note";
import { InlineEditor } from "@/components/ui/inline-editor";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { FEEDBACK_MAX_LENGTH } from "@/lib/harness/prompt-model";
import { answerFieldCopy } from "@/components/answer-field-surface";
import { QuestionHeading } from "@/components/option-button";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { useLive } from "@/lib/liveness";
import { PromptSelectBlock, type PromptBlockAction } from "@/components/prompt-select-block";
import { WizardBlock } from "@/components/wizard-block";
import { PreviewSelectBlock, type PreviewBlockAction } from "@/components/preview-select-block";
import { MultiSelectBlock } from "@/components/multi-select-block";
import { MenuBlock, type MenuBlockAction } from "@/components/menu-block";
import { AutocompleteBlock } from "@/components/autocomplete-block";
import { BoxTextBlock } from "@/components/box-text-block";
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
  /** Optional native editing; the dock retains its temporary context through raw/editor views. */
  onReadEditor?: (purpose: DialogEditorObservation["purpose"], dialog: EditorDialog, remove?: boolean) => Promise<SeenValue | null>;
  onSaveEditor?: (text: string, seen: SeenValue) => Promise<boolean>;
  onCancelEditor?: (seen: SeenValue) => Promise<boolean>;
  /** Injected handler for a generic-menu tap (lib/menu-action.ts). */
  onMenuAction?: (action: MenuBlockAction, menu: MenuModel) => void | Promise<void>;
  /** Injected handler for the unread-dialog card's one declared key (.adr/0053). */
  onUnreadDialogAction?: (key: string, cancel: UnreadDialogModel) => void | Promise<void>;
  /** Opens Report a problem from the unread-dialog card (ADR 0123, amendment 2026-10-28). Absent, the
   *  card offers no report. */
  onUnreadDialogReport?: (cancel: UnreadDialogModel) => void;
  /** Disable every card's controls (read-only device, gone pane). */
  promptDisabled?: boolean;
  /** The pane the card answers for, and its scope. The prompt card enables only while the bridge has
   *  answered a read for it lately (lib/liveness.ts, M46 spec 11). */
  paneId?: string;
  scope?: Scope;
  /** The screen is drawn from the on-device cache (M46 spec 10): the prompt card stays locked. */
  stale?: boolean;
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
}

export { hasDialogCard } from "@/components/card-dock-model";

/** The one card on screen, as a React element, or null when every block is raw. */
function liftedCard({
  blocks,
  onPromptAction,
  onWizardAction,
  onWizardAnswer,
  onPreviewAction,
  onMultiSelectAction,
  onMultiSelectAnswer,
  onReadEditor,
  onMenuAction,
  onUnreadDialogAction,
  onUnreadDialogReport,
  promptDisabled,
  paneId,
  scope,
  stale,
  wrap,
}: CardDockProps): ReactNode {
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
        onReadEditor={onReadEditor ? (purpose, remove) => onReadEditor(purpose, { kind: "preview-select", model: previewBlock.preview }, remove) : undefined}
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
        onReadEditor={onReadEditor ? (purpose, remove) => onReadEditor(purpose, { kind: "multi-select", model: multiBlock.multi }, remove) : undefined}
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
      />
    );
  }
  // No handler and no `disabled`: the completion popup emits no keystroke, so there is nothing for a
  // read-only device to be refused. Last only because it is the least specific tail shape; every
  // dialog above means there is no input box, and a popup means there is one.
  const autoBlock = blocks.find((b): b is AutoBlock => b.kind === "autocomplete");
  if (autoBlock) return <AutocompleteBlock autocomplete={autoBlock.autocomplete} />;
  // Keyless like the popup, and for the same reason: the input box is live under the box it shows.
  const boxTextBlock = blocks.find((b): b is BoxBlock => b.kind === "box-text");
  if (boxTextBlock) return <BoxTextBlock boxText={boxTextBlock.boxText} />;
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
interface OwnedEdit {
  token: number;
  asked: string;
  ownerSignature: string;
  purpose: DialogEditorObservation["purpose"];
  remove: boolean;
  draft: string;
  seen: SeenValue | null;
  busy: "read" | "save" | "return" | null;
}

export function CardDock(props: CardDockProps) {
  useLocale();
  const live = useLive(props.paneId ?? "", props.scope);
  const locked = Boolean(props.promptDisabled || props.stale || (props.paneId !== undefined && !live));
  const [owned, setOwned] = useState<OwnedEdit | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const paneKey = paneScopeKey(props.scope, props.paneId ?? "");
  const invalidate = useCallback(() => { generation.current++; busy.current = false; }, []);
  useEffect(() => {
    invalidate();
    setOwned(null);
    return invalidate;
  }, [paneKey, invalidate]);
  const current = props.blocks.find((block) => block.kind === "multi-select" || block.kind === "preview-select");
  const currentOwner = current?.kind === "multi-select" ? current.multi.editors?.ownerSignature : current?.preview.editors?.ownerSignature;
  useEffect(() => {
    if (owned !== null && currentOwner !== undefined && currentOwner !== owned.ownerSignature) {
      generation.current++;
      busy.current = false;
      setOwned(null);
    }
  }, [currentOwner, owned]);

  async function begin(purpose: DialogEditorObservation["purpose"], dialog: EditorDialog, remove = false): Promise<SeenValue | null> {
    const model = dialog.model;
    if (locked || busy.current || !props.onReadEditor || !props.onSaveEditor || !model.editors) return null;
    const token = ++generation.current;
    busy.current = true;
    setOwned({ token, asked: "phase" in model && model.phase === "review" ? t("dialog.editor.globalNote") : model.question,
      ownerSignature: model.editors.ownerSignature, purpose, remove, draft: "", seen: null, busy: "read" });
    let seen: SeenValue | null = null;
    try {
      seen = await props.onReadEditor(purpose, dialog);
      return generation.current === token ? seen : null;
    } finally {
      if (generation.current === token) {
        busy.current = false;
        setOwned((edit) => edit?.token === token ? { ...edit, seen, draft: seen?.text ?? "", busy: null } : edit);
      }
    }
  }
  async function finish(action: "save" | "return") {
    if (locked || busy.current || owned?.seen === null || owned === null) return;
    const edit = owned;
    const seen = owned.seen;
    const token = owned.token;
    busy.current = true;
    setOwned({ ...edit, busy: action });
    try {
      const acknowledged = action === "save" ? await props.onSaveEditor?.(edit.remove ? "" : edit.draft, seen) : await props.onCancelEditor?.(seen);
      if (generation.current === token && acknowledged === true) setOwned(null);
    } finally {
      if (generation.current === token) {
        busy.current = false;
        setOwned((previous) => previous?.token === token ? { ...previous, busy: null } : previous);
      }
    }
  }
  const answerCopy = answerFieldCopy(t("prompt.feedback.answer.helpMulti"));
  const card = owned === null ? liftedCard({ ...props,
    onReadEditor: props.onReadEditor ? (purpose, dialog, remove) => begin(purpose, dialog, remove) : undefined,
  }) : (
    <div className="space-y-2 py-1">
      <QuestionHeading>{owned.asked}</QuestionHeading>
      {owned.busy === "read" ? <p role="status" className="text-xs text-muted-foreground">{t("dialog.editor.reading")}</p> : owned.seen === null ?
        <Collapse open appear><Notice tone="caution" variant="box" announce="alert" action={<Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={() => setOwned(null)}>{t("common.closeAria")}</Button>}>{t("dialog.editor.readFailed")}</Notice></Collapse> :
        owned.purpose === "answer" ? <InlineEditor id="ask-answer-text" label={answerCopy.editorLabel} value={owned.draft}
          onChange={(draft) => setOwned((edit) => edit === null ? null : { ...edit, draft })} maxLength={FEEDBACK_MAX_LENGTH}
          placeholder={answerCopy.placeholder} help={answerCopy.help} textAriaLabel={answerCopy.textAria}
          sendLabel={owned.remove ? t("keys.clear.label") : answerCopy.send} cancelLabel={t("dialog.backToOptions")}
          onSend={() => void finish("save")} onCancel={() => void finish("return")}
          sendDisabled={locked || owned.busy !== null || (!owned.remove && owned.draft.trim() === "")}
          cancelDisabled={owned.busy !== null} busy={owned.busy === "save"} busyAriaLabel={t("dialog.sendingAria")}
          inputDisabled={locked || owned.busy !== null} readOnly={owned.remove} /> :
        <Suspense fallback={<span role="status">{t("conversations.loading")}</span>}><QuestionNoteEditor draft={owned.draft} onChange={(draft) => setOwned((edit) => edit === null ? null : { ...edit, draft })}
          disabled={locked || owned.busy !== null} inputDisabled={locked || owned.busy !== null} saving={owned.busy === "save"} returning={owned.busy === "return"}
          maxLength={NOTE_MAX_LENGTH} allowEmpty readOnly={owned.remove} onSave={() => void finish("save")} onCancel={() => void finish("return")}
          saveLabel={owned.remove ? t("dialog.preview.removeNoteAria") : undefined} cancelLabel={t("dialog.backToOptions")}
          label={owned.purpose === "global-note" ? t("dialog.editor.globalNote") : undefined} /></Suspense>}
      {owned.seen !== null ? <p className="text-[11px] text-muted-foreground">{t("dialog.editor.returnHelp")}</p> : null}
    </div>
  );
  if (card === null) return null;
  return (
    // `role="presentation"`, the mirror wrapper's own reading: a layout box whose click adds nothing
    // a keyboard user lacks (the textarea is the next tabbable thing).
    <div
      ref={props.ref}
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
