import { useState, type ReactNode } from "react";
import { MessageSquarePlus } from "lucide-react";

import { InlineEditor, InlineEditorOffer } from "@/components/ui/inline-editor";
import { ANSWER_MAX_LENGTH } from "@/lib/answer-field";
import type { WizardStepChip } from "@/lib/harness/wizard-model";
import { t } from "@/lib/i18n";

/** The words a card's inline text field speaks: its offer, its editor and its states. */
export interface FeedbackCopy {
  offer: string | null;
  /** The offer that opens the editor prefilled with what the field holds; `answer` rows only. */
  change: string | null;
  textAria: string;
  editorLabel: string;
  placeholder: string;
  help: string;
  send: string;
  sending: string;
  focused: string;
  typedPrefix: string;
}

/**
 * The copy of an AskUserQuestion answer field (ADR 0113). Only the help line differs between the
 * cards that carry one, because only it says what Send does next. A function, not a module-level
 * object, so it re-reads the current locale on every call.
 */
export function answerFieldCopy(help: string): FeedbackCopy {
  return {
    offer: t("prompt.feedback.answer.offer"),
    change: t("prompt.feedback.answer.change"),
    textAria: t("prompt.feedback.answer.textAria"),
    editorLabel: t("prompt.feedback.answer.editorLabel"),
    placeholder: t("prompt.feedback.answer.placeholder"),
    help,
    send: t("prompt.feedback.answer.send"),
    sending: t("prompt.feedback.answer.sending"),
    focused: t("prompt.feedback.answer.focused"),
    typedPrefix: t("prompt.feedback.answer.typedPrefix"),
  };
}

/** What the terminal's field holds, read-only: the copy's prefix, then the text in the content face. */
export function TypedFieldCard({ prefix, text }: { prefix: string; text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <MessageSquarePlus
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-label={t("prompt.feedback.typedAria")}
      />
      <span className="min-w-0 flex-1 text-xs text-foreground/90">
        {prefix}
        <span className="font-content">{text}</span>
      </span>
    </div>
  );
}

/**
 * The question a field answers, as the card read it: its text, and which step of a stepper it is on.
 * The editor keeps it at open, because the card dock draws one card per dialog kind and does not key
 * it to the dialog: a wizard the desk moves to its next step re-renders the same card under the open
 * editor, and both steps' fields can read the same (empty) text.
 */
export interface AskedQuestion {
  question: string;
  /** The current chip's position and label; "" for a question without a stepper. */
  step: string;
}

/** The step a stepper is on: the current chip's position and label, "" when none reads as current. */
export function stepOf(steps: readonly WizardStepChip[] | null | undefined): string {
  const at = steps?.findIndex((chip) => chip.current) ?? -1;
  return at < 0 ? "" : `${at}:${steps![at]!.label}`;
}

function sameQuestion(a: AskedQuestion, b: AskedQuestion): boolean {
  return a.question === b.question && a.step === b.step;
}

/** A card's answer editor: whether it is open, its draft, and the field and question it was opened over. */
export interface AnswerEditor {
  editorOpen: boolean;
  draft: string;
  setDraft: (value: string) => void;
  /** What the field came to hold while the editor hid it, once a Send has found it; null otherwise. */
  moved: string | null;
  /** The question the dialog moved on to while the editor hid it, once a Send has found it; null otherwise. */
  questionMoved: string | null;
  /** Open the editor holding `prefill`, over a field that reads `fieldText` right now, on `asked`. */
  open: (prefill: string, fieldText: string, asked: AskedQuestion) => void;
  cancel: () => void;
  /**
   * Send the trimmed draft through `onAnswer`, unless the field no longer holds what the person last
   * saw, or the dialog no longer shows the question they wrote it for. The open editor replaces the
   * field's own card on screen, so text typed at the desk meanwhile was never seen here, and the
   * recipe would clear it (ADR 0113 rule 3: clear only what was seen); a step the desk moved on to
   * was never seen either. Then nothing is sent: the change is shown in the editor and becomes what
   * was seen, so the next Send goes to it. The editor closes only on a send `onAnswer` reports as landed.
   */
  send: (
    field: { text: string },
    asked: AskedQuestion,
    onAnswer: (text: string) => boolean | Promise<boolean>,
    locked: boolean,
  ) => Promise<void>;
}

