import type { ReactNode } from "react";
import { MessageSquarePlus } from "lucide-react";

import { InlineEditor, InlineEditorOffer } from "@/components/ui/inline-editor";
import { FEEDBACK_MAX_LENGTH } from "@/lib/answer-field";
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
 * The copy of an AskUserQuestion answer field (ADR 0104). Only the help line differs between the
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

export interface AnswerFieldSurfaceProps {
  /** The terminal's field as the card's model reads it. */
  field: { focused: boolean; text: string };
  copy: FeedbackCopy;
  /** Our own answer send is in flight. */
  ours: boolean;
  /** Any send of this card is in flight: Cancel must not race it. */
  anySending: boolean;
  editorOpen: boolean;
  draft: string;
  onDraft: (value: string) => void;
  /** Open the editor holding `prefill`. */
  onOpen: (prefill: string) => void;
  onCancel: () => void;
  onSend: () => void;
  /** The card cannot send right now (read-only, offline, a send in flight). A focused terminal field
   *  does not lock this surface: the recipe reaches the field itself (lib/answer-field.ts). */
  locked: boolean;
  busyIcon: ReactNode;
}

/**
 * AskUserQuestion's `Type something.` field (ADR 0104), below a card's options: our own send in
 * flight, else the editor, else what the field holds with an offer to change it, else the focused
 * banner with the offer, else the offer alone. Shared by the single-question card and the wizard step.
 */
export function AnswerFieldSurface(props: AnswerFieldSurfaceProps) {
  const { field, copy, locked } = props;
  if (props.ours) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {props.busyIcon}
        {copy.sending}
      </div>
    );
  }
  if (props.editorOpen) {
    return (
      <InlineEditor
        id="ask-answer-text"
        label={copy.editorLabel}
        value={props.draft}
        onChange={props.onDraft}
        maxLength={FEEDBACK_MAX_LENGTH}
        placeholder={copy.placeholder}
        help={copy.help}
        textAriaLabel={copy.textAria}
        sendLabel={copy.send}
        cancelLabel={t("prompt.feedback.cancel")}
        onSend={props.onSend}
        onCancel={props.onCancel}
        sendDisabled={locked || props.draft.trim().length === 0}
        cancelDisabled={props.anySending}
        busy={false}
        busyAriaLabel={t("prompt.sendingAria")}
      />
    );
  }
  if (field.text !== "") {
    return (
      <>
        <TypedFieldCard prefix={copy.typedPrefix} text={field.text} />
        <InlineEditorOffer label={copy.change ?? ""} disabled={locked} onClick={() => props.onOpen(field.text)} />
      </>
    );
  }
  return (
    <>
      {field.focused ? (
        <div className="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
          {copy.focused}
        </div>
      ) : null}
      <InlineEditorOffer label={copy.offer ?? ""} disabled={locked} onClick={() => props.onOpen("")} />
    </>
  );
}