/** The state of one card's answer editor; see {@link AnswerEditor}. */
export function useAnswerEditor(): AnswerEditor {
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [seenText, setSeenText] = useState("");
  const [seenAsked, setSeenAsked] = useState<AskedQuestion>({ question: "", step: "" });
  const [moved, setMoved] = useState<string | null>(null);
  const [questionMoved, setQuestionMoved] = useState<string | null>(null);

  function open(prefill: string, fieldText: string, asked: AskedQuestion) {
    setDraft(prefill);
    setSeenText(fieldText);
    setSeenAsked(asked);
    setMoved(null);
    setQuestionMoved(null);
    setEditorOpen(true);
  }

  function cancel() {
    setEditorOpen(false);
    setMoved(null);
    setQuestionMoved(null);
  }

  async function send(
    field: { text: string },
    asked: AskedQuestion,
    onAnswer: (text: string) => boolean | Promise<boolean>,
    locked: boolean,
  ) {
    const text = draft.trim();
    if (text.length === 0 || locked) return;
    const questionChanged = !sameQuestion(asked, seenAsked);
    const fieldChanged = field.text !== seenText;
    if (questionChanged || fieldChanged) {
      setSeenAsked(asked);
      setSeenText(field.text);
      setQuestionMoved(questionChanged ? asked.question : null);
      setMoved(fieldChanged ? field.text : null);
      return;
    }
    if (await onAnswer(text)) {
      setEditorOpen(false);
      setMoved(null);
      setQuestionMoved(null);
    }
  }

  return { editorOpen, draft, setDraft, moved, questionMoved, open, cancel, send };
}

/**
 * The editor's notice for a dialog that changed under it, as text nodes: the question it moved on to,
 * then what the field holds now. Null when Send found nothing changed.
 */
export function EditorMovedNotice({ editor }: { editor: Pick<AnswerEditor, "moved" | "questionMoved"> }) {
  if (editor.moved === null && editor.questionMoved === null) return null;
  return (
    <div
      role="status"
      className="space-y-1 rounded-md border border-dashed border-status-working/50 px-2 py-1.5 text-xs leading-snug text-status-working"
    >
      {editor.questionMoved === null ? null : (
        <p>{t("prompt.feedback.answer.questionMoved", { question: editor.questionMoved })}</p>
      )}
      {editor.moved === null ? null : (
        <p>
          {editor.moved === ""
            ? t("prompt.feedback.answer.fieldEmptied")
            : t("prompt.feedback.answer.fieldMoved", { text: editor.moved })}
        </p>
      )}
    </div>
  );
}

export interface AnswerFieldSurfaceProps {
  /** The terminal's field as the card's model reads it. */
  field: { focused: boolean; text: string };
  /** The question the field answers right now; the editor keeps it at open. */
  asked: AskedQuestion;
  copy: FeedbackCopy;
  /** Our own answer send is in flight. */
  ours: boolean;
  /** Any send of this card is in flight: Cancel must not race it. */
  anySending: boolean;
  editor: AnswerEditor;
  onSend: () => void;
  /** The card cannot send right now (read-only, offline, a send in flight). A focused terminal field
   *  does not lock this surface: the recipe reaches the field itself (lib/answer-field.ts). */
  locked: boolean;
  busyIcon: ReactNode;
  /** Show what a filled field holds as a read-only card. False where the card already shows the text
   *  elsewhere (a multi-select question draws it as one of its checkbox rows). */
  showTyped: boolean;
  /** Show the focused notice while the terminal field has the keyboard: true where the card locks its
   *  buttons then. False on a multi-select question, whose buttons move the pointer off the field first
   *  (lib/multi-select-action.ts `offField`), so the notice would be untrue there. */
  showFocused: boolean;
}

/**
 * AskUserQuestion's `Type something.` field (ADR 0113), below a card's options: our own send in
 * flight, else the editor, else what the field holds with an offer to change it, else the focused
 * banner (where the card shows it) with the offer, else the offer alone. Shared by the
 * single-question card, the wizard step and the multi-select question.
 */
export function AnswerFieldSurface(props: AnswerFieldSurfaceProps) {
  const { field, copy, locked, editor } = props;
  const focusedBanner = field.focused && props.showFocused ? (
    <div className="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
      {copy.focused}
    </div>
  ) : null;
  if (props.ours) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {props.busyIcon}
        {copy.sending}
      </div>
    );
  }
  if (editor.editorOpen) {
    return (
      <InlineEditor
        id="ask-answer-text"
        label={copy.editorLabel}
        value={editor.draft}
        onChange={editor.setDraft}
        maxLength={ANSWER_MAX_LENGTH}
        placeholder={copy.placeholder}
        help={copy.help}
        textAriaLabel={copy.textAria}
        sendLabel={copy.send}
        cancelLabel={t("prompt.feedback.cancel")}
        onSend={props.onSend}
        onCancel={editor.cancel}
        sendDisabled={locked || editor.draft.trim().length === 0}
        cancelDisabled={props.anySending}
        busy={false}
        busyAriaLabel={t("prompt.sendingAria")}
        notice={<EditorMovedNotice editor={editor} />}
      />
    );
  }
  if (field.text !== "") {
    return (
      <>
        {props.showTyped ? <TypedFieldCard prefix={copy.typedPrefix} text={field.text} /> : focusedBanner}
        <InlineEditorOffer
          label={copy.change ?? ""}
          disabled={locked}
          onClick={() => editor.open(field.text, field.text, props.asked)}
        />
      </>
    );
  }
  return (
    <>
      {focusedBanner}
      <InlineEditorOffer label={copy.offer ?? ""} disabled={locked} onClick={() => editor.open("", "", props.asked)} />
    </>
  );
}
